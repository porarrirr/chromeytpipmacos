import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';

const directory = mkdtempSync(join(tmpdir(), 'macos-pip-smoke-'));
const executable = fileURLToPath(new URL('../build/YouTube macOS PiP.app/Contents/MacOS/YouTubeMacPiP', import.meta.url));
const children = new Set();
const timers = new Set();
let slowServer;
const frame = message => {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
function connect(page) {
  const trace = process.argv.includes('--trace-startup');
  const child = spawn(executable, ['--native-host', '--test-page', page, ...(trace ? ['--trace-startup'] : [])]);
  children.add(child);
  let buffer = Buffer.alloc(0);
  let errors = '';
  const inbox = [];
  const waiting = [];
  child.stderr.on('data', bytes => { errors += bytes; if (trace) process.stderr.write(bytes); });
  child.stdout.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE();
      assert.ok(size > 0 && size < 1_048_576);
      if (buffer.length < size + 4) break;
      const event = JSON.parse(buffer.subarray(4, size + 4));
      buffer = buffer.subarray(size + 4);
      console.log('Native:', JSON.stringify(event));
      inbox.push(event);
      for (const wake of [...waiting]) wake();
    }
  });
  const receive = (type, timeout = 20000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout waiting for ${type}. ${errors}`)); }, timeout);
    timers.add(timer);
    const cleanup = () => { clearTimeout(timer); timers.delete(timer); const i = waiting.indexOf(check); if (i >= 0) waiting.splice(i, 1); };
    const check = () => {
      const error = inbox.find(event => event.type === 'error');
      const index = inbox.findIndex(event => event.type === type);
      if (index >= 0) { const [event] = inbox.splice(index, 1); cleanup(); resolve(event); }
      else if (error) { cleanup(); reject(new Error(JSON.stringify(error))); }
    };
    waiting.push(check); check();
  });
  const exited = once(child, 'exit').then(result => { children.delete(child); return result; });
  return {child, receive, exited, send(message) { child.stdin.write(frame(message)); }};
}
function verifyClosed(presentation) {
  const visible = spawnSync(fileURLToPath(new URL('../build/window-check', import.meta.url)),
    [String(presentation.ownerPID), String(presentation.windowNumber)], {encoding: 'utf8'});
  assert.equal(visible.status, 1, 'The completed shutdown must remove the actual PiP window');
  if (presentation.backend === 'system-agent') {
    assert.doesNotThrow(() => process.kill(presentation.ownerPID, 0),
      'Closing this player must not crash the system PIPAgent and break the next PiP');
  }
}
try {
  const videoPath = join(directory, 'video.mp4');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=24',
    '-t', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], {encoding: 'utf8'});
  assert.equal(generated.status, 0, generated.stderr);
  const page = join(directory, 'index.html');
  writeFileSync(page, '<!doctype html><video src="video.mp4" controls loop style="width:100%"></video>');
  for (const paused of [true, false]) {
    const host = connect(page);
    const sessionID = randomUUID();
    const state = {seconds: 3.5, paused, volume: .35, muted: false, rate: 1.25};
    host.send({type: 'start', sessionID, videoID: 'abcdefghijk', state});
    await host.receive('loading');
    const ready = await host.receive('ready');
    assert.equal(ready.mode, 'picture-in-picture');
    assert.equal(ready.presentation.visible, true);
    const visible = spawnSync(fileURLToPath(new URL('../build/window-check', import.meta.url)), [String(ready.presentation.ownerPID), String(ready.presentation.windowNumber)], {encoding: 'utf8'});
    assert.equal(visible.status, 0, visible.stderr);
    console.log('WindowServer PiP visibility:', visible.stdout.trim());
    assert.equal(ready.state.muted, true, 'Chrome keeps playing until this player is ready; native video must be silent');
    host.send({type: 'commit', sessionID, state: {...state, seconds: 5.25}});
    const active = await host.receive('active');
    assert.equal(active.mode, 'picture-in-picture');
    assert.equal(active.state.paused, paused);
    assert.equal(active.state.muted, false);
    assert.equal(active.state.volume, .35);
    assert.equal(active.state.rate, 1.25);
    assert.ok(Math.abs(active.state.seconds - 5.25) < .3);
    host.send({type: 'control', sessionID, action: 'seek', state: {...state, seconds: 9.75}});
    let updated;
    do { updated = await host.receive('state'); } while (updated.state.seconds < 9.5);
    host.send({type: 'control', sessionID, action: 'settings', state: {...state, volume: .6, rate: 1.5}});
    do { updated = await host.receive('state'); } while (updated.state.rate !== 1.5);
    assert.equal(updated.state.volume, .6);
    host.send({type: 'return', sessionID});
    const returned = await host.receive('returned');
    assert.equal(returned.state.paused, paused);
    assert.equal(returned.state.rate, 1.5);
    assert.ok(returned.state.seconds >= 9.5);
    const [code] = await host.exited;
    assert.equal(code, 0);
    verifyClosed(ready.presentation);
    console.log(`Native macOS PiP ${paused ? 'paused' : 'playing'}: automatic hidden-window entry, commit, seek/settings and return passed.`);
  }
  for (const termination of ['pipe-close', 'SIGTERM']) {
    const host = connect(page);
    const sessionID = randomUUID();
    const state = {seconds: 3.5, paused: false, volume: .35, muted: false, rate: 1};
    host.send({type: 'start', sessionID, videoID: 'abcdefghijk', state});
    const ready = await host.receive('ready');
    host.send({type: 'commit', sessionID, state});
    await host.receive('active');
    const timer = setTimeout(() => host.child.kill('SIGKILL'), 8000);
    try {
      if (termination === 'pipe-close') host.child.stdin.end();
      else host.child.kill('SIGTERM');
      assert.equal((await host.exited)[0], 0, `${termination} must close WebKit gracefully`);
      verifyClosed(ready.presentation);
      console.log(`Native active PiP ${termination}: actual window closed, system PIPAgent survived.`);
    } finally { clearTimeout(timer); }
  }
  let imageResponse;
  slowServer = createServer((request, response) => { imageResponse = response; });
  await new Promise(resolve => slowServer.listen(0, '127.0.0.1', resolve));
  const address = slowServer.address();
  assert.equal(address.address, '127.0.0.1');
  const delayedPage = join(directory, 'delayed.html');
  writeFileSync(delayedPage, `<!doctype html><video src="video.mp4" controls loop></video><img src="http://127.0.0.1:${address.port}/pending.png">`);
  const host = connect(delayedPage);
  const sessionID = randomUUID();
  const state = {seconds: 3.5, paused: false, volume: .35, muted: false, rate: 1.25};
  host.send({type: 'start', sessionID, videoID: 'abcdefghijk', state});
  const ready = await host.receive('ready');
  assert.equal(ready.mode, 'picture-in-picture');
  assert.ok(imageResponse && !imageResponse.writableEnded, 'PiP must open while the image is still loading');
  host.send({type: 'commit', sessionID, state});
  await host.receive('active');
  host.send({type: 'return', sessionID});
  await host.receive('returned');
  assert.equal((await host.exited)[0], 0);
  verifyClosed(ready.presentation);
  console.log('PiP starts before the page finishes loading an unrelated resource: passed.');
} finally {
  if (slowServer) { slowServer.closeAllConnections(); await new Promise(resolve => slowServer.close(resolve)); }
  for (const timer of timers) clearTimeout(timer);
  await Promise.all([...children].map(async child => { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }));
  rmSync(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
}
