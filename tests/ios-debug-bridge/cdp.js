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

  async attach() {
    return new Promise((resolve, reject) => {
      this._ws = new WebSocket(this.wsUrl);
      this._ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.id && this._pending.has(msg.id)) {
          const fn = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          fn(msg);
        }
        if (msg.method && this._handlers[msg.method]) {
          this._handlers[msg.method].forEach((h) => h(msg.params));
        }
      });
      this._ws.on('error', reject);
      this._ws.on('open', async () => {
        try {
          await this._cmd('Runtime.enable');
          await this._cmd('DOM.enable');
          await this._cmd('Page.enable');
          resolve();
        } catch (e) { reject(e); }
      });
    });
  }

  on(method, handler) {
    (this._handlers[method] ||= []).push(handler);
  }

  _cmd(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._id;
      const t = setTimeout(() => { this._pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 8000);
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
