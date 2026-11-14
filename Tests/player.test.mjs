import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../Sources/player.js', import.meta.url), 'utf8');
const desired = changes => ({seconds: 20, paused: false, volume: .4, muted: false, rate: 1.25, ...changes});
function player({ad = false, ready = 4, live = false} = {}) {
  let advertising = ad;
  let now = 2000;
  const events = new Map();
  const reports = [];
  const observers = [];
  const parent = {};
  const v = {currentTime: 0, paused: true, muted: false, volume: 1, playbackRate: 1,
    readyState: ready, duration: live ? Infinity : 120, webkitPresentationMode: 'inline',
    seekable: {length: live ? 1 : 0, start() { return 50; }, end() { return 100; }},
    closest() { return parent; },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
    emit(name) { for (const fn of events.get(name) || []) fn(); },
    async play() { this.paused = false; this.emit('play'); this.emit('playing'); },
    pause() { this.paused = true; this.emit('pause'); },
    webkitSupportsPresentationMode() { return true; },
    webkitSetPresentationMode(mode) { this.webkitPresentationMode = mode; this.emit('webkitpresentationmodechanged'); }
  };
  const context = vm.createContext({
    URL, location: new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    window: {webkit: {messageHandlers: {pipStatus: {postMessage(message) { reports.push(JSON.parse(JSON.stringify(message))); }}}}},
    performance: {now() { return now; }},
    document: {
      querySelector(selector) { return selector === '.ad-showing' ? (advertising ? {} : null) : v; },
      addEventListener() {}
    },
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe() {} disconnect() {} },
    addEventListener() {},
    setInterval() { throw new Error('Player must not poll'); },
    setTimeout() { throw new Error('Player must not require a timer or another click'); }
  });
  vm.runInContext(source, context);
  return {video: v, api: context.macPiP, reports, location: context.location,
    ad(value) { advertising = value; for (const observer of observers.slice(1)) observer.fn([]); },
    advance() { now += 1100; v.emit('timeupdate'); }};
}

test('player requests native-context PiP entry automatically and stays silent until Chrome commits', async () => {
  const p = player();
  p.api.start(desired());
  assert.equal(p.reports.at(-1).type, 'can-enter');
  assert.equal(p.video.currentTime, 20);
  assert.equal(p.video.muted, true);
  await p.api.enter();
  assert.equal(p.reports.at(-1).type, 'ready');
  assert.equal(p.reports.at(-1).mode, 'picture-in-picture');
  assert.equal(p.video.paused, false, 'the muted decoder stays running across the ready/commit handshake');
  assert.equal(p.video.muted, true);
  await p.api.commit(desired({seconds: 23}));
  assert.equal(p.video.currentTime, 23);
  assert.equal(p.video.paused, false);
  assert.equal(p.video.muted, false);
  assert.equal(p.reports.at(-1).type, 'active');
});

test('waiting for metadata and advertisements never applies the content seek to an advertisement', () => {
  const p = player({ad: true, ready: 0});
  p.api.start(desired());
  assert.equal(p.video.currentTime, 0);
  assert.equal(p.reports.length, 0);
  p.video.readyState = 4; p.video.emit('canplay');
  assert.equal(p.video.currentTime, 0);
  p.ad(false);
  assert.equal(p.video.currentTime, 20);
  assert.equal(p.reports.at(-1).type, 'can-enter');
});

test('Chrome settings survive YouTube restoring its saved mute and volume during play()', async () => {
  const p = player(); p.api.start(desired()); await p.api.enter();
  const play = p.video.play.bind(p.video);
  p.video.play = async () => { await play(); p.video.muted = true; p.video.volume = 0; };
  await p.api.commit(desired({volume: .65, muted: false}));
  assert.equal(p.reports.at(-1).type, 'active');
  assert.equal(p.reports.at(-1).state.muted, false);
  assert.equal(p.reports.at(-1).state.volume, .65);
});

test('closing native PiP returns the current state before stopping WebKit playback', async () => {
  const p = player(); p.api.start(desired()); await p.api.enter(); await p.api.commit(desired());
  p.video.currentTime = 42;
  p.video.webkitSetPresentationMode('inline');
  const returned = p.reports.at(-1);
  assert.equal(returned.type, 'returned');
  assert.equal(returned.state.seconds, 42);
  assert.equal(returned.state.paused, false);
  assert.equal(p.video.paused, true);
});

test('returning during an advertisement uses the latest content position, not the initial handoff or ad time', async () => {
  const p = player(); p.api.start(desired()); await p.api.enter(); await p.api.commit(desired());
  p.video.currentTime = 55; p.advance();
  p.ad(true); p.video.currentTime = 1;
  p.api.finish();
  assert.equal(p.reports.at(-1).state.seconds, 55);
  assert.equal(p.reports.at(-1).state.muted, false);
});

test('live DVR positions are relative to the live edge and paused state survives commit', async () => {
  const p = player({live: true});
  p.api.start(desired({liveOffset: 8}));
  assert.equal(p.video.currentTime, 92);
  await p.api.enter(); await p.api.commit(desired({paused: true, liveOffset: 5}));
  assert.equal(p.video.currentTime, 95);
  assert.equal(p.video.paused, true);
  assert.equal(p.reports.at(-1).state.liveOffset, 5);
});

test('autoplay navigation reusing the same video element returns the previous content position', async () => {
  const p = player();
  p.api.start(desired(), 'dQw4w9WgXcQ'); await p.api.enter(); await p.api.commit(desired());
  p.video.currentTime = 90; p.advance();
  p.location.href = 'https://www.youtube.com/watch?v=abcdefghijk';
  p.video.currentTime = 1; p.advance();
  assert.equal(p.reports.at(-1).type, 'returned');
  assert.equal(p.reports.at(-1).state.seconds, 90);
});

test('preparation loads and pauses media silently; only activation can open PiP', async () => {
  const p = player();
  p.api.start(desired(), 'dQw4w9WgXcQ', true);
  assert.equal(p.reports.at(-1).type, 'prepared');
  assert.equal(p.reports.some(event => event.type === 'can-enter'), false);
  assert.equal(p.video.webkitPresentationMode, 'inline');
  assert.equal(p.video.paused, true);
  assert.equal(p.video.muted, true);
  p.video.muted = false; p.video.emit('volumechange');
  assert.equal(p.video.muted, true, 'YouTube restoring saved settings must not produce a second audio stream');
  await p.video.play();
  assert.equal(p.video.paused, true, 'speculative content must stay paused if YouTube autoplays');
  p.api.prepare(desired({seconds: 25}));
  assert.equal(p.video.currentTime, 25);
  assert.equal(p.video.muted, true);
  p.api.activate(desired({seconds: 27}));
  assert.equal(p.reports.at(-1).type, 'can-enter');
  await p.api.enter();
  assert.equal(p.reports.at(-1).type, 'ready');
  assert.equal(p.video.muted, true);
  await p.api.commit(desired({seconds: 28}));
  assert.equal(p.video.currentTime, 28);
  assert.equal(p.video.muted, false);
});

test('metadata is enough to seek ahead while media is still buffering', () => {
  const p = player({ready: 1});
  p.api.start(desired());
  assert.equal(p.video.currentTime, 20);
  assert.equal(p.reports.length, 0);
  p.video.readyState = 2;
  p.video.emit('loadeddata');
  assert.equal(p.reports.at(-1).type, 'can-enter');
});


test('warm loading allows silent playback until a frame is available', async () => {
  const p = player({ready: 1});
  p.api.start(desired(), 'dQw4w9WgXcQ', true);
  await p.video.play();
  assert.equal(p.video.paused, false);
  assert.equal(p.video.muted, true);
  p.video.readyState = 2;
  p.video.emit('seeked');
  assert.equal(p.reports.at(-1).type, 'prepared');
  assert.equal(p.video.paused, true);
});

test('activation resumes after a seek completes without another canplay event', () => {
  const p = player();
  p.api.start(desired(), 'dQw4w9WgXcQ', true);
  p.video.readyState = 1;
  p.api.activate(desired({seconds: 40}));
  p.video.readyState = 2;
  p.video.emit('seeked');
  assert.equal(p.reports.at(-1).type, 'can-enter');
});

test('warm activation reuses a nearby decoded frame instead of starting a blocking seek', async () => {
  const p = player();
  p.api.start(desired(), 'dQw4w9WgXcQ', true);
  let position = p.video.currentTime;
  let seeks = 0;
  Object.defineProperty(p.video, 'currentTime', {
    get() { return position; },
    set(value) { position = value; seeks++; p.video.readyState = 1; }
  });
  p.api.activate(desired({seconds: 24}));
  assert.equal(seeks, 0, 'the warm frame must survive until presentation');
  assert.equal(p.reports.at(-1).type, 'can-enter');
  await p.api.enter();
  assert.equal(p.reports.at(-1).type, 'ready');
  assert.equal(p.video.muted, true);
  await p.api.commit(desired({seconds: 24.5, paused: true}));
  assert.equal(seeks, 1);
  assert.equal(p.reports.at(-1).state.seconds, 24.5);
  assert.equal(p.reports.at(-1).state.paused, true);
});

test('large position changes still seek before opening PiP', () => {
  const p = player();
  p.api.start(desired(), 'dQw4w9WgXcQ', true);
  p.api.activate(desired({seconds: 70}));
  assert.equal(p.video.currentTime, 70);
});

test('a warm player still seeking must not reuse its previous frame', () => {
  const p = player();
  p.api.start(desired(), 'dQw4w9WgXcQ', true);
  p.video.seeking = true;
  p.video.readyState = 1;
  p.api.activate(desired({seconds: 24}));
  assert.equal(p.video.currentTime, 24);
  assert.equal(p.reports.some(event => event.type === 'can-enter'), false);
  p.video.seeking = false;
  p.video.readyState = 2;
  p.video.emit('seeked');
  assert.equal(p.reports.at(-1).type, 'can-enter');
});

test('warm live playback uses edge offset for frame reuse and applies the latest offset on commit', async () => {
  const p = player({live: true});
  p.api.start(desired({liveOffset: 8}), 'dQw4w9WgXcQ', true);
  p.api.activate(desired({seconds: 200, liveOffset: 5}));
  assert.equal(p.video.currentTime, 92);
  await p.api.enter();
  await p.api.commit(desired({seconds: 201, liveOffset: 4}));
  assert.equal(p.reports.at(-1).state.liveOffset, 4);
});

test('PiP entry does not wait for play buffering and a paused commit may abort that play', async () => {
  const p = player();
  p.api.start(desired());
  let rejectPlay;
  p.video.play = () => new Promise((resolve, reject) => { rejectPlay = reject; });
  p.api.enter();
  assert.equal(p.reports.at(-1).type, 'ready', 'request presentation while play is still pending');
  await p.api.commit(desired({paused: true}));
  rejectPlay({name: 'AbortError'});
  await Promise.resolve();
  assert.equal(p.reports.at(-1).type, 'active');
  assert.equal(p.reports.at(-1).state.paused, true);
});

test('play rejection is reported and cancellation suppresses a late rejection', async () => {
  for (const cancel of [false, true]) {
    const p = player();
    p.api.start(desired());
    let rejectPlay;
    p.video.play = () => new Promise((resolve, reject) => { rejectPlay = reject; });
    p.api.enter();
    if (cancel) p.api.finish();
    rejectPlay({name: 'NotAllowedError'});
    await Promise.resolve();
    assert.equal(p.reports.at(-1).type, cancel ? 'returned' : 'error');
  }
});
