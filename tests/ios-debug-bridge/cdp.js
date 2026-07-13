'use strict';

/**
 * Minimal CDP (Chrome DevTools Protocol) client for a single Safari page
 * target exposed by remotedebug-ios-webkit-adapter.
 *
 * We use raw CDP instead of puppeteer.connect because this adapter does not
 * implement puppeteer's browser-level target handshake (puppeteer.connect
 * hangs forever). Talking directly to the page target's WebSocket works.
 */

const WebSocket = require('ws');

class CDPPage {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this._ws = null;
    this._id = 0;
    this._pending = new Map();
    this._handlers = {};
  }

  async attach({ enableTimeout = 20000, retries = 2 } = {}) {
    // iOS WebInspector + this adapter occasionally drop the FIRST
    // Runtime.enable after a fresh WebSocket connects (intermittent — the
    // same command succeeds on retry). Retry the whole open+enable once or
    // twice; do NOT loop-spam (that wedges the single inspector session).
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this._openAndEnable(enableTimeout);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }
    throw lastErr;
  }

  _openAndEnable(enableTimeout) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        try { this._ws && this._ws.close(); } catch {}
        reject(new Error('CDP enable timed out — device likely locked, backgrounded, or inspector link flaky'));
      }, enableTimeout);

      const ws = new WebSocket(this.wsUrl);
      this._ws = ws;

      const onMsg = (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (!msg || typeof msg !== 'object') return;
        if (typeof msg.id === 'number' && this._pending.has(msg.id)) {
          const fn = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          fn(msg);
        }
        if (msg.method && this._handlers[msg.method]) {
          this._handlers[msg.method].forEach((h) => h(msg.params));
        }
      };
      ws.on('message', onMsg);
      ws.on('error', (e) => { console.warn('[cdp] ws error:', e.message); });

      ws.on('open', async () => {
        try {
          for (const m of ['Runtime.enable', 'DOM.enable', 'Page.enable', 'Console.enable']) {
            await this._cmd(m);
          }
          clearTimeout(t);
          resolve();
        } catch (e) {
          clearTimeout(t);
          reject(e);
        }
      });
    });
  }

  on(method, handler) {
    (this._handlers[method] ||= []).push(handler);
  }

  _cmd(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      const t = setTimeout(() => { this._pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20000);
      this._pending.set(id, (msg) => {
        clearTimeout(t);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    // Accept either a string expression or a function (puppeteer-style).
    const src = typeof expression === 'function' ? `(${expression.toString()})()` : expression;
    const res = await this._cmd('Runtime.evaluate', {
      expression: src,
      returnByValue: true,
    });
    if (res && res.exceptionDetails) {
      throw new Error(res.exceptionDetails.text || 'eval exception');
    }
    return res && res.result ? res.result.value : undefined;
  }

  async title() {
    return this.evaluate('document.title');
  }

  async screenshot(path) {
    // iOS WebInspector (via this adapter) does not implement Page.captureScreenshot.
    throw new Error('Page.captureScreenshot not supported on iOS WebInspector');
  }

  detach() {
    if (this._ws) this._ws.close();
  }
}

module.exports = { CDPPage };
