/* pnetlab-app-topology-stub.js — canvas-flow amputation (b2 Wave 3, B2).
 *
 * The Svelte Flow island is now the ONLY lab canvas: the store React bundle
 * (lab.js) and jsPlumb are no longer loaded. lab.js used to install
 * `window.App.topology` — a rich jsPlumb-backed model object. ~14 survivor files
 * still call it UNCONDITIONALLY as their "refresh the canvas / read a node" step:
 *
 *   App.topology.updateData(update)        (every write global's success handler)
 *   App.topology.printTopology()           (redraw the jsPlumb canvas)
 *   App.topology.nodes[id].get('name'|'component'|…)   (lifecycle/interfaces/render)
 *   App.topology.nodes[id].getAll()        (node-runon)
 *   App.topology.links[id].source…         (dead #lab-viewport connToDel lane)
 *   App.topology.isClick                   (webconsole drag guard)
 *   App.topology.getTopoData().then(…)     (isolate / refresh)
 *
 * Without lab.js those throw (App undefined, or nodes[id].get on undefined). This
 * installs a PERSISTENT no-op-ish stub that:
 *   • answers every read the survivors make (nodes/links are Proxies that mint a
 *     synthetic accessor for ANY id, reading from PNQStore + window.__pnqCanvas),
 *   • makes get('component') return `false` so the survivors' `if(comp) …` DOM
 *     branches become no-ops — the island OWNS status/geometry rendering,
 *   • fires the island's reseed signal from updateData (a CustomEvent the island
 *     listens for — the old jsPlumb trip-wire that monkey-patched updateData is
 *     retired; the island now subscribes to this event instead),
 *   • returns resolved thenables from printTopology/getTopoData/ObjectPosUpdateExec
 *     so `.then(...)` callers keep working.
 *
 * Loaded as a classic <script defer> BEFORE actions.js so App.topology exists by
 * the time any survivor runs. CSP-clean (same-origin, no inline). Idempotent.
 */
(function () {
  'use strict';

  // ---- synthetic node accessor: reads PNQStore.state.nodes[id] first, then the
  //      raw topology record on window.__pnqCanvas.rawNodes[id] (fuller: template,
  //      image, ethernets, …). get('component') is deliberately falsy so classic
  //      DOM-status writes skip; the island renders status.
  function nodeRecord(id) {
    var s = (window.PNQStore && window.PNQStore.state && window.PNQStore.state.nodes) || {};
    var raw = (window.__pnqCanvas && window.__pnqCanvas.rawNodes) || {};
    var live = (window.nodes && window.nodes[id]) || {};
    // raw (full record) is the base; live poll status + store geometry overlay it.
    var merged = mergeNodeRecord(raw[id], live);
    merged = mergeNodeRecord(merged, s[id]);
    if (merged.name == null || merged.name === '') merged.name = 'node' + id;
    return merged;
  }
  function makeNode(id) {
    return {
      // get(field, dflt): 'component' -> false (no jsPlumb DOM node); else the
      // merged record value, else dflt.
      get: function (field, dflt) {
        if (field === 'component' || field === '$e' || field === 'element') return false;
        if (field === 'id') return id;
        var rec = nodeRecord(id);
        return (rec[field] != null) ? rec[field] : (arguments.length > 1 ? dflt : undefined);
      },
      getAll: function () { return nodeRecord(id); },
      set: function () { /* island owns state; classic sets are no-ops */ },
      attr: function () { return this; },
    };
  }

  // Proxy so nodes[<anyId>] always yields a synthetic accessor (never undefined),
  // but `in`/enumeration reflect only ids the store actually knows.
  function collProxy(makeEntry, sourceFn) {
    return new Proxy({}, {
      get: function (t, prop) {
        if (typeof prop === 'symbol') return t[prop];
        if (prop === 'hasOwnProperty' || prop === 'constructor') return t[prop];
        var src = sourceFn();
        if (prop in t) return t[prop];
        // Only mint an entry for ids the source knows (so `for (id in nodes)` and
        // `nodes[id]` presence checks stay honest), OR for a bare numeric id read.
        if (Object.prototype.hasOwnProperty.call(src, prop) || /^\w+$/.test(String(prop))) {
          return makeEntry(prop);
        }
        return undefined;
      },
      has: function (t, prop) {
        var src = sourceFn();
        return (prop in t) || Object.prototype.hasOwnProperty.call(src, prop);
      },
      ownKeys: function () { return Object.keys(sourceFn()); },
      getOwnPropertyDescriptor: function (t, prop) {
        var src = sourceFn();
        if (Object.prototype.hasOwnProperty.call(src, prop)) {
          return { enumerable: true, configurable: true, value: makeEntry(prop) };
        }
        return Object.getOwnPropertyDescriptor(t, prop);
      },
    });
  }

  function storeNodes() {
    return (window.PNQStore && window.PNQStore.state && window.PNQStore.state.nodes) || {};
  }
  function storeLinks() {
    return (window.PNQStore && window.PNQStore.state && window.PNQStore.state.links) || {};
  }

  // Overlay a live/derived record without letting an absent value erase the
  // full topology record. PNQStore is intentionally a reduced, hot-path model;
  // rawNodes owns descriptive fields such as image, cpu and ram. In particular,
  // status/bootstrap patches can carry `''` or `undefined` while those fields
  // are not present yet.
  function overlayNonBlank(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (var key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      if (source[key] === undefined || source[key] === '') continue;
      target[key] = source[key];
    }
    return target;
  }
  function mergeNodeRecord(base, overlay) {
    return overlayNonBlank(Object.assign({}, base || {}), overlay);
  }

  // Legacy `lines` map: lab.js kept App.topology.lines keyed by line id; pnetlab-line.js's
  // island exports (pnqLineEdit/pnqLineDelete) read App.topology.lines[id]. api-seed
  // publishes the raw lines onto window.__pnqCanvas.lines (object-map OR array) — expose
  // a live keyed view so line Edit/Delete resolve their record.
  function rawLinesMap() {
    var raw = (window.__pnqCanvas && window.__pnqCanvas.lines) || {};
    if (Array.isArray(raw)) {
      var m = {};
      for (var i = 0; i < raw.length; i++) {
        var r = raw[i]; if (!r) continue;
        var id = r.id != null ? String(r.id) : String(i);
        m[id] = r;
      }
      return m;
    }
    return raw;
  }

  // synthetic link accessor: best-effort .source/.dest with .node.get/.interface.get
  // shims. This lane is only reached by the (now dead) #lab-viewport connToDel menu
  // path — netem/hide/edit resolve from the island's own model — so it just needs
  // to not throw if something touches it.
  function makeLink(id) {
    var rec = (storeLinks()[id]) || {};
    function endpoint(nodeId, ifId) {
      return {
        type: 'ethernet',
        node: makeNode(nodeId),
        interface: { get: function (f) { return f === 'id' ? ifId : (f === 'suspend' ? '0' : undefined); } },
      };
    }
    return {
      id: id,
      source: endpoint(rec.source, rec.srcIfId),
      dest: (rec.target != null) ? endpoint(rec.target, rec.dstIfId) : null,
    };
  }

  // resolved thenable (jQuery-Deferred-like enough for `.then`) so classic
  // `App.topology.getTopoData().then(...)` / `.printTopology().then(...)` work.
  function resolved() {
    var p = Promise.resolve();
    // jQuery Deferred exposes .done too; some callers use .then only.
    p.done = function (fn) { if (typeof fn === 'function') Promise.resolve().then(fn); return p; };
    return p;
  }

  // ---- island reseed arming + state-sync reconciliation guard ----------------
  // The island's updateData trip-wire (CanvasFlow.onAppUpdateData) reseeds its
  // PNQStore model ONLY when the dispatched payload carries a truthy `.nodes`:
  //   `if (update && update.nodes) scheduleUpdateDataReseed();`
  // The engine returns `update` keyed by the collection it touched, so several
  // legacy write handlers hand the island a payload with NO `.nodes` key — and
  // those writes then never reseed the island (stale until a manual reload):
  //   • labinfo-only  — lab lock/unlock (api.php 1717) and AI in-place apply:
  //                     island keeps the OLD lock state → drag/menu gating wrong.
  //   • textobjects-only — legacy text/picture edit (api.php 2193): island deco
  //                     stale.
  //   • lines-only    — legacy line edit (api.php 2313): island line stale.
  // (node/network/interface/p2p writes DO carry `.nodes` — api.php 1844/1967/2156
  //  — so those already reseed; this guard is about the payloads that DON'T.)
  //
  // The island's reseed RE-FETCHES /api/labs/session/topology and re-derives the
  // WHOLE model (nodes + networks + labinfo + decorations + lines); it never reads
  // `update.nodes`' CONTENTS — it is a pure truthiness gate. So we can close every
  // gap above by ARMING that gate on EVERY updateData: when the real payload lacks
  // `.nodes`, attach a synthetic node snapshot so the island always reseeds. The
  // island reseed is debounced (400ms) + skipped while one is already in flight,
  // so arming never double-fires a fetch.
  //
  // We also close the RACE where a legacy updateData lands WHILE an island reseed
  // is in flight: the island's 400ms debounce timer can elapse inside that window
  // and be dropped (scheduleUpdateDataReseed returns without rescheduling when
  // reseedInFlight), leaving the island one structural change stale. A single
  // trailing "settle" re-dispatch, debounced to the END of a burst of writes,
  // fires one quiet-time reseed once the island is no longer in flight — a
  // guaranteed catch-up. It does NOT reschedule itself (no loop), and the island's
  // in-flight-skip + debounce absorb it to at most one extra fetch per burst.
  //
  // No loop risk: the island reseed applies to PNQStore and never calls
  // App.topology.updateData, so it cannot re-enter fireReseed.
  var _settleTimer = 0;
  function dispatchUpdateEvent(update) {
    try {
      document.dispatchEvent(new CustomEvent('pnq:app-updatedata', { detail: { update: update } }));
    } catch (_) { /* best-effort */ }
  }
  function armUpdate(update) {
    var u = (update && typeof update === 'object') ? update : {};
    if (!u.nodes) {
      // shallow snapshot of the store's node map (truthy, real, cheap — the island
      // gate only needs truthiness; contents are ignored). __pnqArmed marks it for
      // any future consumer/debugging so a synthesised payload is distinguishable.
      u = Object.assign({}, u, { nodes: Object.assign({}, storeNodes()), __pnqArmed: true });
    }
    return u;
  }
  function fireReseed(update) {
    // Primary dispatch — armed so the island ALWAYS reseeds regardless of which
    // collection the legacy write touched.
    dispatchUpdateEvent(armUpdate(update));
    // Trailing settle re-fire — one quiet-time catch-up after the write burst ends.
    if (_settleTimer) window.clearTimeout(_settleTimer);
    _settleTimer = window.setTimeout(function () {
      _settleTimer = 0;
      dispatchUpdateEvent({ nodes: Object.assign({}, storeNodes()), __pnqSettle: true });
    }, 900);
  }

  // ---- awaited reseed (sidebar "Refresh Topology") ---------------------------
  // fireReseed() is fire-and-forget: the fetch happens inside the island, so the
  // stub used to have no idea when — or whether — a refresh finished. The island
  // now mirrors every terminal outcome of an updateData-driven reseed back as
  // `pnq:app-updatedata:done` {ok} (CanvasFlow.fireUpdateDataDone), which lets a
  // caller drive a spinner + toast off the REAL result instead of a guessed timer.
  //
  // ALWAYS RESOLVES, never rejects, with {ok:…}: the survivor callers of
  // getTopoData (node lock badge, nodes lifecycle) chain a bare .then and an
  // unhandled rejection would break them. A failed refresh is `ok:false` — the
  // caller decides whether that warrants a danger toast.
  //
  // The timeout is a BACKSTOP, not the mechanism: if the island is absent (no
  // canvas on this page) or the event is ever missed, the promise still settles
  // so a spinner can never strand. It resolves {ok:false, timedOut:true} so the
  // caller reports a failure rather than a false "refreshed".
  var RESEED_DONE_EVENT = 'pnq:app-updatedata:done';
  var RESEED_TIMEOUT_MS = 10000;
  function fireReseedAwaited() {
    var p = new Promise(function (resolve) {
      var settled = false;
      var timer = 0;
      function finish(result) {
        if (settled) return;
        settled = true;
        if (timer) window.clearTimeout(timer);
        document.removeEventListener(RESEED_DONE_EVENT, onDone);
        resolve(result);
      }
      function onDone(e) {
        finish({ ok: !!(e && e.detail && e.detail.ok) });
      }
      document.addEventListener(RESEED_DONE_EVENT, onDone);
      timer = window.setTimeout(function () {
        finish({ ok: false, timedOut: true });
      }, RESEED_TIMEOUT_MS);
      fireReseed({});
    });
    p.done = function (fn) { if (typeof fn === 'function') p.then(fn); return p; };
    return p;
  }

  // ---- window.nodes freshness ------------------------------------------------
  // Rebuild the plain `{id: record}` map the legacy features iterate. Base = the
  // island's FULL raw records (window.__pnqCanvas.rawNodes: name/template/image/
  // ram/cpu/icon/console/url/ethernets/left/top/…); overlay the LIVE PNQStore node
  // (status from the nodestatus poll/WS feed + any store geometry) so status-driven
  // features (node-stats row lock, Destroy-Lab running count, native-console "only
  // when running") read current values. Rebuilt in place (same object identity is
  // fine — nothing holds a stale reference across a rebuild).
  function rebuildWindowNodes() {
    var raw = (window.__pnqCanvas && window.__pnqCanvas.rawNodes) || {};
    var store = (window.PNQStore && window.PNQStore.state && window.PNQStore.state.nodes) || {};
    var map = window.nodes || (window.nodes = {});
    // clear removed ids
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k) &&
          !Object.prototype.hasOwnProperty.call(raw, k) &&
          !Object.prototype.hasOwnProperty.call(store, k)) {
        delete map[k];
      }
    }
    // ids = union of raw + store
    var ids = {};
    var kk;
    for (kk in raw) if (Object.prototype.hasOwnProperty.call(raw, kk)) ids[kk] = 1;
    for (kk in store) if (Object.prototype.hasOwnProperty.call(store, kk)) ids[kk] = 1;
    for (var id in ids) {
      if (!Object.prototype.hasOwnProperty.call(ids, id)) continue;
      var merged = mergeNodeRecord(raw[id], store[id]);
      if (merged.id == null) merged.id = id;
      if (merged.name == null || merged.name === '') merged.name = 'node' + id;
      map[id] = merged;
    }
    return map;
  }

  // ---- window.networks freshness ---------------------------------------------
  // Same story as window.nodes: legacy features iterate a plain `{id: record}`
  // networks map that lab.js populated. actions.js's .action-networkedit handler
  // reads `window.networks[id]` synchronously (Network right-click → Edit); with
  // window.networks undefined it threw and Edit did nothing. Source = the island's
  // PNQStore.state.networks (name/type/left/top/…), which map-store already mints
  // the net_<id> clouds from. Rebuilt in place on the same events as window.nodes.
  function rebuildWindowNetworks() {
    var store = (window.PNQStore && window.PNQStore.state && window.PNQStore.state.networks) || {};
    var map = window.networks || (window.networks = {});
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k) &&
          !Object.prototype.hasOwnProperty.call(store, k)) delete map[k];
    }
    for (var id in store) {
      if (!Object.prototype.hasOwnProperty.call(store, id)) continue;
      var rec = Object.assign({}, store[id] || {});
      if (rec.id == null) rec.id = id;
      map[id] = rec;
    }
    return map;
  }

  // One-shot fetch fallback: if rawNodes is empty when we first need window.nodes
  // (island not seeded yet / ever), pull the node table directly. The list route
  // GET /api/labs/session/nodes returns {status:'success', data:{"<id>":{...}}}.
  var fetchedOnce = false;
  var _rawNodesReady = false;
  var _reseedPending = false;
  var _rawReadyWaiters = [];

  function markRawNodesReady() {
    _rawNodesReady = true;
    _reseedPending = false;
    refreshWindowNodes();
    var waiters = _rawReadyWaiters.splice(0);
    waiters.forEach(function (resolve) { resolve(window.nodes || {}); });
  }

  // The Nodes modal calls this before rendering. A null return means the map is
  // ready; a promise means the caller must wait for the authoritative seed or
  // reseed signal. This keeps the legacy modal from painting a correct row count
  // from the reduced store while raw descriptive fields are still in flight.
  // READINESS_TIMEOUT_MS: the waiter MUST always settle. _rawReadyWaiters is drained
  // only by markRawNodesReady(), which fires from the reseed events or from the
  // fetchNodeTableInto() success branch — and that fetch ends in `.catch(){}`, which
  // swallows an expired session, a network blip or a non-JSON body silently. Without
  // this timeout, any of those leaves the promise forever pending and the Nodes modal
  // NEVER OPENS: clicking the sidebar button does nothing at all. That is strictly
  // worse than the R7 defect it replaced — blank rows at least tell the user
  // something is wrong, while a silent no-op looks like a dead button and gives a
  // support caller nothing to describe. Degrade to rendering whatever we have.
  var READINESS_TIMEOUT_MS = 6000;

  function ensureWindowNodesReady() {
    var raw = (window.__pnqCanvas && window.__pnqCanvas.rawNodes) || {};
    if (!_reseedPending && (_rawNodesReady || Object.keys(raw).length)) {
      _rawNodesReady = true;
      refreshWindowNodes();
      return null;
    }
    return new Promise(function (resolve) {
      var settled = false;
      function settle() {
        if (settled) return;
        settled = true;
        // Rebuild from whatever landed, so a late-but-partial seed is still used.
        try { refreshWindowNodes(); } catch (_) {}
        resolve(window.nodes || {});
      }
      _rawReadyWaiters.push(settle);
      window.setTimeout(function () {
        if (settled) return;
        try {
          window.console && console.warn &&
            console.warn('[pnq] window.nodes readiness timed out after ' +
              READINESS_TIMEOUT_MS + 'ms — rendering with the records available. ' +
              'Descriptive fields may be missing; see rawNodes/PNQStore.');
        } catch (_) {}
        settle();
      }, READINESS_TIMEOUT_MS);
    });
  }

  function fetchNodeTableInto() {
    if (fetchedOnce) return;
    fetchedOnce = true;
    try {
      fetch('/api/labs/session/nodes', {
        credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
      }).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.status === 'success' && j.data && typeof j.data === 'object') {
          // This endpoint is the same full node table used by api-seed. Use it
          // as a readiness fallback only while the island has not published its
          // own raw records; subsequent island publication remains authoritative.
          var hook = (window.__pnqCanvas = window.__pnqCanvas || {});
          if (!Object.keys(hook.rawNodes || {}).length) hook.rawNodes = j.data;
          markRawNodesReady();
        }
      }).catch(function () {});
    } catch (_) {}
  }

  function refreshWindowNodes() {
    rebuildWindowNodes();
    rebuildWindowNetworks(); // keep window.networks in lock-step (network Edit lane)
    // If raw topology has not landed, fetch the authoritative full table once.
    // Store-only rows are not sufficient for the Nodes modal.
    var raw = (window.__pnqCanvas && window.__pnqCanvas.rawNodes) || {};
    if (!Object.keys(raw).length) fetchNodeTableInto();
  }

  // Deferred (microtask) rebuild — coalesced. CRITICAL for the delete/structural
  // race: the island's reseedFromApi() does `store.apply(patch)` FIRST (which fires
  // this stub's PNQStore subscriber SYNCHRONOUSLY) and only THEN publishes the fresh
  // rawNodes via publishEditContext(). So a synchronous rebuild off the store event
  // sees window.__pnqCanvas.rawNodes STILL holding the just-deleted id → the union
  // (raw ∪ store) re-mints it as a `node<id>` ghost in window.nodes, and the timed
  // 120/700ms refreshes both fire BEFORE the island's async reseed (~900ms+) lands.
  // Scheduling the rebuild on a microtask defers it PAST the current synchronous
  // stack (reseedFromApi, incl. publishEditContext), so it reads the fresh rawNodes
  // and drops the ghost deterministically — no timing guess. Coalesced so a burst of
  // store changes in one tick schedules a single rebuild.
  var _deferRebuildQueued = false;
  function scheduleDeferredRebuild() {
    if (_deferRebuildQueued) return;
    _deferRebuildQueued = true;
    Promise.resolve().then(function () {
      _deferRebuildQueued = false;
      rebuildWindowNodes();
      rebuildWindowNetworks();
    });
  }

  function installWindowNodes() {
    if (window.__pnqWindowNodes) { refreshWindowNodes(); return; }
    window.__pnqWindowNodes = true;
    refreshWindowNodes();
    // Initial and write-driven reseeds use authoritative completion events below;
    // no timed pass guesses when rawNodes has landed.
    document.addEventListener('pnq:spike-ready', function () {
      markRawNodesReady();
    });
    document.addEventListener('pnq:app-updatedata', function () {
      _reseedPending = true;
    });
    document.addEventListener(RESEED_DONE_EVENT, function () {
      markRawNodesReady();
    });
    // Store changes (status poll / WS push / geometry) → keep status fresh. Cheap:
    // rebuild only merges the (≤ a few dozen) node records. Sync pass keeps status
    // LEDs/geometry snappy; the deferred pass closes the reseed ordering race above.
    try {
      if (window.PNQStore && typeof window.PNQStore.subscribe === 'function') {
        window.PNQStore.subscribe(function () { rebuildWindowNodes(); scheduleDeferredRebuild(); });
      }
    } catch (_) {}
    // Expose the readiness gate to the legacy status renderer.
    window.__pnqEnsureWindowNodesReady = ensureWindowNodesReady;
  }

  // App.loading(show): lab.js's version SHOWS/HIDES the #loading-lab overlay (a
  // z:9999 full-screen spinner shown while a lab opens). It is CRITICAL that the
  // stub hides it: if it stays up it covers the whole page and eats every pointer
  // event (no menus / hover / drag — the island looks dead). The engine calls
  // App.loading(false) once the lab has painted. Truthy arg → show, falsy → hide.
  // pnetlab-node-form.js wraps jQuery .hide()/.show() on #loading-lab to fade it,
  // so toggling display via jQuery (when present) gets the smooth fade for free.
  function setLoading(show) {
    var el = document.getElementById('loading-lab');
    if (!el) return;
    if (window.jQuery) {
      if (show) window.jQuery(el).show(); else window.jQuery(el).hide();
    } else {
      el.style.display = show ? '' : 'none';
    }
  }

  function installStub() {
    window.App = window.App || {};
    // Always (re)install our loading toggle — a prior no-op assignment would strand
    // the overlay. Only skip if a richer (lab.js) App.loading is present.
    // b2: App.loading only ever HIDES the #loading-lab overlay, never shows it.
    // The full-screen z:9999 spinner is a lab.js-era device for the slow jsPlumb
    // reprint; the island canvas reseeds instantly (~1 frame) and gives its own
    // feedback, so a mid-session App.loading(true) — e.g. the node-duplicate lane,
    // which called it around the add — flashed the overlay over the whole canvas
    // and READ AS A PAGE REFRESH. Suppressing the show kills that for every caller;
    // initial lab-open still hides once painted (nothing re-shows it).
    if (typeof window.App.loading !== 'function' || window.App.loading.__pnqStub) {
      window.App.loading = function (show) { if (!show) setLoading(false); };
      window.App.loading.__pnqStub = true;
    }

    // If a real (lab.js) topology is somehow present, leave it — this stub is only
    // for the amputated page where lab.js never loads.
    if (window.App.topology && window.App.topology.__pnqStub) return;
    if (window.App.topology && typeof window.App.topology.getAllConnections === 'function') return;

    var nodesProxy = collProxy(makeNode, storeNodes);
    var linksProxy = collProxy(makeLink, storeLinks);

    // `lines` is a live proxy over window.__pnqCanvas.lines (published by api-seed)
    // so pnetlab-line.js's pnqLineEdit/pnqLineDelete resolve the record.
    var linesProxy = new Proxy({}, {
      get: function (t, prop) {
        if (typeof prop === 'symbol' || prop === 'hasOwnProperty' || prop === 'constructor') return t[prop];
        var m = rawLinesMap();
        return Object.prototype.hasOwnProperty.call(m, prop) ? m[prop] : undefined;
      },
      has: function (t, prop) { return Object.prototype.hasOwnProperty.call(rawLinesMap(), prop); },
      ownKeys: function () { return Object.keys(rawLinesMap()); },
      getOwnPropertyDescriptor: function (t, prop) {
        var m = rawLinesMap();
        if (Object.prototype.hasOwnProperty.call(m, prop)) return { enumerable: true, configurable: true, value: m[prop] };
        return undefined;
      },
    });

    window.App.topology = {
      __pnqStub: true,
      nodes: nodesProxy,
      links: linksProxy,
      lines: linesProxy,
      networks: {},
      isClick: true,               // webconsole drag guard: true = a real click (open)
      updateData: function (update) { fireReseed(update); },
      printTopology: function () { return resolved(); },
      // getTopoData was lab.js's "re-fetch the topology" primitive; every
      // surviving caller pairs it with printTopology to force a redraw
      // (sidebar Refresh Topology, node lock/unlock badge refresh, nodes
      // lifecycle). As a pure no-op the sidebar button did NOTHING. Fire the
      // island's reseed signal instead — the island re-fetches
      // /api/labs/session/topology and re-derives the whole model (debounced
      // + in-flight-guarded, see fireReseed above), which IS the modern
      // "refresh topology". printTopology stays inert so the frequent
      // redraw-only callers (mutate.js/edit.js/…) never trigger extra fetches.
      // Resolves with {ok:…} once the island's reseed actually lands (see
      // fireReseedAwaited) so a caller can report a real outcome; callers that
      // only want the side effect can keep ignoring the value.
      getTopoData: function () { return fireReseedAwaited(); },
      ObjectPosUpdateExec: function () { return resolved(); },
      createContextMenu: function () {},
      undoPosition: function () {},
      redoPosition: function () {},
      getAll: function () { return {}; },
    };

    // window.nodes: dozens of survivors iterate this as a plain `{id: record}` map
    // (List of Nodes modal, node-stats status sync, duplicate fast-path, native
    // console opener, Destroy-Lab running count, …). lab.js used to keep it current;
    // gone, it was left EMPTY — every one of those features saw zero nodes. Rebuild
    // it from the island's raw records (window.__pnqCanvas.rawNodes, the FULL
    // per-node topology record keyed by id) overlaid with the live PNQStore status/
    // geometry, and KEEP IT FRESH on every reseed + store change.
    window.nodes = window.nodes || {};
    window.networks = window.networks || {}; // network Edit lane iterates this too
    installWindowNodes();

    // BARE lab.js globals (sloppy-mode ReferenceError hazard). lab.js used to define
    // `lab_topology` (the jsPlumb instance) and `getZoomLab` (the zoom slider %).
    // Several survivor handlers reference them as BARE globals (not window.*), so
    // once lab.js is gone a bare read throws ReferenceError mid-dispatch — which
    // aborts the whole jQuery event chain and silently kills delegated interactions
    // (right-click menus, Escape, node placement). Defining them on window makes the
    // bare reads resolve to harmless no-ops:
    //   • lab_topology.* (clearDragSelection/setDraggable/detach/repaintEverything/
    //     addToDragSelection/getAllConnections) — the island owns selection/drag, so
    //     these are inert. getAllConnections returns [] so any stray walk is empty.
    //   • getZoomLab() → 100 (%) — the flow canvas works in flow-space and
    //     contextClickXY is already flow coords, so "100% = identity" is correct.
    if (typeof window.lab_topology === 'undefined') {
      window.lab_topology = {
        clearDragSelection: function () {},
        addToDragSelection: function () {},
        setDraggable: function () {},
        detach: function () {},
        repaintEverything: function () {},
        getAllConnections: function () { return []; },
        revalidate: function () {},
        setZoom: function () {},
      };
    }
    if (typeof window.getZoomLab !== 'function') {
      window.getZoomLab = function () { return 100; };
    }
  }

  installStub();
  // Re-assert on DOMContentLoaded in case load order ever changes.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installStub);
  }
})();
