/*
 * pnetlab-store.js — lab-page client state store (Tier A, Phase 2).
 *
 * The single source of truth for lab state, replacing "state lives in the DOM"
 * (the page reading back $('#node123').attr('data-status')). A normalized,
 * reactive, framework-free store: overlays/renderers become SUBSCRIBERS that
 * derive their view from it, instead of each feature having to know how every
 * other feature mutated the page.
 *
 *   PNQStore.state          -> { nodes:{<id>:{...}}, links:{...}, networks:{...} }
 *   PNQStore.apply(patch)   -> shallow-merge a delta; null value deletes an entry
 *   PNQStore.get(kind, id)  -> read one entry  (kind: "nodes"|"links"|"networks")
 *   PNQStore.subscribe(cb)               -> fire on ANY change
 *   PNQStore.subscribe(["node:7",..],cb) -> fire only when those keys change
 *     (returns an unsubscribe fn)
 *
 * CSP-clean by construction: plain objects + a Set of subscribers + a microtask
 * (Promise.resolve().then) to BATCH notifications within a tick. No eval, no
 * new Function, no framework. Notifications carry the set of changed keys so a
 * subscriber can repaint only what moved.
 *
 * Wiring (Phase 2): pnetlab-labstate-client.js feeds WS pushes in via apply();
 * the node-status renderer is a subscriber that pushes status onto App.topology
 * (the same printLabStatus contract). The 5s nodestatus poll stays as fallback
 * until the WS path is proven, then it is throttled (functions.js setInterval).
 */
(function () {
  "use strict";
  if (window.PNQStore) return;

  var state = { nodes: {}, links: {}, networks: {} };
  var subs = [];                 // [{keys:Set|null, cb}]
  var dirty = new Set();         // changed keys this tick ("node:7","link:1_2"...)
  var scheduled = false;

  var PREFIX = { nodes: "node:", links: "link:", networks: "net:" };

  function flush() {
    scheduled = false;
    var changed = dirty;
    dirty = new Set();
    // snapshot subscribers so a handler that (un)subscribes can't break the loop
    var list = subs.slice();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.keys === null) { fire(s, changed); continue; }
      var hit = false;
      changed.forEach(function (k) { if (s.keys.has(k)) hit = true; });
      if (hit) fire(s, changed);
    }
  }

  function fire(s, changed) {
    try { s.cb(state, changed); } catch (e) { /* a bad subscriber never kills the bus */ }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(flush);
  }

  // merge patch into a collection; return list of changed ids
  function mergeColl(coll, patch) {
    var touched = [];
    for (var id in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, id)) continue;
      var v = patch[id];
      if (v === null) {                                  // delete
        if (id in coll) { delete coll[id]; touched.push(id); }
        continue;
      }
      var cur = coll[id];
      if (cur === undefined || typeof v !== "object") {  // new entry / scalar set
        if (coll[id] !== v) { coll[id] = v; touched.push(id); }
        continue;
      }
      var ch = false;                                    // shallow field merge
      for (var k in v) {
        if (Object.prototype.hasOwnProperty.call(v, k) && cur[k] !== v[k]) {
          cur[k] = v[k]; ch = true;
        }
      }
      if (ch) touched.push(id);
    }
    return touched;
  }

  window.PNQStore = {
    state: state,

    apply: function (patch) {
      if (!patch || typeof patch !== "object") return this;
      ["nodes", "links", "networks"].forEach(function (kind) {
        if (!patch[kind]) return;
        var pre = PREFIX[kind];
        mergeColl(state[kind], patch[kind]).forEach(function (id) {
          dirty.add(pre + id);
        });
      });
      if (dirty.size) schedule();
      return this;
    },

    get: function (kind, id) {
      var c = state[kind];
      return c ? c[id] : undefined;
    },

    subscribe: function (a, b) {
      var keys = null, cb = b;
      if (typeof a === "function") { cb = a; }
      else if (Array.isArray(a)) { keys = new Set(a); }
      var s = { keys: keys, cb: cb };
      subs.push(s);
      return function unsubscribe() {
        var i = subs.indexOf(s);
        if (i >= 0) subs.splice(i, 1);
      };
    }
  };
})();
