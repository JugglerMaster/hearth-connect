// Home Assistant view (lights + HVAC) — hub-owned relay model.
//
// The kiosk NEVER connects to HA directly. The server (hub/Node) opens the HA
// WebSocket with the long-lived token and relays raw HA frames over the room
// signaling channel (HA_CONNECT / HA_CONNECTED / HA_FRAME / HA_DISCONNECTED).
// This keeps HA's (possibly self-signed) cert server-side and the token off
// the device. This module implements the HA protocol against that relay and
// renders a multi-page, editable dashboard of light/climate tiles.

(function () {
  'use strict';

  const HA = {
    sig: null,
    root: null,
    settings: { homeAssistant: { pages: [] } }, // url, pages[], hasToken
    entityStates: {}, // entityId -> { entity_id, state, attributes }
    allEntities: [], // every entity from get_states (for the picker)
    haNextId: 1,
    haConnected: false,
    haConnecting: false,
    reconnectTimer: null,
    reconnectAttempt: 0,
    reconnectMinMs: 1000,
    reconnectMaxMs: 30000,
    editing: false,
    draft: null, // deep copy of pages while editing
    dirty: false, // layout mutated in edit mode but not yet saved
    pickerSelected: null, // Set of entity ids selected in the picker (survives search filtering)
    initialized: false, // guards against double init on WS reconnect
    areaOf: {}, // entity_id -> area_id (from entity registry)
    areaName: {}, // area_id -> area name
    deviceOf: {}, // entity_id -> device_id
    deviceName: {}, // device_id -> device name
    pending: {}, // ws msg id -> 'area_registry' | 'entity_registry' | 'device_registry'
    currentPageId: null,
  };

  // ─── Helpers ────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function curatedEntityIds() {
    const pages = HA.editing && HA.draft ? HA.draft : (HA.settings.homeAssistant && HA.settings.homeAssistant.pages) || [];
    const page = pages.find((p) => p.id === (HA.currentPageId || (pages[0] && pages[0].id)));
    return page ? page.entities : [];
  }

  function allPages() {
    if (HA.editing && HA.draft) return HA.draft;
    return (HA.settings.homeAssistant && HA.settings.homeAssistant.pages) || [];
  }

  function domainOf(entityId) {
    const i = String(entityId).indexOf('.');
    return i < 0 ? '' : entityId.slice(0, i);
  }

  // Per-tile label override stored on the page (page.labels[entityId]).
  function labelFor(entityId) {
    const pages = allPages();
    const page = pages.find((p) => p.id === (HA.currentPageId || (pages[0] && pages[0].id)));
    const labels = page && page.labels;
    return labels && labels[entityId] ? labels[entityId] : null;
  }

  // ─── HA relay protocol ──────────────────────────────────

  function ensureConnected() {
    if (HA.haConnecting || HA.haConnected) return;
    if (!HA.settings.homeAssistant || !HA.settings.homeAssistant.hasToken) {
      setStatus('Home Assistant not configured — add URL + token in Server Settings', 'error');
      return;
    }
    HA.haConnecting = true;
    setStatus('Connecting to Home Assistant…', 'connecting');
    HA.sig.haConnect();
  }

  function onHaConnected() {
    HA.haConnected = true;
    HA.haConnecting = false;
    HA.reconnectAttempt = 0;
    setStatus('Connected to Home Assistant', 'ok');
    // Pull all entity states (used for tiles + picker) and subscribe to changes.
    HA.sig.haFrame({ id: HA.haNextId++, type: 'get_states' });
    HA.sig.haFrame({ id: HA.haNextId++, type: 'subscribe_events', event_type: 'state_changed' });
    // Pull area/device metadata so the picker can group by location then device.
    HA.pending[HA.haNextId] = 'area_registry';
    HA.sig.haFrame({ id: HA.haNextId++, type: 'config/area_registry/list' });
    HA.pending[HA.haNextId] = 'entity_registry';
    HA.sig.haFrame({ id: HA.haNextId++, type: 'config/entity_registry/list' });
    HA.pending[HA.haNextId] = 'device_registry';
    HA.sig.haFrame({ id: HA.haNextId++, type: 'config/device_registry/list' });
  }

  function onHaFrame(payload) {
    const msg = payload || {};
    if (msg.type === 'result' && msg.id === 1 && msg.success) {
      HA.allEntities = Array.isArray(msg.result) ? msg.result : [];
      for (const e of HA.allEntities) {
        if (e && e.entity_id) HA.entityStates[e.entity_id] = e;
      }
      renderTiles();
      return;
    }
    if (msg.type === 'event' && msg.event && msg.event.event_type === 'state_changed') {
      const data = msg.event.data || {};
      const newState = data.new_state;
      if (newState && newState.entity_id) {
        HA.entityStates[newState.entity_id] = newState;
        if (curatedEntityIds().indexOf(newState.entity_id) >= 0) renderTiles();
      }
      return;
    }
    if (msg.type === 'result' && msg.success) {
      const kind = HA.pending[msg.id];
      if (kind === 'area_registry') {
        buildAreaMap(msg.result);
        delete HA.pending[msg.id];
        refreshPickerIfOpen();
        return;
      }
      if (kind === 'entity_registry') {
        buildEntityMap(msg.result);
        delete HA.pending[msg.id];
        refreshPickerIfOpen();
        return;
      }
      if (kind === 'device_registry') {
        buildDeviceMap(msg.result);
        delete HA.pending[msg.id];
        refreshPickerIfOpen();
        return;
      }
    }
    // result for subscribe_events etc. — no client action needed.
  }

  function buildAreaMap(rows) {
    HA.areaName = {};
    (rows || []).forEach((a) => { if (a && a.area_id) HA.areaName[a.area_id] = a.name || a.area_id; });
  }

  function buildEntityMap(rows) {
    HA.areaOf = {};
    HA.deviceOf = {};
    (rows || []).forEach((e) => {
      if (!e || !e.entity_id) return;
      if (e.area_id) HA.areaOf[e.entity_id] = e.area_id;
      if (e.device_id) HA.deviceOf[e.entity_id] = e.device_id;
    });
  }

  function buildDeviceMap(rows) {
    HA.deviceName = {};
    (rows || []).forEach((d) => {
      const id = d && (d.id || d.device_id);
      if (id) HA.deviceName[id] = (d.name || id);
    });
  }

  // Sort key for the picker: location (area) → device → friendly name → id.
  function locKey(e) {
    const areaId = HA.areaOf[e.entity_id] || '';
    const areaName = (areaId && HA.areaName[areaId]) ? HA.areaName[areaId] : '';
    const devId = HA.deviceOf[e.entity_id] || '';
    const devName = (devId && HA.deviceName[devId]) ? HA.deviceName[devId] : '';
    const name = (e.attributes && (e.attributes.friendly_name || e.attributes.friendlyName)) || e.entity_id;
    return [
      areaName ? areaName.toLowerCase() : '~', // unlocated sort last
      devName ? devName.toLowerCase() : '~',
      (name || '').toLowerCase(),
      e.entity_id,
    ];
  }

  function cmpArr(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  }

  function refreshPickerIfOpen() {
    const overlay = HA.root && HA.root.querySelector('#haPickerOverlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      const search = HA.root.querySelector('#haPickerSearch');
      renderPickerList((search && search.value) || '');
    }
  }

  function onHaDisconnected() {
    HA.haConnected = false;
    HA.haConnecting = false;
    renderTiles();
    scheduleReconnect();
  }

  function onHaError(payload) {
    HA.haConnecting = false;
    setStatus('Home Assistant error: ' + ((payload && payload.message) || 'unknown'), 'error');
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (HA.reconnectTimer) return;
    const delay = Math.min(HA.reconnectMaxMs, HA.reconnectMinMs * Math.pow(2, HA.reconnectAttempt));
    HA.reconnectAttempt++;
    HA.reconnectTimer = setTimeout(() => {
      HA.reconnectTimer = null;
      ensureConnected();
    }, delay);
  }

  // ─── Calling services ───────────────────────────────────

  function callService(domain, service, serviceData) {
    if (!HA.haConnected) return;
    HA.sig.haFrame({
      id: HA.haNextId++,
      type: 'call_service',
      domain,
      service,
      service_data: serviceData,
    });
  }

  // ─── Rendering ──────────────────────────────────────────

  function setStatus(text, kind) {
    const el = HA.root && HA.root.querySelector('#haStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'ha-status ha-status-' + (kind || 'info');
  }

  function renderTabs() {
    const tabsEl = HA.root.querySelector('#haTabs');
    if (!tabsEl) return;
    const pages = allPages();
    let html = '';
    for (const p of pages) {
      const active = (p.id === (HA.currentPageId || (pages[0] && pages[0].id))) ? ' active' : '';
      html += `<button class="ha-tab${active}" data-page="${esc(p.id)}">${esc(p.name)}</button>`;
    }
    if (HA.editing) {
      html += `<button class="ha-tab ha-tab-add" data-addpage="1">+ Page</button>`;
    }
    tabsEl.innerHTML = html;
    tabsEl.querySelectorAll('.ha-tab[data-page]').forEach((b) => {
      b.addEventListener('click', () => {
        HA.currentPageId = b.getAttribute('data-page');
        renderTabs();
        renderTiles();
      });
    });
    const addBtn = tabsEl.querySelector('[data-addpage]');
    if (addBtn) addBtn.addEventListener('click', addPage);
  }

  function tileRemoveBtn(entityId) {
    return `<button class="ha-tile-remove" data-remove="${esc(entityId)}" title="Remove">×</button>`;
  }

  function tileRenameBtn(entityId) {
    return `<button class="ha-tile-rename-btn" data-rename="${esc(entityId)}" title="Rename">✎</button>`;
  }

  function editControls(entityId) {
    if (!HA.editing) return '';
    return tileRenameBtn(entityId) + tileRemoveBtn(entityId);
  }

  function offTile(entityId, name, st) {
    return (
      `<div class="ha-tile ha-tile-off">` +
      `<div class="ha-tile-name">${esc(name)}</div>` +
      `<div class="ha-tile-sub">${st && st.state === 'unavailable' ? 'unavailable' : 'unknown'}</div>` +
      editControls(entityId) +
      `</div>`
    );
  }

  function genericTileHtml(entityId, st, name) {
    return (
      `<div class="ha-tile">` +
      `<div class="ha-tile-name">${esc(name)}</div>` +
      `<div class="ha-tile-sub">${esc(st.state)}</div>` +
      editControls(entityId) +
      `</div>`
    );
  }

  function toggleTileHtml(entityId, st, name, domain) {
    const on = st.state === 'on';
    return (
      `<div class="ha-tile ${on ? 'ha-tile-on' : 'ha-tile-off'}">` +
      `<div class="ha-tile-name">${esc(name)}</div>` +
      `<button class="ha-btn ha-toggle" data-entity="${esc(entityId)}" data-domain="${esc(domain)}">${on ? 'On' : 'Off'}</button>` +
      editControls(entityId) +
      `</div>`
    );
  }

  function selectTileHtml(entityId, st, name) {
    const options = (st.attributes && st.attributes.options) || [];
    const cur = st.state;
    const opts = options
      .map((o) => `<option value="${esc(o)}"${o === cur ? ' selected' : ''}>${esc(o)}</option>`)
      .join('');
    return (
      `<div class="ha-tile ha-tile-select">` +
      `<div class="ha-tile-name">${esc(name)}</div>` +
      `<select class="ha-select" data-select="${esc(entityId)}" style="max-width:100%;padding:6px 8px;border-radius:8px;border:1px solid #444;background:#1c1c22;color:#fff;">${opts}</select>` +
      editControls(entityId) +
      `</div>`
    );
  }

  function pressTileHtml(entityId, st, name, domain) {
    const label = domain === 'scene' ? 'Activate' : (domain === 'script' ? 'Run' : 'Press');
    return (
      `<div class="ha-tile ha-tile-press">` +
      `<div class="ha-tile-name">${esc(name)}</div>` +
      `<button class="ha-btn ha-press" data-entity="${esc(entityId)}" data-domain="${esc(domain)}">${label}</button>` +
      editControls(entityId) +
      `</div>`
    );
  }

  function fanTileHtml(entityId, st, name) {
    const on = st.state === 'on';
    const pct = st.attributes && st.attributes.percentage;
    let html =
      `<div class="ha-tile ${on ? 'ha-tile-on' : 'ha-tile-off'}">` +
      `<div class="ha-tile-name">${esc(name)}</div>` +
      `<button class="ha-btn ha-toggle" data-entity="${esc(entityId)}" data-domain="fan">${on ? 'On' : 'Off'}</button>`;
    if (typeof pct === 'number') {
      html +=
        `<div class="ha-bright">` +
        `<input type="range" min="0" max="100" value="${pct}" data-fanpct="${esc(entityId)}">` +
        `<span>${pct}%</span>` +
        `</div>`;
    }
    if (HA.editing) html += editControls(entityId);
    html += `</div>`;
    return html;
  }

  function numberTileHtml(entityId, st, name, domain) {
    const raw = parseFloat(st.state);
    const val = isNaN(raw) ? null : raw;
    const min = (st.attributes && st.attributes.min) != null ? parseFloat(st.attributes.min) : 0;
    const max = (st.attributes && st.attributes.max) != null ? parseFloat(st.attributes.max) : 100;
    const step = (st.attributes && st.attributes.step) != null ? parseFloat(st.attributes.step) : 1;
    const unit = (st.attributes && st.attributes.unit_of_measurement) || '';
    let html =
      `<div class="ha-tile ha-tile-number">` +
      `<div class="ha-tile-name">${esc(name)}</div>` +
      `<div class="ha-setpoint">` +
      `<button class="ha-btn" data-number="${esc(entityId)}" data-domain="${esc(domain)}" data-delta="${-step}">−</button>` +
      `<span class="ha-temp" data-number-val="${esc(entityId)}" data-min="${min}" data-max="${max}" data-step="${step}">${val == null ? esc(st.state) : val + (unit ? unit : '')}</span>` +
      `<button class="ha-btn" data-number="${esc(entityId)}" data-domain="${esc(domain)}" data-delta="${step}">+</button>` +
      `</div>`;
    if (HA.editing) html += editControls(entityId);
    html += `</div>`;
    return html;
  }

  function tileHtml(entityId) {
    const st = HA.entityStates[entityId];
    const domain = domainOf(entityId);
    const override = labelFor(entityId);
    const name = override || (st && st.attributes && (st.attributes.friendly_name || st.attributes.friendlyName)) || entityId;
    if (!st || st.state === 'unavailable') return offTile(entityId, name, st);
    switch (domain) {
      case 'light': return lightTileHtml(entityId, st, name);
      case 'climate': return climateTileHtml(entityId, st, name);
      case 'switch':
      case 'input_boolean': return toggleTileHtml(entityId, st, name, domain);
      case 'select': return selectTileHtml(entityId, st, name);
      case 'scene':
      case 'script':
      case 'button': return pressTileHtml(entityId, st, name, domain);
      case 'fan': return fanTileHtml(entityId, st, name);
      case 'number':
      case 'input_number': return numberTileHtml(entityId, st, name, domain);
      default: return genericTileHtml(entityId, st, name);
    }
  }

  function lightTileHtml(entityId, st, name) {
    const on = st.state === 'on';
    const brightness = st.attributes && st.attributes.brightness; // 0-255 or undefined
    let html =
      `<div class="ha-tile ${on ? 'ha-tile-on' : 'ha-tile-off'}">` +
      `<div class="ha-tile-name">${esc(name)}</div>` +
      `<button class="ha-btn ha-toggle" data-entity="${esc(entityId)}" data-domain="light">` +
      `${on ? 'On' : 'Off'}</button>`;
    if (typeof brightness === 'number') {
      const pct = Math.round((brightness / 255) * 100);
      html +=
        `<div class="ha-bright">` +
        `<input type="range" min="0" max="255" value="${brightness}" data-brightness="${esc(entityId)}">` +
        `<span>${pct}%</span>` +
        `</div>`;
    }
    if (HA.editing) html += editControls(entityId);
    html += `</div>`;
    return html;
  }

  function climateTileHtml(entityId, st, name) {
    const modes = (st.attributes && st.attributes.hvac_modes) || [];
    const curMode = st.state;
    const curTemp = st.attributes && st.attributes.current_temperature;
    const target = st.attributes && st.attributes.temperature;
    const minT = st.attributes && st.attributes.min_temp != null ? st.attributes.min_temp : 7;
    const maxT = st.attributes && st.attributes.max_temp != null ? st.attributes.max_temp : 35;
    let html =
      `<div class="ha-tile ha-tile-climate">` +
      `<div class="ha-tile-name">${esc(name)}</div>` +
      `<div class="ha-tile-sub">${target != null ? esc(target) + '° target' : '—'}${curTemp != null ? ' · now ' + curTemp + '°' : ''}</div>` +
      `<div class="ha-modes">`;
    for (const m of modes) {
      html += `<button class="ha-btn ha-mode${m === curMode ? ' active' : ''}" data-entity="${esc(entityId)}" data-domain="climate" data-hvac-mode="${esc(m)}">${esc(m)}</button>`;
    }
    html += `</div>`;
    if (target != null) {
      html +=
        `<div class="ha-setpoint">` +
        `<button class="ha-btn" data-temp="${esc(entityId)}" data-delta="-1">−</button>` +
        `<span class="ha-temp" data-edit-temp="${esc(entityId)}" data-min="${minT}" data-max="${maxT}">${target}°</span>` +
        `<button class="ha-btn" data-temp="${esc(entityId)}" data-delta="1">+</button>` +
        `</div>`;
    }
    if (HA.editing) html += editControls(entityId);
    html += `</div>`;
    return html;
  }

  function renderTiles() {
    const tilesEl = HA.root.querySelector('#haTiles');
    if (!tilesEl) return;
    const ids = curatedEntityIds();
    if (!ids.length) {
      tilesEl.innerHTML = `<div class="ha-empty">No entities on this page. ${HA.editing ? 'Use “Add entities” to choose lights/HVAC.' : 'Open Server Settings → Home Assistant to edit the layout.'}</div>`;
      return;
    }
    tilesEl.innerHTML = ids.map(tileHtml).join('');
    bindTileListeners(tilesEl);
  }

  function bindTileListeners(tilesEl) {
    tilesEl.querySelectorAll('.ha-toggle').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-entity');
        const domain = b.getAttribute('data-domain') || 'light';
        const currentlyOff = b.textContent.trim() === 'Off';
        if (currentlyOff) {
          if (domain === 'light') {
            const slider = tilesEl.querySelector('[data-brightness="' + cssEsc(id) + '"]');
            const svc = slider ? { entity_id: id, brightness: parseInt(slider.value, 10) } : { entity_id: id };
            callService('light', 'turn_on', svc);
          } else {
            callService(domain, 'turn_on', { entity_id: id });
          }
        } else {
          callService(domain, 'turn_off', { entity_id: id });
        }
      });
    });
    tilesEl.querySelectorAll('[data-brightness]').forEach((s) => {
      s.addEventListener('change', () => {
        const id = s.getAttribute('data-brightness');
        callService('light', 'turn_on', { entity_id: id, brightness: parseInt(s.value, 10) });
      });
    });
    tilesEl.querySelectorAll('[data-select]').forEach((s) => {
      s.addEventListener('change', () => {
        const id = s.getAttribute('data-select');
        callService('select', 'select_option', { entity_id: id, option: s.value });
      });
    });
    tilesEl.querySelectorAll('.ha-press').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-entity');
        const domain = b.getAttribute('data-domain');
        if (domain === 'button') callService('button', 'press', { entity_id: id });
        else if (domain === 'script') callService('script', 'turn_on', { entity_id: id });
        else callService('scene', 'turn_on', { entity_id: id });
      });
    });
    tilesEl.querySelectorAll('[data-fanpct]').forEach((s) => {
      s.addEventListener('change', () => {
        const id = s.getAttribute('data-fanpct');
        callService('fan', 'set_percentage', { entity_id: id, percentage: parseInt(s.value, 10) });
      });
    });
    tilesEl.querySelectorAll('[data-number]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-number');
        const domain = b.getAttribute('data-domain') || 'number';
        const delta = parseFloat(b.getAttribute('data-delta'));
        const valEl = tilesEl.querySelector('[data-number-val="' + cssEsc(id) + '"]');
        if (!valEl) return;
        const min = parseFloat(valEl.getAttribute('data-min'));
        const max = parseFloat(valEl.getAttribute('data-max'));
        const step = parseFloat(valEl.getAttribute('data-step')) || 1;
        const cur = parseFloat(valEl.textContent) || 0;
        let next = Math.round((cur + delta) / step) * step;
        next = Math.min(max, Math.max(min, next));
        callService(domain, 'set_value', { entity_id: id, value: next });
      });
    });
    tilesEl.querySelectorAll('.ha-mode').forEach((b) => {
      b.addEventListener('click', () => {
        callService('climate', 'set_hvac_mode', { entity_id: b.getAttribute('data-entity'), hvac_mode: b.getAttribute('data-hvac-mode') });
      });
    });
    tilesEl.querySelectorAll('[data-temp]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-temp');
        const delta = parseInt(b.getAttribute('data-delta'), 10);
        const st = HA.entityStates[id];
        const cur = st && st.attributes && st.attributes.temperature;
        if (cur == null) return;
        const minT = st.attributes.min_temp != null ? st.attributes.min_temp : 7;
        const maxT = st.attributes.max_temp != null ? st.attributes.max_temp : 35;
        const next = Math.min(maxT, Math.max(minT, Math.round(cur) + delta));
        callService('climate', 'set_temperature', { entity_id: id, temperature: next });
      });
    });
    tilesEl.querySelectorAll('[data-edit-temp]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-edit-temp');
        const minT = parseFloat(el.getAttribute('data-min'));
        const maxT = parseFloat(el.getAttribute('data-max'));
        const cur = parseFloat(el.textContent);
        const v = window.prompt ? window.prompt('Target temperature', String(cur)) : null;
        if (v == null) return;
        const next = Math.min(maxT, Math.max(minT, parseFloat(v)));
        if (isNaN(next)) return;
        callService('climate', 'set_temperature', { entity_id: id, temperature: next });
      });
    });
    tilesEl.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', () => removeEntity(b.getAttribute('data-remove')));
    });
    tilesEl.querySelectorAll('[data-rename]').forEach((b) => {
      b.addEventListener('click', () => renameEntity(b.getAttribute('data-rename')));
    });
  }

  function cssEsc(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  // ─── Edit mode ──────────────────────────────────────────

  function toggleEdit() {
    if (!HA.editing) {
      HA.draft = JSON.parse(JSON.stringify(allPages()));
      if (!HA.draft.length) HA.draft.push({ id: 'p' + Date.now(), name: 'Home', entities: [] });
      HA.editing = true;
      HA.dirty = false;
    } else {
      HA.editing = false;
      HA.draft = null;
      HA.dirty = false;
    }
    renderEditorBar();
    renderTabs();
    renderTiles();
  }

  function addPage() {
    if (!HA.editing || !HA.draft) return;
    HA.draft.push({ id: 'p' + Date.now() + '-' + Math.random().toString(36).slice(2, 5), name: 'New Page', entities: [] });
    HA.currentPageId = HA.draft[HA.draft.length - 1].id;
    HA.dirty = true;
    renderEditorBar();
    renderTabs();
    renderTiles();
  }

  function removeEntity(entityId) {
    if (!HA.editing || !HA.draft) return;
    const page = HA.draft.find((p) => p.id === (HA.currentPageId || (HA.draft[0] && HA.draft[0].id)));
    if (page) page.entities = page.entities.filter((e) => e !== entityId);
    HA.dirty = true;
    renderEditorBar();
    renderTiles();
  }

  function renameEntity(entityId) {
    if (!HA.editing || !HA.draft) return;
    const page = HA.draft.find((p) => p.id === (HA.currentPageId || (HA.draft[0] && HA.draft[0].id)));
    if (!page) return;
    if (!page.labels) page.labels = {};
    const st = HA.entityStates[entityId];
    const cur = page.labels[entityId] ||
      (st && st.attributes && (st.attributes.friendly_name || st.attributes.friendlyName)) || entityId;
    const v = window.prompt ? window.prompt('Tile label (blank to reset to HA name):', cur) : null;
    if (v == null) return;
    const trimmed = v.trim();
    if (trimmed === '') delete page.labels[entityId];
    else page.labels[entityId] = trimmed;
    HA.dirty = true;
    renderEditorBar();
    renderTiles();
  }

  function renamePage() {
    if (!HA.editing || !HA.draft) return;
    const page = HA.draft.find((p) => p.id === (HA.currentPageId || (HA.draft[0] && HA.draft[0].id)));
    if (!page) return;
    const v = window.prompt ? window.prompt('Page name:', page.name) : null;
    if (v == null) return;
    const trimmed = v.trim();
    if (!trimmed) return;
    page.name = trimmed;
    HA.dirty = true;
    renderEditorBar();
    renderTabs();
  }

  function renderEditorBar() {
    const bar = HA.root.querySelector('#haEditBar');
    if (!bar) return;
    if (!HA.editing) {
      bar.innerHTML = `<button class="ha-btn ha-edit" data-edit="1">Edit layout</button>`;
      const b = bar.querySelector('[data-edit]');
      if (b) b.addEventListener('click', toggleEdit);
    } else {
      const unsaved = HA.dirty
        ? `<span class="ha-unsaved" style="color:#ffb020;font-weight:600;margin-right:8px;align-self:center;">● Not saved</span>`
        : '';
      bar.innerHTML =
        unsaved +
        `<button class="ha-btn ha-add" data-pick="1">Add entities</button>` +
        `<button class="ha-btn ha-rename-page" data-renamepage="1">Rename page</button>` +
        `<button class="ha-btn ha-save" data-save="1">Save</button>` +
        `<button class="ha-btn ha-cancel" data-cancel="1">Cancel</button>`;
      bar.querySelector('[data-pick]').addEventListener('click', openPicker);
      bar.querySelector('[data-renamepage]').addEventListener('click', renamePage);
      bar.querySelector('[data-save]').addEventListener('click', saveLayout);
      bar.querySelector('[data-cancel]').addEventListener('click', toggleEdit);
    }
  }

  function saveLayout() {
    if (!HA.draft) return;
    HA.sig.setSettings('homeAssistant', { pages: HA.draft });
  }

  function onSettingsResult(payload) {
    if (payload && payload.settings && payload.settings.homeAssistant) {
      HA.settings.homeAssistant = payload.settings.homeAssistant;
      if (!HA.currentPageId && HA.settings.homeAssistant.pages && HA.settings.homeAssistant.pages[0]) {
        HA.currentPageId = HA.settings.homeAssistant.pages[0].id;
      }
    }
    if (!HA.editing) {
      renderEditorBar();
      renderTabs();
      renderTiles();
    }
    renderHaSettings();
    if (HA.editing && HA.draft && payload && payload.ok) {
      HA.editing = false;
      HA.draft = null;
      HA.dirty = false;
      renderEditorBar();
      renderTabs();
      renderTiles();
    }
    ensureConnected();
  }

  // ─── HA connection settings (gear button) ──────────────

  function renderHaSettings() {
    const overlay = HA.root && HA.root.querySelector('#haSettingsOverlay');
    if (overlay && !overlay.classList.contains('hidden')) return; // don't clobber while open
    const ha = HA.settings.homeAssistant;
    const urlEl = HA.root && HA.root.querySelector('#haUrl');
    const noteEl = HA.root && HA.root.querySelector('#haConfiguredNote');
    if (urlEl && ha && ha.url) urlEl.value = ha.url;
    if (noteEl) {
      const hasToken = !!(ha && ha.hasToken);
      noteEl.textContent = hasToken ? 'Token: configured' : 'Token: not set';
      noteEl.className = 'ha-settings-row' + (hasToken ? ' ha-ok' : '');
    }
  }

  function openHaSettings() {
    renderHaSettings();
    const overlay = HA.root && HA.root.querySelector('#haSettingsOverlay');
    if (overlay) overlay.classList.remove('hidden');
  }

  function closeHaSettings() {
    const overlay = HA.root && HA.root.querySelector('#haSettingsOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function saveHaSettings() {
    const urlEl = HA.root && HA.root.querySelector('#haUrl');
    const tokenEl = HA.root && HA.root.querySelector('#haToken');
    const noteEl = HA.root && HA.root.querySelector('#haConfiguredNote');
    const url = urlEl ? urlEl.value.trim() : '';
    const token = tokenEl ? tokenEl.value : '';
    const value = { url };
    if (token) value.token = token; // only send when the user entered one
    HA.sig.setSettings('homeAssistant', value);
    if (tokenEl) tokenEl.value = '';
    if (noteEl) { noteEl.textContent = 'Saved.'; noteEl.className = 'ha-settings-row ha-ok'; }
  }

  // ─── Picker ─────────────────────────────────────────────

  function openPicker() {
    const overlay = HA.root.querySelector('#haPickerOverlay');
    if (!overlay) return;
    const page = HA.draft.find((p) => p.id === (HA.currentPageId || (HA.draft[0] && HA.draft[0].id)));
    // Track selections in a Set so they survive list re-renders from search
    // filtering (checkboxes for non-matching entities leave the DOM, but the
    // selection must not be lost).
    HA.pickerSelected = new Set(page && page.entities ? page.entities : []);
    renderPickerList('');
    overlay.classList.remove('hidden');
    const search = HA.root.querySelector('#haPickerSearch');
    if (search) {
      search.value = '';
      search.oninput = () => renderPickerList(search.value || '');
    }
  }

  function closePicker() {
    const overlay = HA.root.querySelector('#haPickerOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function renderPickerList(filter) {
    const listEl = HA.root.querySelector('#haPickerList');
    if (!listEl) return;
    const f = (filter || '').toLowerCase();
    const ALLOWED = ['light', 'climate', 'switch', 'input_boolean', 'select', 'scene', 'script', 'button', 'fan', 'sensor', 'binary_sensor', 'number', 'input_number'];
    const items = HA.allEntities
      .filter((e) => {
        const d = domainOf(e.entity_id);
        if (ALLOWED.indexOf(d) < 0) return false;
        if (!f) return true;
        const name = (e.attributes && (e.attributes.friendly_name || e.attributes.friendlyName)) || '';
        return e.entity_id.toLowerCase().includes(f) || String(name).toLowerCase().includes(f);
      })
      .sort((a, b) => cmpArr(locKey(a), locKey(b)));
    listEl.innerHTML = items
      .map((e) => {
        const name = (e.attributes && (e.attributes.friendly_name || e.attributes.friendlyName)) || e.entity_id;
        const areaId = HA.areaOf[e.entity_id];
        const areaName = (areaId && HA.areaName[areaId]) ? HA.areaName[areaId] : '';
        const devId = HA.deviceOf[e.entity_id];
        const devName = (devId && HA.deviceName[devId]) ? HA.deviceName[devId] : '';
        const sub = [areaName, devName].filter(Boolean).join(' · ') || e.entity_id;
        const checked = HA.pickerSelected && HA.pickerSelected.has(e.entity_id) ? ' checked' : '';
        return (
          `<label class="ha-pick-item">` +
          `<input type="checkbox" data-pick-entity="${esc(e.entity_id)}"${checked}>` +
          `<span>${esc(name)} <small>${esc(sub)}</small></span>` +
          `</label>`
        );
      })
      .join('');
    // Keep the Set in sync as the user toggles individual checkboxes,
    // regardless of the current search filter.
    Array.from(listEl.querySelectorAll('input[data-pick-entity]')).forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = cb.getAttribute('data-pick-entity');
        if (!HA.pickerSelected) HA.pickerSelected = new Set();
        if (cb.checked) HA.pickerSelected.add(id);
        else HA.pickerSelected.delete(id);
      });
    });
  }

  function applyPicker() {
    if (!HA.draft) return;
    const page = HA.draft.find((p) => p.id === (HA.currentPageId || (HA.draft[0] && HA.draft[0].id)));
    if (!page) return;
    page.entities = Array.from(HA.pickerSelected || []);
    HA.dirty = true;
    closePicker();
    renderEditorBar();
    renderTiles();
  }

  // ─── Init ───────────────────────────────────────────────

  function bindSettings() {
    HA.sig.on('settingsResult', onSettingsResult);
    HA.sig.on('settingsUpdated', (p) => {
      if (!HA.editing && p && p.settings && p.settings.homeAssistant) {
        HA.settings.homeAssistant = p.settings.homeAssistant;
        renderTabs();
        renderTiles();
      }
    });
    HA.sig.on('haConnected', onHaConnected);
    HA.sig.on('haFrame', onHaFrame);
    HA.sig.on('haDisconnected', onHaDisconnected);
    HA.sig.on('haError', onHaError);
  }

  function init(sig, root) {
    // The WS reconnect handler calls init() on every (re)connection. Only
    // wire listeners and fetch settings once; the SignalingClient keeps its
    // listeners across reconnects.
    if (HA.initialized) {
      HA.sig = sig;
      HA.root = root || HA.root;
      return;
    }
    HA.initialized = true;
    HA.sig = sig;
    HA.root = root || (typeof document !== 'undefined' ? document.getElementById('haRoot') : null);
    bindSettings();
    renderEditorBar();
    HA.sig.getSettings();
    const okBtn = HA.root && HA.root.querySelector('#haPickerOk');
    if (okBtn) okBtn.addEventListener('click', applyPicker);
    const closeBtn = HA.root && HA.root.querySelector('#haPickerClose');
    if (closeBtn) closeBtn.addEventListener('click', closePicker);
    const gearBtn = HA.root && HA.root.querySelector('#haGearBtn');
    if (gearBtn) gearBtn.addEventListener('click', openHaSettings);
    const setClose = HA.root && HA.root.querySelector('#haSettingsClose');
    if (setClose) setClose.addEventListener('click', closeHaSettings);
    const haSave = HA.root && HA.root.querySelector('#haSaveBtn');
    if (haSave) haSave.addEventListener('click', saveHaSettings);
  }

  function autoInit() {
    if (typeof document === 'undefined') return;
    if (!document.getElementById('haRoot')) return;
    const sig = new SignalingClient();
    const deviceId = localStorage.getItem('hearth_baseDeviceId') || 'base-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    localStorage.setItem('hearth_baseDeviceId', deviceId);
    sig.deviceId = deviceId;
    sig.deviceType = 'base';
    sig.deviceLabel = 'Base Station';
    sig.connect();
    sig.on('open', () => {
      sig.joinRoom('default', deviceId);
      // Get settings only after the socket is OPEN — send() drops messages
      // while CONNECTING, which would leave the page stuck on "Loading…".
      init(sig, document.getElementById('haRoot'));
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoInit);
    } else {
      autoInit();
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { HA, init, ensureConnected };
  }
  if (typeof window !== 'undefined') {
    window.HA = HA;
  }
})();
