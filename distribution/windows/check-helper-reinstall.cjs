// Windows CI rehearsal for the real managed updater. The signed build 13305
// manifest intentionally installs the same 13304 payload, so this proves the
// helper handoff/reinstall path without claiming a version migration.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {createRequire} = require('node:module');
const desktopRequire = createRequire(path.resolve(__dirname, '../../desktop/package.json'));
const {chromium} = desktopRequire('@playwright/test');

const ASSET = 'SpektraLab-Windows-x64-Setup.exe';
const IDENTIFIER = 'app.spektralab.windows133';
let activeReceipt;
const CHANNEL = 'windows-x64';
const PREFIX = 'https://github.com/Quietime/SpektraLab-Win/releases/download/';
const EXPECTED_BUILD = 13305;
const MAX_PACKAGE = 512 * 1024 * 1024;
const POLL_MS = 350;
const TIMEOUT_MS = 180000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const shaFile = file => sha256(fs.readFileSync(file));
const fail = message => { throw new Error(message); };
const isFile = file => fs.existsSync(file) && fs.statSync(file).isFile();
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const embedded = value => {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname === 'tauri.localhost' && !url.port ||
      url.protocol === 'tauri:' && url.hostname === 'localhost' && !url.port;
  } catch { return false; }
};

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail('Missing ' + name);
  return value;
}

function decodeSignedInputs() {
  const encoded = requiredEnv('WINDOWS_REHEARSAL_MANIFEST_B64');
  const encodedSignature = requiredEnv('WINDOWS_REHEARSAL_SIGNATURE_B64');
  for (const [name, value] of [['manifest', encoded], ['signature', encodedSignature]]) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
      fail('Invalid base64 ' + name);
  }
  const raw = Buffer.from(encoded, 'base64');
  const signatureText = Buffer.from(encodedSignature, 'base64');
  if (!raw.length || raw.length > 65536 || !signatureText.length || signatureText.length > 4096)
    fail('Signed metadata exceeds updater limits');
  const hex = signatureText.toString('utf8').trim();
  if (!/^[0-9a-fA-F]{768}$/.test(hex)) fail('Invalid RSA-3072 signature encoding');
  const publicKey = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../updater/public-key.json'), 'utf8'));
  if (publicKey.algorithm !== 'RSA-PKCS1-SHA256' ||
      !/^[0-9a-fA-F]{768}$/.test(publicKey.modulus) ||
      !/^[0-9a-fA-F]+$/.test(publicKey.exponent)) fail('Invalid checked-in updater public key');
  const base64url = hexValue => Buffer.from(hexValue, 'hex').toString('base64url');
  const key = crypto.createPublicKey({key:{
    kty:'RSA', n:base64url(publicKey.modulus), e:base64url(publicKey.exponent)
  },format:'jwk'});
  if (!crypto.verify('RSA-SHA256', raw,
    {key,padding:crypto.constants.RSA_PKCS1_PADDING}, Buffer.from(hex, 'hex')))
    fail('Manifest signature did not verify against the shipped updater public key');

  const manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.schema !== 1 || manifest.build !== EXPECTED_BUILD ||
      typeof manifest.version !== 'string' || !manifest.version)
    fail('Expected signed future build 13305 schema 1 manifest');
  for (const channel of [CHANNEL, 'android-phone-arm64', 'android-tablet-arm64']) {
    if (!manifest.channels?.[channel] || typeof manifest.channels[channel] !== 'object')
      fail('Missing signed channel ' + channel);
  }
  const asset = manifest.channels[CHANNEL];
  if (asset.name !== ASSET ||
      !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_PACKAGE ||
      !/^[0-9a-fA-F]{64}$/.test(asset.sha256) ||
      !/^[0-9a-fA-F]{64}$/.test(asset.installed_sha256))
    fail('Signed Windows asset fields are invalid');
  const suffix = asset.url?.startsWith(PREFIX) ? asset.url.slice(PREFIX.length) : '';
  const parts = suffix.split('/');
  if (parts.length !== 2 || !/^[A-Za-z0-9._-]+$/.test(parts[0]) ||
      parts[0] === '.' || parts[0] === '..' || parts[1] !== ASSET)
    fail('Signed installer URL is outside the fixed release asset path');
  return {raw,signatureText,manifest,asset};
}

function processSnapshot() {
  const command = '$items=@(Get-Process -Name SpektraLab-Windows,SpektraLab-UpdateHelper ' +
    '-ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path); ' +
    '[Console]::Write((ConvertTo-Json -InputObject $items -Compress -Depth 3))';
  const output = execFileSync('pwsh',['-NoProfile','-NonInteractive','-Command',command],
    {encoding:'utf8',timeout:15000}).trim();
  const parsed = output ? JSON.parse(output) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function connectEmbedded(deadline) {
  while (Date.now() < deadline) {
    let browser;
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:3000});
      const pagesDeadline = Math.min(deadline, Date.now() + 15000);
      while (Date.now() < pagesDeadline) {
        const page = browser.contexts().flatMap(context => context.pages())
          .find(candidate => embedded(candidate.url()));
        if (page) return {browser,page};
        await sleep(500);
      }
      await browser.close();
    } catch {
      if (browser) { try { await browser.close(); } catch {} }
    }
    await sleep(750);
  }
  fail('No embedded WebView2 CDP page appeared on port 9222');
}

async function run() {
  const install = path.resolve(requiredEnv('GUI_INSTALL'));
  const setup = path.resolve(requiredEnv('GUI_SETUP'));
  const evidence = path.resolve(requiredEnv('GUI_EVIDENCE'));
  const oldPid = Number(requiredEnv('GUI_APP_PID'));
  if (!Number.isSafeInteger(oldPid) || oldPid <= 0) fail('Invalid original GUI PID');
  const exe = path.join(install, 'SpektraLab-Windows.exe');
  const loader = path.join(install, 'WebView2Loader.dll');
  if (!isFile(setup) || !isFile(exe) || !isFile(loader))
    fail('Installed GUI, adjacent WebView2 loader, or setup is missing');
  const {raw,signatureText,manifest,asset} = decodeSignedInputs();
  const setupSize = fs.statSync(setup).size;
  const setupSha = shaFile(setup);
  const exeSha = shaFile(exe);
  if (setupSize !== asset.bytes || setupSha.toLowerCase() !== asset.sha256.toLowerCase() ||
      exeSha.toLowerCase() !== asset.installed_sha256.toLowerCase())
    fail('Signed payload size, installer hash, or installed executable hash differs');
  const initial = processSnapshot();
  if (!initial.some(item => item.Id === oldPid && item.Path && samePath(item.Path, exe)))
    fail('Original GUI PID is not running from GUI_INSTALL');
  const receipt = {
    status:'running', source_commit:process.env.SOURCE_REF || null,
    scope:'Real Windows WebView2 signed same-payload 13305-to-13304 reinstall; no version migration or physical GPU claim',
    installer_sha256:setupSha, installed_exe_sha256:exeSha,
    manifest_sha256:sha256(raw), signature_sha256:sha256(signatureText),
    original_pid:oldPid, setup_bytes:setupSize, helper_observed:false,
    old_process_exited:false, new_pid:null, staged_package_removed:false,
    ready_removed:false, helper_ready_removed:false, unrelated_retained:false,
    restarted_embedded_ui:false, real_windows_gui_tested:true,
    signed_reinstall_tested:false,
  };
  activeReceipt = receipt;
  const deadline = Date.now() + TIMEOUT_MS;
  const {browser,page} = await connectEmbedded(Math.min(deadline,Date.now()+30000));
  let managed;
  try {
    const principal = await page.evaluate(() => ({
      url:location.href, hasTauri:typeof window.__TAURI_INTERNALS__?.invoke === 'function',
      title:document.title
    }));
    if (!embedded(principal.url) || !principal.hasTauri || !/SpektraLab/.test(principal.title))
      fail('Original CDP page is not the installed Tauri app');
    const cache = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('plugin:path|resolve_directory',{directory:16}));
    if (typeof cache !== 'string' || !path.isAbsolute(cache) ||
        path.basename(cache).toLowerCase() !== IDENTIFIER)
      fail('Native app cache path does not match the installed application identifier');
    const local = path.resolve(requiredEnv('LOCALAPPDATA'));
    if (!path.resolve(cache).toLowerCase().startsWith((local+path.sep).toLowerCase()))
      fail('Native app cache is outside this Windows user profile');
    managed = path.join(cache, 'Updates');
    fs.mkdirSync(managed,{recursive:true});
    const owned = [ASSET,'updates.json','updates.json.sig','ready',
      'ready.tmp','updates.json.tmp','updates.json.sig.tmp','helper-ready',
      'SpektraLab-UpdateHelper.exe','WebView2Loader.dll','WebView2Loader.dll.partial'];
    if (owned.some(name => fs.existsSync(path.join(managed,name))))
      fail('Managed Updates already contains a prepared update or helper; refusing to overwrite it');
    const unrelated = path.join(managed,'unrelated.keep');
    if (fs.existsSync(unrelated)) fail('Unrelated preservation marker already exists');
    const marker = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(unrelated,marker,{flag:'wx'});
    const stagedPackage = path.join(managed,ASSET);
    const ready = path.join(managed,'ready');
    const helperReady = path.join(managed,'helper-ready');
    fs.copyFileSync(setup,stagedPackage,fs.constants.COPYFILE_EXCL);
    if (fs.statSync(stagedPackage).size !== asset.bytes ||
        shaFile(stagedPackage).toLowerCase() !== asset.sha256.toLowerCase())
      fail('Managed installer copy differs from the signed asset');
    fs.writeFileSync(path.join(managed,'updates.json'),raw,{flag:'wx'});
    fs.writeFileSync(path.join(managed,'updates.json.sig'),signatureText,{flag:'wx'});
    fs.writeFileSync(ready,'ready',{flag:'wx'});
    receipt.managed_updates = managed;
    receipt.staged_verified = true;
    console.log('Signed future manifest and exact installer staged in managed Updates');

    // The installed app itself performs helper staging, host shutdown, process
    // exit, NSIS installation and restart. The bridge receives no path or URL.
    let invokeOutcome = 'pending';
    const invocation = page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke('update_install')).then(
      value => { invokeOutcome = {resolved:value}; },
      error => { invokeOutcome = {rejected:String(error)}; });
    let lastProcesses = [];
    while (Date.now() < deadline) {
      const processes = processSnapshot();
      lastProcesses = processes;
      const oldAlive = processes.some(item => item.Id === oldPid && item.Path && samePath(item.Path,exe));
      const helperAlive = processes.some(item =>
        item.ProcessName?.toLowerCase() === 'spektralab-updatehelper' &&
        item.Path && samePath(item.Path,path.join(managed,'SpektraLab-UpdateHelper.exe')));
      if (helperAlive || (isFile(helperReady) && fs.readFileSync(helperReady,'utf8') === String(oldPid))) receipt.helper_observed = true;
      const restarted = processes.find(item =>
        item.Id !== oldPid && item.Path && samePath(item.Path,exe));
      receipt.old_process_exited = !oldAlive;
      receipt.new_pid = restarted?.Id || null;
      receipt.staged_package_removed = !fs.existsSync(stagedPackage);
      receipt.ready_removed = !fs.existsSync(ready);
      receipt.helper_ready_removed = !fs.existsSync(helperReady);
      receipt.unrelated_retained = isFile(unrelated) &&
        fs.readFileSync(unrelated,'utf8') === marker;
      if (typeof invokeOutcome === 'object' && 'rejected' in invokeOutcome &&
          !/Target closed|Browser has been closed|Page closed|Session closed|Connection closed/i.test(invokeOutcome.rejected))
        fail('Native update_install rejected before handoff: '+invokeOutcome.rejected);
      if (receipt.old_process_exited && receipt.new_pid &&
          receipt.staged_package_removed && receipt.ready_removed &&
          receipt.helper_ready_removed) break;
      await sleep(POLL_MS);
    }
    await Promise.race([invocation,sleep(1000)]);
    receipt.invoke_outcome = invokeOutcome;
    receipt.final_processes = lastProcesses;
    if (!receipt.helper_observed || !receipt.old_process_exited || !receipt.new_pid ||
        !receipt.staged_package_removed || !receipt.ready_removed ||
        !receipt.helper_ready_removed || !receipt.unrelated_retained)
      fail('Updater helper handoff, cleanup, or restart did not complete');
    if (shaFile(exe).toLowerCase() !== asset.installed_sha256.toLowerCase())
      fail('Reinstalled GUI digest differs from signed installed_sha256');
    const restart = await connectEmbedded(Math.min(Date.now()+45000,deadline+45000));
    try {
      const restarted = await restart.page.evaluate(() => ({
        url:location.href, title:document.title,
        hasTauri:typeof window.__TAURI_INTERNALS__?.invoke === 'function',
        root:!!document.querySelector('#root'),
        editor:!!document.querySelector('[data-testid="editor"]')
      }));
      if (!embedded(restarted.url) || !restarted.hasTauri || !restarted.root ||
          !restarted.editor || !/SpektraLab/.test(restarted.title))
        fail('Restarted GUI did not load the embedded Tauri editor');
      receipt.restarted_embedded_ui = true;
      receipt.restarted_principal = restarted;
      receipt.final_installed_exe_sha256 = shaFile(exe);
      receipt.status = 'passed';
      receipt.signed_reinstall_tested = true;
      return receipt;
    } finally { try { await restart.browser.close(); } catch {} }
  } finally {
    try { await browser.close(); } catch {}
  }
}

(async () => {
  let receipt;
  try {
    receipt = await run();
    console.log('PASS signed same-payload helper reinstall',JSON.stringify({
      old_pid:receipt.original_pid,new_pid:receipt.new_pid,
      installed_exe_sha256:receipt.final_installed_exe_sha256
    }));
  } catch (error) {
    receipt = {...(activeReceipt || {}),status:'failed', error:String(error?.stack || error),
      scope:activeReceipt?.scope || 'Signed same-payload Windows helper rehearsal; staged files preserved for diagnosis',
      source_commit:process.env.SOURCE_REF || null};
    console.error(receipt.error);
    process.exitCode = 1;
  } finally {
    const evidence = process.env.GUI_EVIDENCE;
    if (evidence && fs.existsSync(evidence) && fs.statSync(evidence).isDirectory())
      fs.writeFileSync(path.join(evidence,'HELPER-REINSTALL.json'),JSON.stringify(receipt,null,2)+'\n');
  }
})();
