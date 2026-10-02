/*
 * pnetlab-netem-advanced.js — "Advanced WAN (netem)" per-interface impairment.
 *
 * The stock per-link "Quality" dialog (rendered by the store React bundle) only
 * exposes delay / jitter / loss / bandwidth. The kernel netem qdisc on this
 * platform supports much more (jitter distribution, delay/loss correlation,
 * Gilbert-Elliott bursty loss, duplication, corruption, reordering, queue
 * limit). This engine shim adds an "Advanced WAN (netem)" item to the
 * right-click → interface menu (next to Suspend, which carries the node/if ids)
 * and opens a self-contained glass panel that POSTs every knob to the existing
 * /api/labs/session/interfaces/setquality endpoint. interfc.php setQuality()
 * persists them and applyQuality() hands them to the broker netem_set verb,
 * which builds the `tc qdisc ... netem` command. Pure DOM augmentation, no store
 * rebake; CSP-safe (no inline handlers).
 */
(function () {
  'use strict';

  // [key, label, type, attrs] — type 'select' uses opts. key is the POST field.
  var FIELDS = [
    ['bandwidth',   'Bandwidth (Kbit/s)',          'num',  'min=0 step=1'],
    ['delay',       'Delay (ms)',                   'num',  'min=0 step=1'],
    ['jitter',      'Jitter (ms)',                  'num',  'min=0 step=1'],
    ['dist',        'Jitter distribution',          'sel',  ['uniform', 'normal', 'pareto', 'paretonormal']],
    ['delay_corr',  'Delay correlation (%)',        'num',  'min=0 max=100 step=1'],
    ['loss',        'Loss (%)',                     'num',  'min=0 max=100 step=0.1'],
    ['loss_mode',   'Loss model',                   'sel',  ['random', 'gemodel']],
    ['loss_corr',   'Loss correlation (%)',         'num',  'min=0 max=100 step=1'],
    ['duplicate',   'Duplicate (%)',                'num',  'min=0 max=100 step=0.1'],
    ['corrupt',     'Corrupt (%)',                  'num',  'min=0 max=100 step=0.1'],
    ['reorder',     'Reorder (%)  — needs a delay', 'num',  'min=0 max=100 step=0.1'],
    ['gap',         'Reorder gap (every Nth pkt)',  'num',  'min=0 step=1'],
    ['limit',       'Queue limit (packets)',        'num',  'min=0 step=1']
  ];

  function injectCSS() {
    if (document.getElementById('pnq-netem-style')) return;
    var s = document.createElement('style');
    s.id = 'pnq-netem-style';
    s.textContent =
      // Base (light) theme. The panel is legacy DOM appended to document.body —
      // it sits OUTSIDE the island container, so the island's --pnq-* CSS custom
      // properties (scoped to .pnq-canvas-flow / #pnq-overlay-portal) aren't
      // reachable here. Theme is keyed off body.pnq-dark instead (CanvasFlow.svelte
      // mirrors its own theme onto that class specifically so legacy DOM can react
      // to it — see the "Re-sync body.pnq-dark" comment there). Hex values below
      // match the island's dark/light token VALUES so the panel reads as native.
      '.pnq-netem{position:fixed;top:60px;right:12px;width:320px;max-height:calc(100vh - 84px);' +
      'overflow:auto;z-index:100050;background:#ffffff;' +
      'backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);' +
      'border:1px solid #d0d7de;border-radius:14px;box-shadow:0 16px 50px rgba(0,0,0,0.22);' +
      'padding:14px 16px 16px;color:#24292f;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}' +
      // Light header band matches the EVE shell treatment every island modal got in
      // b5f96ff (docs/eve-parity-modal-audit.md: header #f5f5f5, divider #e0e0e0), so
      // this legacy panel and the island dialogs read as one family.
      '.pnq-netem .hdr{margin:-14px -16px 12px;padding:14px 16px 10px;border-radius:14px 14px 0 0;' +
      'background:#f5f5f5;border-bottom:1px solid #e0e0e0;}' +
      // background/display/text-transform/padding are NOT cosmetic extras here — they
      // NEUTRALISE a global rule. style.css:61-70 ships
      //   h3:where(:not(.pnq-canvas-flow *, #pnq-overlay-portal *)){
      //     background-color:#58585a; color:#fff; display:inline-block;
      //     text-transform:uppercase; padding:2px 10px 2px 4px; }
      // — the legacy site-wide "grey chip" heading. This panel is body-level, so it is
      // OUTSIDE the :where() containment fence and the chip applies. That is what made
      // the header read as a dark box hugging an uppercased "ADVANCED WAN (NETEM)" in
      // light mode (owner report, Wave 9 / R4). It was invisible in dark mode only
      // because the .hdr band behind it is dark too. The previous rule set colour and
      // font but never background/display/text-transform, so the chip survived.
      // NO !important needed: `:where()` contributes ZERO specificity, so the global is
      // (0,0,1) and `.pnq-netem h3` at (0,1,1) already out-ranks it — it simply has to
      // DECLARE the properties. Contrast after this change: #24292f on #f5f5f5 = 12.8:1
      // light, #c9d1d9 on #1c2128 = 10.2:1 dark, both well clear of the 4.5:1 AA floor.
      '.pnq-netem h3{font-size:14px;font-weight:600;margin:0 0 4px;letter-spacing:-.01em;color:inherit;' +
      'background:transparent;display:block;text-transform:none;padding:0;}' +
      // .sub's own divider would double up under the .hdr band's border-bottom.
      '.pnq-netem .sub{font-size:11px;color:#57606a;margin:0;padding-bottom:0;' +
      'border-bottom:none;}' +
      '.pnq-netem label{display:block;font-size:12px;font-weight:600;color:#24292f;margin:10px 0 4px;}' +
      // !important: pnetlab-enhance-v2.css's `body.pnq-dark input[type="number"],
      // select{...!important}` rule targets EVERY page input/select (its containment
      // fence only excludes .pnq-canvas-flow/#pnq-overlay-portal — this legacy panel
      // is neither), so a plain declaration here loses even though .pnq-netem input
      // is more specific; only !important can out-rank another !important rule.
      '.pnq-netem input,.pnq-netem select{width:100%;box-sizing:border-box;padding:7px 9px;font-size:13px;' +
      'color:#24292f!important;background:#ffffff!important;border:1px solid #d0d7de!important;border-radius:8px;}' +
      '.pnq-netem .row{display:flex;gap:8px;margin-top:14px;}' +
      '.pnq-netem .row button{flex:1;padding:8px 0;border-radius:8px;font-size:13px;font-weight:600;' +
      'border:1px solid #d0d7de;cursor:pointer;}' +
      '.pnq-netem .apply{background:#3c708a;color:#fff;border-color:#3c708a;}' +
      '.pnq-netem .clear{background:#ffffff;color:#24292f;}' +
      // !important: style.css ships a global `.close{color:red!important;
      // opacity:.5!important}` (the classic Bootstrap modal-dismiss "X"); this
      // button reuses the .close class for its OWN unrelated quiet-danger text
      // treatment, so it must out-rank that rule the same way.
      '.pnq-netem .close{background:transparent!important;color:#b3261e!important;' +
      'opacity:1!important;border-color:transparent;font-weight:500;}' +
      '.pnq-netem .msg{font-size:11px;margin-top:8px;min-height:14px;}' +
      '.pnq-netem .msg.ok{color:#1c7c34;}.pnq-netem .msg.bad{color:#c0341d;}' +
      // Dark theme override — keyed off body.pnq-dark, values match the island's
      // dark token layer (--pnq-panel-bg #21262d / --pnq-panel-fg #c9d1d9 /
      // --pnq-hover-bg #444c56 / --pnq-input-bg #0d1117).
      'body.pnq-dark .pnq-netem{background:#21262d;color:#c9d1d9;border-color:#444c56;' +
      'box-shadow:0 16px 50px rgba(0,0,0,0.5);}' +
      'body.pnq-dark .pnq-netem .hdr{background:#1c2128;border-bottom:1px solid #444c56;}' +
      'body.pnq-dark .pnq-netem .sub{color:#8b949e;border-bottom-color:transparent;padding-bottom:0;}' +
      'body.pnq-dark .pnq-netem label{color:#c9d1d9;}' +
      'body.pnq-dark .pnq-netem input,body.pnq-dark .pnq-netem select{color:#c9d1d9!important;' +
      'background:#0d1117!important;border-color:#444c56!important;}' +
      'body.pnq-dark .pnq-netem .row button{border-color:#444c56;}' +
      'body.pnq-dark .pnq-netem .apply{background:#3c708a;color:#fff;border-color:#3c708a;}' +
      'body.pnq-dark .pnq-netem .clear{background:#0d1117;color:#c9d1d9;}' +
      'body.pnq-dark .pnq-netem .close{background:transparent!important;color:#ff7b72!important;' +
      'opacity:1!important;border-color:transparent;}' +
      'body.pnq-dark .pnq-netem .msg.ok{color:#3fb950;}body.pnq-dark .pnq-netem .msg.bad{color:#ff7b72;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function close() {
    var p = document.getElementById('pnq-netem-panel');
    if (p) p.remove();
  }

  function openPanel(endpoints) {
    close();
    injectCSS();
    var p = document.createElement('div');
    p.className = 'pnq-netem';
    p.id = 'pnq-netem-panel';

    var h = document.createElement('h3');
    h.textContent = 'Advanced WAN (netem)';
    var sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = endpoints.length > 1
      ? 'Applies symmetrically to BOTH directions of the link. Leave a field blank to disable that knob.'
      : 'Applies to this link interface. Leave a field blank to disable that knob.';
    var hdr = document.createElement('div');
    hdr.className = 'hdr';
    hdr.appendChild(h); hdr.appendChild(sub);
    p.appendChild(hdr);

    var inputs = {};
    FIELDS.forEach(function (f) {
      var lab = document.createElement('label');
      lab.textContent = f[1];
      var el;
      if (f[2] === 'sel') {
        el = document.createElement('select');
        f[3].forEach(function (o) {
          var op = document.createElement('option');
          op.value = o; op.textContent = o; el.appendChild(op);
        });
      } else {
        el = document.createElement('input');
        el.type = 'number';
        (f[3] || '').split(' ').forEach(function (a) {
          if (!a) return; var kv = a.split('='); el.setAttribute(kv[0], kv[1]);
        });
      }
      inputs[f[0]] = el;
      lab.appendChild(el);
      p.appendChild(lab);
    });

    var msg = document.createElement('div');
    msg.className = 'msg';

    var row = document.createElement('div');
    row.className = 'row';
    var apply = mkBtn('Apply', 'apply');
    var clear = mkBtn('Clear', 'clear');
    var closeb = mkBtn('Close', 'close');
    row.appendChild(apply); row.appendChild(clear); row.appendChild(closeb);
    p.appendChild(row); p.appendChild(msg);
    document.body.appendChild(p);

    closeb.addEventListener('click', close);
    clear.addEventListener('click', function () {
      Object.keys(inputs).forEach(function (k) {
        if (inputs[k].tagName === 'SELECT') inputs[k].selectedIndex = 0;
        else inputs[k].value = '';
      });
      post(endpoints, collect(inputs, true), msg);  // empty -> clears qdisc on both sides
    });
    apply.addEventListener('click', function () {
      post(endpoints, collect(inputs, false), msg);
    });
  }

  function mkBtn(text, cls) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = text;
    return b;
  }

  // collect form values; selects only sent when meaningful (non-default), so a
  // bare "uniform"/"random" doesn't force a knob on.
  function collect(inputs, blankAll) {
    var d = {};
    Object.keys(inputs).forEach(function (k) {
      var el = inputs[k];
      if (blankAll) { d[k] = ''; return; }
      var v = (el.value || '').trim();
      if (el.tagName === 'SELECT') {
        // only send dist when not uniform, and loss_mode always (cheap)
        if (k === 'dist' && v === 'uniform') v = '';
        d[k] = v;
      } else {
        d[k] = v;
      }
    });
    return d;
  }

  // Apply the same impairment to every endpoint of the link (both directions),
  // so the link has one symmetric value regardless of which end it was opened from.
  function post(endpoints, data, msg) {
    msg.className = 'msg';
    msg.textContent = 'Applying…';
    // Item 2 (netem-active edge indicator) — whether THIS apply/clear leaves the
    // link with any non-blank knob. Values are collect()ed as strings; blankAll
    // (Clear) always sends '' for every key, so this is false for a clear and
    // true for any Apply where at least one field was filled in.
    var active = Object.keys(data).some(function (k) {
      var v = data[k];
      return v !== '' && v != null;
    });
    var remaining = endpoints.length, anyFail = false, lastMsg = '';
    endpoints.forEach(function (ep) {
      var d = {};
      Object.keys(data).forEach(function (k) { d[k] = data[k]; });
      d.node_id = ep.node;
      d.interface_id = ep.iface;
      sendOne(d, function (ok, text) {
        if (!ok) { anyFail = true; lastMsg = text; }
        if (--remaining === 0) {
          msg.className = 'msg ' + (anyFail ? 'bad' : 'ok');
          msg.textContent = anyFail ? ('One direction failed: ' + lastMsg)
            : (endpoints.length > 1 ? 'Applied to both directions.' : 'Applied.');
          // Fire-and-forget notice for the canvas-flow island (CanvasFlow.svelte's
          // onNetemChanged listener): the island's own topology reseed (api-seed.js)
          // already derives netemActive from the SAME server-side quality state this
          // POST just wrote, so the cheapest correct refresh is a debounced re-seed,
          // not a manual edge lookup here. Fired even on partial failure (anyFail) —
          // a per-direction failure still means at least one side may have changed.
          try {
            document.dispatchEvent(new CustomEvent('pnq:netem-changed', {
              detail: { endpoints: endpoints, active: active }
            }));
          } catch (e) { /* inert on very old browsers — no CustomEvent ctor */ }
        }
      });
    });
  }

  function sendOne(data, cb) {
    if (window.jQuery) {
      window.jQuery.ajax({
        url: '/api/labs/session/interfaces/setquality', type: 'POST',
        dataType: 'json', cache: false, data: data,
        success: function (r) { cb(r && r.status === 'success', (r && r.message) || 'ok'); },
        error: function (x) {
          var m = (x && x.responseJSON && x.responseJSON.message) || null;
          cb(false, m || ('HTTP ' + (x && x.status) + ' — check the combo (e.g. reorder needs a delay).'));
        }
      });
    } else {
      var body = Object.keys(data).map(function (k) {
        return encodeURIComponent(k) + '=' + encodeURIComponent(data[k]);
      }).join('&');
      fetch('/api/labs/session/interfaces/setquality',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (r) { cb(r && r.status === 'success', (r && r.message) || 'ok'); })
        .catch(function () { cb(false, 'request failed'); });
    }
  }

  // Both endpoints of the right-clicked link (source + dest interface), so netem
  // can be applied to both directions. window.connToDel.id is the link id and is
  // the same whether the menu was opened from a port label or the link middle.
  function linkEndpoints() {
    try {
      var id = window.connToDel && window.connToDel.id;
      var lk = id && window.App && App.topology && App.topology.links && App.topology.links[id];
      if (!lk || !lk.source) return null;
      var eps = [];
      if (lk.source.node && lk.source.interface)
        eps.push({ node: lk.source.node.get('id'), iface: lk.source.interface.get('id') });
      if (lk.dest && lk.dest.node && lk.dest.interface)
        eps.push({ node: lk.dest.node.get('id'), iface: lk.dest.interface.get('id') });
      return eps.length ? eps : null;
    } catch (e) { return null; }
  }

  // Inject "Advanced WAN (netem)" into the Connection menu, anchored to the Edit
  // item — which is present from BOTH the port-label and the link-middle
  // right-click, so the entry (and the panel it opens) is identical either way.
  function augmentMenu(node) {
    var edit = node.querySelector ? node.querySelector('.action-connectedit') : null;
    if (node.matches && node.matches('.action-connectedit')) edit = node;
    if (!edit) return;
    var ul = edit.closest('ul');
    if (!ul || ul.querySelector('.pnq-netem-adv')) return;
    var eps = linkEndpoints();
    if (!eps) return;
    var li = document.createElement('li');
    var a = document.createElement('a');
    a.href = 'javascript:void(0)';
    a.className = 'pnq-netem-adv';
    a.innerHTML = '<i class="fa fa-sliders"></i> Advanced WAN (netem)';
    li.appendChild(a);
    edit.closest('li').insertAdjacentElement('afterend', li);
    a.addEventListener('click', function () {
      var cm = document.getElementById('context-menu');
      if (cm) cm.remove();
      openPanel(eps);
    });
  }

  // Direct opener for the canvas-flow island (Wave 1 / b2 A4). The island already
  // knows both endpoints of a right-clicked link from its own PNQStore-derived model
  // ({node, iface} per end), so it can open the panel WITHOUT the jsPlumb
  // window.connToDel round-trip + App.topology.links[id] lookup the observer path
  // (augmentMenu/linkEndpoints) uses. Same panel, id-based input.
  //   endpoints: [{node:<id>, iface:<ifId>}, ...] (1 or 2)
  window.pnqNetemOpen = function (endpoints) {
    if (!endpoints || !endpoints.length) return false;
    openPanel(endpoints);
    return true;
  };

  function init() {
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes && m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          augmentMenu(n);
          if (n.querySelectorAll) n.querySelectorAll('.action-connectedit').forEach(function (s) { augmentMenu(s); });
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})();
