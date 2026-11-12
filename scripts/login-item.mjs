import {mkdirSync, writeFileSync, unlinkSync} from 'node:fs';
import {spawnSync, execFileSync} from 'node:child_process';
import {join} from 'node:path';

const label = 'com.chromeytpip.player.login';
const domain = `gui/${process.getuid()}`;
const directory = join(process.env.HOME, 'Library/LaunchAgents');
const plist = join(directory, `${label}.plist`);
const executable = join(process.env.HOME, 'Applications/YouTube macOS PiP.app/Contents/MacOS/PiPResident');
const mode = process.argv[2];
if (mode === 'status') {
  const result = spawnSync('/bin/launchctl', ['print', `${domain}/${label}`], {stdio: 'inherit'});
  process.exit(result.status ?? 1);
}
if (!['enable', 'disable', 'unload'].includes(mode)) throw new Error('Usage: node scripts/login-item.mjs enable|disable|status|unload');
const stopped = spawnSync('/bin/launchctl', ['bootout', `${domain}/${label}`], {encoding: 'utf8'});
if (stopped.status !== 0 && !/No such process|Could not find service/.test(stopped.stderr)) {
  throw new Error(`Could not unload login item: ${stopped.stderr}`);
}
if (mode === 'unload') process.exit(0);
if (mode === 'disable') {
  try { unlinkSync(plist); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log('ログイン時の自動起動を解除しました。');
  process.exit(0);
}
const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
mkdirSync(directory, {recursive: true});
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(executable)}</string></array>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Interactive</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`, {mode: 0o644});
execFileSync('/bin/launchctl', ['enable', `${domain}/${label}`]);
execFileSync('/bin/launchctl', ['bootstrap', domain, plist]);
console.log('ログイン時の自動起動を有効にし、軽量な待受プロセスの常駐を開始しました。');
