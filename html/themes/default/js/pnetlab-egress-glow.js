/**
 * pnetlab-egress-glow.js — always-on interface-label glow when a node
 * sends traffic, based on sysfs tap rx_packets counters (tap rx = node
 * egress). THREE states, evaluated per poll from the last-egress age:
 *   solid green  egress within GLOW_MS (~6.5 s)        "sending now"
 *   soft green   egress within the retention window    "alive but quiet"
 *   red          watched ≥ retention with zero egress  "down / shut"
 * Solid is immediate: the first poll that sees a delta paints full green.
 * Red needs OBSERVED silence — each tap is timed from first sight, so a
 * fresh page never flashes red before it has watched a full window.
 * Why retention instead of ingress: a shut port's tap still RECEIVES the
 * peer's frames (taps don't propagate carrier), so ingress can't tell
 * "shut" from "quiet". Retention is per TEMPLATE (meta tpl): vios routers
 * keepalive every 10 s → 30 s window; L2 switchports (vIOS-L2/IOL) emit
 * only CDP 60 s when STP-blocked → 70 s window. The GNS3-style "ask the
 * emulator" isn't available for IOL, and qemu only exposes guest ifstate
 * via virtio rx-filter or the guest agent — neither exists on vIOS/e1000.
 *
 * Design:
 *  • Polls /pnq-linkstats.php every 5 s (skips when document.hidden).
 *  • QEMU + IOL + docker nodes (server meta carries ntype; VPCS etc. skipped).
 *    Docker is glow-on-traffic only (solid green when sending, else neutral) —
 *    it has no keepalive/CDP beacon, so the red "down" state is limited to the
 *    beacon-emitting types (DOWN_TYPES).
 *  • Diffs totals per tap vs previous sample; ignores first sample and
 *    counter resets (wrap-around or re-created tap → value drops).
 *  • Maps vunl<sid>_<iface> → node_id + network_id + if_name from the server's
 *    /pnq-linkstats.php "meta" (resolved from the lab XML — NOT window.nodes,
 *    which doesn't reliably carry per-interface data; that was the v1 bug).
 *  • Finds the jsPlumb connection(s) for that node+interface — parallel p2p
 *    links between one node pair ALL match, so the label overlay is picked
 *    by interface-name text first, then nearest-the-node.
 *  • Respects body.pnq-hide-linklabels (item #12): skips painting when set.
 *  • Sidebar toggle "Traffic glow" persisted in localStorage (default ON).
 *
 * Satellite-hosted nodes are covered: pnq-linkstats.php fetches their taps'
 * rx/tx from the satellite via the satd-forwarded `linkstats` verb and merges
 * them into the same response, so the glow paints them like local taps.
 */
/* global $, App, lab_topology */

(function () {
  'use strict';

  var POLL_MS   = 5000;
  // Solid window: just above the poll period so steady traffic never blinks.
  var GLOW_MS   = 6500;
  // Quiet-retention per template (ms of observed silence → red "down").
  // vios ROUTERS loopback-keepalive every 10 s on every up routed port, so
  // 30 s of silence is conclusive. Everything else (vIOS-L2/IOL switchports)
  // bottoms out at CDP every 60 s when STP-blocked → 70 s floor; below that
  // healthy CDP-only ports flicker red between announcements.
  var RETAIN_TPL = { vios: 30000 };
  var RETAIN_DEF = 70000;
  // Glow for these node types (VPCS et al. excluded by request).
  var GLOW_TYPES = { qemu: 1, iol: 1, docker: 1 };
  // Types whose retention-window SILENCE conclusively means "down" (red): they
  // beacon while up (routing keepalives, CDP/DTP/STP), so a full quiet window
  // is evidence of a dead port. Docker containers emit no such beacon — a quiet
  // docker port is just idle, not down — so they glow SOLID on traffic and
  // otherwise stay neutral, never red (and no lingering soft-green either,
  // which would falsely claim "alive but quiet" for a type we can't vouch for).
  var DOWN_TYPES = { qemu: 1, iol: 1 };
  // BUG FIX (Layout Settings not remembered per-lab): scope this the same way
  // pnetlab-sidebar-tools.js scopes its Layout Settings toggles — see its
  // pnqLabKey() for the full rationale. Previously a bare global key, so
  // Traffic Glow was one shared on/off switch for every lab.
  function TG_KEY() {
    try {
      var lab = (typeof window.LAB !== 'undefined' && window.LAB) ? String(window.LAB) : '';
      return lab ? ('pnq_trafficglow_off::' + lab) : 'pnq_trafficglow_off';
    } catch (e) { return 'pnq_trafficglow_off'; }
  }
  var STYLE_ID  = 'pnq-egress-glow-style';

  /* ── CSS ───────────────────────────────────────────────────────────────── */
  (function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    // Solid green fill behind the interface name while the node sends traffic
    // (the label div AND its inner elements carry their own backgrounds, so
    // paint both).
    s.textContent =
      '.pnq-egress-glow,' +
      '.pnq-egress-glow *{' +
        'background:#2e9e44!important;' +
        'color:#ffffff!important;' +
        'border-color:#27863a!important;' +
      '}' +
      '.pnq-egress-glow{' +
        'transition:background 0.2s ease-in;' +
        'border-radius:3px;' +
      '}' +
      /* quiet-but-alive: no egress right now, but the port sent within its
         retention window (STP root/blocked ports tick over on CDP/DTP) —
         soft green so an up link doesn't look dead. */
      '.pnq-quiet-glow,' +
      '.pnq-quiet-glow *{' +
        'background:#c5e6cd!important;' +
        'color:#14532d!important;' +
        'border-color:#8fcf9f!important;' +
      '}' +
      '.pnq-quiet-glow{' +
        'transition:background 0.2s ease-in;' +
        'border-radius:3px;' +
      '}' +
      /* down/shut: a full retention window observed with ZERO egress. */
      '.pnq-down-glow,' +
      '.pnq-down-glow *{' +
        'background:#c0392b!important;' +
        'color:#ffffff!important;' +
        'border-color:#992d22!important;' +
      '}' +
      '.pnq-down-glow{' +
        'transition:background 0.2s ease-in;' +
        'border-radius:3px;' +
      '}';
    (document.head || document.documentElement).appendChild(s);
  }());

  /* ── state ─────────────────────────────────────────────────────────────── */
  var prev       = null;  // {tap: rx count} from last poll
  var tapMap     = {};    // tap key → {node_id, network_id}  (from server meta)
  var labelMap   = {};    // tap key → {el, ts} (cached label element)
  var lastEgress = {};    // tap key → ms timestamp of last egress delta
  var firstSeen  = {};    // tap key → ms timestamp we started watching it

  /* ── helpers ───────────────────────────────────────────────────────────── */
  function glowOff() { return localStorage.getItem(TG_KEY()) === '1'; }

  // The server (pnq-linkstats.php "meta") tells us each tap's node_id +
  // network_id — resolved from the lab XML, so we don't depend on window.nodes
  // carrying per-interface data (it doesn't reliably, which is why glow used to
  // never fire). Connector matching below mirrors pnetlab-network-watcher.js.
  function setTapMap(meta) {
    tapMap = (meta && typeof meta === 'object') ? meta : {};
  }

  /* Find the jsPlumb connection(s) that can carry a tap's interface.
     Returns {conns:[…], nodeElId} or null. PARALLEL p2p links between the
     same node pair (e.g. an LACP bundle) all match here — every candidate
     is returned and findLabelEl() disambiguates by interface-name text. */
  function findConns(tapKey) {
    var jp = window.lab_topology;
    if (!jp || !jp.getAllConnections) return null;
    var info = tapMap[tapKey];
    if (!info) return null;
    var nodeId = info.node_id, netId = info.network_id;
    if (!netId) return null;

    var nodeElId = 'node' + nodeId;
    var netElId  = 'network' + netId;

    // peer nodes sharing this network (a p2p link has exactly one peer and is
    // drawn node<->node with no network blob).
    var peers = {};
    for (var t in tapMap) {
      if (t === tapKey) continue;
      if (tapMap[t].network_id === netId) peers[tapMap[t].node_id] = true;
    }
    var peerIds = Object.keys(peers);

    var out = [];
    var conns = jp.getAllConnections();
    for (var i = 0; i < conns.length; i++) {
      var c = conns[i];
      var sId = c.sourceId || (c.source && c.source.id) || '';
      var tId = c.targetId || (c.target && c.target.id) || '';
      // node <-> network blob (multi-access)
      if ((sId === nodeElId && tId === netElId) ||
          (tId === nodeElId && sId === netElId)) {
        out.push(c);
        continue;
      }
      // p2p node <-> peer node: collect ALL connections between the pair —
      // with parallel links the right one is only knowable by its label text.
      if (peerIds.length === 1) {
        var peerElId = 'node' + peerIds[0];
        if ((sId === nodeElId && tId === peerElId) ||
            (tId === nodeElId && sId === peerElId)) {
          out.push(c);
        }
      }
    }
    return out.length ? { conns: out, nodeElId: nodeElId } : null;
  }

  /* Find the .jtk-overlay div for a tap: among ALL candidate connections'
     own label overlays, prefer those whose text equals the interface name
     (meta if_name — resolves parallel links), then take the one nearest the
     node (resolves the two ends of one link). Caches per tap key. */
  function findLabelEl(tapKey) {
    var cached = labelMap[tapKey];
    if (cached && cached.el && cached.el.isConnected) return cached.el;

    var found = findConns(tapKey);
    if (!found) return null;

    var nodeEl = document.getElementById(found.nodeElId);
    if (!nodeEl) return null;

    // Use the connections' own label overlays (conn.getOverlays) — every
    // overlay on the canvas shares one parent container, so a container-wide
    // .jtk-overlay scan can match a DIFFERENT link's label that happens to sit
    // closer to the node (the "inconsistent labels" bug).
    var overlays = [];
    for (var ci = 0; ci < found.conns.length; ci++) {
      var conn = found.conns[ci];
      if (conn.getOverlays) {
        var ovs = conn.getOverlays();
        for (var oid in ovs) {
          var oc = ovs[oid] && ovs[oid].canvas;
          if (oc && oc.classList && oc.classList.contains('jtk-overlay')) overlays.push(oc);
        }
      }
    }
    if (!overlays.length) {            // fallback: old container-wide scan
      var c0 = found.conns[0];
      var svg = (c0.connector && c0.connector.canvas) || c0.canvas;
      if (!svg || !svg.parentNode) return null;
      overlays = Array.prototype.slice.call(svg.parentNode.querySelectorAll('.jtk-overlay'));
      if (!overlays.length) return null;
    }

    // Parallel links give several candidate connections; only the overlay
    // whose text is this tap's interface name can be right. (Both ends of a
    // link may share a name like "e0/1" — the nearest-to-node pass below
    // picks our end.) No name match (or no if_name) → old nearest-overall.
    var info = tapMap[tapKey];
    var ifName = info && info.if_name ? String(info.if_name).trim() : '';
    if (ifName) {
      var named = overlays.filter(function (o) {
        return (o.textContent || '').trim() === ifName;
      });
      if (named.length) overlays = named;
    }

    var nRect = nodeEl.getBoundingClientRect();
    var nCx = nRect.left + nRect.width / 2;
    var nCy = nRect.top + nRect.height / 2;

    var best = null, bestDist = Infinity;
    for (var i = 0; i < overlays.length; i++) {
      var o = overlays[i];
      var r = o.getBoundingClientRect();
      var cx = r.left + r.width / 2;
      var cy = r.top + r.height / 2;
      var d = Math.sqrt((cx - nCx) * (cx - nCx) + (cy - nCy) * (cy - nCy));
      if (d < bestDist) { bestDist = d; best = o; }
    }

    if (best) labelMap[tapKey] = { el: best, ts: Date.now() };
    return best;
  }

  /* Paint a tap's label for its current state: 'solid', 'quiet', 'down' or
     'off'. Evaluated every poll from the last-egress age — no per-tap
     timers, so the displayed state can never outlive the evidence by more
     than one poll period. */
  function setGlow(tapKey, st) {
    var info = tapMap[tapKey];
    if (!info) return;
    // glow-eligible types only — skip VPCS, dynamips taps entirely
    if (info.ntype && !GLOW_TYPES[info.ntype]) return;

    var el = findLabelEl(tapKey);
    if (!el) return;

    el.classList.toggle('pnq-egress-glow', st === 'solid');
    el.classList.toggle('pnq-quiet-glow',  st === 'quiet');
    el.classList.toggle('pnq-down-glow',   st === 'down');
  }

  /* ── polling ────────────────────────────────────────────────────────────── */
  // NOT gated on window.PNQLabState.isLive() like pnetlab-network-watcher.js —
  // investigated and rejected, don't re-attempt without re-checking the two
  // facts below:
  //  1) Availability: pnetlab-labstated only ever broadcasts "link.state" when
  //     /dev/shm/pnet-watch/<tenant>_<ls>.json exists, i.e. only while a
  //     Network Watcher capture is running for this lab (see _tick_links() in
  //     pnetlab-labstated.py and the "link.state ... Only flows when a Network
  //     Watcher watch is running" note in pnetlab-labstate-client.js). Egress
  //     glow is always-on regardless of Network Watcher state, so most of the
  //     time this channel would simply never fire.
  //  2) Shape: when it does fire, "taps" is keyed by Network Watcher FILTER id
  //     (f0, f1, …) with {out:{pps,last_ts}, in:{pps,last_ts}} — a per-protocol
  //     packet-rate sample, not the per-tap cumulative sysfs rx_packets counter
  //     this file diffs in poll() (see pnq-linkstats.php's "taps":{tap:rx} vs.
  //     pnq-linkwatch.php's watch snapshot consumed by pnetlab-network-watcher.js
  //     snapFromStore()).
  // Gating poll() on isLive() here would silently stop the HTTP fetch with NO
  // substitute feed the vast majority of the time (no watch running), freezing
  // every glow at its last-known state instead of just skipping a paint. That
  // is worse than the redundant poll it would "fix", so the poll stays
  // unconditional (still skips only on document.hidden below).
  function clearAllGlows() {
    document.querySelectorAll('.pnq-egress-glow,.pnq-quiet-glow,.pnq-down-glow').forEach(function (el) {
      el.classList.remove('pnq-egress-glow');
      el.classList.remove('pnq-quiet-glow');
      el.classList.remove('pnq-down-glow');
    });
  }

  function poll() {
    if (glowOff()) { prev = null; lastEgress = {}; firstSeen = {}; return; }
    if (document.hidden) return;

    fetch('/pnq-linkstats.php', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.taps) return;
        setTapMap(data.meta);                  // tap -> {node_id, network_id}
        var cur = data.taps;
        var now = Date.now();

        if (prev !== null) {
          for (var tap in cur) {
            if (!(tap in tapMap)) continue;
            var prevVal = prev[tap];
            if (prevVal === undefined) continue;
            if (cur[tap] - prevVal > 0) lastEgress[tap] = now;  // node egress
            // counter reset (tap recreated, node restarted) → ignore
          }
        }
        prev = cur;

        // Repaint EVERY known tap each poll: solid → quiet → red purely by
        // last-egress age (retention window per template). A shut port stops
        // CDP/DTP/STP/keepalives instantly: it demotes to quiet within one
        // poll and goes RED after its retention. Red requires a full window
        // of OBSERVED silence (timed from first sight), so a fresh page never
        // flashes red before it has actually watched that long.
        var hide = document.body.classList.contains('pnq-hide-linklabels');
        for (var t in tapMap) {
          if (!(t in firstSeen)) firstSeen[t] = now;
          var tinfo   = tapMap[t] || {};
          var retain  = RETAIN_TPL[tinfo.tpl] || RETAIN_DEF;
          var age     = (t in lastEgress) ? (now - lastEgress[t])
                                          : (now - firstSeen[t]);
          var seen    = (t in lastEgress);
          // Non-down-capable types (docker) get a pure traffic glow: SOLID while
          // sending, neutral otherwise — no quiet/down, since we can't vouch for
          // a beacon-less port being alive or dead.
          var downCap = !!DOWN_TYPES[tinfo.ntype];
          var st;
          if (hide)                            st = 'off';
          else if (seen && age <= GLOW_MS)     st = 'solid';
          else if (!downCap)                   st = 'off';
          else if (seen && age <= retain)      st = 'quiet';
          else if (age >= retain)              st = 'down';
          else                                 st = 'off';   // still gathering evidence
          setGlow(t, st);
        }
        // Taps that vanished (node stopped): drop their state + leftover
        // paint. firstSeen covers every watched tap (a stopped node's ports
        // go BLANK, not red — no tap means no evidence either way).
        for (var g in firstSeen) {
          if (!(g in tapMap)) {
            delete lastEgress[g];
            delete firstSeen[g];
            var cached = labelMap[g];
            if (cached && cached.el) {
              cached.el.classList.remove('pnq-egress-glow');
              cached.el.classList.remove('pnq-quiet-glow');
              cached.el.classList.remove('pnq-down-glow');
            }
            delete labelMap[g];
          }
        }
      })
      .catch(function () {});
  }

  /* ── sidebar toggle ─────────────────────────────────────────────────────── */
  // Inject a "Traffic glow" entry alongside the existing sidebar toggles.
  var TG_LI_ID = 'pnq-trafficglow-toggle';
  function injectToggle() {
    if (document.getElementById(TG_LI_ID)) return true;
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return false;

    var fixLi = document.getElementById('pnq-fixperm');
    var li = document.createElement('li');
    li.id = TG_LI_ID;
    li.innerHTML = '<a href="#"><i class="fa fa-toggle-' + (glowOff() ? 'off' : 'on') +
      '" style="font-size:16px;"></i><span class="lab-sidebar-title">Traffic Glow</span></a>';
    li.querySelector('a').addEventListener('click', function (e) {
      e.preventDefault();
      localStorage.setItem(TG_KEY(), glowOff() ? '0' : '1');
      var ic = li.querySelector('i');
      if (ic) ic.className = 'fa fa-toggle-' + (glowOff() ? 'off' : 'on');
      if (glowOff()) {
        clearAllGlows();
        prev = null; lastEgress = {}; firstSeen = {};
      }
      // BUG FIX (sidebar toggle not live on the flow canvas): this handler used
      // to be capture-intercepted by the canvas-flow island and never ran at
      // all when the island was mounted (fragile — a WeakSet leak on the
      // island's $effect cleanup could permanently disarm the intercept). Now
      // it always runs (icon/localStorage stay legacy-owned) and announces the
      // new state; the island listens for pnq:trafficglow-changed and mirrors
      // it into its own egressOn state/poll. CSP-safe plain CustomEvent.
      try {
        document.dispatchEvent(new CustomEvent('pnq:trafficglow-changed', {
          detail: { off: glowOff() }
        }));
      } catch (err) {}
    });

    if (fixLi && fixLi.parentNode === ul) {
      ul.insertBefore(li, fixLi);
    } else {
      ul.appendChild(li);
    }
    return true;
  }

  function init() {
    if (!injectToggle()) {
      var mo = new MutationObserver(function () { if (injectToggle()) mo.disconnect(); });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    setInterval(poll, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}());
