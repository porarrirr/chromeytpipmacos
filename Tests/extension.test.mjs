import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const read = file => readFileSync(new URL(`../Extension/${file}`, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const state = changes => ({seconds: 10, paused: false, volume: .4, muted: false, rate: 1.25, ...changes});
const presentation = () => ({visible: true, onActiveSpace: true, ownerPID: 123, backend: 'system-agent', windowNumber: 42, level: 19});
const event = () => { const listeners = []; return {addListener(fn) { listeners.push(fn); }, emit(...args) { return listeners.map(fn => fn(...args)); }}; };
function harness({paused = false, ad = false, noHost = false, path = '/watch?v=dQw4w9WgXcQ', startDelay, warming = false, sourceReady = 4, missingVideo = false} = {}) {
  const pages = new Map();
  const ports = [];
  const timers = new Map();
  let nextTimer = 1;
  const badges = [];
  const focused = [];
  const timerAPI = {setTimeout(fn, ms) { const id = nextTimer++; timers.set(id, {fn, ms}); return id; }, clearTimeout(id) { timers.delete(id); }};
  let background;
  const base = {
    URL, crypto: {randomUUID}, ...timerAPI,
    chrome: {
      runtime: {id: 'extension', onMessage: event(), onInstalled: event(), lastError: undefined,
        connectNative(host) {
          assert.equal(host, 'com.chromeytpip.bridge');
          if (noHost) throw new Error('not installed');
          const port = {onMessage: event(), onDisconnect: event(), messages: [], closed: false,
            postMessage(message) { this.messages.push(JSON.parse(JSON.stringify(message))); },
            disconnect() { this.closed = true; this.onDisconnect.emit(); }};
          ports.push(port); return port;
        }},
      tabs: {onRemoved: event(), onActivated: event(),
        async query() { return [...pages].map(([id, p]) => ({id, url: p.location.href})); },
        async sendMessage(id, message, options) {
          const p = pages.get(id);
          if (!p || (options?.documentId && options.documentId !== p.documentID)) throw new Error('tab/document gone');
          return p.deliver(message);
        }, async update(id) { focused.push(id); }},
      windows: {async update(id) { focused.push(`window:${id}`); }},
      scripting: {async executeScript({target, files}) { pages.get(target.tabId).inject(files); }},
      action: {onClicked: event(), async setBadgeText(value) { badges.push(value); }, async setTitle() {}}
    }, importScripts(file) { vm.runInContext(read(file), background); }
  };
  background = vm.createContext(base);
  vm.runInContext(read('background.js'), background);
  function messageToBackground(message, sender) {
    return new Promise((resolve, reject) => {
      const listeners = base.chrome.runtime.onMessage.emit(message, sender, resolve);
      if (!listeners.some(value => value === true)) resolve(undefined);
    });
  }
  function createPage(id = 1) {
    const elements = [];
    const events = new Map();
    const observers = [];
    let onMessage = event();
    let currentAd = ad;
    let controls;
    let pauseCalls = 0;
    let playCalls = 0;
    let playing = !paused;
    let video;
    const dispatch = name => { for (const fn of events.get(name) || []) fn(); };
    const node = () => ({style: {setProperty(name, value) { this[name] = value; }}, attributes: {}, handlers: {}, children: [], isConnected: false,
      classList: {toggle() {}}, setAttribute(k, v) { this.attributes[k] = v; },
      removeAttribute(k) { delete this.attributes[k]; delete this[k]; },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      remove() { this.isConnected = false; this.parentNode = null; },
      append(...items) { for (const item of items) { item.parentNode = this; item.isConnected = true; this.children.push(item); } }});
    controls = node();
    const videoEvents = new Map();
    const makeVideo = () => ({isConnected: true, readyState: 4, currentTime: 10, duration: 300,
      volume: .4, muted: false, playbackRate: 1.25, seekable: {length: 0},
      get paused() { return !playing; },
      pause() { pauseCalls++; const changed = playing; playing = false; if (changed) queueMicrotask(() => this.emit('pause')); },
      play() { playCalls++; playing = true; queueMicrotask(() => this.emit('play')); return Promise.resolve(); },
      addEventListener(name, fn) { if (!videoEvents.has(name)) videoEvents.set(name, []); videoEvents.get(name).push(fn); },
      emit(name) { for (const fn of videoEvents.get(name) || []) fn(); }
    });
    video = missingVideo ? null : makeVideo();
    if (video) video.readyState = sourceReady;
    const document = {
      visibilityState: warming ? 'visible' : 'hidden', hasFocus() { return this.visibilityState === 'visible'; },
      documentElement: node(), createElement() { const item = node(); elements.push(item); return item; },
      getElementById(id) { return elements.find(item => item.id === id && item.isConnected); },
      querySelectorAll(selector) { return elements.filter(item => item.isConnected && selector.split(',').some(part => part.trim() === `#${item.id}`)); },
      addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
      querySelector(selector) {
        if (selector === '.ad-showing') return currentAd ? {} : null;
        if (selector === 'ytd-reel-video-renderer[is-active] .ytp-right-controls') return null;
        if (selector === '.ytp-right-controls') return controls;
        if (selector.includes('video')) return video;
        return null;
      }
    };
    const location = new URL(`https://www.youtube.com${path}`);
    const documentID = randomUUID();
    let contextURL;
    const makeContext = () => { contextURL = location.href; return vm.createContext({
      document, location, URL, ...timerAPI,
      chrome: {runtime: {id: 'extension', onMessage, async sendMessage(message) {
        if (message.type === 'start-pip' && startDelay) await startDelay;
        return messageToBackground(message, {id: 'extension', url: contextURL, frameId: 0, documentId: documentID,
          tab: {id, windowId: 7, active: true, url: location.href}});
      }}},
      MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
      addEventListener(name, fn) { document.addEventListener(name, fn); }
    }); };
    let context = makeContext();
    const p = {
      documentID, document, location, elements, observers,
      get context() { return context; }, get onMessage() { return onMessage; },
      get source() { return video; }, get pauseCalls() { return pauseCalls; }, get playCalls() { return playCalls; },
      get button() { return document.getElementById('macos-pip-bridge-button'); }, get phase() { return this.button.attributes['data-phase']; },
      async deliver(message) {
        return new Promise(resolve => {
          const handled = onMessage.emit(message, {id: 'extension'}, resolve);
          if (!handled.some(value => value === true)) resolve(undefined);
        });
      },
      inject(files = ['pip.js', 'content.js']) { for (const file of files) vm.runInContext(read(file), context); },
      invalidate() { context.chrome.runtime.id = undefined; onMessage = event(); context = makeContext(); },
      async click() { await this.deliver({type: 'toggle-pip'}); await tick(); },
      navigate(to) { location.href = `https://www.youtube.com${to}`; dispatch('yt-navigate-finish'); },
      unload() { dispatch('pagehide'); },
      visible(value) { document.visibilityState = value ? 'visible' : 'hidden'; dispatch('visibilitychange'); },
      setAd(value) { currentAd = value; },
      replaceVideo() { if (video) video.isConnected = false; video = makeVideo(); dispatch('yt-navigate-finish'); },
      send(message, senderChanges = {}) { return messageToBackground(message, {id: 'extension', url: contextURL, frameId: 0,
        documentId: documentID, tab: {id, windowId: 7, url: location.href}, ...senderChanges}); }
    };
    pages.set(id, p); p.inject(); return p;
  }
  const page = createPage();
  return {page, createPage, background, ports, badges, focused, timers,
    async emit(type, changes = {}, port = ports.at(-1)) {
      const start = port.messages.find(message => message.type === 'start' || message.type === 'prepare');
      await Promise.all(port.onMessage.emit({type, sessionID: start.sessionID, videoID: start.videoID,
        ...(type === 'ready' || type === 'active' ? {mode: 'picture-in-picture', presentation: presentation()} : {}), ...changes}));
      await tick();
    },
    async active(changes = {}) {
      await page.click(); await this.emit('ready');
      const commit = ports.at(-1).messages.find(message => message.type === 'commit');
      await this.emit('active', {state: {...commit.state, ...changes}});
    }
  };
}

test('native readiness, not successful process launch, pauses Chrome and commits its latest position', async () => {
  const h = harness(); await h.page.click();
  assert.equal(h.page.source.paused, false);
  assert.equal(h.page.pauseCalls, 0);
  assert.equal(h.ports.length, 1);
  h.page.source.currentTime = 18.25;
  await h.emit('ready');
  assert.equal(h.page.source.paused, true);
  assert.equal(h.ports[0].messages.at(-1).type, 'commit');
  assert.equal(h.ports[0].messages.at(-1).state.seconds, 18.25);
  assert.equal(h.ports[0].messages.at(-1).state.paused, false);
  await h.emit('active', {state: state({seconds: 18.25})});
  assert.equal(h.page.phase, 'active');
});

test('a click before video metadata loads automatically starts once ready with the latest state', async () => {
  for (const missingVideo of [false, true]) {
    const h = harness({sourceReady: 0, missingVideo});
    const click = h.page.click();
    await tick();
    assert.equal(h.page.phase, 'waiting');
    assert.equal(h.page.button.textContent, '準備中…');
    assert.equal(h.ports.length, 0);
    assert.notEqual(h.page.document.getElementById('macos-pip-bridge-notice').style.display, 'block');
    if (missingVideo) h.page.replaceVideo();
    h.page.source.readyState = 1;
    h.page.source.currentTime = 23;
    h.page.source.volume = .8;
    [...h.timers.values()].find(timer => timer.ms === 100).fn();
    await click;
    assert.equal(h.ports.length, 1);
    assert.equal(h.ports[0].messages[0].state.seconds, 23);
    assert.equal(h.ports[0].messages[0].state.volume, .8);
    assert.equal(h.page.pauseCalls, 0);
    await h.emit('ready');
    await h.emit('active', {state: state({seconds: 23, volume: .8})});
    assert.equal(h.page.phase, 'active');
  }
});

test('another click cancels a queued request and a fresh click can start normally', async () => {
  const h = harness({sourceReady: 0});
  const first = h.page.click(); await tick();
  await h.page.click(); await first;
  assert.equal(h.page.phase, 'idle');
  assert.equal([...h.timers.values()].some(timer => timer.ms === 100 || timer.ms === 65000), false);
  h.page.source.readyState = 1;
  await h.page.click();
  assert.equal(h.ports.length, 1);
  assert.equal(h.page.phase, 'loading');
});

test('navigation or page unload cancels a queued request without starting the old video', async () => {
  for (const leave of [h => h.page.navigate('/watch?v=abcdefghijk'), h => h.page.unload()]) {
    const h = harness({sourceReady: 0});
    const click = h.page.click(); await tick();
    leave(h); await click;
    h.page.source.readyState = 1;
    assert.equal(h.page.phase, 'idle');
    assert.equal(h.ports.length, 0);
    assert.equal(h.page.pauseCalls, 0);
    assert.equal([...h.timers.values()].some(timer => timer.ms === 100 || timer.ms === 65000), false);
  }
});

test('queued source loading times out cleanly and cannot start later', async () => {
  const h = harness({sourceReady: 0});
  const click = h.page.click(); await tick();
  [...h.timers.values()].find(timer => timer.ms === 65000).fn();
  await click;
  assert.equal(h.page.phase, 'idle');
  assert.equal(h.ports.length, 0);
  assert.equal(h.page.pauseCalls, 0);
  assert.equal([...h.timers.values()].some(timer => timer.ms === 100), false);
});

test('YouTube SPA navigation starts the current video when MessageSender.url still names the original document URL', async () => {
  for (const path of ['/', '/watch?v=dQw4w9WgXcQ', '/results?search_query=video']) {
    const h = harness({path});
    h.page.navigate('/watch?v=abcdefghijk');
    await h.page.click();
    assert.equal(h.ports.length, 1, `Starting after navigating from ${path} must not report that video information changed`);
    assert.equal(h.ports[0].messages[0].videoID, 'abcdefghijk');
    await h.emit('ready');
    await h.emit('active', {state: state()});
    assert.equal(h.page.phase, 'active');
    await h.page.click();
    assert.equal(h.ports[0].messages.at(-1).type, 'return');
    await h.emit('returned', {state: state({seconds: 20})});
    assert.equal(h.page.phase, 'idle');
  }
});

test('playing and paused PiP states return to Chrome with latest position, settings and intended playback', async () => {
  for (const paused of [false, true]) {
    const h = harness({paused}); await h.active({paused});
    const latest = state({seconds: 42.75, paused, volume: .7, rate: 1.5, muted: true});
    await h.emit('state', {state: latest});
    assert.equal(h.page.source.currentTime, 42.75);
    assert.equal(h.page.source.paused, true);
    await h.page.click();
    assert.equal(h.ports[0].messages.at(-1).type, 'return');
    await h.emit('returned', {state: {...latest, seconds: 45}});
    assert.equal(h.page.source.currentTime, 45);
    assert.equal(h.page.source.paused, paused);
    assert.equal(h.page.source.volume, .7);
    assert.equal(h.page.source.playbackRate, 1.5);
    assert.equal(h.page.phase, 'idle');
    assert.equal(h.ports[0].closed, true);
    assert.ok(h.focused.includes(1));
  }
});

test('missing host and loading failures leave Chrome playing without moving its position', async () => {
  const missing = harness({noHost: true}); await missing.page.click();
  assert.equal(missing.page.source.paused, false);
  assert.equal(missing.page.pauseCalls, 0);
  assert.equal(missing.page.phase, 'idle');
  const h = harness(); await h.page.click();
  h.page.source.currentTime = 20;
  await h.emit('error', {error: 'not playable', state: state({seconds: 0, paused: true})});
  assert.equal(h.page.source.currentTime, 20);
  assert.equal(h.page.pauseCalls, 0);
  assert.equal(h.page.phase, 'idle');
});

test('failure between ready and active restores the Chrome state captured at handoff', async () => {
  const h = harness(); await h.page.click(); h.page.source.currentTime = 22;
  await h.emit('ready');
  assert.equal(h.page.source.paused, true);
  await h.emit('error', {error: 'commit failed', state: state({seconds: 0, paused: true, muted: true})});
  assert.equal(h.page.source.currentTime, 22);
  assert.equal(h.page.source.paused, false);
  assert.equal(h.page.source.muted, false);
});

test('native process crash restores the most recent state and prevents a permanently paused tab', async () => {
  const h = harness(); await h.active(); await h.emit('state', {state: state({seconds: 33})});
  h.ports[0].onDisconnect.emit(); await tick();
  assert.equal(h.page.phase, 'idle');
  assert.equal(h.page.source.paused, false);
  assert.ok(h.page.source.currentTime >= 33 && h.page.source.currentTime < 34);
});

test('playing the source video requests return and waits for native shutdown before resuming audio', async () => {
  const h = harness({paused: true}); await h.active({paused: true});
  await h.page.source.play(); await tick();
  assert.equal(h.page.source.paused, true);
  assert.equal(h.ports[0].messages.at(-1).type, 'return');
  await h.emit('returned', {state: state({seconds: 37, paused: true})});
  assert.equal(h.page.source.paused, false);
  assert.equal(h.page.source.currentTime, 37);
});

test('loading can be cancelled without pausing or rewinding the source', async () => {
  const h = harness(); await h.page.click(); h.page.source.currentTime = 25;
  await h.page.click();
  assert.equal(h.ports[0].messages.at(-1).type, 'cancel');
  await h.emit('returned', {state: state({seconds: 0, paused: true})});
  assert.equal(h.page.pauseCalls, 0);
  assert.equal(h.page.source.currentTime, 25);
  assert.equal(h.page.phase, 'idle');
});

test('SPA navigation cancels the old session and ignores stale native replies without touching the new video', async () => {
  const h = harness(); await h.active(); h.page.navigate('/watch?v=abcdefghijk');
  h.page.replaceVideo(); h.page.source.currentTime = 4;
  await tick();
  assert.equal(h.ports[0].messages.at(-1).type, 'return');
  await h.emit('returned', {state: state({seconds: 90})});
  assert.equal(h.page.source.currentTime, 4);
  assert.equal(h.page.phase, 'idle');
});

test('a delayed start reply after navigation does not attach the old session to the new page', async () => {
  let release;
  const h = harness({startDelay: new Promise(resolve => { release = resolve; })});
  const click = h.page.click();
  await tick(); h.page.navigate('/watch?v=abcdefghijk'); h.page.replaceVideo();
  release(); await click;
  assert.equal(h.page.phase, 'idle');
  assert.equal(h.ports.length, 0, 'background validates the changed sender URL');
});

test('source seeks and settings go to native while mirrored changes do not feed back', async () => {
  const h = harness(); await h.active();
  await h.emit('state', {state: state({seconds: 35, volume: .7, rate: 1.5})});
  const before = h.ports[0].messages.length;
  h.page.source.emit('seeked'); h.page.source.emit('volumechange'); h.page.source.emit('ratechange'); await tick();
  assert.equal(h.ports[0].messages.length, before);
  h.page.source.currentTime = 80; h.page.source.emit('seeked'); await tick();
  assert.equal(h.ports[0].messages.at(-1).action, 'seek');
  assert.equal(h.ports[0].messages.at(-1).state.seconds, 80);
  h.page.source.volume = .2; h.page.source.emit('volumechange'); await tick();
  assert.equal(h.ports[0].messages.at(-1).action, 'settings');
  assert.equal(h.ports[0].messages.at(-1).state.volume, .2);
});

test('advertising and invalid media state cannot start a handoff; ads appearing while loading prevent commit', async () => {
  const ads = harness({ad: true}); await ads.page.click(); assert.equal(ads.ports.length, 0);
  const h = harness(); await h.page.click(); h.page.setAd(true); await h.emit('ready');
  assert.equal(h.page.pauseCalls, 0);
  assert.equal(h.ports[0].closed, true);
  const invalid = await h.page.send({type: 'start-pip', videoID: 'dQw4w9WgXcQ', state: state({rate: NaN})});
  assert.equal(invalid.ok, false);
});

test('native commands are bound to the original extension, tab, document and session', async () => {
  const h = harness(); await h.active(); const start = h.ports[0].messages[0];
  const command = {type: 'control-pip', sessionID: start.sessionID, videoID: start.videoID, action: 'seek', state: state()};
  for (const sender of [{id: 'other'}, {url: 'https://evil.example/watch?v=dQw4w9WgXcQ'}, {frameId: 1},
    {tab: {id: 1, url: 'https://evil.example/watch?v=dQw4w9WgXcQ'}},
    {tab: {id: 1, url: 'https://www.youtube.com/watch?v=abcdefghijk'}}, {documentId: randomUUID()}, {tab: {id: 2}}]) {
    assert.equal((await h.page.send(command, sender)).ok, false);
  }
  assert.equal((await h.page.send({...command, sessionID: randomUUID()})).ok, false);
  assert.equal(h.ports[0].messages.length, 2);
});

test('toolbar and shortcut send a single toggle, and do not open a Chrome PiP or popup', async () => {
  const h = harness();
  const chrome = h.background.chrome;
  await Promise.all(chrome.action.onClicked.emit({id: 1})); await tick();
  assert.equal(h.ports.length, 1);
  assert.equal(h.page.pauseCalls, 0);
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.permissions.includes('nativeMessaging'), true);
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.commands._execute_action.suggested_key.mac, 'Alt+Shift+P');
  assert.equal(read('pip.js').includes('video.requestPictureInPicture('), false);
});

test('an extension update reconnects an open YouTube page and replaces its orphaned button', async () => {
  const h = harness();
  const oldButton = h.page.button;
  const oldObserver = h.page.observers[0];
  h.page.invalidate();
  await Promise.all(h.background.chrome.runtime.onInstalled.emit({reason: 'update'}));
  await tick();
  assert.notEqual(h.page.button, oldButton);
  assert.equal(oldButton.isConnected, false);
  assert.equal(h.page.document.querySelectorAll('#macos-pip-bridge-button').length, 1);
  assert.equal(h.page.document.querySelectorAll('#macos-pip-bridge-notice').length, 1);
  oldObserver.fn([]);
  assert.equal(oldObserver.disconnected, true, 'invalidated observers must stop instead of remounting the old button');
  h.page.button.handlers.click({stopPropagation() {}});
  await tick();
  assert.equal(h.ports.length, 1);
  assert.equal(h.page.phase, 'loading');
  assert.equal(h.page.source.paused, false);
});

test('a legacy observer reinserting its button cannot shadow the replacement after an upgrade', async () => {
  const h = harness();
  const oldButton = h.page.button;
  h.page.invalidate();
  h.page.inject();
  h.page.document.documentElement.append(oldButton);
  assert.notEqual(h.page.button, oldButton);
  assert.equal(h.page.document.querySelectorAll('#macos-pip-bridge-button').length, 1);
  assert.equal(oldButton.style.display, 'none');
  h.page.button.handlers.click({stopPropagation() {}});
  await tick();
  assert.equal(h.ports.length, 1);
});

test('toolbar recovery replaces an orphaned button instead of silently skipping injection', async () => {
  const h = harness();
  const oldButton = h.page.button;
  h.page.invalidate();
  await Promise.all(h.background.chrome.action.onClicked.emit({id: 1}));
  await tick();
  assert.notEqual(h.page.button, oldButton);
  assert.equal(h.ports.length, 1);
});

test('reinjecting a live controller keeps one listener, one button and the current session', async () => {
  const h = harness(); await h.active();
  const button = h.page.button;
  h.page.inject();
  assert.equal(h.page.button, button);
  assert.equal(h.page.phase, 'active');
  h.page.button.handlers.click({stopPropagation() {}});
  await tick();
  assert.equal(h.ports.length, 1);
  assert.equal(h.ports[0].messages.filter(message => message.type === 'return').length, 1);
});

test('live state uses DVR distance from the seekable edge rather than mismatched absolute timestamps', () => {
  const h = harness();
  const tools = vm.runInContext('macPiPTools', h.page.context);
  h.page.source.duration = Infinity;
  h.page.source.currentTime = 95;
  h.page.source.seekable = {length: 1, start() { return 40; }, end() { return 100; }};
  const captured = tools.snapshot(h.page.source);
  assert.equal(captured.liveOffset, 5);
  h.page.source.seekable.end = () => 110;
  assert.equal(tools.position(h.page.source, captured), 105);
});

test('committing can also be cancelled while the new seek is buffering', async () => {
  const h = harness(); await h.page.click(); await h.emit('ready');
  assert.equal(h.page.phase, 'committing');
  assert.equal(h.page.button.disabled, false);
  await h.page.click();
  await h.emit('returned', {state: state({seconds: 0, paused: true, muted: true})});
  assert.equal(h.page.source.paused, false);
  assert.equal(h.page.source.currentTime, 10);
});

test('switching tabs hands the previous native session back paused before starting the next', async () => {
  const h = harness(); await h.active(); const second = h.createPage(2);
  const nextStart = second.click(); await tick();
  assert.equal(h.ports.length, 1);
  assert.equal(h.ports[0].messages.at(-1).type, 'return');
  await h.emit('returned', {state: state({seconds: 50})}, h.ports[0]);
  await nextStart;
  assert.equal(h.ports.length, 2);
  assert.equal(h.page.source.paused, true);
  assert.equal(h.page.source.currentTime, 50);
  assert.equal(second.phase, 'loading');
  assert.equal(h.focused.length, 0, 'do not steal focus back to the replaced tab');
});

test('native timeout leaves the source playing and rapid clicks do not start duplicate processes', async () => {
  const h = harness();
  const first = h.page.click(); const second = h.page.click();
  await Promise.all([first, second]);
  assert.equal(h.ports.length, 1);
  const timeout = [...h.timers.values()].find(timer => timer.ms === 5000);
  assert.ok(timeout);
  await timeout.fn(); await tick();
  assert.equal(h.page.source.paused, false);
  assert.equal(h.page.phase, 'idle');
  assert.equal(h.ports[0].closed, true);
});

test('an older native snapshot cannot overwrite a local seek or setting before its DOM event fires', async () => {
  const h = harness(); await h.active();
  h.page.source.currentTime = 70;
  h.page.source.volume = .8;
  h.page.source.playbackRate = 1.5;
  await h.emit('state', {state: state({seconds: 11})});
  assert.equal(h.page.source.currentTime, 70);
  assert.equal(h.page.source.volume, .8);
  assert.equal(h.page.source.playbackRate, 1.5);
  assert.equal(h.ports[0].messages.at(-2).action, 'seek');
  assert.equal(h.ports[0].messages.at(-1).action, 'settings');
  const count = h.ports[0].messages.length;
  h.page.source.emit('seeked'); h.page.source.emit('volumechange'); await tick();
  assert.equal(h.ports[0].messages.length, count);
  await h.emit('state', {state: state({seconds: 70, volume: .8, rate: 1.5})});
  await h.emit('state', {state: state({seconds: 71, volume: .8, rate: 1.5})});
  assert.equal(h.page.source.currentTime, 71);
});

test('visible media is prepared without pausing Chrome and a click reuses that native connection', async () => {
  const h = harness({warming: true}); await tick();
  assert.equal(h.ports.length, 1);
  const port = h.ports[0];
  assert.equal(port.messages[0].type, 'prepare');
  assert.equal(h.page.phase, 'idle');
  assert.equal(h.page.pauseCalls, 0);
  await h.emit('prepared');
  assert.equal(h.page.button.attributes['data-prepared'], 'true');
  h.page.source.currentTime = 24;
  await h.page.click();
  assert.equal(h.ports.length, 1);
  assert.equal(h.page.button.attributes['data-prepared'], 'false');
  assert.equal(port.messages.at(-1).type, 'start');
  assert.equal(port.messages.at(-1).state.seconds, 24);
  assert.equal(h.page.pauseCalls, 0);
  await h.emit('ready');
  assert.equal(port.messages.at(-1).type, 'commit');
  assert.equal(port.messages.at(-1).state.seconds, 24);
});

test('lease renewals with a small position drift do not re-seek the prepared WebKit player', async () => {
  const h = harness({warming: true}); await tick();
  const port = h.ports[0];
  const prepares = () => port.messages.filter(message => message.type === 'prepare');
  assert.equal(prepares().length, 1);
  const lease = () => [...h.timers.entries()].find(([, timer]) => timer.ms === 15000)?.[0];
  const firstLease = lease();
  assert.equal((await h.page.send({type: 'prepare-pip', videoID: 'dQw4w9WgXcQ', state: state({seconds: 12})})).ok, true);
  assert.equal((await h.page.send({type: 'prepare-pip', videoID: 'dQw4w9WgXcQ', state: state({seconds: 14.9})})).ok, true);
  assert.equal(prepares().length, 1);
  assert.notEqual(lease(), firstLease);
  assert.equal(h.timers.has(firstLease), false);
  await h.page.send({type: 'prepare-pip', videoID: 'dQw4w9WgXcQ', state: state({seconds: 15})});
  assert.equal(prepares().length, 2);
  assert.equal(prepares().at(-1).state.seconds, 15);
  await h.page.send({type: 'prepare-pip', videoID: 'dQw4w9WgXcQ', state: state({seconds: 3})});
  assert.equal(prepares().length, 3);
  await h.page.send({type: 'prepare-pip', videoID: 'dQw4w9WgXcQ', state: state({seconds: 3, liveOffset: 20})});
  assert.equal(prepares().length, 4);
  await h.page.send({type: 'prepare-pip', videoID: 'dQw4w9WgXcQ', state: state({seconds: 6, liveOffset: 21})});
  assert.equal(prepares().length, 4);
  h.page.source.currentTime = 16;
  await h.page.click();
  assert.equal(port.messages.at(-1).type, 'start');
  assert.equal(port.messages.at(-1).state.seconds, 16);
});

test('hidden tabs, navigation, expired leases and tab removal release speculative native players', async () => {
  for (const release of [
    h => h.page.visible(false),
    h => h.page.navigate('/'),
    h => h.background.chrome.tabs.onRemoved.emit(1),
    h => h.background.chrome.tabs.onActivated.emit({tabId: 2, windowId: 7}),
    h => [...h.timers.values()].find(timer => timer.ms === 15000).fn()
  ]) {
    const h = harness({warming: true}); await tick();
    release(h); await tick();
    assert.equal(h.ports[0].closed, true);
    assert.equal(h.page.source.paused, false);
  }
});

test('speculative failures stay quiet, do not interrupt active PiP, and never reuse another document', async () => {
  const missing = harness({warming: true, noHost: true}); await tick();
  assert.equal(missing.page.phase, 'idle');
  assert.notEqual(missing.page.document.getElementById('macos-pip-bridge-notice').style.display, 'block');
  const h = harness({warming: true}); await tick();
  const old = h.ports[0];
  const other = h.createPage(2); await tick();
  assert.equal(old.closed, true);
  await other.click();
  const count = h.ports.length;
  const result = await h.page.send({type:'prepare-pip', videoID:'dQw4w9WgXcQ', state:state()});
  assert.equal(result.ok, false);
  assert.equal(h.ports.length, count);
});

test('a PiP mode flag without a visible floating window never pauses Chrome or declares success', async () => {
  for (const proof of [undefined, {...presentation(), visible: false}, {...presentation(), onActiveSpace: false},
    {...presentation(), ownerPID: 0}, {...presentation(), backend: 'placeholder'}, {...presentation(), level: 0}]) {
    const h = harness(); await h.page.click();
    await h.emit('ready', {presentation: proof});
    assert.equal(h.page.phase, 'idle');
    assert.equal(h.page.pauseCalls, 0);
    assert.equal(h.ports[0].closed, true);
    assert.equal(h.ports[0].messages.some(message => message.type === 'commit'), false);
  }
});

test('a window disappearing during handoff restores Chrome instead of leaving an invisible PiP session', async () => {
  const h = harness(); await h.page.click(); await h.emit('ready');
  assert.equal(h.page.source.paused, true);
  await h.emit('active', {state: state(), presentation: {...presentation(), visible: false}});
  assert.equal(h.page.phase, 'idle');
  assert.equal(h.page.source.paused, false);
  assert.equal(h.ports[0].closed, true);
});
