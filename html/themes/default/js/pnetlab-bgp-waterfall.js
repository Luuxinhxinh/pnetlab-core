/*
 * pnetlab-bgp-waterfall.js — BGP best-path "decision waterfall".
 *
 * The lab editor's link context menu (actions.js) gains a "BGP Best-Path Finder" item
 * carrying the two endpoint node ids. Clicking it opens a draggable/resizable
 * modal that:
 *   Stage 1 — runs `show ip bgp` on a chosen endpoint and lists one row per
 *             prefix (the picker);
 *   Stage 2 — on a prefix, runs `show ip bgp <prefix>` and walks the Cisco
 *             best-path tiebreakers, showing which paths drop out at each rung
 *             and the attribute that decided the winner.
 *
 * Backend: pnq-bgppath.php -> brokerd node_show -> pnet-showcmd.py (read-only
 * telnet to the node console) -> pnet_bgpparse.py (parse + decide). This file is
 * a dumb renderer; the decision ladder is computed server-side. CSP-safe: no
 * inline handlers, delegated listeners only.
 */
(function () {
  'use strict';
  var URL = '/pnq-bgppath.php';
  var ORIGIN_SUB = {
    'Weight': 'highest; Cisco-local, default 0',
    'Local preference': 'highest; AS-wide, default 100',
    'Locally originated': 'prefer self-originated',
    'AS-path length': 'shortest AS_PATH wins',
    'Origin code': 'IGP < EGP < incomplete',
    'MED': 'lowest, from same neighbor AS',
    'eBGP over iBGP': 'prefer external over internal',
    'IGP metric to next-hop': 'lowest IGP cost',
    'Router ID': 'lowest neighbor router-id'
  };

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function toast(msg) {
    var t = el('div', 'bw-toast', esc(msg));
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 300); }, 3600);
  }
  function post(body) {
    return fetch(URL, { method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; }); });
  }

  /* entry point: link menu item */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('.action-bgppath');
    if (!a) return;
    e.preventDefault();
    var s = parseInt(a.getAttribute('data-src'), 10);
    var d = parseInt(a.getAttribute('data-dst'), 10);
    if (!isNaN(s) && !isNaN(d)) openModal(s, d);
  });

  function openModal(a, b) {
    var st = { node: null, prefix: null, table: null, fs: 13 };
    var modal = el('div', 'bw-modal');
    modal.innerHTML =
      '<div class="bw-bar">' +
        '<span class="bw-title"><i class="fa fa-sitemap"></i> BGP Best-Path Finder</span>' +
        '<span class="bw-nodes"></span>' +
        '<span class="bw-status">…</span>' +
        '<span class="bw-sp"></span>' +
        '<button class="bw-btn bw-refresh" title="Reload"><i class="fa fa-refresh"></i></button>' +
        '<button class="bw-btn bw-close" title="Close"><i class="fa fa-times"></i></button>' +
      '</div>' +
      '<div class="bw-body"><div class="bw-empty">Loading nodes…</div></div>' +
      '<div class="bw-resize" title="Drag to resize"></div>';
    document.body.appendChild(modal);
    var n = document.querySelectorAll('.bw-modal').length;
    modal.style.left = (110 + n * 24) + 'px';
    modal.style.top = (90 + n * 24) + 'px';

    var $ = function (s) { return modal.querySelector(s); };
    var body = $('.bw-body'), statusEl = $('.bw-status'), nodesEl = $('.bw-nodes');
    function setStatus(t) { statusEl.textContent = t; }

    $('.bw-close').addEventListener('click', function () { modal.remove(); });
    $('.bw-refresh').addEventListener('click', function () {
      if (st.node != null) loadTable(st.node);
    });

    // resolve which endpoints are running console nodes
    setStatus('finding nodes…');
    fetch(URL + '?list=1', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var all = (j.nodes || []);
        var cands = all.filter(function (x) {
          return x.node_id === a || x.node_id === b;
        });
        if (!cands.length) {
          body.innerHTML = '<div class="bw-empty">Neither endpoint of this link ' +
            'is a running node with a serial console, so <b>show ip bgp</b> can\'t ' +
            'be run here.</div>';
          setStatus('no console');
          return;
        }
        cands.forEach(function (c) {
          var nb = el('button', 'bw-node', esc(c.name));
          nb.setAttribute('data-node', c.node_id);
          nb.addEventListener('click', function () { selectNode(c.node_id); });
          nodesEl.appendChild(nb);
        });
        selectNode(cands[0].node_id);
      })
      .catch(function () { setStatus('error'); toast('Could not load node list.'); });

    function selectNode(id) {
      st.node = id;
      Array.prototype.forEach.call(nodesEl.children, function (c) {
        c.classList.toggle('on', parseInt(c.getAttribute('data-node'), 10) === id);
      });
      loadTable(id);
    }

    /* ── Stage 1: the prefix picker ─────────────────────────────────────────── */
    function loadTable(node_id) {
      setStatus('running show ip bgp…');
      body.innerHTML = '<div class="bw-empty">Reading the BGP table…</div>';
      post({ action: 'table', node_id: node_id }).then(function (res) {
        if (!res.ok) { setStatus('error');
          body.innerHTML = '<div class="bw-empty">' +
            esc(res.j.error || 'failed') + '</div>'; return; }
        st.table = res.j;
        renderPicker(res.j);
      }).catch(function () { setStatus('error');
        body.innerHTML = '<div class="bw-empty">Request failed.</div>'; });
    }

    function renderPicker(data) {
      var rows = data.picker || [];
      setStatus(rows.length + ' prefix' + (rows.length === 1 ? '' : 'es'));
      if (!rows.length) {
        body.innerHTML = '<div class="bw-empty">No prefixes in the BGP table. Is ' +
          'BGP configured and converged on <b>' + esc(nodeName(data)) + '</b>?</div>';
        return;
      }
      // div/grid layout (NOT a <table>) so PNetLab's global table CSS can't
      // leak a light row background or dim text into it.
      var html = '<div class="bw-list"><div class="bw-lhead">' +
        '<span>Prefix</span><span>Paths</span><span>Best next-hop</span>' +
        '<span></span></div>';
      rows.forEach(function (r) {
        var flags = '';
        if (r.rib_failure) flags += '<span class="bw-flag rib">RIB-failure</span>';
        if (r.multipath) flags += '<span class="bw-flag ecmp">multipath</span>';
        html += '<div class="bw-prefix-row" data-prefix="' + esc(r.prefix) + '">' +
          '<span class="bw-mono bw-c-prefix">' + esc(r.prefix) + '</span>' +
          '<span class="bw-c-paths">' + esc(r.paths) + '</span>' +
          '<span class="bw-mono bw-c-nh">' + esc(r.best_next_hop || '—') + '</span>' +
          '<span class="bw-c-flags">' + flags + '</span></div>';
      });
      html += '</div>';
      body.innerHTML = html;
      body.querySelectorAll('.bw-prefix-row').forEach(function (row) {
        row.addEventListener('click', function () {
          loadPath(st.node, row.getAttribute('data-prefix'));
        });
      });
    }
    function nodeName(data) {
      return (data && data.node && data.node.name) ? data.node.name : 'this node';
    }

    /* ── Stage 2: the waterfall for one prefix ──────────────────────────────── */
    function loadPath(node_id, prefix) {
      st.prefix = prefix;
      setStatus('show ip bgp ' + prefix + '…');
      body.innerHTML = '<div class="bw-empty">Resolving best path for ' +
        esc(prefix) + '…</div>';
      post({ action: 'path', node_id: node_id, prefix: prefix }).then(function (res) {
        if (!res.ok) { setStatus('error');
          body.innerHTML = '<div class="bw-empty">' +
            esc(res.j.error || 'failed') + '</div>'; return; }
        renderWaterfall(res.j);
      }).catch(function () { setStatus('error');
        body.innerHTML = '<div class="bw-empty">Request failed.</div>'; });
    }

    function renderWaterfall(data) {
      var paths = data.waterfall || [];
      var dec = data.decision || {};
      var winner = dec.winner;
      setStatus(paths.length + ' candidate path' + (paths.length === 1 ? '' : 's'));

      var wrap = el('div');
      var crumb = el('div', 'bw-crumbs',
        '<a class="bw-back">‹ all prefixes</a> &nbsp;·&nbsp; <b class="bw-mono">' +
        esc(data.prefix) + '</b>');
      wrap.appendChild(crumb);

      if (!paths.length) {
        wrap.appendChild(el('div', 'bw-empty', 'No paths returned for this prefix.'));
        body.innerHTML = ''; body.appendChild(wrap);
        body.querySelector('.bw-back').addEventListener('click', backToPicker);
        return;
      }

      // path chips — the single installed best, or (with maximum-paths) every
      // co-installed multipath member, are highlighted as winners.
      var mp = (dec.multipath && dec.multipath.length > 1) ? dec.multipath : [];
      var chips = el('div', 'bw-chips');
      paths.forEach(function (p) {
        var isMp = mp.indexOf(p.id) >= 0;
        var win = p.id === winner || isMp;
        var c = el('div', 'bw-chip' + (win ? ' win' : ''));
        var src = (p.source === 'ibgp') ? 'ibgp' : 'ebgp';
        var asp = (p.as_path && p.as_path.length) ? p.as_path.join(' ') : 'local';
        var tag = isMp ? '<span class="bw-src" style="background:#1f6feb;color:#fff">MP</span>' : '';
        c.innerHTML =
          '<div class="bw-chip-h"><span class="bw-chip-id">' + esc(p.id) + '</span>' +
            '<span class="nh">' + esc(p.next_hop || '') + '</span>' + tag +
            '<span class="bw-src ' + src + '">' + src.toUpperCase() + '</span></div>' +
          '<div class="bw-chip-b">as ' + esc(asp) + '<br>origin ' +
            esc(p.origin || '?') + ' · med ' + esc(p.metric == null ? '—' : p.metric) +
            (p.igp_metric != null ? ' · igp ' + esc(p.igp_metric) : '') + '</div>';
        chips.appendChild(c);
      });
      wrap.appendChild(chips);

      // the rungs
      (dec.rungs || []).forEach(function (r, i) {
        var atMpBoundary = mp.length && dec.multipath_at && r.name === dec.multipath_at;
        var decided = (!mp.length && dec.decided_at && r.name === dec.decided_at);
        var row = el('div', 'bw-rung' + (decided || atMpBoundary ? ' decided' : '') +
          (r.reached ? '' : ' skip'));
        var badges = '';
        // show every path that entered this rung: survivors as in/win, the rest out
        var entering = r.reached ? r.survivors.concat(r.eliminated) : r.survivors;
        // preserve original P-order
        paths.forEach(function (p) {
          if (entering.indexOf(p.id) < 0) return;
          if (r.reached && r.eliminated.indexOf(p.id) >= 0)
            badges += '<span class="bw-pill out">' + esc(p.id) + '</span>';
          else if ((decided && p.id === winner) || (mp.indexOf(p.id) >= 0 && !r.reached))
            badges += '<span class="bw-pill win">' + esc(p.id) + '</span>';
          else
            badges += '<span class="bw-pill in">' + esc(p.id) + '</span>';
        });
        var verdict = atMpBoundary ? 'multipath — load shared'
          : !r.reached ? 'not evaluated'
          : (r.eliminated.length ? 'tie broken' : 'tie — all survive');
        row.innerHTML =
          '<span class="bw-rung-n">' + (i + 1) + '</span>' +
          '<span class="bw-rung-name"><b>' + esc(r.name) + '</b>' +
            '<span class="sub">' + esc(ORIGIN_SUB[r.name] || '') + '</span></span>' +
          '<span class="bw-rung-badges">' + badges + '</span>' +
          '<span class="bw-rung-verdict">' + verdict + '</span>';
        wrap.appendChild(row);
      });

      // winner banner
      var banner = el('div', 'bw-winner');
      if (mp.length) {
        var atTxt = dec.multipath_at
          ? (' — equal at and beyond the <b>' + esc(dec.multipath_at) + '</b> step')
          : '';
        banner.innerHTML = '<i class="fa fa-code-fork"></i><div>' +
          '<div class="h">' + esc(mp.join(' + ')) + ' installed as BGP multipath</div>' +
          '<div class="s">These paths are equal through the comparable attributes' + atTxt +
          ', so <b>maximum-paths</b> installs them all and shares the load. The ' +
          'Router-ID / oldest-path tiebreakers are not applied.</div></div>';
      } else {
        var w = paths.filter(function (p) { return p.id === winner; })[0] || {};
        var why = dec.decided_at
          ? ('Won at the <b>' + esc(dec.decided_at) + '</b> step.')
          : 'Only candidate — best by default.';
        banner.innerHTML = '<i class="fa fa-trophy"></i><div>' +
          '<div class="h">' + esc(winner || '?') + ' installed as best path</div>' +
          '<div class="s">' + why + ' Next-hop ' + esc(w.next_hop || '—') +
          (w.router_id ? ', via neighbor ' + esc(w.router_id) : '') + '.</div></div>';
      }
      wrap.appendChild(banner);

      // raw toggle
      if (data.raw) {
        var rawWrap = el('div', 'bw-raw');
        var tgl = el('button', 'bw-btn', 'Show device output');
        var pre = el('pre'); pre.style.display = 'none';
        pre.textContent = data.raw;
        tgl.addEventListener('click', function () {
          var on = pre.style.display === 'none';
          pre.style.display = on ? '' : 'none';
          tgl.textContent = on ? 'Hide device output' : 'Show device output';
        });
        rawWrap.appendChild(tgl); rawWrap.appendChild(pre);
        wrap.appendChild(rawWrap);
      }

      body.innerHTML = ''; body.appendChild(wrap);
      body.querySelector('.bw-back').addEventListener('click', backToPicker);
    }

    function backToPicker() {
      if (st.table) renderPicker(st.table); else loadTable(st.node);
    }

    dragify(modal, $('.bw-bar'));
    resizeify(modal, $('.bw-resize'));
  }

  /* ── drag by the title bar ───────────────────────────────────────────────── */
  function dragify(modal, handle) {
    var dx = 0, dy = 0, on = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest('.bw-btn') || e.target.closest('.bw-node')) return;
      on = true; dx = e.clientX - modal.offsetLeft; dy = e.clientY - modal.offsetTop;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!on) return;
      modal.style.left = Math.max(0, e.clientX - dx) + 'px';
      modal.style.top = Math.max(0, e.clientY - dy) + 'px';
    });
    document.addEventListener('mouseup', function () { on = false; });
  }

  /* ── drag the bottom-right grip to resize ────────────────────────────────── */
  function resizeify(modal, grip) {
    var ox = 0, oy = 0, ow = 0, oh = 0, on = false;
    grip.addEventListener('mousedown', function (e) {
      on = true; ox = e.clientX; oy = e.clientY;
      ow = modal.offsetWidth; oh = modal.offsetHeight;
      e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener('mousemove', function (e) {
      if (!on) return;
      modal.style.width = Math.max(380, ow + e.clientX - ox) + 'px';
      modal.style.height = Math.max(260, oh + e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', function () { on = false; });
  }
})();
