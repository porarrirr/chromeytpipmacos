var macPiPTools = {
  visiblePresentation(value) {
    return value?.visible === true && value.onActiveSpace === true
      && Number.isInteger(value.ownerPID) && value.ownerPID > 0
      && ['system-agent', 'application'].includes(value.backend) && Number.isInteger(value.windowNumber) && value.windowNumber > 0
      && Number.isInteger(value.level) && value.level >= 3;
  },
  videoID(raw) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || !['www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
      const id = url.pathname === '/watch' ? url.searchParams.get('v')
        : url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})(?:\/|$)/)?.[1];
      return /^[\w-]{11}$/.test(id || '') ? id : null;
    } catch { return null; }
  },
  state(value) {
    if (!value || !Number.isFinite(value.seconds) || value.seconds < 0 || value.seconds > 31536000
      || typeof value.paused !== 'boolean' || typeof value.muted !== 'boolean'
      || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1
      || !Number.isFinite(value.rate) || value.rate < .0625 || value.rate > 16
      || (value.liveOffset != null && (!Number.isFinite(value.liveOffset) || value.liveOffset < 0 || value.liveOffset > 31536000))) return null;
    const state = {seconds: value.seconds, paused: value.paused, volume: value.volume, muted: value.muted, rate: value.rate};
    if (value.liveOffset != null) state.liveOffset = value.liveOffset;
    return state;
  },
  video() {
    return document.querySelector('ytd-reel-video-renderer[is-active] video')
      || document.querySelector('#movie_player video.html5-main-video')
      || document.querySelector('video.html5-main-video') || document.querySelector('video');
  },
  snapshot(video) {
    const state = {seconds: Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0,
      paused: video.paused, volume: video.volume, muted: video.muted, rate: video.playbackRate};
    if (!Number.isFinite(video.duration) && video.seekable.length) state.liveOffset = Math.max(0, video.seekable.end(video.seekable.length - 1) - video.currentTime);
    return state;
  },
  position(video, state) {
    let target = state.seconds;
    if (state.liveOffset != null && video.seekable.length) target = video.seekable.end(video.seekable.length - 1) - state.liveOffset;
    if (video.seekable.length) target = Math.max(video.seekable.start(0), Math.min(target, video.seekable.end(video.seekable.length - 1)));
    else if (Number.isFinite(video.duration)) target = Math.min(target, Math.max(0, video.duration - .05));
    return Math.max(0, target);
  }
};
