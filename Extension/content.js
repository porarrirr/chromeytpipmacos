(() => {
  if (globalThis.macPiPBridge) { globalThis.macPiPBridge.mount(); return; }
  for (const stale of document.querySelectorAll('#macos-pip-bridge-button, #macos-pip-bridge-notice, #macos-pip-bridge-style')) {
    stale.removeAttribute('id');
    stale.style.setProperty('display', 'none', 'important');
    stale.remove();
  }
  const tools = macPiPTools;
  const button = document.createElement('button');
  button.id = 'macos-pip-bridge-button';
  button.type = 'button';
  button.className = 'ytp-button';
  const style = document.createElement('style');
  style.id = 'macos-pip-bridge-style';
  style.textContent = `
    #macos-pip-bridge-button { width:96px; white-space:nowrap; font:600 12px system-ui; color:white; cursor:pointer; }
    #macos-pip-bridge-button[aria-pressed="true"] { color:#8ab4f8; }
    #macos-pip-bridge-button:focus-visible { outline:2px solid #8ab4f8; outline-offset:-3px; }
    #macos-pip-bridge-button:disabled { opacity:.5; cursor:wait; }
    #macos-pip-bridge-button.macos-pip-floating { position:fixed; right:24px; bottom:24px;
      z-index:2147483647; width:auto; height:auto; padding:10px 16px; border:1px solid #ffffff55;
      border-radius:24px; background:#222; box-shadow:0 2px 12px #0005; }
    #macos-pip-bridge-button[hidden] { display:none !important; }
  `;
  const notice = document.createElement('div');
  notice.id = 'macos-pip-bridge-notice';
  notice.setAttribute('role', 'status');
  notice.style.cssText = 'display:none;position:fixed;right:24px;bottom:80px;max-width:360px;z-index:2147483647;padding:14px;border-radius:12px;background:#222;color:white;font:14px/1.6 system-ui;box-shadow:0 2px 12px #0005';
  document.documentElement.append(style, notice);
  let timer;
  let phase = 'idle';
  let sessionID;
  let videoID;
  let source;
  let handoffState;
  let handedOff = false;
  let lastState;
  let lastStateAt;
  let returnPlay = false;
  let sourcePosition;
  let sourceSettings;
  let pendingSeek;
  let pendingSettings;
  let generation = 0;
  let startReady = Promise.resolve();
  let cancelSourceWait;
  let warmTimer;
  let warmGeneration = 0;
  let warmInFlight = false;
  const wired = new WeakSet();
  function stopWarmTimer() { warmGeneration++; clearTimeout(warmTimer); }
  function releaseWarm() {
    stopWarmTimer();
    button.setAttribute('data-prepared', 'false');
    if (chrome.runtime.id) chrome.runtime.sendMessage({type: 'release-pip'}).catch(() => {});
  }
  async function prepareWarm() {
    if (warmInFlight) return;
    clearTimeout(warmTimer);
    if (!chrome.runtime.id) return;
    const v = tools.video();
    const id = tools.videoID(location.href);
    if (phase !== 'idle' || document.visibilityState !== 'visible' || !document.hasFocus() || !id || !v || v.readyState < 1) {
      releaseWarm(); return;
    }
    if (document.querySelector('.ad-showing')) {
      warmTimer = setTimeout(prepareWarm, 2000); return;
    }
    const attempt = warmGeneration;
    warmInFlight = true;
    let delay = 2000;
    try {
      const result = await chrome.runtime.sendMessage({type: 'prepare-pip', videoID: id, state: tools.snapshot(v)});
      if (!result?.ok) delay = 15000;
    } catch { delay = 15000; }
    finally {
      warmInFlight = false;
      if (attempt === warmGeneration) warmTimer = setTimeout(prepareWarm, delay);
    }
  }
  function hideNotice() { clearTimeout(timer); notice.style.display = 'none'; }
  function show(text) {
    hideNotice();
    notice.textContent = text;
    notice.style.display = 'block';
    timer = setTimeout(hideNotice, 10000);
  }
  function sameVideo() { return chrome.runtime.id && source?.isConnected && tools.videoID(location.href) === videoID && tools.video() === source; }
  function update() {
    const active = phase !== 'idle';
    button.hidden = !active && !tools.videoID(location.href);
    button.setAttribute('aria-pressed', String(active));
    button.setAttribute('data-phase', phase);
    const label = phase === 'waiting' || phase === 'loading' || phase === 'committing' ? 'PiPへの切り替えをキャンセル'
      : phase === 'returning' ? '再生状態を引き継ぎ中'
      : phase === 'active' ? 'Chromeに戻す' : 'macOSのPiPで見る';
    button.textContent = phase === 'waiting' || phase === 'loading' || phase === 'committing' ? '準備中…' : active ? 'Chromeに戻す' : 'macOS PiP';
    button.setAttribute('aria-label', label);
    button.title = `${label}（Option+Shift+P）`;
    button.disabled = phase === 'returning';
  }
  function mount() {
    if (!chrome.runtime.id) return;
    const controls = location.pathname.startsWith('/shorts/')
      ? document.querySelector('ytd-reel-video-renderer[is-active] .ytp-right-controls')
      : document.querySelector('.ytp-right-controls');
    const parent = controls || document.documentElement;
    if (button.parentNode !== parent) parent.append(button);
    button.classList.toggle('macos-pip-floating', !controls);
    update();
  }
  function mirror(state) {
    if (!sameVideo()) return;
    const owns = phase === 'active';
    if (owns) detectControls();
    if (pendingSeek && Math.abs(tools.position(source, state) - tools.position(source, pendingSeek)) < .5) pendingSeek = undefined;
    if (pendingSettings && settingsEqual(state, pendingSettings)) pendingSettings = undefined;
    const target = tools.position(source, state);
    if (!owns || !pendingSeek) {
      if (Math.abs(source.currentTime - target) > .05) source.currentTime = target;
      sourcePosition = source.currentTime;
    }
    if (!owns || !pendingSettings) {
      if (source.volume !== state.volume) source.volume = state.volume;
      if (source.muted !== state.muted) source.muted = state.muted;
      if (source.playbackRate !== state.rate) source.playbackRate = state.rate;
      sourceSettings = {volume: source.volume, muted: source.muted, rate: source.playbackRate};
    }
  }
  async function restore(event) {
    const valid = sameVideo();
    let state = handedOff ? tools.state(event.state) || lastState : handoffState;
    if (state && event.event === 'disconnected' && handedOff && !state.paused && lastStateAt) {
      state = {...state, seconds: state.seconds + Math.max(0, (Date.now() - lastStateAt) / 1000) * state.rate};
    }
    const play = returnPlay;
    sessionID = undefined;
    phase = 'idle';
    handedOff = false;
    handoffState = undefined;
    lastState = undefined;
    returnPlay = false;
    pendingSeek = undefined;
    pendingSettings = undefined;
    update();
    if (valid && state) {
      mirror(state);
      if (event.forcePaused || (state.paused && !play)) source.pause();
      else {
        source.play().catch(() => show('再生位置をChromeへ戻しました。動画の再生ボタンを押すと続きから再開します。'));
      }
    }
    if (event.error) show(event.error);
    warmTimer = setTimeout(prepareWarm, 1500);
  }
  async function send(type, extra = {}) {
    return chrome.runtime.sendMessage({type, sessionID, videoID, ...extra});
  }
  function cancelForNavigation() {
    if (phase === 'idle') { releaseWarm(); mount(); prepareWarm(); return; }
    if (phase === 'waiting' && chrome.runtime.id && tools.videoID(location.href) === videoID) { mount(); return; }
    if (sameVideo()) { mount(); return; }
    generation++;
    cancelSourceWait?.();
    const oldID = sessionID;
    if (oldID) send('cancel-pip').catch(() => {});
    sessionID = undefined;
    phase = 'idle';
    handoffState = undefined;
    handedOff = false;
    source = undefined;
    hideNotice();
    mount();
    prepareWarm();
  }
  function waitForSource() {
    return new Promise((resolve, reject) => {
      let poll;
      const finish = (video, error) => {
        clearTimeout(poll);
        clearTimeout(timeout);
        cancelSourceWait = undefined;
        if (error) reject(error); else resolve(video);
      };
      const timeout = setTimeout(() => finish(null, new Error('動画を読み込めませんでした。Chromeでの再生を確認してください。')), 65000);
      cancelSourceWait = () => finish(null);
      const check = () => {
        if (!chrome.runtime.id || tools.videoID(location.href) !== videoID) { finish(null); return; }
        const video = tools.video();
        if (video?.isConnected && video.readyState >= 1) { finish(video); return; }
        poll = setTimeout(check, 100);
      };
      check();
    });
  }
  async function toggle() {
    if (!chrome.runtime.id) return {ok: false};
    if (phase === 'returning') return {ok: true};
    if (phase === 'waiting') {
      generation++;
      cancelSourceWait?.();
      phase = 'idle'; update();
      warmTimer = setTimeout(prepareWarm, 1500);
      return {ok: true};
    }
    if (phase === 'loading' && !sessionID) { await startReady; return phase === 'loading' && sessionID ? toggle() : {ok: true}; }
    stopWarmTimer();
    hideNotice();
    if (sessionID) {
      const type = phase === 'loading' ? 'cancel-pip' : 'return-pip';
      phase = 'returning'; update();
      try {
        const response = await send(type);
        if (!response?.ok) throw new Error('Session ended');
      }
      catch { await restore({event: 'disconnected', error: 'アプリとの接続が切れたためChromeへ戻しました。'}); }
      return {ok: true};
    }
    videoID = tools.videoID(location.href);
    source = tools.video();
    if (!videoID) { show('YouTubeの動画ページを開いてください。'); return {ok: false}; }
    if (document.querySelector('.ad-showing')) { show('Chromeの広告が終了してからPiPを開始してください。'); return {ok: false}; }
    phase = !source || source.readyState === 0 ? 'waiting' : 'loading';
    button.setAttribute('data-prepared', 'false');
    const attempt = ++generation;
    const requestedID = videoID;
    handoffState = undefined;
    handedOff = false;
    returnPlay = false;
    update();
    let resolveStart;
    startReady = new Promise(resolve => { resolveStart = resolve; });
    try {
      const readySource = phase === 'waiting' ? await waitForSource() : source;
      if (attempt !== generation) return {ok: false};
      source = readySource;
      if (!source) { phase = 'idle'; update(); return {ok: false}; }
      if (document.querySelector('.ad-showing')) throw new Error('Chromeの広告が終了してからPiPを開始してください。');
      phase = 'loading';
      wire(source);
      update();
      const response = await send('start-pip', {state: tools.snapshot(source)});
      if (!response?.ok) throw new Error(response?.error || 'アプリに接続できませんでした。');
      if (attempt !== generation) {
        chrome.runtime.sendMessage({type: 'cancel-pip', sessionID: response.sessionID, videoID: requestedID}).catch(() => {});
        return {ok: false};
      }
      sessionID = response.sessionID;
      if (!sameVideo()) cancelForNavigation();
      return {ok: true};
    } catch (error) {
      if (attempt === generation) { phase = 'idle'; update(); show(error.message); }
      return {ok: false};
    } finally { resolveStart(); }
  }
  function control(action, state = tools.snapshot(source)) {
    if (!sessionID || phase !== 'active' || !sameVideo()) return;
    send('control-pip', {action, state}).then(response => {
      if (!response?.ok) restore({event: 'disconnected', error: '接続が切れたためChromeへ戻しました。'});
    }).catch(() => restore({event: 'disconnected', error: '接続が切れたためChromeへ戻しました。'}));
  }
  function settingsEqual(a, b) { return a.volume === b.volume && a.muted === b.muted && a.rate === b.rate; }
  function detectControls() {
    if (phase !== 'active' || !sameVideo()) return;
    const local = tools.snapshot(source);
    if (sourcePosition != null && Math.abs(source.currentTime - sourcePosition) > .05) {
      pendingSeek = local;
      sourcePosition = source.currentTime;
      control('seek', local);
    }
    if (sourceSettings && !settingsEqual(local, sourceSettings)) {
      pendingSettings = local;
      sourceSettings = local;
      control('settings', local);
    }
  }
  function wire(v) {
    if (wired.has(v)) return;
    wired.add(v);
    v.addEventListener('play', () => {
      if (phase !== 'active' || !sameVideo()) return;
      v.pause();
      returnPlay = true;
      toggle();
    });
    for (const event of ['seeking', 'seeked', 'volumechange', 'ratechange']) v.addEventListener(event, detectControls);
  }
  async function handle(event) {
    await startReady;
    if (!sessionID || event.sessionID !== sessionID || event.videoID !== videoID) return {ok: false};
    if (!sameVideo()) { cancelForNavigation(); return {ok: false}; }
    switch (event.event) {
      case 'loading':
        button.title = String(event.message || 'macOS PiPを準備中…').slice(0, 300);
        return {ok: true};
      case 'ready': {
        if (phase !== 'loading' || document.querySelector('.ad-showing')) return {ok: false};
        handoffState = tools.snapshot(source);
        sourcePosition = source.currentTime;
        sourceSettings = handoffState;
        pendingSeek = undefined;
        pendingSettings = undefined;
        lastState = handoffState;
        lastStateAt = Date.now();
        source.pause();
        phase = 'committing'; update();
        return {ok: true, state: handoffState};
      }
      case 'active':
      case 'state': {
        const state = tools.state(event.state);
        if (!state) return {ok: false};
        if (event.event === 'active') { phase = 'active'; handedOff = true; }
        lastState = state;
        lastStateAt = Date.now();
        mirror(state);
        update();
        return {ok: true};
      }
      case 'returned':
      case 'disconnected': await restore(event); return {ok: true};
      default: return {ok: false};
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'pip-warm' && message.videoID === tools.videoID(location.href)) {
      button.setAttribute('data-prepared', String(phase === 'idle' && message.ready === true));
      respond({ok: true}); return;
    }
    if (message?.type === 'toggle-pip') { toggle().then(respond); return true; }
    if (message?.type === 'pip-event') { handle(message).then(respond).catch(() => respond({ok: false})); return true; }
  });
  button.addEventListener('click', event => { event.stopPropagation(); toggle(); });
  document.addEventListener('yt-navigate-finish', cancelForNavigation);
  addEventListener('popstate', cancelForNavigation);
  addEventListener('pagehide', () => {
    generation++;
    cancelSourceWait?.();
    if (phase === 'waiting') { phase = 'idle'; update(); }
    releaseWarm();
    if (sessionID) send('cancel-pip').catch(() => {});
  });
  addEventListener('focus', () => { if (phase === 'active' && lastState) mirror(lastState); else prepareWarm(); });
  addEventListener('blur', () => { clearTimeout(warmTimer); warmTimer = setTimeout(prepareWarm, 1000); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseWarm(); else prepareWarm();
  });
  document.addEventListener('loadeddata', prepareWarm, true);
  const observer = new MutationObserver(records => {
    if (!chrome.runtime.id) { observer.disconnect(); return; }
    if (!button.isConnected) { mount(); return; }
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && (node.matches('.ytp-right-controls') || node.querySelector('.ytp-right-controls'))) { mount(); return; }
      }
    }
  });
  observer.observe(document.documentElement, {childList: true, subtree: true});
  globalThis.macPiPBridge = {mount};
  mount();
  prepareWarm();
})();
