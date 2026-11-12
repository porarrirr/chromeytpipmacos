(() => {
  const report = message => window.webkit.messageHandlers.pipStatus.postMessage(message);
  let desired;
  let expectedID;
  let current;
  let active = false;
  let committed = false;
  let applying = false;
  let entering = false;
  let finishing = false;
  let requested = true;
  let prepared = false;
  let positionApplied = false;
  let lastReport = 0;
  let lastContentState;
  let observedPlayer;
  let adObserver;
  const wired = new WeakSet();
  const video = () => document.querySelector('video.html5-main-video') || document.querySelector('video');
  const ad = () => Boolean(document.querySelector('.ad-showing'));
  function sameContent() {
    if (!expectedID || !['www.youtube.com', 'm.youtube.com'].includes(location.hostname)) return true;
    const url = new URL(location.href);
    const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/)?.[1];
    return id === expectedID;
  }
  function snapshot(v) {
    const state = {seconds: Number.isFinite(v.currentTime) ? Math.max(0, v.currentTime) : 0,
      paused: v.paused, volume: v.volume, muted: v.muted, rate: v.playbackRate};
    if (!Number.isFinite(v.duration) && v.seekable.length) state.liveOffset = Math.max(0, v.seekable.end(v.seekable.length - 1) - v.currentTime);
    return state;
  }
  function emit(type, v = current, extra = {}) {
    report({type, ...(v ? {state: snapshot(v)} : {}), ...extra});
  }
  function position(v, state) {
    if (v.readyState < 1 || ad()) return false;
    let target = state.seconds;
    if (typeof state.liveOffset === 'number') {
      if (!v.seekable.length) return false;
      target = v.seekable.end(v.seekable.length - 1) - state.liveOffset;
    }
    if (v.seekable.length) target = Math.max(v.seekable.start(0), Math.min(target, v.seekable.end(v.seekable.length - 1)));
    else if (Number.isFinite(v.duration)) target = Math.min(target, Math.max(0, v.duration - .05));
    target = Math.max(0, target);
    if (Math.abs(v.currentTime - target) > .05) v.currentTime = target;
    return true;
  }
  function settings(v, state, silent = false) {
    v.volume = state.volume;
    v.playbackRate = state.rate;
    v.muted = silent || state.muted;
  }
  function stateChanged(v, immediate = true) {
    if (!committed || finishing || applying || ad()) return;
    if (!sameContent()) return finish('動画が切り替わったためChromeへ戻しました。', true);
    lastContentState = snapshot(v);
    const now = performance.now();
    if (immediate || now - lastReport >= 1000) { lastReport = now; emit('state', v); }
  }
  function tryStart() {
    const v = current;
    if (!desired || !v || finishing || active || entering || ad() || v.readyState < 1) return;
    if (!sameContent()) return finish('動画が切り替わったためPiPの準備を中止しました。', true);
    if (!positionApplied) {
      applying = true;
      try { positionApplied = position(v, desired); settings(v, desired, true); }
      finally { applying = false; }
      if (!positionApplied) return;
    }
    if (v.readyState < 2) return;
    if (!requested) {
      v.pause();
      if (!prepared) { prepared = true; emit('prepared', v); }
      return;
    }
    entering = true;
    emit('can-enter', v);
  }
  function refresh() {
    if (committed && !sameContent()) return finish('動画が切り替わったためChromeへ戻しました。', true);
    const v = video();
    if (!v || finishing) return;
    if (v !== current) {
      if (committed) return finish('動画が切り替わったためChromeへ戻しました。');
      current = v;
      positionApplied = false;
    }
    if (!wired.has(v)) {
      wired.add(v);
      for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'durationchange', 'progress', 'playing', 'seeked']) v.addEventListener(name, tryStart);
      for (const name of ['pause', 'play', 'seeked', 'ratechange', 'volumechange', 'ended']) v.addEventListener(name, () => {
        if (!committed && !applying && !finishing) {
          if (!v.muted) v.muted = true;
          if (!requested && prepared && !ad() && !v.paused) v.pause();
        }
        stateChanged(v);
      });
      v.addEventListener('timeupdate', () => stateChanged(v, false));
      v.addEventListener('error', () => { if (!finishing) emit('error', v, {error: '動画を読み込めませんでした。Chromeでの再生を続けてください。'}); });
      v.addEventListener('webkitpresentationmodechanged', () => {
        const pip = v.webkitPresentationMode === 'picture-in-picture';
        if (pip && !active && !finishing) {
          active = true;
          entering = false;
          emit('ready', v, {mode: v.webkitPresentationMode});
        } else if (!pip && active && !finishing) finish();
      });
    }
    const player = v.closest('.html5-video-player');
    if (player && observedPlayer !== player) {
      adObserver?.disconnect();
      observedPlayer = player;
      adObserver = new MutationObserver(() => {
        if (ad()) { v.muted = true; emit('loading', v, {message: '広告の終了を待っています。Chromeでは再生を続けられます。'}); }
        else if (committed) { applying = true; settings(v, desired); applying = false; stateChanged(v); }
        else tryStart();
      });
      adObserver.observe(player, {attributes: true, attributeFilter: ['class']});
    }
    if (!committed) v.muted = true;
    tryStart();
  }
  async function enter() {
    const v = current;
    if (!v || finishing || !entering) return;
    if (typeof v.webkitSetPresentationMode !== 'function' || !v.webkitSupportsPresentationMode?.('picture-in-picture')) {
      entering = false;
      emit('error', v, {error: 'この動画ではmacOSのPiPを開始できませんでした。'});
      return;
    }
    try {
      await v.play();
      if (finishing) return;
      v.webkitSetPresentationMode('picture-in-picture');
    } catch { emit('error', v, {error: 'macOSのPiPを開始できませんでした。'}); }
  }
  async function commit(state) {
    if (!active || finishing || !current) return;
    desired = state;
    applying = true;
    try {
      position(current, state);
      settings(current, state);
      if (state.paused) current.pause(); else await current.play();
      if (finishing) return;
      settings(current, state);
      committed = true;
    } finally { applying = false; }
    emit('active', current, {mode: current.webkitPresentationMode});
    lastContentState = snapshot(current);
  }
  function control(action, state) {
    if (!committed || finishing || !current) return;
    applying = true;
    try {
      if (action === 'seek') position(current, state);
      if (action === 'settings') settings(current, state);
      desired = {...desired, ...snapshot(current)};
    } finally { applying = false; }
    emit('state');
    lastContentState = snapshot(current);
  }
  function finish(message, useLastContent = false) {
    if (finishing) return;
    finishing = true;
    const state = !useLastContent && current && !ad() ? snapshot(current) : lastContentState || desired;
    current?.pause();
    try { if (current?.webkitPresentationMode === 'picture-in-picture') current.webkitSetPresentationMode('inline'); } catch {}
    report({type: 'returned', state, ...(message ? {message} : {})});
  }
  globalThis.macPiP = {
    start(state, videoID, warm = false) { desired = state; expectedID = videoID; requested = !warm; refresh(); },
    prepare(state) {
      if (requested || finishing) return;
      desired = state;
      positionApplied = false;
      prepared = false;
      refresh();
    },
    activate(state) {
      if (requested || finishing) return;
      requested = true;
      desired = state;
      positionApplied = false;
      refresh();
    }, enter, commit, control,
    finish, snapshot() { return current ? snapshot(current) : desired; }
  };
  const observer = new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && (node.matches('video') || node.querySelector('video'))))) refresh();
  });
  observer.observe(document, {childList: true, subtree: true});
  document.addEventListener('yt-navigate-finish', refresh);
  addEventListener('pagehide', () => { observer.disconnect(); adObserver?.disconnect(); }, {once: true});
  refresh();
})();
