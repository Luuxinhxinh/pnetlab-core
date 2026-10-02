/*
 * pnetlab-protocol-inspector.js — per-link protocol "packet ladder".
 *
 * The lab editor's native connector context menu (actions.js, the "Connection"
 * menu) gains a "Protocol Inspector" item carrying the two endpoint node ids;
 * clicking it opens a draggable, resizable modal that shows, time-by-time, the
 * control-plane conversation between the two nodes for a chosen protocol (drop-
 * down; v1: BGP) — each packet an arrow A->B / B->A with a short label and a
 * plain-English explanation of what it means for convergence.
 *
 * Backend: pnq-prototrace.php (start/stop/poll, ?list=1 link map) -> brokerd
 * prototrace_* -> pnetlab-prototracer.py (in-kernel BPF capture, stdlib decode
 * in pnet_protodecode.py). This file is a dumb renderer: all meaning text comes
 * from the engine. CSP-safe: no inline handlers, delegated listeners only.
 */
(function () {
  'use strict';
  var URL = '/pnq-prototrace.php';
  var POLL_MS = 1000;
  var FS_MIN = 11, FS_MAX = 20, FS_DEF = 13;

  var linkIndex = null;     // "loId_hiId" -> {network_id,a,b,...}
  var protos = ['bgp'];
  var PROTO_LABELS = { bgp: 'BGP', ospf: 'OSPF', eigrp: 'EIGRP', isis: 'IS-IS',
    stp: 'STP / RSTP / MSTP', gre: 'GRE' };
  function protoLabel(p) { return PROTO_LABELS[p] || String(p).toUpperCase(); }

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
  function getFs() {
    var v = parseInt(localStorage.getItem('pi_fs'), 10);
    return (v >= FS_MIN && v <= FS_MAX) ? v : FS_DEF;
  }
  function toast(msg) {
    var t = el('div', 'pi-toast', esc(msg));
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 300); }, 3200);
  }

  /* ── link list (node-pair -> network_id) ─────────────────────────────────── */
  function loadLinks() {
    return fetch(URL + '?list=1', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        linkIndex = {};
        (j.links || []).forEach(function (l) {
          var lo = Math.min(l.a_node_id, l.b_node_id);
          var hi = Math.max(l.a_node_id, l.b_node_id);
          linkIndex[lo + '_' + hi] = l;
        });
        if (j.protos && j.protos.length) protos = j.protos;
        return j;
      });
  }

  function openByNodes(s, d) {
    var key = Math.min(s, d) + '_' + Math.max(s, d);
    var tryOpen = function () {
      var link = linkIndex && linkIndex[key];
      if (link) { openModal(link); return true; }
      return false;
    };
    // Fast path: a cached index that already knows this link. Otherwise the
    // topology may have changed since the index was built (a link was added or
    // deleted without a page refresh) — reload the list from the backend and
    // retry once before declaring it's not a p2p link.
    if (tryOpen()) return;
    loadLinks().then(function () {
      if (!tryOpen()) {
        toast('Protocol Inspector: this is not a point-to-point link between ' +
          'two nodes.');
      }
    }).catch(function () {
      toast('Protocol Inspector: could not load the link list.');
    });
  }

  // Entry point: the native "Connection" menu item (actions.js).
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('.action-protoinspect');
    if (!a) return;
    e.preventDefault();
    var s = parseInt(a.getAttribute('data-src'), 10);
    var d = parseInt(a.getAttribute('data-dst'), 10);
    if (!isNaN(s) && !isNaN(d)) openByNodes(s, d);
  });

  /* ── the inspector modal ──────────────────────────────────────────────────── */
  function openModal(link) {
    var st = {
      link: link, proto: protos[0], running: false, paused: false,
      since: 0, t0: 0, timer: null, stick: true, rows: 0,
      seen: false, startedAt: 0, fs: getFs(),
      // Convergence Timeline: latest FSM block from the poll, plus the playhead.
      fsm: null, tMax: 0, scrub: false, cursor: 0, phDrag: false,
    };
    var modal = el('div', 'pi-modal');
    var optsHtml = protos.map(function (p) {
      return '<option value="' + esc(p) + '">' + esc(protoLabel(p)) +
        '</option>';
    }).join('');
    modal.innerHTML =
      '<div class="pi-bar">' +
        '<span class="pi-title"><i class="fa fa-exchange"></i> ' +
          esc(link.a) + ' ↔ ' + esc(link.b) + '</span>' +
        '<select class="pi-proto" title="Protocol">' + optsHtml + '</select>' +
        '<span class="pi-status">idle</span>' +
        '<span class="pi-fsm-badge" title="Current protocol state"></span>' +
        '<span class="pi-sp"></span>' +
        '<button class="pi-btn pi-fsdec" title="Smaller text">A&minus;</button>' +
        '<button class="pi-btn pi-fsinc" title="Larger text">A+</button>' +
        '<button class="pi-btn pi-start"><i class="fa fa-play"></i> Start</button>' +
        '<button class="pi-btn pi-pause" disabled><i class="fa fa-pause"></i></button>' +
        '<button class="pi-btn pi-clear" title="Clear"><i class="fa fa-eraser"></i></button>' +
        '<button class="pi-btn pi-ghost" title="See-through (20% opaque; hover to read)"><i class="fa fa-adjust"></i></button>' +
        '<button class="pi-btn pi-close" title="Close"><i class="fa fa-times"></i></button>' +
      '</div>' +
      '<div class="pi-heads"><span class="pi-head-a">' + esc(link.a) +
        '</span><span class="pi-head-b">' + esc(link.b) + '</span></div>' +
      '<div class="pi-fsm" title="Convergence timeline — drag the playhead or ' +
        'click a transition to scrub the conversation back and forth">' +
        '<div class="pi-fsm-track"></div>' +
        '<div class="pi-fsm-head"></div>' +
        '<button class="pi-fsm-live"><i class="fa fa-step-backward"></i> Live' +
        '</button>' +
      '</div>' +
      '<div class="pi-ladder"><div class="pi-empty">Choose a protocol and ' +
        'press <b>Start</b> to watch the conversation on this link as it ' +
        'unfolds.</div></div>' +
      '<div class="pi-resize" title="Drag to resize"></div>';
    document.body.appendChild(modal);

    // size: restore saved, else default; cascade position
    var sw = parseInt(localStorage.getItem('pi_w'), 10);
    var sh = parseInt(localStorage.getItem('pi_h'), 10);
    if (sw >= 360) modal.style.width = sw + 'px';
    if (sh >= 240) modal.style.height = sh + 'px';
    var n = document.querySelectorAll('.pi-modal').length;
    modal.style.left = (90 + n * 24) + 'px';
    modal.style.top = (90 + n * 24) + 'px';
    modal.style.setProperty('--pi-fs', st.fs + 'px');

    var $ = function (s) { return modal.querySelector(s); };
    var statusEl = $('.pi-status'), ladder = $('.pi-ladder');
    var startBtn = $('.pi-start'), pauseBtn = $('.pi-pause'), protoSel = $('.pi-proto');
    var fsmWrap = $('.pi-fsm'), track = $('.pi-fsm-track'),
        playhead = $('.pi-fsm-head'), liveBtn = $('.pi-fsm-live'),
        badge = $('.pi-fsm-badge');
    fsmWrap.style.display = 'none';      // hidden until a proto with an FSM runs

    function setStatus(txt) { statusEl.textContent = txt; }

    function teardown(sendStop) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      if (sendStop && st.running) {
        fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stop', network_id: link.network_id }) })
          .catch(function () {});
      }
      st.running = false;
    }

    function fieldsHtml(f) {
      if (!f) return '';
      var keys = Object.keys(f);
      if (!keys.length) return '';
      var rows = keys.map(function (k) {
        return '<tr><td>' + esc(k) + '</td><td>' + esc(f[k]) + '</td></tr>';
      }).join('');
      return '<table class="pi-fields">' + rows + '</table>';
    }

    function rowFor(ev) {
      var dirAB = ev.dir === 'ab';
      var row = el('div', 'pi-evt sev-' + (ev.severity || 'info') +
        (dirAB ? ' ab' : ' ba'));
      if (!st.t0) st.t0 = ev.ts;
      var time = '+' + (ev.ts - st.t0).toFixed(1) + 's';
      row.innerHTML =
        '<span class="pi-time">' + time + '</span>' +
        '<span class="pi-track">' +
          '<span class="pi-arrow"></span>' +
          '<span class="pi-chip">' + esc(ev.label) + '</span>' +
        '</span>';
      var detail = el('div', 'pi-detail');
      detail.innerHTML = '<div class="pi-why">' + esc(ev.detail) + '</div>' +
        fieldsHtml(ev.fields);
      detail.style.display = 'none';
      row.addEventListener('click', function () {
        detail.style.display = detail.style.display === 'none' ? '' : 'none';
      });
      var wrap = el('div', 'pi-evtwrap');
      wrap.dataset.ts = ev.ts;            // playhead scrubbing maps cursor->rows
      wrap.appendChild(row);
      wrap.appendChild(detail);
      return wrap;
    }

    function append(events) {
      if (!events.length) return;
      var empty = ladder.querySelector('.pi-empty');
      if (empty) empty.remove();
      events.forEach(function (ev) {
        if (ev.seq != null && ev.seq >= st.since) st.since = ev.seq + 1;
        if (ev.ts > st.tMax) st.tMax = ev.ts;
        ladder.appendChild(rowFor(ev));
        st.rows++;
      });
      if (st.stick) ladder.scrollTop = ladder.scrollHeight;
      if (st.scrub) applyCursor();        // newly-arrived rows are past the cursor
    }

    /* ── convergence timeline (FSM track + playhead) ───────────────────────── */
    function stateClass(s) {
      if (s === 'Established' || s === 'Full' || s === 'Up') return 'fsm-good';
      if (s === 'Idle' || s === 'Down') return 'fsm-down';
      return 'fsm-mid';                   // negotiating (OpenSent, ExStart, …)
    }
    // The state the session was in at time `cursor`, walking the transitions.
    function fsmStateAt(fsm, cursor) {
      var trs = (fsm && fsm.transitions) || [];
      if (!trs.length) return fsm ? fsm.current : '';
      var s = trs[0].from;
      for (var i = 0; i < trs.length; i++) {
        if (trs[i].ts <= cursor) s = trs[i].to; else break;
      }
      return s;
    }
    function fsmBounds() {
      var trs = (st.fsm && st.fsm.transitions) || [];
      var t0 = st.t0 || (trs[0] && trs[0].ts) || 0;
      var tEnd = Math.max(st.tMax, t0 + 0.001);
      return { t0: t0, tEnd: tEnd, span: (tEnd - t0) || 1 };
    }
    function renderFsm() {
      if (!st.fsm) {
        fsmWrap.style.display = 'none';
        badge.className = 'pi-fsm-badge'; badge.textContent = '';
        return;
      }
      fsmWrap.style.display = '';
      var fsm = st.fsm, trs = fsm.transitions || [], b = fsmBounds();
      track.innerHTML = '';
      var prev = trs.length ? trs[0].from : fsm.current, ptime = b.t0;
      function seg(state, a, z) {
        var s = el('span', 'pi-seg ' + stateClass(state));
        s.style.left = ((a - b.t0) / b.span * 100) + '%';
        s.style.width = (Math.max(0, z - a) / b.span * 100) + '%';
        s.title = state;
        track.appendChild(s);
      }
      trs.forEach(function (tr) { seg(prev, ptime, tr.ts); prev = tr.to; ptime = tr.ts; });
      seg(prev, ptime, b.tEnd);
      trs.forEach(function (tr) {
        var m = el('span', 'pi-mark');
        m.style.left = ((tr.ts - b.t0) / b.span * 100) + '%';
        m.setAttribute('data-ts', tr.ts);
        m.title = tr.from + ' → ' + tr.to + (tr.reason ? ' · ' + tr.reason : '');
        track.appendChild(m);
      });
      var cursor = st.scrub ? st.cursor : b.tEnd;
      playhead.style.left =
        Math.max(0, Math.min(100, (cursor - b.t0) / b.span * 100)) + '%';
      var cur = st.scrub ? fsmStateAt(fsm, cursor) : fsm.current;
      badge.className = 'pi-fsm-badge ' + stateClass(cur);
      badge.textContent = cur || '';
      badge.title = fsm.seeded
        ? 'This session was already up when capture started — the earliest ' +
          'state was inferred from steady-state traffic, not observed live.'
        : 'Current protocol state';
      liveBtn.style.display = st.scrub ? '' : 'none';
    }
    function clearCursorMarks() {
      var marked = ladder.querySelectorAll('.pi-dim, .pi-cursorrow');
      for (var i = 0; i < marked.length; i++) {
        marked[i].classList.remove('pi-dim');
        marked[i].classList.remove('pi-cursorrow');
      }
    }
    function applyCursor() {
      var wraps = ladder.querySelectorAll('.pi-evtwrap'), cursorRow = null;
      for (var i = 0; i < wraps.length; i++) {
        var ts = parseFloat(wraps[i].dataset.ts);
        if (ts > st.cursor + 1e-6) {
          wraps[i].classList.add('pi-dim');
          wraps[i].classList.remove('pi-cursorrow');
        } else {
          wraps[i].classList.remove('pi-dim');
          cursorRow = wraps[i];           // last row at/before the cursor
        }
      }
      var prev = ladder.querySelectorAll('.pi-cursorrow');
      for (var j = 0; j < prev.length; j++) prev[j].classList.remove('pi-cursorrow');
      if (cursorRow) {
        cursorRow.classList.add('pi-cursorrow');
        cursorRow.scrollIntoView({ block: 'nearest' });
      }
    }
    function timeAtX(clientX) {
      var r = track.getBoundingClientRect(), b = fsmBounds();
      var frac = r.width ? (clientX - r.left) / r.width : 0;
      frac = Math.max(0, Math.min(1, frac));
      return b.t0 + frac * (b.tEnd - b.t0);
    }
    function scrubTo(t) {
      st.scrub = true; st.cursor = t; st.stick = false;
      applyCursor(); renderFsm();
    }
    function goLive() {
      st.scrub = false; clearCursorMarks(); st.stick = true;
      ladder.scrollTop = ladder.scrollHeight; renderFsm();
    }
    track.addEventListener('mousedown', function (e) {
      if (!st.fsm) return;
      st.phDrag = true;
      var m = e.target.closest && e.target.closest('.pi-mark');
      scrubTo(m ? parseFloat(m.getAttribute('data-ts')) : timeAtX(e.clientX));
      e.preventDefault();
    });
    playhead.addEventListener('mousedown', function (e) {
      if (!st.fsm) return;
      st.phDrag = true; e.preventDefault(); e.stopPropagation();
    });
    document.addEventListener('mousemove', function (e) {
      if (st.phDrag) scrubTo(timeAtX(e.clientX));
    });
    document.addEventListener('mouseup', function () { st.phDrag = false; });
    liveBtn.addEventListener('click', goLive);
    function resetFsm() {
      st.fsm = null; st.tMax = 0; st.scrub = false; st.cursor = 0;
      clearCursorMarks(); renderFsm();
    }

    ladder.addEventListener('scroll', function () {
      st.stick = (ladder.scrollHeight - ladder.scrollTop - ladder.clientHeight) < 40;
    });

    function poll() {
      if (!st.running || st.paused) return;
      fetch(URL + '?network_id=' + link.network_id + '&since=' + st.since,
        { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!st.running) return;
          if (!j.active) {
            // daemon needs ~0.5s to write its first snapshot — tolerate a grace
            if (!st.seen && (Date.now() - st.startedAt) < 12000) {
              setStatus('starting…');
              st.timer = setTimeout(poll, POLL_MS);
              return;
            }
            setStatus(st.seen ? 'engine watcher ended' : 'could not start watcher');
            teardown(false); setUi(false); return;
          }
          st.seen = true;
          append(j.events || []);
          st.fsm = j.fsm || null;
          renderFsm();
          var drop = j.dropped ? (' · ' + j.dropped + ' dropped (buffer)') : '';
          var tail = st.rows ? (st.rows + ' events') : ('waiting for ' +
            protoLabel(st.proto) + ' packets…');
          setStatus((st.paused ? 'paused' : 'live') + ' · ' + tail + drop);
          st.timer = setTimeout(poll, POLL_MS);
        })
        .catch(function () { if (st.running) st.timer = setTimeout(poll, POLL_MS); });
    }

    function setUi(running) {
      startBtn.innerHTML = running
        ? '<i class="fa fa-stop"></i> Stop' : '<i class="fa fa-play"></i> Start';
      startBtn.classList.toggle('on', running);
      pauseBtn.disabled = !running;
      protoSel.disabled = running;
    }

    function start() {
      st.proto = protoSel.value;
      setStatus('starting…');
      fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', network_id: link.network_id,
          proto: st.proto }) })
        .then(function (r) { return r.json().then(function (j) {
          return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) { setStatus(res.j.message || res.j.error || 'start failed');
            return; }
          st.running = true; st.paused = false; st.since = 0;
          st.seen = false; st.startedAt = Date.now();
          st.t0 = 0; resetFsm();
          setUi(true); setStatus('starting…'); poll();
        })
        .catch(function () { setStatus('start failed'); });
    }

    startBtn.addEventListener('click', function () {
      if (st.running) { teardown(true); setUi(false); setStatus('stopped'); }
      else start();
    });
    pauseBtn.addEventListener('click', function () {
      if (!st.running) return;
      st.paused = !st.paused;
      pauseBtn.innerHTML = st.paused
        ? '<i class="fa fa-play"></i>' : '<i class="fa fa-pause"></i>';
      if (!st.paused) poll(); else setStatus('paused · ' + st.rows + ' events');
    });
    protoSel.addEventListener('change', function () {
      st.proto = protoSel.value;
      if (st.running) {           // restart on the newly chosen protocol
        teardown(true);
        ladder.innerHTML = ''; st.rows = 0; st.t0 = 0; resetFsm();
        setUi(false);
        start();
      }
    });
    $('.pi-clear').addEventListener('click', function () {
      ladder.innerHTML = ''; st.rows = 0; st.t0 = 0; resetFsm();
    });
    $('.pi-close').addEventListener('click', function () {
      teardown(true); modal.remove();
    });
    function setFs(fs) {
      st.fs = Math.max(FS_MIN, Math.min(FS_MAX, fs));
      modal.style.setProperty('--pi-fs', st.fs + 'px');
      localStorage.setItem('pi_fs', st.fs);
    }
    $('.pi-fsdec').addEventListener('click', function () { setFs(st.fs - 1); });
    $('.pi-fsinc').addEventListener('click', function () { setFs(st.fs + 1); });

    // See-through toggle (like the webconsole telnet window): make the modal 20%
    // opaque to glance at the topology behind it; it restores to full on hover so
    // it stays readable. Preference persisted across opens.
    function setGhost(on) {
      modal.classList.toggle('pi-ghost-on', on);
      $('.pi-ghost').classList.toggle('on', on);
      localStorage.setItem('pi_ghost', on ? '1' : '0');
    }
    setGhost(localStorage.getItem('pi_ghost') === '1');
    $('.pi-ghost').addEventListener('click', function () {
      setGhost(!modal.classList.contains('pi-ghost-on'));
    });

    dragify(modal, $('.pi-bar'));
    resizeify(modal, $('.pi-resize'));
  }

  /* ── drag by the title bar ───────────────────────────────────────────────── */
  function dragify(modal, handle) {
    var dx = 0, dy = 0, on = false;
    handle.addEventListener('mousedown', function (e) {
      if (e.target.closest('.pi-btn') || e.target.closest('.pi-proto')) return;
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
      modal.style.width = Math.max(360, ow + e.clientX - ox) + 'px';
      modal.style.height = Math.max(240, oh + e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!on) return;
      on = false;
      localStorage.setItem('pi_w', modal.offsetWidth);
      localStorage.setItem('pi_h', modal.offsetHeight);
    });
  }

  /* ── boot: warm the link cache once the topology exists ──────────────────── */
  function init() {
    if (window.lab_topology) { loadLinks().catch(function () {}); return; }
    var tries = 0;
    var iv = setInterval(function () {
      if (window.lab_topology || tries++ > 40) {
        clearInterval(iv);
        if (window.lab_topology) loadLinks().catch(function () {});
      }
    }, 500);
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})();
