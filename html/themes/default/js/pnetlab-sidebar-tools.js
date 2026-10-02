/**
 * pnetlab-sidebar-tools.js — left-pane (#lab-sidebar) additions for the
 * PNetLab topology page:
 *
 *   Quick Bar on/off toggle, Resource Monitor toggle, Fix Permissions,
 *   Shell (admin), and Link Labels toggle (hides jsPlumb label overlays).
 *
 * The sidebar <ul> is built in functions.js; we wait for it then append once.
 */
(function () {
  'use strict';

  // BUG FIX (Layout Settings not remembered per-lab): these were plain global
  // localStorage keys, so every lab shared one Quick Bar / Resource Monitor /
  // Link Labels / Icon Resizer preference — toggling it in one lab silently
  // changed it for every other lab too. window.LAB (set by postLogin() before
  // printPageLabOpen() builds #lab-sidebar — see functions/api/users.js) is
  // the stable per-lab identifier; suffix the base key with it so each lab
  // gets its own stored value. Falls back to the bare global key if LAB is
  // ever unset (defensive only — #lab-sidebar never exists before LAB does).
  function pnqLabKey(base) {
    try {
      var lab = (typeof window.LAB !== 'undefined' && window.LAB) ? String(window.LAB) : '';
      return lab ? (base + '::' + lab) : base;
    } catch (e) { return base; }
  }
  function QB_KEY() { return pnqLabKey('pnq_quickbar_hidden'); }      // '1' => quickbar hidden
  function SM_KEY() { return pnqLabKey('pnq_sysmon_hidden'); }        // '1' => resource monitor hidden
  function LL_KEY() { return pnqLabKey('pnq_linklabels_hidden'); }    // '1' => link labels hidden
  function IR_KEY() { return pnqLabKey('pnq_iconresize_hidden'); }    // '1' => icon resizer hidden
  function SL_KEY() { return pnqLabKey('pnq_statusled_hidden'); }     // '1' => node status LEDs hidden

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  /* ── #2 Quick Bar toggle ──────────────────────────────────────────────────── */
  function quickbar() { return document.getElementById('pnetlab-quickbar'); }
  function isHidden() { return localStorage.getItem(QB_KEY()) === '1'; }

  function applyQuickbar() {
    var qb = quickbar();
    if (qb) qb.style.display = isHidden() ? 'none' : '';
    var ic = document.querySelector('#pnq-quickbar-toggle i');
    if (ic) ic.className = isHidden() ? 'fa fa-toggle-off' : 'fa fa-toggle-on';
  }

  function toggleQuickbar(e) {
    if (e) e.preventDefault();
    localStorage.setItem(QB_KEY(), isHidden() ? '0' : '1');
    applyQuickbar();
  }

  /* ── #7 Resource Monitor toggle ───────────────────────────────────────────── */
  function sysmon() { return document.getElementById('pnq-sysmon'); }
  function smHidden() { return localStorage.getItem(SM_KEY()) === '1'; }

  function applySysmon() {
    var sm = sysmon();
    if (sm) sm.style.display = smHidden() ? 'none' : '';
    var ic = document.querySelector('#pnq-sysmon-toggle i');
    if (ic) ic.className = smHidden() ? 'fa fa-toggle-off' : 'fa fa-toggle-on';
  }

  function toggleSysmon(e) {
    if (e) e.preventDefault();
    localStorage.setItem(SM_KEY(), smHidden() ? '0' : '1');
    applySysmon();
  }

  /* ── Link labels toggle ───────────────────────────────────────────────────── */
  // The flow island owns label rendering (edges/iflabels.svelte.js reads the
  // same LL_KEY and intercepts clicks on #pnq-linklabels-toggle); this lane only
  // keeps the localStorage flip + body class + icon state in sync. The old
  // .jtk-overlay CSS injection died with jsPlumb.
  function llHidden() { return localStorage.getItem(LL_KEY()) === '1'; }
  function applyLinkLabels() {
    if (llHidden()) {
      document.body.classList.add('pnq-hide-linklabels');
    } else {
      document.body.classList.remove('pnq-hide-linklabels');
    }
    var ic = document.querySelector('#pnq-linklabels-toggle i');
    if (ic) ic.className = llHidden() ? 'fa fa-toggle-off' : 'fa fa-toggle-on';
  }
  function toggleLinkLabels(e) {
    if (e) e.preventDefault();
    localStorage.setItem(LL_KEY(), llHidden() ? '0' : '1');
    applyLinkLabels();
    // BUG FIX (sidebar toggle not live on the flow canvas): the canvas-flow
    // island used to capture-intercept this click and never let this handler
    // run at all — fragile (a WeakSet leak on its $effect cleanup could
    // permanently disarm the intercept, see CanvasFlow.svelte). Now this
    // handler always runs (icon/localStorage stay legacy-owned, so the classic
    // canvas keeps working unchanged) and just announces the new state; the
    // island (mounted only with ?canvas=flow) listens for
    // pnq:linklabels-changed and mirrors it into its own reactive iflabels
    // state. CSP-safe: plain CustomEvent, no inline/eval. On a normal page
    // nothing listens and this is a cheap no-op.
    try {
      document.dispatchEvent(new CustomEvent('pnq:linklabels-changed', {
        detail: { hidden: llHidden() }
      }));
    } catch (err) {}
  }

  function irHidden() { return localStorage.getItem(IR_KEY()) === '1'; }
  function applyIconResize() {
    var ic = document.querySelector('#pnq-iconresize-toggle i');
    if (ic) ic.className = irHidden() ? 'fa fa-toggle-off' : 'fa fa-toggle-on';
  }
  function toggleIconResize(e) {
    if (e) e.preventDefault();
    localStorage.setItem(IR_KEY(), irHidden() ? '0' : '1');
    applyIconResize();
    try {
      document.dispatchEvent(new CustomEvent('pnq:iconresize-changed', {
        detail: { hidden: irHidden() }
      }));
    } catch (err) {}
  }

  function slHidden() { return localStorage.getItem(SL_KEY()) === '1'; }
  function applyStatusLed() {
    var ic = document.querySelector('#pnq-statusled-toggle i');
    if (ic) ic.className = slHidden() ? 'fa fa-toggle-off' : 'fa fa-toggle-on';
  }
  function toggleStatusLed(e) {
    if (e) e.preventDefault();
    localStorage.setItem(SL_KEY(), slHidden() ? '0' : '1');
    applyStatusLed();
    try {
      document.dispatchEvent(new CustomEvent('pnq:statusled-changed', {
        detail: { hidden: slHidden() }
      }));
    } catch (err) {}
  }

  /* ── Sticky Sidebar toggle ────────────────────────────────────────────────────
   * Surfaces the existing pin mechanism (the #gim thumb-tack → gimMenu() → body.fixed,
   * persisted as left_menu_gim) as a labelled on/off toggle alongside the others, so the
   * pane can be kept always-visible without hunting for the tack. Drives the SAME state,
   * so the tack and this toggle stay in sync. */
  function stickyPinned() { return localStorage.getItem('left_menu_gim') == 1; }
  function applySticky() {
    var ic = document.querySelector('#pnq-sticky-toggle i');
    if (ic) ic.className = stickyPinned() ? 'fa fa-toggle-on' : 'fa fa-toggle-off';
  }
  function toggleSticky(e) {
    if (e) e.preventDefault();
    // reuse the engine's own pin toggle when present (keeps body.fixed + storage in lockstep)
    if (typeof window.gimMenu === 'function') {
      window.gimMenu();
    } else {
      var on = stickyPinned();
      localStorage.setItem('left_menu_gim', on ? 0 : 1);
      document.body.classList.toggle('fixed', !on);
    }
    applySticky();
  }

  /* ── Host Shell (admin) ───────────────────────────────────────────────────── */
  // Admin only. token_mint.php also enforces this server-side; we hide the entry
  // for clearly non-admin sessions (the engine sets the global ROLE in
  // functions.js). Unknown role -> show and let the server gate.
  function isAdmin() {
    var r = (typeof window !== 'undefined') ? window.ROLE : undefined;
    if (r === undefined || r === null) return true;
    return r === 0 || r === '0' || String(r).toLowerCase() === 'admin';
  }

  function openShell(e) {
    if (e) e.preventDefault();
    var url = '/console/console.html?shell=1';
    if (typeof window.pnqOpenConsoleWindow === 'function')
      window.pnqOpenConsoleWindow(url, 'shell', 'Host Shell');
    else
      window.open(url, 'pnet-shell');
  }

  /* ── Lab PKI (new tab) ────────────────────────────────────────────────────── */
  // Opens the standalone CA / certificate GUI (html/pki/) in its own tab, scoped
  // to the current lab. Engine-side, broker-mediated; see scripts/pki/pnet-pki.py.
  function openPki(e) {
    if (e) e.preventDefault();
    var lab = (typeof window.LAB !== 'undefined' && window.LAB) ? window.LAB : '';
    window.open('/pki/?lab=' + encodeURIComponent(lab), 'pnet-pki');
  }

  /* ── #10 Fix Permissions ──────────────────────────────────────────────────── */
  function fixPermissions(e) {
    if (e) e.preventDefault();
    // keepalive so the in-flight POST survives the immediate reload; the wrapper
    // runs server-side regardless. credentials carry the store admin session.
    try {
      fetch('/system/api.php?action=fixPermission', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      }).catch(function () {});
    } catch (err) {}
    if (typeof addMessage === 'function') addMessage('info', 'Fixing permissions… reloading.');
    setTimeout(function () { window.location.reload(); }, 600);
  }

  /* ── inject both items into the sidebar list ──────────────────────────────── */
  function inject() {
    if (document.getElementById('pnq-quickbar-toggle')) return true;   // already injected
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return false;                                             // sidebar not built yet → keep observing

    var toggleLi = el('li');
    toggleLi.id = 'pnq-quickbar-toggle';
    toggleLi.innerHTML = '<a href="#"><i class="fa fa-toggle-on" style="font-size:16px;"></i>' +
      '<span class="lab-sidebar-title">Quick Bar</span></a>';
    toggleLi.querySelector('a').addEventListener('click', toggleQuickbar);

    var sysmonLi = el('li');
    sysmonLi.id = 'pnq-sysmon-toggle';
    sysmonLi.innerHTML = '<a href="#"><i class="fa fa-toggle-on" style="font-size:16px;"></i>' +
      '<span class="lab-sidebar-title">Resource Monitor</span></a>';
    sysmonLi.querySelector('a').addEventListener('click', toggleSysmon);

    var llLi = el('li');
    llLi.id = 'pnq-linklabels-toggle';
    llLi.innerHTML = '<a href="#"><i class="fa fa-toggle-on" style="font-size:16px;"></i>' +
      '<span class="lab-sidebar-title">Link Labels</span></a>';
    llLi.querySelector('a').addEventListener('click', toggleLinkLabels);

    var irLi = el('li');
    irLi.id = 'pnq-iconresize-toggle';
    irLi.innerHTML = '<a href="#" title="Show the drag handle for resizing node icons"><i class="fa fa-toggle-on" style="font-size:16px;"></i>' +
      '<span class="lab-sidebar-title">Icon Resizer</span></a>';
    irLi.querySelector('a').addEventListener('click', toggleIconResize);

    var slLi = el('li');
    slLi.id = 'pnq-statusled-toggle';
    slLi.innerHTML = '<a href="#" title="Show node status LEDs"><i class="fa fa-toggle-on" style="font-size:16px;"></i>' +
      '<span class="lab-sidebar-title">Status LED</span></a>';
    slLi.querySelector('a').addEventListener('click', toggleStatusLed);

    var stickyLi = el('li');
    stickyLi.id = 'pnq-sticky-toggle';
    stickyLi.innerHTML = '<a href="#" title="Keep the sidebar always visible (pin)">' +
      '<i class="fa fa-toggle-off" style="font-size:16px;"></i>' +
      '<span class="lab-sidebar-title">Sticky Sidebar</span></a>';
    stickyLi.querySelector('a').addEventListener('click', toggleSticky);

    var fixLi = el('li');
    fixLi.id = 'pnq-fixperm';
    fixLi.innerHTML = '<a href="javascript:void(0)" title="Fix Permissions">' +
      '<i class="fa fa-wrench"></i><span class="lab-sidebar-title">Fix Permissions</span></a>';
    fixLi.querySelector('a').addEventListener('click', fixPermissions);

    var pkiLi = el('li');
    pkiLi.id = 'pnq-pki';
    pkiLi.innerHTML = '<a href="javascript:void(0)" title="Lab PKI — create a CA and issue certificates">' +
      '<i class="fa fa-certificate"></i><span class="lab-sidebar-title">Lab PKI</span></a>';
    pkiLi.querySelector('a').addEventListener('click', openPki);

    var shellLi = null;
    if (isAdmin()) {
      shellLi = el('li');
      shellLi.id = 'pnq-shell';
      shellLi.innerHTML = '<a href="javascript:void(0)" title="Open an authenticated host shell">' +
        '<i class="fa fa-terminal"></i><span class="lab-sidebar-title">Shell</span></a>';
      shellLi.querySelector('a').addEventListener('click', openShell);
    }

    // place the Quick Bar + Resource Monitor switches right after the HTML
    // Console switch (the toggles together), then Fix Permissions + Shell.
    var consoleLi = document.getElementById('action_change_console');
    if (consoleLi && consoleLi.parentNode === ul) {
      ul.insertBefore(toggleLi, consoleLi.nextSibling);
      ul.insertBefore(sysmonLi, toggleLi.nextSibling);
      ul.insertBefore(llLi, sysmonLi.nextSibling);
      ul.insertBefore(slLi, llLi.nextSibling);
      ul.insertBefore(irLi, slLi.nextSibling);
      ul.insertBefore(stickyLi, irLi.nextSibling);
      ul.insertBefore(fixLi, stickyLi.nextSibling);
      ul.insertBefore(pkiLi, fixLi.nextSibling);
      if (shellLi) ul.insertBefore(shellLi, pkiLi.nextSibling);
    } else {
      ul.appendChild(toggleLi);
      ul.appendChild(sysmonLi);
      ul.appendChild(llLi);
      ul.appendChild(slLi);
      ul.appendChild(irLi);
      ul.appendChild(stickyLi);
      ul.appendChild(fixLi);
      ul.appendChild(pkiLi);
      if (shellLi) ul.appendChild(shellLi);
    }
    applyQuickbar();
    applySysmon();
    applyLinkLabels();
    applyStatusLed();
    applyIconResize();
    applySticky();
    return true;
  }

  function init() {
    applyQuickbar();                 // honour the stored choice ASAP (quickbar is static markup)
    applySysmon();                   // sysmon card honours SM_KEY itself; sync if already present
    applyLinkLabels();               // apply hide-linklabels class before first render
    if (inject()) return;
    var mo = new MutationObserver(function () { if (inject()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
