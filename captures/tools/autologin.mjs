// Auto-login capture for MiMo2API.
// Runs a headless chromium via CDP, logs in to xiaomi.com with email+password,
// completes email verification (code prompted on stdout OR passed via env/arg),
// navigates to aistudio.xiaomimimo.com, clicks Sign in, and prints the
// .xiaomimimo.com cookies as JSON.
//
// Usage:
//   node autologin.mjs --email=foo@bar.com --password=Secret123
//   # then, when prompted, paste the email verification code:
//   node autologin.mjs --email=... --password=... --code=123456
//
// Requires a running chromium with --remote-debugging-port=9333.
// If not running, this script will try to launch one.
//
// Output: a single JSON line on stdout with {serviceToken, userId, phToken}.

import { spawn } from 'node:child_process';
import { CDP, findPageTarget, hookNetwork } from './cdp.mjs';
import { mkdirSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const i = a.indexOf('=');
  return i < 0 ? [a.replace(/^--/, ''), true] : [a.slice(2, i), a.slice(i + 1)];
}));

const EMAIL = args.email || process.env.MIMO_EMAIL;
const PASSWORD = args.password || process.env.MIMO_PASSWORD;
const CODE = args.code || process.env.MIMO_CODE;
const CDP_PORT = parseInt(args.port || '9333', 10);
const PROFILE_DIR = args.profile || process.env.MIMO_PROFILE || '/tmp/mimo-cdp-profile';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

if (!EMAIL || !PASSWORD) {
  console.error('Usage: node autologin.mjs --email=you@example.com --password=Secret123 [--code=123456]');
  process.exit(1);
}

const log = s => process.stderr.write(s + '\n');

async function ensureChromium() {
  // Try existing
  try {
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (r.ok) { log(`[autologin] using existing chromium on port ${CDP_PORT}`); return; }
  } catch {}
  // Launch
  log(`[autologin] launching chromium on port ${CDP_PORT}`);
  const flags = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--headless=new', '--no-sandbox', '--no-zygote', '--disable-setuid-sandbox',
    '--disable-gpu', '--disable-dev-shm-usage', '--disable-extensions',
    '--disable-background-networking', '--no-first-run', '--disable-default-apps',
    `--user-agent=${UA}`,
  ];
  const candidates = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', '/usr/bin/chromium'];
  let proc = null;
  for (const bin of candidates) {
    try { proc = spawn(bin, flags, { stdio: 'ignore', detached: true }); break; } catch {}
  }
  if (!proc) { throw new Error('could not launch chromium (no binary found)'); }
  proc.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return; } catch {}
  }
  throw new Error('chromium did not come up on port ' + CDP_PORT);
}

async function waitForCode(promptMsg) {
  if (CODE) return CODE;
  log(`[autologin] ${promptMsg}`);
  log('[autologin] waiting for code on stdin... (re-run with --code=NNNNNN to provide)');
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    let buf = '';
    process.stdin.on('data', d => {
      buf += d;
      const m = buf.match(/(\d{4,8})/);
      if (m) { process.stdin.pause(); resolve(m[1]); }
    });
  });
}

async function main() {
  await ensureChromium();
  const t = await findPageTarget();
  const cdp = new CDP(t.webSocketDebuggerUrl);
  await cdp.connect();
  try {
    await cdp.send('Network.enable'); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.setUA(UA); await cdp.setViewport(1366, 900, UA);
    await cdp.navigate('https://account.xiaomi.com/fe/service/login/password');
    await cdp.wait(2500);

    // tick checkbox
    await cdp.eval(`(function(){const cb=document.querySelector('input[type=checkbox]');if(cb&&!cb.checked)(cb.closest('label')||cb).click();return cb?.checked})()`);

    // type creds
    await cdp.typeChars('input[name="account"]', EMAIL, { delayMs: 35 });
    await cdp.typeChars('input[name="password"]', PASSWORD, { delayMs: 25 });
    await cdp.wait(300);

    // click submit
    await cdp.clickEvents('button.mi-button[type="submit"]');
    log('[autologin] submitted login form');

    // wait for either redirect (logged in) or verifyEmail page
    let onVerify = false;
    for (let i = 1; i <= 15; i++) {
      await cdp.wait(2000);
      const url = await cdp.eval('location.href');
      if (url.includes('/identity/verifyEmail')) { onVerify = true; break; }
      if (url.includes('/fe/service/account')) { log('[autologin] already logged in (no verification needed)'); break; }
      if (!url.includes('/fe/service/login/password')) { log(`[autologin] redirected: ${url}`); break; }
    }

    if (onVerify) {
      // click "Send" to email the code
      await cdp.eval(`(function(){const b=[...document.querySelectorAll('button')].find(b=>/^Send$/i.test((b.innerText||'').trim()));if(b){b.click();return true}return false})()`);
      log('[autologin] verification code email sent');
      const code = await waitForCode('Enter the email verification code:');
      await cdp.typeChars('input[name="ticket"]', code, { delayMs: 60 });
      await cdp.wait(400);
      await cdp.clickEvents('button.miui-btn-primary');
      log('[autologin] submitted verification code');
      for (let i = 1; i <= 15; i++) {
        await cdp.wait(2000);
        const url = await cdp.eval('location.href');
        if (url.includes('/fe/service/account')) { log('[autologin] verification accepted'); break; }
      }
    }

    // Navigate to aistudio chat page
    await cdp.navigate('https://aistudio.xiaomimimo.com/#/c');
    await cdp.wait(5000);

    // Dismiss cookie banner + click Sign in
    await cdp.eval(`(function(){const b=[...document.querySelectorAll('button,a')].find(x=>/Accept All/i.test(x.innerText));if(b){b.click();return true}return false})()`);
    await cdp.wait(800);
    const signin = await cdp.eval(`(function(){const b=[...document.querySelectorAll('button,a')].find(x=>/^Sign in/i.test((x.innerText||'').trim())&&!x.disabled);if(b){b.click();return 'clicked'}return 'not found'})()`);
    log(`[autologin] sign-in: ${signin}`);
    await cdp.wait(5000);

    // Extract .xiaomimimo.com cookies
    const all = await cdp.getCookies(['https://aistudio.xiaomimimo.com/']);
    const want = {};
    for (const c of all) {
      if (c.name === 'xiaomichatbot_serviceToken') want.serviceToken = c.value.replace(/^"|"$/g, '');
      else if (c.name === 'userId') want.userId = c.value;
      else if (c.name === 'xiaomichatbot_ph') want.phToken = c.value.replace(/^"|"$/g, '');
    }
    if (!want.serviceToken || !want.userId || !want.phToken) {
      log('[autologin] cookies not yet set; waiting 10s and retrying');
      await cdp.wait(10000);
      const all2 = await cdp.getCookies(['https://aistudio.xiaomimimo.com/']);
      for (const c of all2) {
        if (c.name === 'xiaomichatbot_serviceToken') want.serviceToken = c.value.replace(/^"|"$/g, '');
        else if (c.name === 'userId') want.userId = c.value;
        else if (c.name === 'xiaomichatbot_ph') want.phToken = c.value.replace(/^"|"$/g, '');
      }
    }
    if (!want.serviceToken || !want.userId || !want.phToken) {
      throw new Error('login did not produce required cookies (serviceToken, userId, phToken)');
    }
    // Output single-line JSON to stdout
    process.stdout.write(JSON.stringify(want) + '\n');
    log(`[autologin] success: userId=${want.userId} serviceToken=(${want.serviceToken.length} chars) phToken=${want.phToken}`);
  } finally { try { await cdp.close(); } catch {} }
}

main().catch(e => { console.error('[autologin] failed:', e.message || e); process.exit(1); });
