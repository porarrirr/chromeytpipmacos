import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const app = process.env.PIP_PLAYER || fileURLToPath(new URL('../build/YouTube macOS PiP.app/Contents/MacOS/YouTubeMacPiP', import.meta.url));
const child = spawn(app, ['--native-host']);
const sessionID = randomUUID();
const state = {seconds: 12, paused: false, volume: .25, muted: false, rate: 1};
let buffer = Buffer.alloc(0);
let active = false;
let returned = false;
let failure;
let stopTimer;
const holdMS = Number(process.env.PIP_HOLD_MS || 2500);
assert.ok(Number.isFinite(holdMS) && holdMS >= 0 && holdMS <= 120000);
const send = message => {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));
};
child.stdin.on('error', () => {});
child.stderr.on('data', bytes => process.stderr.write(bytes));
child.stdout.on('data', bytes => {
  buffer = Buffer.concat([buffer, bytes]);
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
    const size = buffer.readUInt32LE();
    const event = JSON.parse(buffer.subarray(4, size + 4));
    buffer = buffer.subarray(size + 4);
    if (event.type !== 'state') console.log(JSON.stringify(event));
    if (event.type === 'prepared') send({type: 'start', sessionID, videoID: process.argv[2] || 'dQw4w9WgXcQ', state: {...state, seconds: 20}});
    if (event.type === 'ready') {
      assert.equal(event.mode, 'picture-in-picture');
      assert.equal(event.presentation?.visible, true);
      const physical = spawnSync(fileURLToPath(new URL('../build/window-check', import.meta.url)),
        [String(event.presentation.ownerPID), String(event.presentation.windowNumber)], {encoding: 'utf8'});
      assert.equal(physical.status, 0, physical.stderr);
      send({type: 'commit', sessionID, state});
    }
    if (event.type === 'active') {
      active = true;
      assert.equal(event.mode, 'picture-in-picture');
      assert.equal(event.state.muted, state.muted);
      assert.equal(event.state.volume, state.volume);
      stopTimer = setTimeout(() => send({type: 'return', sessionID}), holdMS);
    }
    if (event.type === 'returned') {
      returned = event.state.seconds >= 12 && event.state.paused === false;
    }
    if (event.type === 'error') failure = event.error;
  }
});
const deadline = setTimeout(() => { failure = 'YouTube native PiP timed out'; child.kill('SIGTERM'); }, 65000 + holdMS);
try {
  send({type: process.env.PIP_WARM === '1' ? 'prepare' : 'start', sessionID, videoID: process.argv[2] || 'dQw4w9WgXcQ', state});
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, failure);
  assert.ok(active && returned, failure || 'YouTube did not complete native PiP entry and state return');
  console.log('PASS: real YouTube → automatic macOS WebKit PiP → playing state and position returned.');
} finally {
  clearTimeout(deadline); clearTimeout(stopTimer); child.kill('SIGTERM');
}
