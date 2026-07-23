(function () {
  'use strict';

  // Skip on the monitor page — it must stay fullscreen with no UI chrome.
  if (document.body && document.body.classList.contains('monitor-page')) return;

  var PAGES = [
    { label: 'Home',         href: '/' },
    { label: 'Monitor',      href: '/monitor.html' },
    { label: 'Base Station', href: '/base-station.html' },
    { label: 'Room Control', href: '/room-control.html' },
  ];

  var LS_KEY = 'hearthRestoreLastPage';
  var LS_LAST = 'hearthLastPage';

  function getCurrentPath() {
    return window.location.pathname;
  }

  function inject() {
    // Hamburger button
    var btn = document.createElement('button');
    btn.id = 'hamburgerBtn';
    btn.className = 'hamburger-btn';
    btn.setAttribute('aria-label', 'Menu');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
    document.body.appendChild(btn);

    // Overlay
    var overlay = document.createElement('div');
    overlay.id = 'drawerOverlay';
    overlay.className = 'drawer-overlay hidden';
    document.body.appendChild(overlay);

    // Side drawer
    var drawer = document.createElement('nav');
    drawer.id = 'sideDrawer';
    drawer.className = 'side-drawer';

    var current = getCurrentPath();
    var restoreOn = localStorage.getItem(LS_KEY) === 'true';

    // Page links / selector
    var pageItems = PAGES.map(function (p) {
      var active = (p.href === '/' && current === '/') ||
                   (p.href !== '/' && current.indexOf(p.href) === 0);
      return '<a href="' + p.href + '" class="drawer-item' + (active ? ' active' : '') + '">' + p.label + '</a>';
    }).join('');

    drawer.innerHTML =
      '<div class="drawer-header">Menu</div>' +
      '<div class="drawer-pages">' + pageItems + '</div>' +
      '<div class="drawer-divider"></div>' +
      '<div class="drawer-setting">' +
        '<label class="drawer-setting-label" for="drawerRestoreToggle">Restore last page</label>' +
        '<div class="toggle-switch' + (restoreOn ? ' active' : '') + '" id="drawerRestoreToggle"></div>' +
      '</div>';

    document.body.appendChild(drawer);

    // Save current page as last visited
    try { localStorage.setItem(LS_LAST, current); } catch {}

    // If restore is on and we're on index, redirect to last page
    if (restoreOn && current === '/') {
      try {
        var last = localStorage.getItem(LS_LAST);
        if (last && last !== '/' && window.location.href.indexOf(last) === -1) {
          window.location.replace(last);
          return; // don't wire up listeners during redirect
        }
      } catch {}
    }

    // Open / close
    function openDrawer() {
      drawer.classList.add('open');
      overlay.classList.remove('hidden');
    }
    function closeDrawer() {
      drawer.classList.remove('open');
      overlay.classList.add('hidden');
    }

    btn.addEventListener('click', function () {
      if (drawer.classList.contains('open')) closeDrawer();
      else openDrawer();
    });
    overlay.addEventListener('click', closeDrawer);

    // Close on link click
    drawer.querySelectorAll('.drawer-item').forEach(function (a) {
      a.addEventListener('click', function () {
        closeDrawer();
      });
    });

    // Restore toggle
    var toggle = document.getElementById('drawerRestoreToggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        toggle.classList.toggle('active');
        var on = toggle.classList.contains('active');
        try { localStorage.setItem(LS_KEY, on ? 'true' : 'false'); } catch {}
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
