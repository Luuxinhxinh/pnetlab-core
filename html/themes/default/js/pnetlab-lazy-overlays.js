/* pnetlab-lazy-overlays.js — Hybrid lazy-loader for the heavy lab overlays.
 *
 * Phase 3 (Tier A) payload win: the heavy overlay modules
 *   - pnetlab-topology-overlay.js   (~56 K)  via window.pnqOverlay* (protocol-painter)
 *   - pnetlab-network-watcher.js    (~36 K)  via #lab-sidebar entry
 *   - pnetlab-rack-view.js          (~36 K)  via #lab-sidebar entry
 *   - pnetlab-protocol-inspector.js (~22 K)  via .action-protoinspect link-menu item
 *   - pnetlab-bgp-waterfall.js      (~16 K)  via .action-bgppath link-menu item
 * are NO LONGER loaded eagerly on every lab open. This always-loaded launcher
 * keeps their trigger surfaces alive (window.pnq* stubs, the two link-menu
 * delegated listeners, and transient sidebar placeholder entries) and pulls each
 * module in via a same-origin dynamic import() ONLY on its first real invocation.
 * After the first load the overlay behaves byte-for-byte as the eager build did
 * (each overlay self-inits on a late import — its readyState gate is past
 * "loading"), and the launcher's stub/placeholder steps aside.
 *
 * wifi-painter stays EAGER (always-on auto-start paints wireless badges with no
 * user click); protocol-painter and iso-nodes also stay eager.
 *
 * CSP-clean: same-origin import(), no eval / new Function / inline.
 */
(function () {
  'use strict';

  var BASE = '/themes/default/js/';
  var loaded = {};            // path -> Promise  (shared; one fetch per module)

  function load(path) {
    if (!loaded[path]) loaded[path] = import(BASE + path);
    return loaded[path];
  }

  /* ── window.pnq* stubs ──────────────────────────────────────────────────────
   * protocol-painter (eager) calls window.pnqOverlayOSPF(rootId) etc. guarded by
   * `typeof === 'function'`. We install a stub that, on first call, imports the
   * topology-overlay module (which overwrites window[name] with the real fn) then
   * forwards the call. The closure compares against the captured stub so it never
   * recurses if the module fails to define the name.                            */
  function stub(name, path) {
    if (typeof window[name] === 'function') return;     // already real
    var s = function () {
      var args = arguments, self = this;
      return load(path).then(function () {
        var fn = window[name];
        if (typeof fn === 'function' && fn !== s) return fn.apply(self, args);
      });
    };
    window[name] = s;
  }

  var TOPO = 'pnetlab-topology-overlay.js?v=57bb452a';
  ['pnqOverlayClear', 'pnqOverlayOSPF', 'pnqOverlayBGP', 'pnqOverlayEIGRP',
   'pnqOverlaySTP', 'pnqOverlayBGPPick', 'pnqOverlayRoute', 'pnqOverlayRoutePick',
   'pnqOverlayEIGRPPick', 'pnqOverlaySTPPick', 'pnqOverlayMST', 'pnqOverlayMSTPick',
   'pnqOverlaySTPRoots'
  ].forEach(function (n) { stub(n, TOPO); });

  /* ── delegated link-menu triggers ───────────────────────────────────────────
   * The native connector context menu (actions.js) emits <a class="action-…">.
   * We catch the FIRST matching click in the capture phase (before the module's
   * own bubble-phase listener exists), import the module, remove ourselves, then
   * replay the click so the module — which registered its listener on import —
   * handles it. All subsequent clicks go straight to the module.               */
  function delegate(selector, path) {
    function onClick(e) {
      var a = e.target && e.target.closest && e.target.closest(selector);
      if (!a) return;
      e.preventDefault();
      document.removeEventListener('click', onClick, true);   // one-shot
      load(path).then(function () {
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
    }
    document.addEventListener('click', onClick, true);          // capture
  }
  delegate('.action-protoinspect', 'pnetlab-protocol-inspector.js?v=6c0f0ec3');
  // .action-bgppath is now owned by the Tier B overlays-launcher island
  // (src/islands/overlays-launcher), which lazy-imports the compiled BGP
  // waterfall island instead of this vanilla file.

  /* ── sidebar placeholder entries ────────────────────────────────────────────
   * network-watcher / rack-view each self-inject a #lab-sidebar entry on init,
   * guarded by getElementById(<realId>). We inject a transient placeholder under
   * a DIFFERENT id so the module's guard does not fire; on first click we import
   * the module (its init injects the real entry + wires its real handler),
   * remove our placeholder, and click the real entry to open the panel.        */
  function sidebarStub(o) {   // {realId, lazyId, path, icon, title, tip, anchorId, after}
    function inject() {
      if (document.getElementById(o.realId) || document.getElementById(o.lazyId)) return true;
      var ul = document.querySelector('#lab-sidebar ul');
      if (!ul) return false;
      var li = document.createElement('li');
      li.id = o.lazyId;
      li.innerHTML = '<a href="javascript:void(0)" title="' + o.tip + '">' +
        '<i class="fa ' + o.icon + '"></i>' +
        '<span class="lab-sidebar-title">' + o.title + '</span></a>';
      li.querySelector('a').addEventListener('click', function () {
        load(o.path).then(function () {
          var ph = document.getElementById(o.lazyId);
          if (ph) ph.parentNode.removeChild(ph);
          var real = document.querySelector('#' + o.realId + ' a');
          if (real) real.click();
        });
      });
      var anchor = o.anchorId && document.getElementById(o.anchorId);
      if (anchor && anchor.parentNode === ul) {
        ul.insertBefore(li, o.after ? anchor.nextSibling : anchor);
      } else {
        ul.appendChild(li);
      }
      return true;
    }
    if (inject()) return;
    var mo = new MutationObserver(function () { if (inject()) mo.disconnect(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  sidebarStub({
    realId: 'pnq-netwatch', lazyId: 'pnq-netwatch-lazy',
    path: 'pnetlab-network-watcher.js?v=42682678',
    icon: 'fa-heartbeat', title: 'Network Watcher',
    tip: 'Visualise matching traffic on the topology links',
    anchorId: 'pnq-fixperm', after: false,
  });
  sidebarStub({
    realId: 'pnq-rackview', lazyId: 'pnq-rackview-lazy',
    path: 'pnetlab-rack-view.js?v=86a09eb2',
    icon: 'fa-server', title: 'Rack View',
    tip: 'See the topology laid out in equipment racks',
    anchorId: 'pnq-protopainter', after: true,
  });

  /* ── shared panel drag ──────────────────────────────────────────────────────
   * The overlay legend / picker / protocol-painter / rack-view / wifi-painter
   * panels all share .pnq-ov-legend + a .pnq-ov-head and a single delegated drag
   * handler. It used to live in pnetlab-topology-overlay.js, but that overlay is
   * now lazy-loaded — so protocol-painter & rack-view panels would not drag until
   * an OSPF/BGP overlay had been run. It lives here (always loaded) instead. The
   * remembered position is published on window.pnqOvLegendPos so topology-overlay
   * re-applies it on re-render (its applyPos reads it). */
  (function () {
    var dragEl = null, dx = 0, dy = 0, remember = false;
    document.addEventListener('mousedown', function (e) {
      if (!e.target.closest) return;
      var head = e.target.closest('.pnq-ov-head');
      if (!head || e.target.closest('button')) return;   // header buttons still click
      var panel = head.closest('.pnq-ov-legend');
      if (!panel) return;
      var r = panel.getBoundingClientRect();
      dragEl = panel; dx = e.clientX - r.left; dy = e.clientY - r.top;
      remember = (panel.id === 'pnq-ov-legend' || panel.id === 'pnq-ov-picker');
      panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
      panel.style.right = 'auto';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragEl) return;
      var left = Math.max(0, Math.min(e.clientX - dx, window.innerWidth - 60));
      var top = Math.max(0, Math.min(e.clientY - dy, window.innerHeight - 28));
      dragEl.style.left = left + 'px'; dragEl.style.top = top + 'px';
      if (remember) window.pnqOvLegendPos = { left: left, top: top };
    });
    document.addEventListener('mouseup', function () { dragEl = null; });
  })();
})();
