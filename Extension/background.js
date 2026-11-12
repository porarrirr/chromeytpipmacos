importScripts('pip.js');
const HOST = 'com.chromeytpip.bridge';
let activeSession;
let preparedSession;

function sameSource(session, message, sender) {
  return session && session.videoID === message.videoID && session.tabID === sender.tab.id
    && (!session.documentID || session.documentID === sender.documentId);
}
function warmStatus(session, ready) {
  chrome.tabs.sendMessage(session.tabID, {type: 'pip-warm', videoID: session.videoID, ready},
    session.documentID ? {documentId: session.documentID} : undefined).catch(() => {});
}
function dropPrepared() {
  const session = preparedSession;
  if (!session) return;
  preparedSession = undefined;
  session.finalized = true;
  clearTimeout(session.timer);
  warmStatus(session, false);
  try { session.port.disconnect(); } catch {}
}
function refreshWarmTimeout(session) {
  clearTimeout(session.timer);
  session.timer = setTimeout(() => { if (preparedSession === session) dropPrepared(); }, 15000);
}
function connect(message, sender, warm = false) {
  const port = chrome.runtime.connectNative(HOST);
  const session = {id: crypto.randomUUID(), tabID: sender.tab.id, windowID: sender.tab.windowId,
    documentID: sender.documentId, videoID: message.videoID, port, latestState: message.state, focusOnReturn: true, warm};
  if (warm) preparedSession = session; else activeSession = session;
  port.onMessage.addListener(event => {
    nativeEvent(session, event).catch(() => {
      if (preparedSession === session) dropPrepared();
      else finalize(session, {event: 'disconnected', error: 'PiPとの接続に失敗しました。'});
    });
  });
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError;
    if (preparedSession === session) { dropPrepared(); return; }
    if (error) console.error('Native PiP:', error.message);
    if (!session.finalized) finalize(session, {event: 'disconnected', state: session.committed ? session.latestState : undefined,
      forcePaused: session.replaced, error: error ? 'アプリに接続できません。scripts/install.shを実行し、拡張機能を再読み込みしてください。' : 'PiPとの接続が終了したためChromeへ戻しました。'});
  });
  return session;
}
const PREPARE_DRIFT_SECONDS = 5;
function preparedDrift(previous, next) {
  if (!previous || (previous.liveOffset == null) !== (next.liveOffset == null)) return Infinity;
  return next.liveOffset != null ? Math.abs(previous.liveOffset - next.liveOffset) : Math.abs(previous.seconds - next.seconds);
}
function prepare(message, sender) {
  if (activeSession || starting || sender.tab.active === false) return {ok: false};
  try {
    if (preparedSession && !sameSource(preparedSession, message, sender)) dropPrepared();
    const session = preparedSession || connect(message, sender, true);
    const state = macPiPTools.state(message.state);
    session.latestState = state;
    refreshWarmTimeout(session);
    if (preparedDrift(session.preparedState, state) < PREPARE_DRIFT_SECONDS) return {ok: true};
    session.preparedState = state;
    session.port.postMessage({type: 'prepare', sessionID: session.id, videoID: session.videoID, state});
    return {ok: true};
  } catch { dropPrepared(); return {ok: false}; }
}

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({url: ['https://www.youtube.com/*', 'https://m.youtube.com/*']});
  await Promise.allSettled(tabs.filter(tab => Number.isInteger(tab.id)).map(tab =>
    chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['pip.js', 'content.js']})));
});

function notify(session, event) {
  return chrome.tabs.sendMessage(session.tabID, {type: 'pip-event', sessionID: session.id, videoID: session.videoID, ...event},
    session.documentID ? {documentId: session.documentID} : undefined);
}
function badge(session, text) {
  chrome.action.setBadgeText({tabId: session.tabID, text}).catch(() => {});
}
async function finalize(session, event) {
  if (session.finalized) return;
  session.finalized = true;
  clearTimeout(session.timer);
  if (activeSession === session) activeSession = null;
  badge(session, '');
  try { await notify(session, event); } catch {}
  try { session.port.disconnect(); } catch {}
  session.done?.();
  if (event.event === 'returned' && session.focusOnReturn && !session.replaced) {
    try {
      await chrome.tabs.update(session.tabID, {active: true});
      if (Number.isInteger(session.windowID)) await chrome.windows.update(session.windowID, {focused: true});
    } catch {}
  }
}
function stop(session, {replaced = false, focus = false} = {}) {
  if (session.stopping) return session.finished;
  session.stopping = true;
  session.replaced = replaced;
  session.focusOnReturn = focus;
  session.finished = new Promise(resolve => { session.done = resolve; });
  clearTimeout(session.timer);
  session.timer = setTimeout(() => finalize(session, {event: 'disconnected', state: session.latestState,
    forcePaused: replaced, error: 'PiPとの接続が終了しました。Chromeへ戻しました。'}), 5000);
  try { session.port.postMessage({type: session.committed ? 'return' : 'cancel', sessionID: session.id}); }
  catch { finalize(session, {event: 'disconnected', state: session.latestState, forcePaused: replaced}); }
  return session.finished;
}
async function nativeEvent(session, message) {
  if (preparedSession === session && message?.sessionID === session.id && !session.finalized) {
    if (message.type === 'prepared') { session.preloaded = true; warmStatus(session, true); }
    if (message.type === 'error' || message.type === 'returned') dropPrepared();
    return;
  }
  if (activeSession !== session || session.finalized || message?.sessionID !== session.id) return;
  const state = macPiPTools.state(message.state);
  switch (message.type) {
    case 'loading':
      notify(session, {event: 'loading', message: message.message}).catch(() => {});
      break;
    case 'ready': {
      if (session.preparing || session.stopping || message.mode !== 'picture-in-picture') return;
      if (!macPiPTools.visiblePresentation(message.presentation)) {
        await finalize(session, {event: 'disconnected', error: 'PiPウインドウの表示を確認できません。アプリを更新して再度お試しください。'});
        return;
      }
      session.presentation = message.presentation;
      session.preparing = true;
      try {
        const response = await notify(session, {event: 'ready'});
        if (session.finalized || session.stopping) return;
        const current = macPiPTools.state(response?.state);
        if (!response?.ok || !current) throw new Error('元のYouTube動画が見つかりません。');
        session.committed = true;
        session.latestState = current;
        session.port.postMessage({type: 'commit', sessionID: session.id, state: current});
      } catch {
        await finalize(session, {event: 'disconnected', error: '元のYouTubeタブが変わったためPiPを中止しました。'});
      }
      break;
    }
    case 'active':
      if (!session.committed || session.stopping || !state || message.mode !== 'picture-in-picture') return;
      if (!macPiPTools.visiblePresentation(message.presentation)) {
        await finalize(session, {event: 'disconnected', state: session.latestState, error: 'PiPウインドウを表示できなかったためChromeへ戻しました。'});
        return;
      }
      session.presentation = message.presentation;
      clearTimeout(session.timer);
      session.latestState = state;
      badge(session, 'PiP');
      notify(session, {event: 'active', state}).catch(() => stop(session, {replaced: true}));
      break;
    case 'state':
      if (!session.committed || session.stopping || !state) return;
      session.latestState = state;
      notify(session, {event: 'state', state}).catch(() => stop(session, {replaced: true}));
      break;
    case 'returned':
      await finalize(session, {event: 'returned', state, forcePaused: session.replaced});
      break;
    case 'error':
      await finalize(session, {event: 'disconnected', state: session.committed ? state || session.latestState : undefined,
        error: String(message.error || 'macOS PiPとの接続に失敗しました。').slice(0, 300)});
      break;
  }
}
let starting = false;
async function start(message, sender) {
  if (starting) return {ok: false, error: 'PiPを切り替え中です。'};
  starting = true;
  try {
    if (activeSession) await stop(activeSession, {replaced: true});
    if (preparedSession && !sameSource(preparedSession, message, sender)) dropPrepared();
    const session = preparedSession || connect(message, sender);
    preparedSession = undefined;
    activeSession = session;
    session.warm = false;
    session.latestState = message.state;
    clearTimeout(session.timer);
    session.timer = setTimeout(() => finalize(session, {event: 'disconnected', error: 'macOS PiPの読み込みに時間がかかっています。Chromeでの再生を続けてください。'}), 65000);
    badge(session, '…');
    session.port.postMessage({type: 'start', sessionID: session.id, videoID: message.videoID, state: macPiPTools.state(message.state)});
    return {ok: true, sessionID: session.id};
  } catch {
    if (activeSession && !activeSession.committed) finalize(activeSession, {event: 'disconnected'});
    return {ok: false, error: 'アプリに接続できません。scripts/install.shを実行してください。'};
  } finally { starting = false; }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['prepare-pip', 'release-pip', 'start-pip', 'return-pip', 'cancel-pip', 'control-pip'].includes(message?.type)) return;
  const currentURL = sender.tab?.url || sender.url;
  const id = macPiPTools.videoID(currentURL);
  let youtube = false;
  try {
    const original = new URL(sender.url);
    const current = new URL(currentURL);
    youtube = original.protocol === 'https:' && ['www.youtube.com', 'm.youtube.com'].includes(original.hostname)
      && current.origin === original.origin;
  } catch {}
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || !youtube
    || (!['cancel-pip', 'release-pip'].includes(message.type) && (!id || id !== message.videoID))) {
    sendResponse({ok: false, error: 'YouTubeの動画情報が変わりました。'}); return;
  }
  if (message.type === 'release-pip') {
    if (preparedSession?.tabID === sender.tab.id && (!preparedSession.documentID || preparedSession.documentID === sender.documentId)) dropPrepared();
    sendResponse({ok: true}); return;
  }
  if (message.type === 'prepare-pip' || message.type === 'start-pip') {
    if (!macPiPTools.state(message.state)) { sendResponse({ok: false, error: '再生状態が不正です。'}); return; }
    if (message.type === 'prepare-pip') { sendResponse(prepare(message, sender)); return; }
    start(message, sender).then(sendResponse);
    return true;
  }
  const session = activeSession;
  if (!session || session.id !== message.sessionID || session.videoID !== message.videoID || session.tabID !== sender.tab.id
    || (session.documentID && session.documentID !== sender.documentId)) { sendResponse({ok: false}); return; }
  if (message.type === 'control-pip') {
    const state = macPiPTools.state(message.state);
    if (!state || !['seek', 'settings'].includes(message.action)) { sendResponse({ok: false}); return; }
    if (session.committed && !session.stopping) {
      try { session.port.postMessage({type: 'control', sessionID: session.id, action: message.action, state}); }
      catch { finalize(session, {event: 'disconnected', state: session.latestState}); }
    }
  } else stop(session, {replaced: message.type === 'cancel-pip', focus: message.type === 'return-pip'});
  sendResponse({ok: true});
});
chrome.tabs.onRemoved.addListener(tabID => {
  if (activeSession?.tabID === tabID) stop(activeSession, {replaced: true});
  if (preparedSession?.tabID === tabID) dropPrepared();
});
chrome.tabs.onActivated.addListener(({tabId, windowId}) => {
  if (preparedSession?.windowID === windowId && preparedSession.tabID !== tabId) dropPrepared();
});
chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab.id)) return;
  try {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {type: 'toggle-pip'});
      if (!response) throw new Error('Content script is unavailable');
    }
    catch {
      await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['pip.js', 'content.js']});
      await chrome.tabs.sendMessage(tab.id, {type: 'toggle-pip'});
    }
    await chrome.action.setTitle({tabId: tab.id, title: 'macOS PiPを切り替える（Option+Shift+P）'});
  } catch {
    await chrome.action.setBadgeText({tabId: tab.id, text: '!'}).catch(() => {});
    await chrome.action.setTitle({tabId: tab.id, title: 'YouTubeの動画ページを開いてください。'}).catch(() => {});
  }
});
