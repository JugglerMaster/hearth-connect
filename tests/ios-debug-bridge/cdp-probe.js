#!/usr/bin/env node
'use strict';
// CDP attach probe (clean state: adapter manages its own proxy). Attaches to
// the device tab ONCE, enables domains, reads title + connection dot, detaches.
// No navigation, no re-attach — isolates whether Runtime.enable now succeeds.
const http = require('http');
const { CDPPage } = require('/home/dadisc01/Documents/hearth-connect/tests/ios-debug-bridge/cdp');
const ap = parseInt(process.env.ADAPTER_PORT || '9000', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gj = (u) => new Promise((res, rej) => { http.get(u, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>{try{res(JSON.parse(b))}catch(e){rej(e)}}); }).on('error', rej); });
(async () => {
  const tabs = await gj(`http://localhost:${ap}/json`);
  const real = tabs.filter(t => t.webSocketDebuggerUrl && t.url && !t.url.startsWith('data:'));
  console.log('usable tabs:', real.map(t => t.title + ' ' + t.url));
  if (!real.length) { console.log('NO TABS'); process.exit(1); }
  const p = new CDPPage(real[0].webSocketDebuggerUrl);
  await p.attach(); // single attempt
  console.log('ATTACH OK');
  console.log('title:', await p.title());
  const dot = await p.evaluate(() => { const d=document.getElementById('connectionDot'); return d?d.className:null; }).catch(e=>'eval-err:'+e.message);
  console.log('connectionDot:', dot);
  await p.detach();
  console.log('DETACH OK');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
