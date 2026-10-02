/*
 * pnetlab-ai-builder.js — "AI Lab Builder" lab-view side pane (P3).
 *
 * A self-contained chat panel (own sidebar entry, own panel, own CSS) that turns
 * a natural-language request into a built lab. It POSTs to the lab session route
 *   /api/labs/session/ai/plan   (mode=plan  — proposes, does not modify)
 *   /api/labs/session/ai/build  (mode=apply — builds into the open lab)
 * which brokers the in-app agent (ai_lab_agent.py) over the MCP tool surface.
 * Provider + key are the appliance-wide AI settings; when the MCP service is off
 * or unconfigured the panel shows a "configure AI" link to the dashboard.
 *
 * Mirrors the Wi-Fi Painter overlay pattern (sidebar <li> + toggled panel).
 */
(function () {
  'use strict';

  var panel = null, active = false, lastPlanPrompt = '';
  // results-only pane state: by default show the AI's narration + a single step
  // ticker; raw MCP tool_call/tool_result events hide behind a "details" toggle.
  var runEvents = [], stepCount = 0;
  var showDetails = false;
  try { showDetails = (localStorage.getItem('pnq_ai_details') === '1'); } catch (e) {}

  // Panel size persistence (Task 1: custom resize grip — grows panel left/down).
  var PANEL_SIZE_KEY = 'pnq_ai_panel_size';
  var panelW = 380, panelH = null;   // null height = use flex/max-height default
  try {
    var _ps = JSON.parse(localStorage.getItem(PANEL_SIZE_KEY) || 'null');
    if (_ps && _ps.w >= 300) { panelW = _ps.w; panelH = _ps.h || null; }
  } catch (e) {}
  function savePanelSize(w, h) {
    try { localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify({ w: w, h: h })); } catch (e) {}
  }
  function applyPanelSize() {
    if (!panel) return;
    panel.style.width = panelW + 'px';
    if (panelH) { panel.style.height = panelH + 'px'; panel.style.maxHeight = 'none'; }
    else { panel.style.height = ''; panel.style.maxHeight = '78vh'; }
  }

  // The post-build canvas refresh reloads the page (the only reliable way to draw
  // the agent's new nodes), which would wipe this panel + the conversation. Stash
  // the panel state in sessionStorage just before the reload and restore it after,
  // so the user keeps their AI context and can continue (e.g. "now start & verify").
  var SS_KEY = 'pnq_ai_session';
  function saveSession() {
    try {
      var ta = document.getElementById('pnq-ai-prompt');
      var apply = document.getElementById('pnq-ai-apply');
      sessionStorage.setItem(SS_KEY, JSON.stringify({
        open: active,
        events: runEvents.slice(-300),
        prompt: ta ? ta.value : '',
        applyShown: !!(apply && apply.style.display !== 'none'),
        lastPlanPrompt: lastPlanPrompt,
        ts: Date.now()
      }));
    } catch (e) {}
  }
  function restoreSession() {
    var raw;
    try { raw = sessionStorage.getItem(SS_KEY); sessionStorage.removeItem(SS_KEY); } catch (e) { return; }
    if (!raw) return;
    var s; try { s = JSON.parse(raw); } catch (e) { return; }
    if (!s || (Date.now() - (s.ts || 0)) > 1800000) return;   // 30-min stale guard
    if (!panel) buildPanel();
    runEvents = s.events || [];
    stepCount = 0;
    clearLog();
    runEvents.forEach(renderOne);
    var ta = document.getElementById('pnq-ai-prompt'); if (ta && s.prompt) ta.value = s.prompt;
    lastPlanPrompt = s.lastPlanPrompt || '';
    if (s.applyShown) showApply(true);
    if (s.open) { panel.style.display = 'flex'; active = true; }
    log('', '', 'Restored your previous AI session — continue the conversation (e.g. "start the nodes and apply their configs").');
  }

  function esc(t) {
    return String(t == null ? '' : t).replace(/[<>&"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
    });
  }

  function injectCss() {
    if (document.getElementById('pnq-ai-css')) return;
    var s = document.createElement('style');
    s.id = 'pnq-ai-css';
    s.textContent =
      // overflow:visible so the absolute resize grip is not clipped; border-radius
      // is kept for the backdrop — inner content areas scroll individually.
      '#pnq-ai-panel{position:fixed;top:64px;right:16px;width:380px;max-height:78vh;' +
      'display:flex;flex-direction:column;z-index:1050;border-radius:14px;overflow:visible;' +
      'background:rgba(28,30,38,.92);backdrop-filter:blur(14px);color:#e8eaf0;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.08);' +
      'font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif}' +
      '#pnq-ai-panel header{display:flex;align-items:center;gap:8px;padding:11px 14px;' +
      'background:rgba(255,255,255,.05);font-weight:600}' +
      '#pnq-ai-panel header .sp{flex:1}' +
      '#pnq-ai-panel header .x{cursor:pointer;opacity:.7;font-size:16px}' +
      '#pnq-ai-panel header .x:hover{opacity:1}' +
      '#pnq-ai-panel header .det{cursor:pointer;opacity:.55;font-size:12px;font-family:monospace;' +
      'margin-right:10px;padding:1px 5px;border-radius:5px;border:1px solid transparent}' +
      '#pnq-ai-panel header .det:hover{opacity:.9}' +
      '#pnq-ai-panel header .det.on{opacity:1;background:rgba(91,141,239,.25);border-color:rgba(91,141,239,.5)}' +
      '#pnq-ai-log .ev.tool#pnq-ai-step{border-left-color:#d8a23a;font-style:italic}' +
      '#pnq-ai-log .pnq-ai-dl{cursor:pointer;border:0;border-radius:7px;padding:3px 10px;' +
      'margin-top:4px;font:600 12px inherit;color:#fff;background:#3ec07a}' +
      '#pnq-ai-log .pnq-ai-dl:hover{background:#34a869}' +
      '#pnq-ai-log .pnq-ai-dl i{margin-right:5px}' +
      '#pnq-ai-log{flex:1;overflow:auto;padding:10px 14px;min-height:120px}' +
      '#pnq-ai-log .ev{margin:3px 0;padding:5px 9px;border-radius:8px;background:rgba(255,255,255,.04);' +
      'white-space:pre-wrap;word-break:break-word}' +
      '#pnq-ai-log .ev.tool{border-left:3px solid #5b8def}' +
      '#pnq-ai-log .ev.ok{border-left:3px solid #3ec07a}' +
      '#pnq-ai-log .ev.err{border-left:3px solid #e0556b;color:#ffd2d8}' +
      '#pnq-ai-log .ev.asst{border-left:3px solid #c79bff}' +
      '#pnq-ai-log .ev .k{opacity:.65;font-size:11px;text-transform:uppercase;letter-spacing:.04em}' +
      '#pnq-ai-foot{padding:10px 14px;border-top:1px solid rgba(255,255,255,.07)}' +
      '#pnq-ai-prompt{width:100%;box-sizing:border-box;resize:vertical;min-height:56px;' +
      'border-radius:9px;border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.25);' +
      'color:#fff;padding:8px;font:13px/1.4 inherit}' +
      '#pnq-ai-foot .row{display:flex;gap:8px;margin-top:8px}' +
      '#pnq-ai-foot button{flex:1;cursor:pointer;border:0;border-radius:9px;padding:8px;' +
      'font-weight:600;color:#fff}' +
      '#pnq-ai-foot button.plan{background:#3a3f4d}' +
      '#pnq-ai-foot button.build{background:#5b8def}' +
      '#pnq-ai-foot button.apply{background:#3ec07a}' +
      '#pnq-ai-foot button:disabled{opacity:.5;cursor:default}' +
      '#pnq-ai-note{margin-top:8px;font-size:12px;opacity:.85}' +
      '#pnq-ai-note a{color:#8fb6ff}' +
      // Resize grip: bottom-left corner of the right-anchored panel.
      // Dragging it left widens the panel; dragging it down tallens it.
      '#pnq-ai-resize-grip{position:absolute;bottom:0;left:0;width:18px;height:18px;cursor:nesw-resize;' +
      'display:flex;align-items:flex-end;justify-content:flex-start;padding:3px;z-index:10;' +
      'opacity:.45;transition:opacity .15s}' +
      '#pnq-ai-resize-grip:hover{opacity:.9}' +
      // SVG diagonal lines drawn via box-shadow trick using a small canvas pattern
      '#pnq-ai-resize-grip::before{content:"";display:block;width:10px;height:10px;' +
      'border-bottom:2px solid #8fb6ff;border-left:2px solid #8fb6ff;border-radius:0 0 0 3px}';
    document.head.appendChild(s);
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function log(cls, k, msg) {
    var box = document.getElementById('pnq-ai-log');
    if (!box) return;
    var d = el('div', 'ev ' + (cls || ''),
      (k ? '<span class="k">' + esc(k) + '</span> ' : '') + esc(msg));
    box.appendChild(d);
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    var box = document.getElementById('pnq-ai-log');
    if (box) box.innerHTML = '';
  }

  function setBusy(b) {
    ['pnq-ai-plan', 'pnq-ai-build', 'pnq-ai-apply'].forEach(function (id) {
      var n = document.getElementById(id);
      if (n) n.disabled = b;
    });
  }

  // Friendly one-liners for the step ticker (clean mode) — no JSON, no tool jargon.
  var STEP_VERB = {
    add_node: function (a) { return 'Adding ' + (a.name || 'a node') + (a.role ? ' (' + a.role + ')' : ''); },
    connect_nodes: function (a) {
      return (a.a_id != null && a.b_id != null) ? ('Cabling node ' + a.a_id + ' ↔ ' + a.b_id) : 'Cabling devices';
    },
    add_network: function (a) { return 'Adding network ' + (a.name || ''); },
    connect_node_to_network: function () { return 'Connecting to a network'; },
    set_startup_config: function () { return 'Writing a day-0 config'; },
    set_lab_documentation: function () { return 'Writing documentation'; },
    create_lab: function (a) { return 'Creating new lab ' + (a.name || ''); },
    open_lab: function () { return 'Opening the lab'; },
    set_node_position: function () { return 'Arranging the layout'; },
    edit_node: function () { return 'Adjusting a node'; },
    start_node: function (a) { return 'Starting ' + (a.name || ('node ' + (a.id != null ? a.id : ''))); },
    stop_node: function () { return 'Stopping a node'; },
    list_templates: function () { return 'Reading templates'; },
    list_node_images: function () { return 'Checking images'; },
    get_node_interfaces: function () { return 'Checking interfaces'; },
    host_capacity: function () { return 'Sizing to the host'; },
    export_running_config: function () { return 'Reading a running config'; },
    set_link_impairment: function () { return 'Setting link conditions'; },
    link_down: function () { return 'Bringing a link down'; },
    link_up: function () { return 'Bringing a link up'; }
  };
  function friendly(ev) {
    var f = STEP_VERB[ev.tool];
    try { return f ? f(ev.args || {}) : ('Working: ' + ev.tool); } catch (e) { return 'Working…'; }
  }
  function ticker(text, done) {
    var box = document.getElementById('pnq-ai-log'); if (!box) return;
    var t = document.getElementById('pnq-ai-step');
    if (!t) { t = el('div', 'ev tool'); t.id = 'pnq-ai-step'; box.appendChild(t); }
    t.className = 'ev ' + (done ? 'ok' : 'tool');
    t.innerHTML = '<span class="k">' + (done ? 'done' : 'building') + '</span> ' + esc(text);
    box.scrollTop = box.scrollHeight;
  }
  function tokensLine(u) {
    u = u || {};
    if (!(u.input || u.output || u.billed || u.cache_read)) return;
    var billed = (u.billed != null) ? u.billed
      : (Math.max(0, (u.input || 0) - (u.cache_read || 0)) + (u.output || 0));
    var parts = ['billed ' + billed, 'gross in ' + (u.input || 0) + '/out ' + (u.output || 0)];
    if (u.cache_read) parts.push('cached ' + u.cache_read);
    if (u.cache_creation) parts.push('cache-write ' + u.cache_creation);
    log('', 'tokens', parts.join(' · '));
  }

  // Verbose rendering (details toggle ON): the full event stream as before.
  function renderRaw(ev) {
    switch (ev.type) {
      case 'start':
        log('', 'start', (ev.provider || '') + ' / ' + (ev.model || '') +
          ' — ' + (ev.tools || 0) + ' tools, mode ' + ev.mode); break;
      case 'tool_call':
        log('tool', ev.tool, JSON.stringify(ev.args || {})); break;
      case 'tool_result':
        log(ev.ok ? 'ok' : 'err', ev.tool + (ev.ok ? ' ✓' : ' ✗'),
          (ev.result || '').slice(0, 240)); break;
      case 'lab_created':
        log('ok', 'new lab', ev.name || ev.lab_path || ''); break;
      case 'tool_blocked':
        log('err', 'blocked', ev.tool + ' (not allowed in plan mode)'); break;
      case 'tool_error':
        log('err', ev.tool, ev.error || 'error'); break;
      case 'assistant':
        log('asst', 'ai', ev.text || ''); break;
      case 'error':
        log('err', 'error', ev.error || 'failed'); break;
      case 'done':
        log('ok', 'done', ev.summary || 'complete'); tokensLine(ev.usage); break;
    }
  }

  // Clean rendering (default): only the AI's narration + final summary + a single
  // updating step ticker; raw MCP tool_call/tool_result findings are NOT shown
  // (errors always are).
  function renderClean(ev) {
    switch (ev.type) {
      case 'assistant':
        log('asst', 'ai', ev.text || ''); break;
      case 'lab_created':
        log('ok', 'new lab', ev.name || ev.lab_path || ''); break;
      case 'tool_call':
        stepCount++; ticker(friendly(ev) + ' (step ' + stepCount + ')'); break;
      case 'tool_result':
        break;                                   // silent — not shown in clean mode
      case 'tool_blocked':
        log('err', 'blocked', ev.tool); break;
      case 'tool_error':
        log('err', 'error', (ev.tool || '') + ': ' + (ev.error || '')); break;
      case 'error':
        log('err', 'error', ev.error || 'failed'); break;
      case 'done':
        if (stepCount) ticker('Completed ' + stepCount + ' step' + (stepCount === 1 ? '' : 's'), true);
        log('ok', 'done', ev.summary || 'complete'); tokensLine(ev.usage); break;
    }
  }

  // A provide_config tool call carries a node's day-0 config in its args; render it
  // as a Download button (a client-side .txt blob) in BOTH modes — it's a deliverable
  // the user pastes into the console, not build noise.
  function safeFn(s) { return String(s || 'config').replace(/[^A-Za-z0-9._-]+/g, '_'); }
  function renderConfigDownload(args) {
    var box = document.getElementById('pnq-ai-log'); if (!box) return;
    var name = args.node_name || 'config';
    var cfg = args.config_text || '';
    var d = el('div', 'ev ok');
    d.innerHTML = '<span class="k">config</span> ' + esc(name) + '.txt ' +
      '<span style="opacity:.6">(' + cfg.length + ' bytes)</span> ';
    var btn = el('button', 'pnq-ai-dl', '<i class="fa fa-download"></i> Download');
    btn.addEventListener('click', function () {
      try {
        var blob = new Blob([cfg], { type: 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = el('a'); a.href = url; a.download = safeFn(name) + '.txt';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
      } catch (e) { log('err', 'download', String(e)); }
    });
    d.appendChild(btn);
    box.appendChild(d); box.scrollTop = box.scrollHeight;
  }

  function renderOne(ev) {
    if (ev.type === 'tool_call' && ev.tool === 'provide_config') {
      renderConfigDownload(ev.args || {});
      return;
    }
    (showDetails ? renderRaw : renderClean)(ev);
  }

  function renderEvents(events) {
    (events || []).forEach(function (ev) {
      runEvents.push(ev);
      renderOne(ev);
    });
  }

  // Re-render the current run's events in the active mode (used when the user
  // flips the details toggle mid/after a build).
  function rerender() {
    clearLog();
    stepCount = 0;
    runEvents.forEach(renderOne);
  }
  function toggleDetails() {
    showDetails = !showDetails;
    try { localStorage.setItem('pnq_ai_details', showDetails ? '1' : '0'); } catch (e) {}
    var b = document.getElementById('pnq-ai-details');
    if (b) { b.classList.toggle('on', showDetails); b.title = showDetails ? 'Hide technical details' : 'Show technical details'; }
    rerender();
  }

  function showApply(show) {
    var b = document.getElementById('pnq-ai-apply');
    if (b) b.style.display = show ? '' : 'none';
  }

  var pollTimer = null;
  function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  function centerSoon() {
    if (typeof window.pnqCenterTopology !== 'function') return;
    setTimeout(function () { try { window.pnqCenterTopology(); } catch (e) {} }, 700);
  }

  function run(action) {
    var ta = document.getElementById('pnq-ai-prompt');
    var prompt = (ta && ta.value || '').trim();
    if (!prompt) { log('err', '', 'Enter a request first.'); return; }
    if (action !== 'apply') clearLog();
    runEvents = []; stepCount = 0;          // fresh transcript for this run
    setBusy(true);
    showApply(false);
    var mode = action === 'plan' ? 'plan' : 'build';
    log('', '', mode === 'plan' ? 'Planning…' : 'Building…');

    // Live progress: poll the per-pod tee file while the long build POST runs, so
    // tool calls/results stream in instead of arriving in one dump at the end.
    var seen = 0;            // events already rendered (poll + final tail)
    var pollOffset = 0;
    var finished = false;
    stopPoll();
    function poll() {
      fetch('/api/labs/session/ai/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ offset: pollOffset })
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (finished) return;
        var d = (j && j.data) || {};
        if (d.events && d.events.length) { renderEvents(d.events); seen += d.events.length; }
        if (typeof d.offset === 'number') pollOffset = d.offset;
        pollTimer = setTimeout(poll, 800);
      }).catch(function () { if (!finished) pollTimer = setTimeout(poll, 1200); });
    }
    pollTimer = setTimeout(poll, 800);

    fetch('/api/labs/session/ai/' + mode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ prompt: prompt })
    }).then(function (r) { return r.json(); }).then(function (j) {
      finished = true; stopPoll();
      setBusy(false);
      if (!j || (j.status && j.status !== 'success')) {
        log('err', 'error', (j && j.message) || 'request failed');
        return;
      }
      var data = j.data || {};
      // The POST returns the authoritative full event list; render any tail the
      // poll didn't catch (dedup by count — both lists are the same ordered stream).
      if (data.events && data.events.length > seen) {
        renderEvents(data.events.slice(seen));
        seen = data.events.length;
      }
      if (mode === 'plan') {
        lastPlanPrompt = prompt;
        showApply(true);            // offer one-click Apply of the planned build
      } else if (data.open_lab && data.open_lab.url) {
        // the agent created a NEW lab and api.php made it this pod's open session
        log('ok', 'open', 'Opening the new lab…');
        saveSession();
        setTimeout(function () { window.location.href = data.open_lab.url; }, 600);
      } else {
        // built in place: reflect on the canvas, then center the topology in view.
        if (typeof window.pnqRefreshTopology === 'function') {
          try { window.pnqRefreshTopology(j.update); centerSoon(); }
          catch (e) { saveSession(); location.reload(); }
        } else {
          saveSession();
          setTimeout(function () { location.reload(); }, 900);
        }
      }
    }).catch(function (e) {
      finished = true; stopPoll();
      setBusy(false);
      log('err', 'error', String(e));
    });
  }

  function checkService() {
    var note = document.getElementById('pnq-ai-note');
    if (!note) return;
    // If the access probe already told us enabled=false, show the config link
    // without an extra round-trip.  Otherwise fall through to the status fetch
    // which gives a more detailed configured/unconfigured message.
    if (window._pnqAiEnabled === false) {
      note.innerHTML = 'AI/MCP service is off — ' +
        '<a href="/main/#ai" target="_blank">enable &amp; configure it</a>.';
      return;
    }
    fetch('/mcp/api.php?action=status', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var d = (j && j.data) || {};
        if (!d.active) {
          note.innerHTML = 'AI/MCP service is off — ' +
            '<a href="/main/#ai" target="_blank">enable &amp; configure it</a>.';
        } else if (!d.configured) {
          note.innerHTML = 'No access token / provider yet — ' +
            '<a href="/main/#ai" target="_blank">configure AI</a>.';
        } else {
          note.textContent = 'Plan proposes a build; Build applies it to this lab.';
        }
      })
      .catch(function () { note.textContent = ''; });
  }

  function buildPanel() {
    injectCss();
    panel = el('div'); panel.id = 'pnq-ai-panel';
    panel.appendChild(el('header', null,
      '<i class="fa fa-magic"></i><span class="sp">AI Lab Builder</span>' +
      '<span id="pnq-ai-details" class="det' + (showDetails ? ' on' : '') +
      '" title="' + (showDetails ? 'Hide' : 'Show') + ' technical details">&lt;/&gt;</span>' +
      '<span class="x">&times;</span>'));

    var logBox = el('div'); logBox.id = 'pnq-ai-log';
    panel.appendChild(logBox);

    var foot = el('div'); foot.id = 'pnq-ai-foot';
    var ta = el('textarea'); ta.id = 'pnq-ai-prompt';
    ta.setAttribute('placeholder',
      'e.g. 3-router OSPF lab on R1–R3 with a management cloud and a PC; preconfigure loopbacks and OSPF area 0; write objectives and 4 tasks.');
    foot.appendChild(ta);

    var row = el('div', 'row');
    row.innerHTML =
      '<button id="pnq-ai-plan" class="plan">Plan</button>' +
      '<button id="pnq-ai-build" class="build">Build</button>' +
      '<button id="pnq-ai-apply" class="apply" style="display:none">Apply plan</button>';
    foot.appendChild(row);

    var note = el('div'); note.id = 'pnq-ai-note'; foot.appendChild(note);
    panel.appendChild(foot);

    // Resize grip — bottom-left corner. Dragging left widens the panel; dragging
    // down tallens it. Right-anchored layout means growing width moves the LEFT edge.
    var grip = el('div'); grip.id = 'pnq-ai-resize-grip';
    grip.title = 'Drag to resize';
    panel.appendChild(grip);

    document.body.appendChild(panel);

    // Restore persisted size before first display.
    applyPanelSize();

    panel.querySelector('header .x').addEventListener('click', toggle);
    panel.querySelector('#pnq-ai-details').addEventListener('click', toggleDetails);
    document.getElementById('pnq-ai-plan').addEventListener('click', function () { run('plan'); });
    document.getElementById('pnq-ai-build').addEventListener('click', function () { run('build'); });
    document.getElementById('pnq-ai-apply').addEventListener('click', function () { run('apply'); });

    // Resize drag: mousedown on grip, track mousemove/mouseup on document.
    // startX/startY = mouse coords at drag-start; startW/startH = panel size then.
    // Moving left (dx < 0) widens the panel; moving down (dy > 0) tallens it.
    grip.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var startX = e.clientX, startY = e.clientY;
      var startW = panel.offsetWidth;
      var startH = panel.offsetHeight;
      function onMove(ev) {
        var dx = ev.clientX - startX;   // positive = moved right (shrink)
        var dy = ev.clientY - startY;   // positive = moved down (tallen)
        var newW = Math.max(300, Math.min(720, startW - dx));
        var maxH = Math.round(window.innerHeight * 0.92);
        var newH = Math.max(240, Math.min(maxH, startH + dy));
        panelW = newW; panelH = newH;
        panel.style.width = newW + 'px';
        panel.style.height = newH + 'px';
        panel.style.maxHeight = 'none';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        savePanelSize(panelW, panelH);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    checkService();
  }

  function toggle() {
    if (active) {
      if (panel) panel.style.display = 'none';
      active = false; return;
    }
    if (!panel) buildPanel();
    panel.style.display = 'flex';
    active = true;
    checkService();
  }
  window.pnqOverlayAi = toggle;

  function inject() {
    if (document.getElementById('pnq-aibuilder')) return true;
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return false;
    var li = el('li'); li.id = 'pnq-aibuilder';
    li.innerHTML = '<a href="javascript:void(0)" title="Build this lab from a description with AI">' +
      '<i class="fa fa-magic" style="font-size:15px;"></i>' +
      '<span class="lab-sidebar-title">AI Lab Builder</span></a>';
    li.querySelector('a').addEventListener('click', function (e) {
      e.preventDefault(); toggle();
    });
    var anchor = document.getElementById('pnq-wifipainter');
    if (anchor && anchor.parentNode === ul) ul.insertBefore(li, anchor.nextSibling);
    else ul.appendChild(li);
    return true;
  }

  // Probe the server-authoritative access endpoint before injecting the pane.
  // The server derives the role from the session cookie — the client supplies nothing.
  // Fail CLOSED: any network or parse error means no pane.
  function probeAccess(cb) {
    fetch('/api/labs/session/ai/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({})
    }).then(function (r) {
      return r.json();
    }).then(function (j) {
      var d = (j && j.data) || {};
      cb(!!d.allowed, !!d.enabled);
    }).catch(function () {
      // Network/parse error — fail closed.
      cb(false, false);
    });
  }

  function init() {
    // Restore a stashed session after the post-build reload, once the lab has had
    // a moment to settle (the panel attaches to <body>, not the sidebar).
    setTimeout(restoreSession, 1500);

    // Gate the entire pane on the server-authoritative role check.
    // Only inject the sidebar item + panel when the server confirms access.
    probeAccess(function (allowed, enabled) {
      if (!allowed) return;   // role not permitted — no pane at all
      // Store the enabled flag so checkService() can reflect it if the panel is opened.
      window._pnqAiEnabled = enabled;
      if (inject()) return;
      var mo = new MutationObserver(function () { if (inject()) mo.disconnect(); });
      mo.observe(document.body, { childList: true, subtree: true });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
