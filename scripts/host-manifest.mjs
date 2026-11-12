import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const manifest = JSON.parse(readFileSync(new URL('../Extension/manifest.json', import.meta.url)));
const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
  .map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
writeFileSync(process.argv[3], JSON.stringify({
  name: 'com.chromeytpip.bridge', description: 'YouTube macOS PiP bridge',
  path: process.argv[2], type: 'stdio', allowed_origins: [`chrome-extension://${id}/`]
}, null, 2) + '\n');
console.log(`Chrome extension ID: ${id}`);
