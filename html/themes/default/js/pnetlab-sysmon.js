/**
 * pnetlab-sysmon.js — host CPU / RAM / Disk monitor for the topology page.
 *
 * A small frosted card pinned to the bottom-right of the canvas. Polls
 * /pnq-sysmon.php (cheap JSON: {cpu,mem,disk} percentages) for the master and,
 * when a cluster is present, /status/api.php?action=getClusterInfo for each
 * satellite (cached server-side, 5s TTL). Shows each metric as a coloured bar +
 * value: green (ok) / yellow (warning) / red (critical) by per-metric
 * threshold. With satellites the card stacks one row per host (Master + Satnn);
 * with none it stays the single inline row. pointer-events:none so it never
 * blocks canvas interaction.
 */
(function () {
  'use strict';

  var URL = '/pnq-sysmon.php';
  var CLUSTER_URL = '/status/api.php?action=getClusterInfo';
  var POLL = 4000;
  var METRICS = [
    { k: 'cpu',  label: 'CPU',  warn: 70, crit: 90 },
    { k: 'mem',  label: 'RAM',  warn: 75, crit: 90 },
    { k: 'disk', label: 'Disk', warn: 80, crit: 90 }
  ];
  var THEME_VARS = [
    '--pnq-panel-bg', '--pnq-panel-fg', '--pnq-panel-border', '--pnq-head-bg',
    '--pnq-hover-bg', '--pnq-fg-dim', '--pnq-fg-strong', '--pnq-accent'
  ];
  var themeObserver = null;

  // BUG FIX (Layout Settings not remembered per-lab): pnetlab-sidebar-tools.js
  // now stores the Resource Monitor toggle under a per-window.LAB-scoped key
  // (see its pnqLabKey()); mirror the exact same formula here so this widget's
  // own initial-visibility check (build(), below — it runs before the sidebar
  // toggle's applySysmon() sync) agrees with the scoped value instead of the
  // old bare global key, which would otherwise always read "not hidden".
  function pnqSysmonKey() {
    try {
      var lab = (typeof window.LAB !== 'undefined' && window.LAB) ? String(window.LAB) : '';
      return lab ? ('pnq_sysmon_hidden::' + lab) : 'pnq_sysmon_hidden';
    } catch (e) { return 'pnq_sysmon_hidden'; }
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? -1 : Math.max(0, Math.min(100, Math.round(n))); }
  function level(v, m) {
    if (typeof v !== 'number' || v < 0) return 'na';
    if (v >= m.crit) return 'red';
    if (v >= m.warn) return 'yellow';
    return 'green';
  }

  function injectStyle() {
    if (document.getElementById('pnq-sysmon-style')) return;
    var st = el('style'); st.id = 'pnq-sysmon-style';
    st.textContent =
      // Horizontal pill pinned to the BOTTOM CENTRE of the lab view (clear of the
      // bottom-right minimap). CPU/RAM/Disk sit in a row.
      '#pnq-sysmon{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:1200;pointer-events:none;' +
      'display:flex;flex-direction:row;align-items:center;gap:16px;' +
       '--pnq-panel-bg:#fff;--pnq-panel-fg:#24292f;--pnq-panel-border:#d0d7de;' +
       '--pnq-head-bg:#f5f5f5;--pnq-hover-bg:#eaeef2;--pnq-fg-dim:#57606a;' +
       '--pnq-fg-strong:#1f2328;--pnq-accent:#3c708a;' +
       'font:11px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:var(--pnq-panel-fg);' +
       'background:var(--pnq-panel-bg);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
       'border:1px solid var(--pnq-accent);border-radius:999px;padding:6px 16px;' +
       'box-shadow:0 6px 20px rgba(0,0,0,0.28);}' +
       'body.pnq-dark #pnq-sysmon{--pnq-panel-bg:#21262d;--pnq-panel-fg:#c9d1d9;' +
       '--pnq-panel-border:#444c56;--pnq-head-bg:#1c2128;--pnq-hover-bg:#30363d;' +
       '--pnq-fg-dim:#8b949e;--pnq-fg-strong:#f0f6fc;--pnq-accent:#6ba3bf;}' +
      // multi-host: stack vertically, square the corners a touch (stays centred)
      '#pnq-sysmon.pnq-multi{flex-direction:column;align-items:stretch;gap:5px;border-radius:14px;}' +
      '#pnq-sysmon .pnq-sm-host{display:flex;flex-direction:row;align-items:center;gap:14px;}' +
      '#pnq-sysmon .pnq-sm-hname{flex:0 0 auto;min-width:62px;font-weight:700;letter-spacing:.02em;' +
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;}' +
       '#pnq-sysmon .pnq-sm-hname.off{color:var(--pnq-fg-dim);}' +
      '#pnq-sysmon .pnq-sm-row{display:flex;align-items:center;margin:0;gap:7px;}' +
      '#pnq-sysmon .pnq-sm-label{flex:0 0 auto;opacity:.85;font-weight:600;letter-spacing:.03em;}' +
       '#pnq-sysmon .pnq-sm-bar{flex:0 0 64px;width:64px;height:6px;border-radius:4px;background:var(--pnq-hover-bg);overflow:hidden;}' +
      '#pnq-sysmon .pnq-sm-bar>i{display:block;height:100%;width:0;border-radius:4px;background:#34c759;transition:width .5s ease,background .3s;}' +
      '#pnq-sysmon .pnq-sm-val{flex:0 0 auto;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;}' +
      // warn/crit numeral treatment uses the island design-system semantic
      // tokens (DESIGN.md --pnq-warn #c77700 / --pnq-danger #b3261e), not the
      // ad-hoc iOS-system-color hex this file used to hardcode.
      '#pnq-sysmon .pnq-sm-row.yellow .pnq-sm-bar>i{background:#c77700;}' +
      '#pnq-sysmon .pnq-sm-row.red .pnq-sm-bar>i{background:#b3261e;}' +
      '#pnq-sysmon .pnq-sm-row.green .pnq-sm-val{color:#34c759;}' +
      '#pnq-sysmon .pnq-sm-row.yellow .pnq-sm-val{color:#c77700;}' +
      '#pnq-sysmon .pnq-sm-row.red .pnq-sm-val{color:#b3261e;font-weight:700;}' +
       '#pnq-sysmon .pnq-sm-row.na .pnq-sm-val{color:var(--pnq-fg-dim);}';
    document.head.appendChild(st);
    ensureThemeSync();
  }

  // #pnq-sysmon is a legacy body-level node, so it cannot inherit the island's
  // --pnq-* layer. Consume the computed values from the mounted canvas and keep
  // this surface synchronized when either canvas mode or app profile changes.
  function syncThemeVars() {
    var canvas = document.querySelector('.pnq-canvas-flow');
    var target = document.getElementById('pnq-sysmon');
    if (!canvas || !target) return;
    var cs = window.getComputedStyle(canvas);
    for (var i = 0; i < THEME_VARS.length; i++) {
      var value = cs.getPropertyValue(THEME_VARS[i]).trim();
      if (value) target.style.setProperty(THEME_VARS[i], value);
    }
  }
  function ensureThemeSync() {
    var canvas = document.querySelector('.pnq-canvas-flow');
    if (!canvas) return;
    syncThemeVars();
    if (themeObserver) return;
    themeObserver = new MutationObserver(syncThemeVars);
    themeObserver.observe(canvas, { attributes: true, attributeFilter: ['class', 'data-theme-profile'] });
  }

  function build() {
    var existing = document.getElementById('pnq-sysmon');
    if (existing) return existing;
    var w = el('div'); w.id = 'pnq-sysmon';
    if (localStorage.getItem(pnqSysmonKey()) === '1') w.style.display = 'none';
    document.body.appendChild(w);
    return w;
  }

  // one metric (label + bar + value); v is a 0..100 number or -1 for n/a.
  // hostLabel names the polled host in the accessible/tooltip text ("Host" for
  // the single-host case, the satellite's own name in a cluster) so a screen
  // reader or a hover doesn't just get a bare "34%" — it gets what it's 34% of.
  function metricRow(m, v, hostLabel) {
    var row = el('div', 'pnq-sm-row ' + m.k + ' ' + level(v, m));
    var text = hostLabel + ' ' + m.label + ' usage ' + (v < 0 ? 'unavailable' : v + '%');
    row.title = text;
    row.setAttribute('aria-label', text);
    row.innerHTML =
      '<span class="pnq-sm-label">' + m.label + '</span>' +
      '<span class="pnq-sm-bar"><i style="width:' + (v < 0 ? 0 : v) + '%"></i></span>' +
      '<span class="pnq-sm-val">' + (v < 0 ? 'n/a' : v + '%') + '</span>';
    return row;
  }

  // hosts: [{name, online, cpu, mem, disk}] — master first; name omitted ⇒ single inline row
  function render(hosts) {
    var w = document.getElementById('pnq-sysmon'); if (!w) return;
    ensureThemeSync();
    var multi = hosts.length > 1;
    w.className = multi ? 'pnq-multi' : '';
    w.innerHTML = '';
    hosts.forEach(function (h) {
      var hostEl = multi ? el('div', 'pnq-sm-host') : w;
      if (multi) {
        hostEl.appendChild(el('span', 'pnq-sm-hname' + (h.online === false ? ' off' : ''), h.name || ''));
      }
      var hostLabel = (h.name === 'Master') ? 'Host' : (h.name || 'Host');
      METRICS.forEach(function (m) { hostEl.appendChild(metricRow(m, h.online === false ? -1 : num(h[m.k]), hostLabel)); });
      if (multi) w.appendChild(hostEl);
    });
  }

  function positionBesideZoom() {
    var sm = document.getElementById('pnq-sysmon'); if (!sm) return;
    var zfs = document.querySelectorAll('.zoom_frame'), z = null;
    for (var i = 0; i < zfs.length; i++) {
      var r = zfs[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { z = r; break; }
    }
    if (!z) return;
    sm.style.right = Math.round(window.innerWidth - z.left + 8) + 'px';
    sm.style.bottom = Math.round(window.innerHeight - z.bottom) + 'px';
  }

  var timer = null;
  function poll() {
    if (document.hidden) return;   // background tab: don't poll (matches egress-glow/sat-badge)
    var master = fetch(URL, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); }).catch(function () { return null; });
    var cluster = fetch(CLUSTER_URL, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); }).catch(function () { return null; });
    Promise.all([master, cluster]).then(function (res) {
      var m = res[0] || {};
      var hosts = [{ name: 'Master', online: true, cpu: m.cpu, mem: m.mem, disk: m.disk }];
      var cd = res[1] && res[1].data ? res[1].data : null;
      if (cd && cd.enabled && cd.satellites && cd.satellites.length) {
        cd.satellites.forEach(function (s) {
          hosts.push({ name: s.name || ('Sat ' + s.id), online: !!s.online,
            cpu: s.cpu, mem: (s.ram != null ? s.ram : s.mem), disk: s.disk });
        });
      }
      render(hosts);
    }).then(positionBesideZoom);
  }

  function init() {
    injectStyle();
    build();
    ensureThemeSync();
    poll();
    if (timer) clearInterval(timer);
    timer = setInterval(poll, POLL);
    window.addEventListener('resize', positionBesideZoom);
    [400, 1000, 2000, 3500].forEach(function (t) { setTimeout(positionBesideZoom, t); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
