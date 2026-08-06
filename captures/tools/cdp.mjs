// Minimal dependency-free CDP driver using Node's built-in WebSocket/fetch.
// Connects to a Chromium remote-debugging endpoint and exposes async helpers.
import { mkdirSync, appendFileSync } from 'node:fs';
import { FileWriteStream } from 'node:fs';

const HUB = 'http://127.0.0.1:9333';

export async function listTargets() {
  const res = await fetch(`${HUB}/json`);
  if (!res.ok) throw new Error(`/json failed: ${res.status}`);
  return await res.json();
}

export async function findPageTarget() {
  const targets = await listTargets();
  const page = targets.find(t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-untrusted://'))
              || targets.find(t => t.type === 'page');
  if (!page) throw new Error('no page target available');
  return page;
}

export async function findTargetByUrl(substr) {
  const targets = await listTargets();
  const t = targets.find(t => t.type === 'page' && t.url.includes(substr));
  return t || null;
}

export class CDP {
  constructor(wsUrl, { logFile = null } = {}) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = null;
    this.closed = false;
    this.logFile = logFile;
  }
  log(line) {
    process.stderr.write(line + '\n');
    if (this.logFile) appendFileSync(this.logFile, line + '\n');
  }
  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { maxPayload: 0 });
      this.ws = ws;
      ws.onopen = () => resolve(this);
      ws.onerror = (e) => {
        if (this.pending.size) {
          for (const [, p] of this.pending) p.reject(new Error('ws error'));
          this.pending.clear();
        }
        reject(new Error('ws connect error'));
      };
      ws.onclose = () => { this.closed = true; };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg.id != null) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(`${msg.method || ''} ${JSON.stringify(msg.error)}`));
            else p.resolve(msg.result);
          }
        } else if (msg.method) {
          const arr = this.handlers.get(msg.method);
          if (arr) for (const fn of arr) { try { fn(msg.params); } catch (e) { this.log(`handler ${msg.method} err: ${e.message}`); } }
        }
      };
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      const payload = { id, method, params };
      if (this.ws.readyState !== 1) return reject(new Error('ws not open'));
      this.ws.send(JSON.stringify(payload));
    });
  }
  async enableNetwork(maxBufferSize = 100*1024*1024) {
    await this.send('Network.enable', { maxTotalBufferSize: maxBufferSize, maxResourceBufferSize: 50*1024*1024 });
  }
  async enablePage() { await this.send('Page.enable'); await this.send('Page.setLifecycleEventsEnabled', { enabled: true }); }
  async enableRuntime() { await this.send('Runtime.enable'); }
  async navigate(url) {
    await this.send('Page.enable');
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw new Error('navigate error: ' + r.errorText);
    return r;
  }
  async waitLoad(timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('waitLoad timeout')), timeoutMs);
      const onEvent = (p) => {
        if (p.name === 'load') { clearTimeout(t); this.handlers.get('Page.lifecycleEvent').splice(this.handlers.get('Page.lifecycleEvent').indexOf(onEvent), 1); resolve(); }
      };
      if (!this.handlers.has('Page.lifecycleEvent')) this.handlers.set('Page.lifecycleEvent', []);
      this.handlers.get('Page.lifecycleEvent').push(onEvent);
    });
  }
  async wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  async eval(expression, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: !opts.noGesture, ...opts
    });
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails);
      throw new Error('JS error: ' + desc);
    }
    return r.result?.value;
  }
  async evalJsFile(path) {
    const src = await import('node:fs/promises').then(m => m.readFile(path, 'utf8'));
    return this.eval(src);
  }
  async getCookies(urls) { const r = await this.send('Network.getAllCookies', urls ? { urls } : undefined); return r.cookies; }
  async setCookie(cookies) {
    for (const c of cookies) { await this.send('Network.setCookie', c); }
  }
  async screenshot(path, opts = {}) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, ...opts });
    const b = Buffer.from(r.data, 'base64');
    await import('node:fs/promises').then(m => m.writeFile(path, b));
    return path;
  }
  async html() {
    return this.eval(`document.documentElement.outerHTML`);
  }
  async setUA(ua) { await this.send('Network.setUserAgentOverride', { userAgent: ua }); }
  async setViewport(width, height, ua) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    if (ua) await this.setUA(ua);
  }
  async click(selector) {
    return this.eval(`(function(){const el=document.querySelector(${JSON.stringify(selector)});if(!el) throw new Error('not found: ${selector}'.replace(/'/g,''));el.scrollIntoView({block:'center'});el.click();return true;})()`, { noGesture: false });
  }
  async typeInto(selector, text) {
    const expr = `(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) throw new Error('not found');
      el.focus(); el.scrollIntoView();
      const proto=el.tagName==='INPUT'||el.tagName==='TEXTAREA'?Object.getPrototypeOf(el):window.HTMLElement.prototype;
      const set=Object.getOwnPropertyDescriptor(proto,'value')?.set || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set;
      set?set.call(el,${JSON.stringify(text)}):(el.value=${JSON.stringify(text)});
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return el.value;
    })()`;
    return this.eval(expr);
  }
  async press(selector, keys) {
    for (const k of keys) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k.length === 1 ? 'Key' + k.toUpperCase() : k });
    }
  }
  async enterKey() {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  }
  // Mouse drag along a CSS-selector center point with realistic timing.
  // Useful for slider captchas. pct: how far across the slider track (0..1).
  async dragSlider(containerSelector, { fromX = 0, fromY = 0, distance, steps = 50, stepMs = 14, jitter = 1.5 } = {}) {
    const box = await this.eval(`(function(){
      const el=document.querySelector(${JSON.stringify(containerSelector)});
      if(!el) throw new Error('drag: container not found');
      const r=el.getBoundingClientRect();
      return {x:r.left+${fromX}, y:r.top+r.height/2+${fromY}, w:r.width, h:r.height, br:el.getBoundingClientRect().width};
    })()`);
    const x0 = box.x, y = box.y;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y, button: 'left', clickCount: 1 });
    let x = x0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // ease with small jitter to look human
      const eased = t;
      const jx = jitter * (Math.random() - 0.5);
      const jy = jitter * (Math.random() - 0.5);
      x = x0 + (distance * eased) + jx;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: y + jy });
      await this.wait(stepMs + Math.random() * 6);
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { x0, y, finalX: x, distance };
  }
  async mouseMoveTo(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
  async mouseClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async clickEvents(selector) {
    const rect = await this.eval(`(function(){
      const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) throw new Error('click: not found');
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2,vis:!!el.offsetParent};
    })()`);
    await this.mouseClick(rect.x, rect.y);
    return rect;
  }
  // Real keyboard typing through the CDP Input domain — guaranteed to update
  // React state (Ant Design / OTHER controlled inputs) since the browser sees
  // genuine key events from the focused element.
  async typeChars(selector, text, { clear = true, delayMs = 18 } = {}) {
    let rect;
    try { rect = await this.clickEvents(selector); } catch (e) {
      // fall back to JS focus
      await this.eval(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
    }
    if (clear) {
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      await this.wait(60);
    }
    for (const ch of String(text)) {
      const textArg = ch;
      const keyCode = ch.length === 1 ? ch.charCodeAt(0) : undefined;
      const code = (keyCode >= 65 && keyCode <= 90) ? 'Key' + ch.toUpperCase() : (ch === ' ' ? 'Space' : undefined);
      await this.send('Input.dispatchKeyEvent', {
        type: 'char', key: ch, text: textArg, unmodifiedText: textArg,
        code, windowsVirtualKeyCode: keyCode, modifiers: 0
      });
      await this.wait(delayMs + Math.random() * 6);
    }
    return rect;
  }
  async close() { try { this.ws.close(); } catch {} }
}

export async function attach({ logFile } = {}) {
  const t = await findPageTarget();
  const cdp = new CDP(t.webSocketDebuggerUrl, { logFile });
  await cdp.connect();
  return { cdp, target: t };
}

export async function hookNetwork(cdp, path) {
  const { appendFileSync } = await import('node:fs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(require_parent_of(path), { recursive: true });
  const write = (o) => appendFileSync(path, JSON.stringify(o) + '\n');
  cdp.on('Network.requestWillBeSent', (p) => {
    write({ e: 'req', id: p.requestId, t: p.timestamp, url: p.request.url, method: p.request.method,
      headers: p.request.headers, postData: p.request.postData || null, type: p.type, initiator: p.initiator?.type, frameId: p.frameId });
  });
  cdp.on('Network.responseReceived', (p) => {
    write({ e: 'res', id: p.requestId, t: p.timestamp, url: p.response.url, status: p.response.status,
      mime: p.response.mimeType, headers: p.response.headers, remote: p.response.remoteIPAddress, remotePort: p.response.remotePort });
  });
  cdp.on('Network.loadingFinished', async (p) => {
    let body = null, base64 = false;
    try {
      const r = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
      body = r.body; base64 = r.base64Encoded;
      if (body && body.length > 800000) body = body.slice(0, 800000) + '...[truncated]';
    } catch (err) {
      write({ e: 'body-err', id: p.requestId, msg: err.message });
      return;
    }
    write({ e: 'body', id: p.requestId, body, base64 });
  });
  cdp.on('Network.dataReceived', (p) => {
    write({ e: 'data', id: p.requestId, len: p.dataLength, t: p.timestamp });
  });
  cdp.on('Network.eventSourceMessageReceived', (p) => {
    write({ e: 'sse', id: p.requestId, ev: p.eventName, d: p.data });
  });
  cdp.on('Network.requestWillBeSentExtraInfo', (p) => {
    write({ e: 'req-extra', id: p.requestId, headers: p.headers });
  });
  cdp.on('Network.responseReceivedExtraInfo', (p) => {
    write({ e: 'res-extra', id: p.requestId, status: p.statusCode, headers: p.headers });
  });
}
function require_parent_of(path) {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '.';
}
