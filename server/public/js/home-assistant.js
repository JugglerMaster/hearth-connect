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
    // result for subscribe_events etc. — no client action needed.
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

  function tileHtml(entityId) {
    const st = HA.entityStates[entityId];
    const domain = domainOf(entityId);
    const name = (st && st.attributes && (st.attributes.friendly_name || st.attributes.friendlyName)) || entityId;
    if (!st || st.state === 'unavailable') {
      return (
        `<div class="ha-tile ha-tile-off">` +
        `<div class="ha-tile-name">${esc(name)}</div>` +
        `<div class="ha-tile-sub">${st && st.state === 'unavailable' ? 'unavailable' : 'unknown'}</div>` +
        (HA.editing ? tileRemoveBtn(entityId) : '') +
        `</div>`
      );
    }
    if (domain === 'light') return lightTileHtml(entityId, st, name);
    if (domain === 'climate') return climateTileHtml(entityId, st, name);
    return (
      `<div class="ha-tile">` +
      `<div class="ha-tile-name">${esc(name)}</div>` +
      `<div class="ha-tile-sub">${esc(st.state)}</div>` +
      (HA.editing ? tileRemoveBtn(entityId) : '') +
      `</div>`
    );
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
    if (HA.editing) html += tileRemoveBtn(entityId);
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
      `<div class="ha-tile-sub">now ${curTemp != null ? curTemp + '°' : '—'}</div>` +
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
    if (HA.editing) html += tileRemoveBtn(entityId);
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
        const currentlyOff = b.textContent.trim() === 'Off';
        if (currentlyOff) {
          const slider = tilesEl.querySelector('[data-brightness="' + cssEsc(id) + '"]');
          const svc = slider ? { entity_id: id, brightness: parseInt(slider.value, 10) } : { entity_id: id };
          callService('light', 'turn_on', svc);
        } else {
          callService('light', 'turn_off', { entity_id: id });
        }
      });
    });
    tilesEl.querySelectorAll('[data-brightness]').forEach((s) => {
      s.addEventListener('change', () => {
        const id = s.getAttribute('data-brightness');
        callService('light', 'turn_on', { entity_id: id, brightness: parseInt(s.value, 10) });
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
    } else {
      HA.editing = false;
      HA.draft = null;
    }
    renderEditorBar();
    renderTabs();
    renderTiles();
  }

  function addPage() {
    if (!HA.editing || !HA.draft) return;
    HA.draft.push({ id: 'p' + Date.now() + '-' + Math.random().toString(36).slice(2, 5), name: 'New Page', entities: [] });
    HA.currentPageId = HA.draft[HA.draft.length - 1].id;
    renderTabs();
    renderTiles();
  }

  function removeEntity(entityId) {
    if (!HA.editing || !HA.draft) return;
    const page = HA.draft.find((p) => p.id === (HA.currentPageId || (HA.draft[0] && HA.draft[0].id)));
    if (page) page.entities = page.entities.filter((e) => e !== entityId);
    renderTiles();
  }

  function renderEditorBar() {
    const bar = HA.root.querySelector('#haEditBar');
    if (!bar) return;
    if (!HA.editing) {
      bar.innerHTML = `<button class="ha-btn ha-edit" data-edit="1">Edit layout</button>`;
      const b = bar.querySelector('[data-edit]');
      if (b) b.addEventListener('click', toggleEdit);
    } else {
      bar.innerHTML =
        `<button class="ha-btn ha-add" data-pick="1">Add entities</button>` +
        `<button class="ha-btn ha-save" data-save="1">Save</button>` +
        `<button class="ha-btn ha-cancel" data-cancel="1">Cancel</button>`;
      bar.querySelector('[data-pick]').addEventListener('click', openPicker);
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
      renderTabs();
      renderTiles();
    }
    if (HA.editing && HA.draft && payload && payload.ok) {
      HA.editing = false;
      HA.draft = null;
      renderEditorBar();
      renderTabs();
      renderTiles();
    }
    ensureConnected();
  }

  // ─── Picker ─────────────────────────────────────────────

  function openPicker() {
    const overlay = HA.root.querySelector('#haPickerOverlay');
    if (!overlay) return;
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
    const page = HA.draft.find((p) => p.id === (HA.currentPageId || (HA.draft[0] && HA.draft[0].id)));
    const selected = page ? page.entities : [];
    const f = (filter || '').toLowerCase();
    const items = HA.allEntities
      .filter((e) => {
        const d = domainOf(e.entity_id);
        if (d !== 'light' && d !== 'climate') return false;
        if (!f) return true;
        const name = (e.attributes && (e.attributes.friendly_name || e.attributes.friendlyName)) || '';
        return e.entity_id.toLowerCase().includes(f) || String(name).toLowerCase().includes(f);
      })
      .sort((a, b) => a.entity_id.localeCompare(b.entity_id));
    listEl.innerHTML = items
      .map((e) => {
        const name = (e.attributes && (e.attributes.friendly_name || e.attributes.friendlyName)) || e.entity_id;
        const checked = selected.indexOf(e.entity_id) >= 0 ? ' checked' : '';
        return (
          `<label class="ha-pick-item">` +
          `<input type="checkbox" data-pick-entity="${esc(e.entity_id)}"${checked}>` +
          `<span>${esc(name)} <small>${esc(e.entity_id)}</small></span>` +
          `</label>`
        );
      })
      .join('');
  }

  function applyPicker() {
    if (!HA.draft) return;
    const page = HA.draft.find((p) => p.id === (HA.currentPageId || (HA.draft[0] && HA.draft[0].id)));
    if (!page) return;
    const checked = Array.from(HA.root.querySelectorAll('[data-pick-entity]:checked')).map((c) => c.getAttribute('data-pick-entity'));
    page.entities = checked.slice();
    closePicker();
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
    HA.sig = sig;
    HA.root = root || (typeof document !== 'undefined' ? document.getElementById('haRoot') : null);
    bindSettings();
    HA.sig.getSettings();
    const okBtn = HA.root && HA.root.querySelector('#haPickerOk');
    if (okBtn) okBtn.addEventListener('click', applyPicker);
    const closeBtn = HA.root && HA.root.querySelector('#haPickerClose');
    if (closeBtn) closeBtn.addEventListener('click', closePicker);
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
    });
    init(sig, document.getElementById('haRoot'));
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
