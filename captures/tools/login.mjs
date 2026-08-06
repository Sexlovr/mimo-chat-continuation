// Simple browser login: type creds, tick checkbox, click sign in, report result.
import { CDP, findPageTarget, hookNetwork } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
const log = s => process.stdout.write(s + '\n');
const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0,19);

const EMAIL = 'vonlth3645@javaemail.com';
const PASS = 'Admin1234';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const t = await findPageTarget();
const cdp = new CDP(t.webSocketDebuggerUrl);
await cdp.connect();
try {
  await cdp.send('Network.enable'); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  const netPath = `/home/user/mimo-capture/net/${ts()}-login.jsonl`;
  mkdirSync('/home/user/mimo-capture/net', { recursive: true });
  await hookNetwork(cdp, netPath);
  await cdp.setUA(UA); await cdp.setViewport(1366, 900, UA);
  await cdp.wait(2000);

  // tick checkbox
  await cdp.eval(`(function(){const cb=document.querySelector('input[type=checkbox]');if(cb&&!cb.checked)(cb.closest('label')||cb).click();return cb?.checked})()`);

  // type email
  await cdp.typeChars('input[name="account"]', EMAIL, { delayMs: 35 });
  // type password
  await cdp.typeChars('input[name="password"]', PASS, { delayMs: 25 });
  await cdp.wait(500);

  // verify form state
  const state = await cdp.eval(`(function(){return{acc:document.querySelector('input[name=account]').value,pwd:document.querySelector('input[name=password]').value.length,cb:document.querySelector('input[type=checkbox]').checked,btn:[...document.querySelectorAll('button[type=submit]')].find(b=>b.classList.contains('mi-button'))?.disabled}})()`);
  log('FORM_STATE=' + JSON.stringify(state));

  // click sign in
  await cdp.clickEvents('button.mi-button[type="submit"]');
  log('SUBMITTED');

  // poll for result
  for (let i = 1; i <= 12; i++) {
    await cdp.wait(2000);
    const url = await cdp.eval('location.href');
    const err = await cdp.eval(`[...document.querySelectorAll('.ant-message-error,[role=alert],.ant-form-item-explain-error')].map(e=>e.innerText.trim()).filter(Boolean).slice(0,3)`);
    const captcha = await cdp.eval(`!!document.querySelector('.miverify_panel_box:not(.loading)')`);
    if (err.length) { log(`T+${i*2}s ERR=${JSON.stringify(err)} captcha=${captcha}`); if(!captcha) break; }
    if (!url.includes('account.xiaomi.com/fe/service/login/password')) { log(`T+${i*2}s REDIRECTED=${url}`); break; }
    if (captcha) { log(`T+${i*2}s CAPTCHA_VISIBLE`); break; }
  }

  // final state
  const finalUrl = await cdp.eval('location.href');
  const finalTitle = await cdp.eval('document.title');
  const cookies = await cdp.getCookies();
  log(`FINAL: url=${finalUrl} title=${finalTitle}`);
  log('COOKIES=' + JSON.stringify(cookies.map(c => c.name)));
  await cdp.screenshot('/home/user/mimo-capture/login-result.png');
  log('NETLOG=' + netPath);
} finally { try { await cdp.close(); } catch {} }
