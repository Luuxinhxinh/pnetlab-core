/* pnetlab-sidebar-groups.js — functional regrouping of the lab sidebar menu.
 *
 * The #lab-sidebar entries are injected by MANY independent scripts at
 * unpredictable times (render.js core entries, pnetlab-sidebar-tools.js,
 * pnetlab-webconsole.js, pnetlab-egress-glow.js, pnetlab-sketch.js,
 * pnetlab-wifi-painter.js, pnetlab-roce-lab.js, pnetlab-protocol-painter.js, pnetlab-ai-builder.js,
 * pnetlab-lazy-overlays.js placeholders → real network-watcher/rack-view, and
 * the canvas-flow island's Theme/Grid/Mini Map entries), so a static reorder
 * in any one injector cannot work. This always-loaded script REORDERS the
 * entries (DOM moves only — every <li> keeps its exact id/class/handlers, so
 * island interception + toggle bindings are untouched) into functional
 * groups, with a divider between groups, and re-asserts the order whenever
 * the sidebar membership changes (MutationObserver, idempotent no-op when
 * already sorted).
 *
 * TOP_APPEND entries are relocated INTO the top section (built by render.js),
 * right before its closing divider, after "Destroy Lab" — everything above
 * that stays byte-untouched.
 *
 * TOGGLES are boolean on/off switches, collected under a single collapsible
 * "Layout Settings" entry (same caret/expand pattern as the Lab Tasks
 * sidebar accordion) instead of living loose in the list.
 *
 * GROUPS is the single tuning point for the remaining entries — reorder
 * freely. Each member is a CSS selector matched against the sidebar
 * <li>/<div> children (or their <a>). Unknown/future entries keep their
 * position after the known groups.
 */
(function () {
  'use strict';

  var DIV_CLASS = 'pnq-sbg-hr';       // marks OUR group dividers (vs the top one)
  var LS_ID = 'pnq-layout-settings';  // the injected "Layout Settings" <li>
  var LS_SUBLIST_CLASS = 'pnq-ls-sublist';
  var LS_CARET_CLASS = 'pnq-ls-caret';
  var LS_COLLAPSED_CLASS = 'pnq-ls-collapsed';
  var LS_EXPANDED_KEY = 'pnq-layout-settings-expanded';
  var STYLE_ID = 'pnq-sbg-style';

  // ── Entries moved into the TOP (render.js) section, right after Destroy
  //    Lab and before its divider — in this order. ─────────────────────────
  var TOP_APPEND = [
    '.lab_workbook',   // Lab Tasks
    '#pnq-pki',        // Lab PKI
    '#pnq-aibuilder'   // AI Lab Builder
  ];

  // ── Boolean on/off switches — collapsed under "Layout Settings". ────────
  var TOGGLES = [
    '#pnq-sysmon-toggle',       // Resource Monitor
    '#pnq-trafficglow-toggle',  // Traffic Glow
    '#pnq-linklabels-toggle',   // Link Labels
    '#pnq-statusled-toggle',    // Status LED
    '#pnq-iconresize-toggle',   // Icon Resizer
    '#pnq-wc-mode-toggle',      // Web Console Tab
    '#pnq-html5-toggle',        // HTML5 Console
    '#pnq-quickbar-toggle',     // Quick Bar
    '#pnq-sticky-toggle'        // Sticky Sidebar
  ];

  // ── Functional groups (user-adjustable: reorder lines to taste) ────────────
  var GROUPS = [
    [ // System Status — live status + canvas overlays together
      '.action-systemstatus',        // System Status        (render.js)
      '#pnq-flow-minimap',           // Mini Map             (island)
      '#pnq-netwatch',               // Network Watcher      (network-watcher)
      '#pnq-netwatch-lazy',          //   … its lazy placeholder (lazy-overlays)
      '#pnq-protopainter',           // Protocol Painter
      '#pnq-rackview',               // Rack View
      '#pnq-rackview-lazy',          //   … its lazy placeholder
      '#pnq-sketch-toggle',          // Sketch
      '#pnq-wifipainter',            // Wi-Fi Painter
      '#pnq-roce-lab',               // RoCE Lab
      '.action-editbackground'       // Background (hidden under flow canvas)
    ],
    [ // the collapsible Layout Settings entry (built by ensureLayoutSettings)
      '#' + LS_ID
    ],
    [ // Display & Tools — always last; Theme/Grid kept adjacent
      '#pnq-flow-theme',             // Theme                (island)
      '#pnq-flow-grid',              // Grid                 (island)
      '#pnq-shell',                  // Shell (admin only)
      '#pnq-fixperm'                 // Fix Permissions
    ]
  ];

  function isDivider(el) {
    return el.tagName === 'DIV' && el.querySelector('hr') !== null &&
      el.id === '';   // action-labclose/-labdestroy are <div>-wrapped entries
  }

  // Resolve a selector to the sidebar LIST-ITEM element that owns it — the
  // nearest ancestor whose immediate parent is a <ul> (either the outer
  // #lab-sidebar list or the Layout Settings sublist). Selectors may match
  // the item itself or a descendant (e.g. the <a class=…>).
  function resolveEntry(sel) {
    var el = document.querySelector('#lab-sidebar ' + sel);
    if (!el) return null;
    while (el && el.parentElement && el.parentElement.tagName !== 'UL') el = el.parentElement;
    return (el && el.parentElement && el.parentElement.tagName === 'UL') ? el : null;
  }

  function makeDivider() {
    var d = document.createElement('div');
    d.className = DIV_CLASS;
    d.setAttribute('style', 'padding:0px 7px');   // matches the top divider
    d.innerHTML = '<hr/>';
    return d;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '#lab-sidebar #' + LS_ID + ' > a { cursor: pointer; }\n' +
      '#lab-sidebar .' + LS_CARET_CLASS + ' { float: right; margin-right: 12px; opacity: .75; }\n' +
      '#lab-sidebar .' + LS_CARET_CLASS + ' i { font-size: 11px !important; margin-right: 0 !important; }\n' +
      '#lab-sidebar ul.' + LS_SUBLIST_CLASS + ' { margin: 0; padding: 0; list-style: none; }\n' +
      '#lab-sidebar ul.' + LS_SUBLIST_CLASS + '.' + LS_COLLAPSED_CLASS + ' { display: none; }\n';
    document.head.appendChild(style);
  }

  // Create (once) the collapsible "Layout Settings" <li>, with a caret and a
  // nested sublist that the TOGGLES entries get moved into. Detached from the
  // DOM at creation time — the group-placement pass below moves it into its
  // final position, same as every other tracked entry.
  function ensureLayoutSettings(ul) {
    var li = document.getElementById(LS_ID);
    if (li) return li;
    var expanded = false;
    try { expanded = window.localStorage.getItem(LS_EXPANDED_KEY) === '1'; } catch (e) { /* ignore */ }

    li = document.createElement('li');
    li.id = LS_ID;
    li.innerHTML =
      '<a href="javascript:void(0)" title="Layout Settings" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
        '<i class="fa fa-sliders" aria-hidden="true"></i>' +
        '<span class="lab-sidebar-title">Layout Settings</span>' +
        '<span class="lab-sidebar-title ' + LS_CARET_CLASS + '"><i class="fa fa-chevron-' + (expanded ? 'up' : 'down') + '" aria-hidden="true"></i></span>' +
      '</a>';

    var sub = document.createElement('ul');
    sub.className = LS_SUBLIST_CLASS + (expanded ? '' : ' ' + LS_COLLAPSED_CLASS);
    li.appendChild(sub);

    var a = li.querySelector('a');
    a.addEventListener('click', function (evt) {
      evt.preventDefault();
      evt.stopPropagation();
      var isExpanded = a.getAttribute('aria-expanded') !== 'true';
      a.setAttribute('aria-expanded', String(isExpanded));
      sub.classList.toggle(LS_COLLAPSED_CLASS, !isExpanded);
      var caretIcon = a.querySelector('.' + LS_CARET_CLASS + ' i');
      if (caretIcon) caretIcon.className = 'fa fa-chevron-' + (isExpanded ? 'up' : 'down');
      try { window.localStorage.setItem(LS_EXPANDED_KEY, isExpanded ? '1' : '0'); } catch (e) { /* ignore */ }
    });

    ul.appendChild(li);
    return li;
  }

  // Move the TOGGLES entries (found wherever they currently live) into the
  // Layout Settings sublist, in order. No-ops once already in place.
  function placeToggles(sublist) {
    var desired = [];
    for (var i = 0; i < TOGGLES.length; i++) {
      var el = resolveEntry(TOGGLES[i]);
      if (el) desired.push(el);
    }
    var current = Array.prototype.slice.call(sublist.children);
    var matches = current.length === desired.length;
    if (matches) {
      for (var c = 0; c < desired.length; c++) {
        if (current[c] !== desired[c]) { matches = false; break; }
      }
    }
    if (matches) return;
    desired.forEach(function (el) { sublist.appendChild(el); });
  }

  function findTopDivider(ul) {
    var children = Array.prototype.slice.call(ul.children);
    for (var i = 0; i < children.length; i++) {
      if (isDivider(children[i]) && !children[i].classList.contains(DIV_CLASS)) return children[i];
    }
    return null;
  }

  // Move TOP_APPEND entries to sit right before the top divider (after
  // Destroy Lab), in order. No-ops once already in place.
  function placeTopAppend(ul, topDivider) {
    var desired = [];
    for (var i = 0; i < TOP_APPEND.length; i++) {
      var el = resolveEntry(TOP_APPEND[i]);
      if (el) desired.push(el);
    }
    var prevSibs = [];
    var node = topDivider.previousElementSibling;
    for (var i2 = 0; i2 < desired.length && node; i2++) { prevSibs.unshift(node); node = node.previousElementSibling; }
    var matches = prevSibs.length === desired.length;
    if (matches) {
      for (var c = 0; c < desired.length; c++) {
        if (prevSibs[c] !== desired[c]) { matches = false; break; }
      }
    }
    if (matches) return;
    desired.forEach(function (el) { ul.insertBefore(el, topDivider); });
  }

  var scheduled = false;

  function regroup() {
    scheduled = false;
    var ul = document.querySelector('#lab-sidebar ul');
    if (!ul) return;

    // Bail until render.js has built the top section (its divider is the
    // anchor everything else is positioned against).
    var topDivider = findTopDivider(ul);
    if (!topDivider) return;

    ensureStyle();
    var lsLi = ensureLayoutSettings(ul);
    var lsSublist = lsLi.querySelector('ul.' + LS_SUBLIST_CLASS);
    placeToggles(lsSublist);
    placeTopAppend(ul, topDivider);

    // Re-locate the divider's index now that TOP_APPEND may have shifted it.
    var children = Array.prototype.slice.call(ul.children);
    var topEnd = children.indexOf(topDivider);

    // Build the desired lower-section sequence out of PRESENT entries.
    var desired = [];
    var seen = [];
    var dividers = Array.prototype.slice.call(ul.querySelectorAll('div.' + DIV_CLASS));
    var firstGroup = true;
    for (var g = 0; g < GROUPS.length; g++) {
      var members = [];
      for (var m = 0; m < GROUPS[g].length; m++) {
        var el = resolveEntry(GROUPS[g][m]);
        if (el && seen.indexOf(el) < 0) { members.push(el); seen.push(el); }
      }
      if (!members.length) continue;
      if (!firstGroup) desired.push(dividers.length ? dividers.shift() : makeDivider());
      firstGroup = false;
      desired = desired.concat(members);
    }
    // Surplus group dividers from a previous pass (a group emptied) → drop.
    dividers.forEach(function (d) { d.parentNode && d.parentNode.removeChild(d); });

    // Idempotence check — the observer fires on our own moves; when the lower
    // section already matches, do nothing (breaks the loop).
    var current = Array.prototype.slice.call(ul.children).slice(topEnd + 1);
    var matches = current.length >= desired.length;
    if (matches) {
      for (var c = 0; c < desired.length; c++) {
        if (current[c] !== desired[c]) { matches = false; break; }
      }
    }
    if (matches) return;

    // Re-append in order: nodes in `desired` move to the ul END in sequence;
    // unknown entries (e.g. #action_change_console anchor, future items) are
    // then moved after them, keeping their own relative order. The top
    // section never moves. appendChild MOVES nodes — listeners survive.
    var known = desired.slice();
    var leftovers = current.filter(function (el) { return known.indexOf(el) < 0; });
    desired.forEach(function (el) { ul.appendChild(el); });
    leftovers.forEach(function (el) { ul.appendChild(el); });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || window.setTimeout)(regroup);
  }

  // The sidebar <ul> is torn down + rebuilt on every lab open (render.js
  // replaces #body), so observe the document — but only react to mutations
  // that touch #lab-sidebar or replace the ul (the canvas island churns the
  // rest of the DOM constantly; skip those cheaply).
  var lastUl = null;
  var mo = new MutationObserver(function (mutations) {
    var ul = document.querySelector('#lab-sidebar ul');
    if (ul !== lastUl) { lastUl = ul; if (ul) schedule(); return; }
    if (!ul) return;
    for (var i = 0; i < mutations.length; i++) {
      var t = mutations[i].target;
      if (t === ul || (t.closest && t.closest('#lab-sidebar'))) { schedule(); return; }
    }
  });
  function start() {
    mo.observe(document.body, { childList: true, subtree: true });
    lastUl = document.querySelector('#lab-sidebar ul');
    schedule();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
