import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const directory = mkdtempSync(join(tmpdir(), 'macos-pip-chrome-'));
const liveSite = process.argv.includes('--youtube');
const benchmarking = process.argv.includes('--benchmark');
const cold = process.argv.includes('--cold');
const fullscreen = process.argv.includes('--fullscreen');
const spa = process.argv.includes('--spa');
const warm = process.argv.includes('--warm') || (benchmarking && !cold);
const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const samples = [];
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const app = process.env.PIP_PLAYER || fileURLToPath(new URL('../build/YouTube macOS PiP.app/Contents/MacOS/YouTubeMacPiP', import.meta.url));
const hostName = `com.chromeytpip.smoke${process.pid}`;
const hostDirectory = join(directory, 'profile/NativeMessagingHosts');
const hostManifest = join(hostDirectory, `${hostName}.json`);
const timers = new Set();
let browser;
let stderr = '';
let send;
let diagnostics;
try {
  const videoPath = join(directory, 'video.mp4');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=24',
    '-t', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], {encoding: 'utf8'});
  assert.equal(generated.status, 0, generated.stderr);
  const media = readFileSync(videoPath).toString('base64');
  const page = join(directory, 'index.html');
  writeFileSync(page, '<!doctype html><video controls loop src="video.mp4" style="width:100%"></video>');
  const extension = join(directory, 'Extension');
  cpSync(new URL('../Extension/', import.meta.url), extension, {recursive: true});
  if (cold) {
    const contentPath = join(extension, 'content.js');
    writeFileSync(contentPath, readFileSync(contentPath, 'utf8').replace('async function prepareWarm() {', 'async function prepareWarm() { return;'));
  }
  const backgroundPath = join(extension, 'background.js');
  writeFileSync(backgroundPath, readFileSync(backgroundPath, 'utf8').replace("'com.chromeytpip.bridge'", `'${hostName}'`)
    .replace('session.latestState = current;', 'session.handoffState = current; session.latestState = current;')
    .replace('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {',
      'chrome.runtime.onMessage.addListener((message, sender, sendResponse) => { globalThis.lastSource = {type:message.type,videoID:message.videoID,url:sender.url,tabURL:sender.tab?.url,documentID:sender.documentId};'));
  const wrapper = join(directory, 'native-host');
  const quote = raw => `'${raw.replaceAll("'", "'\\''")}'`;
  writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(app)} --native-host${liveSite ? '' : ` --test-page ${quote(page)}`}\n`, {mode: 0o755});

  browser = spawn(chromePath, [...(fullscreen ? [] : ['--headless=new']), '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${join(directory, 'profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--mute-audio', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']});
  browser.stderr.on('data', bytes => { stderr += bytes; });
  let sequence = 0;
  let buffer = '';
  const requests = new Map();
  const listeners = new Map();
  browser.stdio[4].on('data', bytes => {
    buffer += bytes;
    while (buffer.includes('\0')) {
      const end = buffer.indexOf('\0');
      const raw = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!raw) continue;
      const packet = JSON.parse(raw);
      if (packet.id) {
        const request = requests.get(packet.id);
        if (!request) continue;
        requests.delete(packet.id); clearTimeout(request.timer); timers.delete(request.timer);
        if (packet.error) request.reject(new Error(JSON.stringify(packet.error)));
        else request.resolve(packet.result);
      } else for (const fn of listeners.get(packet.method) || []) fn(packet.params, packet.sessionId);
    }
  });
  send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { requests.delete(id); timers.delete(timer); reject(new Error(`CDP timed out: ${method} ${String(params.expression || '').slice(0, 160)}\n${stderr.slice(-500)}`)); }, liveSite ? 70000 : 20000);
    timers.add(timer); requests.set(id, {resolve, reject, timer});
    browser.stdio[3].write(JSON.stringify({id, method, params, sessionId}) + '\0');
  });
  const on = (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); };
  const loaded = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { timers.delete(timer); reject(new Error('Page did not load')); }, liveSite ? 65000 : 15000);
    timers.add(timer);
    on('Page.loadEventFired', () => { clearTimeout(timer); timers.delete(timer); resolve(); });
  });
  const version = await send('Browser.getVersion');
  console.log('Chrome:', version.product);
  const {id: extensionID} = await send('Extensions.loadUnpacked', {path: extension});
  mkdirSync(hostDirectory, {recursive: true});
  writeFileSync(hostManifest, JSON.stringify({name: hostName, description: 'Temporary macOS PiP integration test',
    path: wrapper, type: 'stdio', allowed_origins: [`chrome-extension://${extensionID}/`]}));
  const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  if (!liveSite) await send('Fetch.enable', {patterns: [{urlPattern: '*'}]}, sessionId);
  let interceptionError;
  on('Fetch.requestPaused', async ({requestId, request}, session) => {
    try {
      const main = request.url.startsWith('https://www.youtube.com/watch?');
      const html = `<!doctype html><html><body><video controls loop width="320" height="180" src="data:video/mp4;base64,${media}"></video><div class="ytp-right-controls" style="width:320px;height:48px;background:#222"></div></body></html>`;
      await send('Fetch.fulfillRequest', {requestId, responseCode: main ? 200 : 204,
        responseHeaders: [{name: 'Content-Type', value: 'text/html'}], body: main ? Buffer.from(html).toString('base64') : ''}, session);
    } catch (error) { interceptionError = error; }
  });
  const pageLoaded = loaded();
  await send('Page.navigate', {url: spa && liveSite ? 'https://www.youtube.com/'
    : `https://www.youtube.com/watch?v=${liveSite ? 'dQw4w9WgXcQ' : 'abcdefghijk'}`}, sessionId);
  await pageLoaded;
  const evaluate = async (expression, extra = {}, session = sessionId) => {
    const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true, ...extra}, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  diagnostics = async () => {
    console.error('Page:', await evaluate(`({phase:document.getElementById('macos-pip-bridge-button')?.getAttribute('data-phase'),notice:document.getElementById('macos-pip-bridge-notice')?.textContent,time:document.querySelector('video')?.currentTime,paused:document.querySelector('video')?.paused,rate:document.querySelector('video')?.playbackRate,volume:document.querySelector('video')?.volume})`));
    const {targetInfos} = await send('Target.getTargets', {filter: [{}]});
    const worker = targetInfos.find(target => target.type==='service_worker');
    if (worker) {
      const {sessionId: workerSession} = await send('Target.attachToTarget',{targetId:worker.targetId,flatten:true});
      console.error('Native session:', await evaluate(`activeSession && ({latest:activeSession.latestState,committed:activeSession.committed,preparing:activeSession.preparing,stopping:activeSession.stopping})`,{},workerSession));
      console.error('Message source:', await evaluate('globalThis.lastSource', {}, workerSession));
    }
  };
  const waitForMedia = () => evaluate(`new Promise((resolve, reject) => {
    const check = () => {
      const correct = ${liveSite} ? document.getElementById('movie_player')?.getVideoData?.().video_id === new URL(location.href).searchParams.get('v') : true;
      if(correct && document.querySelector('video')?.readyState >= 1 && document.getElementById('macos-pip-bridge-button') && !document.querySelector('.ad-showing')) { observer.disconnect(); resolve(); }
    };
    const observer = new MutationObserver(check); observer.observe(document, {childList:true,subtree:true,attributes:true,attributeFilter:['class']});
    document.addEventListener('loadeddata', check, true); check();
  })`);
  if (spa && liveSite) await evaluate(`new Promise(resolve => {
    const check=()=>{if(document.getElementById('macos-pip-bridge-button')){observer.disconnect();resolve();}};
    const observer=new MutationObserver(check);observer.observe(document,{childList:true,subtree:true});check();
  })`);
  else await waitForMedia();
  if (fullscreen) {
    const {windowId} = await send('Browser.getWindowForTarget', {targetId});
    await send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'fullscreen'}});
    await send('Page.bringToFront', {}, sessionId);
    assert.equal((await send('Browser.getWindowBounds', {windowId})).bounds.windowState, 'fullscreen');
    console.log('Testing a visible Chrome window in its native macOS fullscreen Space.');
  }
  console.log(`${liveSite ? 'Real YouTube' : 'Local YouTube fixture'} and genuine content script loaded.`);
  await evaluate(`globalThis.videoBeforeReload = document.querySelector('video');
    globalThis.buttonBeforeReload = document.getElementById('macos-pip-bridge-button');
    globalThis.bridgeReconnected = new Promise(resolve => {
      const observer = new MutationObserver(() => {
        const button = document.getElementById('macos-pip-bridge-button');
        if (button && button !== buttonBeforeReload && button.getAttribute('data-phase') === 'idle') {
          observer.disconnect(); resolve(true);
        }
      });
      observer.observe(document, {childList:true,subtree:true,attributes:true});
    }); undefined`);
  const {id: reloadedID} = await send('Extensions.loadUnpacked', {path: extension});
  assert.equal(reloadedID, extensionID);
  assert.equal(await evaluate('bridgeReconnected'), true);
  assert.deepEqual(await evaluate(`({sameVideo:videoBeforeReload===document.querySelector('video'),
    oldButtonRemoved:!buttonBeforeReload.isConnected,
    buttons:document.querySelectorAll('#macos-pip-bridge-button').length,
    notices:document.querySelectorAll('#macos-pip-bridge-notice').length,
    styles:document.querySelectorAll('#macos-pip-bridge-style').length})`),
    {sameVideo:true, oldButtonRemoved:true, buttons:1, notices:1, styles:1});
  console.log('PASS: extension reload reconnects the existing video and replaces the orphaned button without reloading the page.');
  const navigateYouTube = async videoID => {
    const initialDocument = await evaluate('performance.timeOrigin');
    await evaluate(`(() => {
      const input=document.querySelector('input[name="search_query"]');
      if(!input) throw new Error('YouTube search input is missing');
      input.value=''; input.focus();
    })()`);
    await send('Input.insertText', {text: videoID}, sessionId);
    await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}, sessionId);
    await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}, sessionId);
    await evaluate(`new Promise(resolve => {
      const check=()=>{
        const link=[...document.querySelectorAll('a[href^="/watch?"]')].find(a=>new URL(a.href).searchParams.get('v')===${JSON.stringify(videoID)});
        if(location.pathname==='/results' && link){observer.disconnect();resolve();}
      };
      const observer=new MutationObserver(check);observer.observe(document,{childList:true,subtree:true,attributes:true});check();
    })`);
    await evaluate(`[...document.querySelectorAll('a[href^="/watch?"]')].find(a=>new URL(a.href).searchParams.get('v')===${JSON.stringify(videoID)}).click()`, {userGesture:true});
    await waitForMedia();
    assert.equal(await evaluate('new URL(location.href).searchParams.get("v")'), videoID);
    assert.equal(await evaluate('performance.timeOrigin'), initialDocument, 'Real YouTube search and video navigation must keep the same document/content-script context');
    console.log(`PASS: real YouTube search → watch ${videoID} without a document reload.`);
  };
  if (spa && liveSite) await navigateYouTube('dQw4w9WgXcQ');
  if (spa && !liveSite) {
    await evaluate(`history.pushState({}, '', '/watch?v=ZYXWVUTSRQP'); document.dispatchEvent(new Event('yt-navigate-finish'));`);
    console.log('Same-document navigation to a different video URL without reloading the content-script context.');
  }
  const armPhase = async phase => evaluate(`globalThis.phaseReady = new Promise((resolve, reject) => {
    const check = () => {
      const b=document.getElementById('macos-pip-bridge-button');
      if (b?.getAttribute('data-phase')==='committing' && globalThis.activationStarted && !globalThis.pipVisibleMS) globalThis.pipVisibleMS=performance.now()-globalThis.activationStarted;
      if(b?.getAttribute('data-phase')===${JSON.stringify(phase)}) {
        if (${JSON.stringify(phase)}==='active') globalThis.handoffMS=performance.now()-globalThis.activationStarted;
        observer.disconnect(); resolve(true);
      }
      const n=document.getElementById('macos-pip-bridge-notice');
      if(${JSON.stringify(phase)}==='active' && b?.getAttribute('data-phase')==='idle' && n?.style.display==='block') {observer.disconnect(); reject(new Error(n.textContent));}
    };
    const observer=new MutationObserver(check); observer.observe(document,{attributes:true,childList:true,subtree:true}); check();
  }); undefined`);
  const click = async () => {
    if (fullscreen) await send('Page.bringToFront', {}, sessionId);
    const point = await evaluate(`(() => {const r=document.getElementById('macos-pip-bridge-button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', ...point}, sessionId);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await evaluate(`(() => {const b=document.getElementById('macos-pip-bridge-button');const hit=document.elementFromPoint(${point.x},${point.y});return hit===b || b.contains(hit);})()`), true,
      'The real player button must be under the pointer before clicking');
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', clickCount: 1, ...point}, sessionId);
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', clickCount: 1, ...point}, sessionId);
  };
  const cases = benchmarking ? Array.from({length: Number(argument('--runs', '5'))}, (_, i) =>
    ({paused: false, entry: `button ${warm ? 'prepared' : 'cold'} sample ${i + 1}`})) : [
    ...(!liveSite ? [{paused: true, entry: 'button before video attaches', early: true}] : []),
    {paused: true, entry: 'button after extension reload'},
    {paused: false, entry: spa && liveSite ? 'button after another video SPA navigation' : 'button after page reload',
      reloadPage: !(spa && liveSite), navigateVideo: spa && liveSite ? 'aqz-KE-bpKQ' : undefined},
    {paused: false, entry: 'toolbar'}
  ];
  for (const {paused, entry, reloadPage, navigateVideo, early} of cases) {
    if (navigateVideo) await navigateYouTube(navigateVideo);
    if (reloadPage) {
      const reloaded = loaded();
      await send('Page.reload', {}, sessionId);
      await reloaded;
      await waitForMedia();
      assert.equal(await evaluate(`document.querySelectorAll('#macos-pip-bridge-button').length`), 1);
    }
    await evaluate(`(async () => { const v=document.querySelector('video');v.currentTime=3.5;v.volume=.35;v.playbackRate=1.25;${paused ? 'v.pause();' : 'await v.play();'} })()`, {userGesture: true});
    if (liveSite) await evaluate(`{const p=document.getElementById('movie_player');${paused ? 'p.pauseVideo();' : 'p.playVideo();'}}`, {userGesture:true});
    if (warm) {
      await send('Page.bringToFront', {}, sessionId);
      assert.equal(await evaluate('document.hasFocus()'), true, 'Prewarming requires the foreground video tab');
      await evaluate(`new Promise(resolve => {
        const check=()=>{ if(document.getElementById('macos-pip-bridge-button')?.getAttribute('data-prepared')==='true') {observer.disconnect();resolve();} };
        const observer=new MutationObserver(check);observer.observe(document,{attributes:true,subtree:true});check();
      })`);
    }
    if (liveSite) await evaluate(`(async () => {const p=document.getElementById('movie_player');const v=document.querySelector('video');
      ${paused ? 'p.pauseVideo();v.pause();' : 'p.playVideo();await v.play();'}})()`, {userGesture:true});
    assert.equal(await evaluate('document.querySelector("video").paused'), paused);
    console.log('Source before opening:', await evaluate(`({paused:document.querySelector('video').paused,time:document.querySelector('video').currentTime})`));
    await armPhase('active');
    await evaluate('globalThis.activationStarted=performance.now(); globalThis.pipVisibleMS=undefined; globalThis.handoffMS=undefined;');
    if (early) await evaluate(`globalThis.pendingVideo=document.querySelector('video');pendingVideo.remove();`);
    if (entry !== 'toolbar') await click();
    else {
      const {targetInfos} = await send('Target.getTargets', {filter: [{}]});
      const tab = targetInfos.find(target => target.type === 'tab' && target.url.startsWith('https://www.youtube.com/watch?'));
      assert.ok(tab, JSON.stringify(targetInfos));
      await send('Extensions.triggerAction', {id: extensionID, targetId: tab.targetId});
    }
    if (early) {
      assert.equal(await evaluate(`document.getElementById('macos-pip-bridge-button').getAttribute('data-phase')`), 'waiting');
      await evaluate('document.body.prepend(pendingVideo);');
    }
    await evaluate('phaseReady');
    const timing = await evaluate('({readyMS:pipVisibleMS,activeMS:handoffMS})');
    assert.ok(timing.readyMS > 0 && timing.activeMS >= timing.readyMS);
    samples.push(timing);
    console.log('Click to real PiP / playable handoff (ms):', timing);
    console.log('Native PiP active; checking state transfer.');
    assert.deepEqual(await evaluate(`({sourcePaused:document.querySelector('video').paused,chromePiP:!!document.pictureInPictureElement})`), {sourcePaused: true, chromePiP: false});
    const {targetInfos} = await send('Target.getTargets');
    const worker = targetInfos.find(target => target.type === 'service_worker' && target.url === `chrome-extension://${extensionID}/background.js`);
    assert.ok(worker, 'Real extension service worker must be running');
    const {sessionId: workerSession} = await send('Target.attachToTarget', {targetId: worker.targetId, flatten: true});
    await send('Runtime.enable', {}, workerSession);
    const initial = await evaluate('activeSession.latestState', {}, workerSession);
    if (spa) console.log('Chrome message source after SPA navigation:', await evaluate('globalThis.lastSource', {}, workerSession));
    const presentation = await evaluate('activeSession.presentation', {}, workerSession);
    assert.equal(presentation.visible, true);
    if (fullscreen) await send('Page.bringToFront', {}, sessionId);
    const physicalWindow = spawnSync(fileURLToPath(new URL('../build/window-check', import.meta.url)),
      [String(presentation.ownerPID), String(presentation.windowNumber)], {encoding:'utf8'});
    assert.equal(physicalWindow.status, 0, physicalWindow.stderr);
    console.log('Verified physical native PiP window:', physicalWindow.stdout.trim());
    const handoff = await evaluate('activeSession.handoffState', {}, workerSession);
    console.log('Handoff state:', handoff);
    assert.equal(initial.paused, paused);
    assert.equal(initial.rate, 1.25);
    assert.equal(initial.muted, handoff.muted);
    assert.equal(initial.volume, handoff.volume);
    assert.ok(initial.seconds >= 3.4);
    assert.ok(Math.abs(initial.seconds - handoff.seconds) < .3, 'Native playback must begin at the position captured when Chrome was paused');
    if (samples.length === 1 && argument('--hold-ms')) {
      const holdMS = Number(argument('--hold-ms'));
      assert.ok(Number.isFinite(holdMS) && holdMS >= 0 && holdMS <= 60000);
      console.log(`Holding verified PiP for ${holdMS}ms for visual inspection.`);
      await new Promise(resolve => setTimeout(resolve, holdMS));
    }
    await evaluate(`globalThis.updated = new Promise(resolve => { const port=activeSession.port; const listener=message => {
      if(message.type==='state' && message.state.seconds>=12 && message.state.rate===1.5 && message.state.volume===.6) { port.onMessage.removeListener(listener);resolve(message.state); }
    };port.onMessage.addListener(listener); }); undefined`, {}, workerSession);
    await evaluate(`{const v=document.querySelector('video');v.currentTime=12;v.volume=.6;v.playbackRate=1.5;}`);
    const nativeState = await evaluate('updated', {}, workerSession);
    assert.ok(nativeState.seconds >= 12);
    assert.equal(nativeState.paused, paused);
    await armPhase('idle');
    await click();
    await evaluate('phaseReady');
    const returned = await evaluate(`({time:document.querySelector('video').currentTime,paused:document.querySelector('video').paused,volume:document.querySelector('video').volume,rate:document.querySelector('video').playbackRate})`);
    assert.equal(returned.paused, paused);
    assert.equal(returned.volume, .6);
    assert.equal(returned.rate, 1.5);
    assert.ok(returned.time >= 11.9 && returned.time < 14);
    assert.equal(await evaluate('activeSession === null', {}, workerSession), true);
    console.log(`PASS: ${entry} / ${paused ? 'paused' : 'playing'} → macOS WebKit PiP → source seek/settings → Chrome return at ${returned.time.toFixed(2)}s.`);
  }
  if (benchmarking) {
    const median = key => {const values=samples.map(row=>row[key]).sort((a,b)=>a-b);const middle=Math.floor(values.length/2);return values.length%2?values[middle]:(values[middle-1]+values[middle])/2;};
    const report = {measuredAt:new Date().toISOString(), liveSite, warm, app, runs:samples.length,
      medianReadyMS:median('readyMS'), medianActiveMS:median('activeMS'), samples};
    if (argument('--output')) writeFileSync(argument('--output'), JSON.stringify(report,null,2)+'\n');
    console.log('Startup benchmark:', JSON.stringify(report));
  }
  if (interceptionError) throw interceptionError;
  await send('Browser.close');
} catch (error) {
  try { await diagnostics?.(); } catch {}
  throw error;
} finally {
  for (const timer of timers) clearTimeout(timer);
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    const exited = once(browser, 'exit'); browser.kill('SIGTERM'); await exited;
  }
  rmSync(hostManifest, {force: true});
  rmSync(directory, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
}
