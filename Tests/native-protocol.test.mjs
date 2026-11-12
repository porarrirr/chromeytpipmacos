import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const host = fileURLToPath(new URL('../build/YouTube macOS PiP.app/Contents/MacOS/PiPBridge', import.meta.url));
const frame = object => {
  const body = Buffer.from(JSON.stringify(object));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
async function run(bytes) {
  const child = spawn(host);
  let output = Buffer.alloc(0);
  child.stdout.on('data', data => { output = Buffer.concat([output, data]); });
  child.stdin.on('error', () => {});
  child.stdin.write(bytes);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(output.readUInt32LE(), output.length - 4);
    return JSON.parse(output.subarray(4));
  } finally { clearTimeout(timer); child.kill('SIGTERM'); }
}
test('real installed-style wrapper rejects oversized, empty, malformed and invalid state frames', async () => {
  for (const bytes of [Buffer.from([255, 255, 255, 255]), Buffer.alloc(4), Buffer.from([1, 0, 0, 0, 123]),
    frame({type: 'start', sessionID: randomUUID(), videoID: '../bad', state: {seconds: -1}})]) {
    assert.equal((await run(bytes)).type, 'error');
  }
});
test('closing the Chrome pipe exits the player instead of leaving an idle WebKit process', async () => {
  const child = spawn(host);
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  child.stdin.end();
  try { assert.equal((await once(child, 'exit'))[0], 0); }
  finally { clearTimeout(timer); child.kill('SIGTERM'); }
});
