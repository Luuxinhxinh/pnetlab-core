/**
 * pnetlab-node-duplicate.js — node "Duplicate" clone lane.
 *
 * b2 Wave 3 amputation: the legacy #context-menu injector lane (MutationObserver +
 * injectMenu + capture-phase click) is gone — lab.js no longer builds a legacy node
 * menu. The flow island builds its OWN node context menu and calls the duplicate
 * lane directly via window.pnqDuplicateNodes([ids]) (same direct-global contract as
 * deleteNode/deleteTextObject).
 *
 * There is no clone API. Each source node's FULL record is self-fetched from the
 * engine (window.nodes is no longer populated — lab.js is unloaded), the same
 * add-node payload PNetLab's Add Node form sends is rebuilt (POST
 * /api/labs/session/nodes/add), the position offset +60px, and the engine assigns a
 * fresh id/ports/uuid. Multiple nodes clone SEQUENTIALLY (the engine assigns fresh
 * ids/ports per node — parallel adds can race on port allocation), then the topology
 * is refreshed ONCE.
 */
(function () {
  'use strict';

  // Build the add-node payload from a topology node object (window.nodes[id]).
  // Copy every scalar field (so template/image/ram/cpu/console/config/qemu_* all
  // carry over), drop the identity/runtime fields so the engine mints fresh ones,
  // and offset the position.
  function buildPayload(src) {
    var p = {};
    Object.keys(src).forEach(function (k) {
      var v = src[k];
      if (v === null || typeof v === 'object') return;   // skip ethernets/serials/nested objects
      p[k] = v;
    });
    ['id', 'status', 'url', 'url_2nd', 'port', 'port_2nd', 'session',
     'uuid', 'firstmac', 'first_nic'].forEach(function (k) { delete p[k]; });
    p.left = (parseInt(src.left, 10) || 0) + 60;
    p.top  = (parseInt(src.top, 10) || 0) + 60;
    p.count = 1;       // single node
    p.postfix = 0;     // don't append an index to the name
    // Audit-only origin marker. The server strips it before addNode() and uses
    // the existing response data.ids to log this as duplicate, not create.
    p.duplicate_of = src.id;
    return p;
  }

  // POST a single add-node built from a source node object; resolves true/false.
  // Hands any r.update to onUpdate so the caller can apply topology updates.
  function addOne(src, onUpdate) {
    return new Promise(function (resolve) {
      $.ajax({
        cache: false, type: 'POST', url: encodeURI('/api/labs/session/nodes/add'),
        dataType: 'json', data: buildPayload(src),
        success: function (r) {
          if (r && r.status === 'success') {
            if (r.update && onUpdate) onUpdate(r.update);
            resolve(true);
          } else {
            if (typeof error_handle === 'function') error_handle(r);
            else if (typeof addMessage === 'function') addMessage('danger', (r && r.message) || 'duplicate failed');
            resolve(false);
          }
        },
        error: function (e) {
          if (typeof error_handle === 'function') error_handle(e);
          else if (typeof addMessage === 'function') addMessage('danger', 'duplicate failed');
          resolve(false);
        }
      });
    });
  }

  // Fetch the FULL node table from the engine, keyed by id. b2 Wave 3 amputation:
  // window.nodes was populated by lab.js, which no longer loads, so source records
  // are self-fetched (same self-sufficiency pattern as the island's NodeEditDialog).
  //
  // IMPORTANT: there is NO single-node GET route on this engine —
  // GET /api/labs/session/nodes/<id> returns 404 (Resource not found 60038). The
  // list route GET /api/labs/session/nodes returns {status:'success', data:{"<id>":
  // {...record...}}} keyed by id string, so we fetch the table once and index it.
  // Resolves {} on any failure.
  function fetchNodeTable() {
    return fetch('/api/labs/session/nodes', {
      credentials: 'same-origin', cache: 'no-store',
      headers: { Accept: 'application/json' },
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        return (j && j.status === 'success' && j.data && typeof j.data === 'object') ? j.data : {};
      })
      .catch(function () { return {}; });
  }

  // Duplicate one or many nodes. Sources are resolved UP FRONT (window.nodes when
  // lab.js populated it; else the full node table is fetched ONCE and indexed by id)
  // so the duplicates added during the loop never get re-duplicated. Adds run one at
  // a time, then the topology is refreshed once.
  function duplicateNodes(ids) {
    // Fast path: everything already in window.nodes (lab.js populated it).
    var needFetch = ids.some(function (id) { return !(window.nodes && window.nodes[id]); });
    var tableP = needFetch ? fetchNodeTable() : Promise.resolve({});
    tableP.then(function (table) {
      var records = ids.map(function (id) {
        return (window.nodes && window.nodes[id]) || table[id] || table[String(id)] || null;
      }).filter(function (r) { return !!r; });
      duplicateFromRecords(records);
    });
  }

  function duplicateFromRecords(srcs) {
    if (!srcs.length) {
      if (typeof addMessage === 'function') addMessage('danger', 'Cannot duplicate: node not found');
      return;
    }
    if (typeof App !== 'undefined' && App.loading) App.loading(true);
    var ok = 0, fail = 0;
    var applyUpdate = function (update) {
      if (typeof App !== 'undefined' && App.topology && App.topology.updateData) App.topology.updateData(update);
    };
    var chain = Promise.resolve();
    srcs.forEach(function (s) {
      chain = chain.then(function () {
        return addOne(s, applyUpdate).then(function (good) { good ? ok++ : fail++; });
      });
    });
    chain.then(function () {
      if (typeof App !== 'undefined' && App.loading) App.loading(false);
      // refresh the topology exactly like lab.js saveNode does (once, at the end)
      if (typeof App !== 'undefined' && App.topology && App.topology.printTopology) App.topology.printTopology();
      else if (ok) window.location.reload();
      if (ok && typeof addMessage === 'function') {
        addMessage('success', ok + ' node' + (ok === 1 ? '' : 's') + ' ' +
          (typeof lang === 'function' ? lang('duplicated') : 'duplicated') +
          (fail ? (' — ' + fail + ' failed') : ''));
      }
    });
  }

  // The flow island builds its OWN node context menu and calls this lane directly —
  // same direct-global contract as deleteNode/deleteTextObject (never synthesize
  // legacy anchor clicks). It always passes an explicit array of ids, e.g.
  // window.pnqDuplicateNodes([String(id)]) or the multi-selection set.
  window.pnqDuplicateNodes = duplicateNodes;
})();
