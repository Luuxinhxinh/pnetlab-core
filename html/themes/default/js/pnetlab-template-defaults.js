/**
 * pnetlab-template-defaults.js — "Save as template default" / "Revert to factory"
 * for the Add/Edit Node modal (admin only).
 *
 * The React Add/Edit modal (#form-node-data, footer #form-node-buttons) submits
 * the whole node config object via $.ajax POST to /api/labs/session/nodes/add or
 * /edit. Rather than scrape React-managed field values, we:
 *
 *   1. Inject a "Save as template default" checkbox + "Revert to factory" button
 *      into the modal footer each time it renders (the modal DOM is recreated on
 *      every open, so a MutationObserver re-injects).
 *   2. $.ajaxPrefilter taps the outgoing nodes/add|edit request and, when the
 *      checkbox is ticked, forwards the EXACT submitted config object to
 *      POST /api/templatedefaults/<template> after the node saves successfully.
 *   3. "Revert" DELETEs /api/templatedefaults/<template> for the template the
 *      modal currently targets (#form-node-template).
 *
 * The server (includes/api_templatedefaults.php) persists an upgrade-safe JSON
 * side store and merges it into /api/list/templates/<t>, so all FUTURE Add-Node
 * operations start from the saved values; satellites are synced automatically.
 */
(function () {
  'use strict';

  /* admin gate — mirrors pnetlab-sidebar-tools.js: unknown role shows and lets
   * the server (403) decide. */
  function isAdmin() {
    var r = (typeof window !== 'undefined') ? window.ROLE : undefined;
    if (r === undefined || r === null) return true;
    return r === 0 || r === '0' || String(r).toLowerCase() === 'admin';
  }

  function currentTemplate() {
    var sel = document.getElementById('form-node-template');
    return (sel && sel.value) ? sel.value : '';
  }

  function msg(kind, text) {
    if (typeof window.addMessage === 'function') window.addMessage(kind, text);
  }

  // drop the cached template so the next Add Node re-fetches the merged defaults
  function bustTemplateCache(template) {
    try { if (window.templates && template) delete window.templates[template]; } catch (e) {}
  }

  /* ── footer controls ──────────────────────────────────────────────────────── */
  function injectControls() {
    if (!isAdmin()) return;
    var footer = document.getElementById('form-node-buttons');
    if (!footer || document.getElementById('pnq-td-wrap')) return;

    var wrap = document.createElement('span');
    wrap.id = 'pnq-td-wrap';
    wrap.className = 'pnq-td-wrap';
    wrap.innerHTML =
      '<label class="pnq-td-check" title="Persist these field values as the default ' +
      'for all future nodes of this template (synced to satellites)">' +
      '<input type="checkbox" id="pnq-td-save"> Save as template default</label>' +
      '<button type="button" id="pnq-td-revert" class="btn btn-default btn-xs" ' +
      'title="Delete the saved default for this template and restore factory values">' +
      '<i class="fa fa-undo"></i> Revert to factory</button>';

    // place the controls at the FRONT of the footer (left of Save/Cancel)
    footer.insertBefore(wrap, footer.firstChild);

    document.getElementById('pnq-td-revert')
      .addEventListener('click', onRevert);
  }

  function onRevert(e) {
    e.preventDefault();
    var template = currentTemplate();
    if (!template) { msg('warning', 'Pick a template first.'); return; }
    if (!window.confirm('Revert "' + template + '" to its factory defaults? ' +
        'This deletes the saved template default for everyone.')) return;
    window.$.ajax({
      type: 'DELETE',
      url: encodeURI('/api/templatedefaults/' + template),
      dataType: 'json'
    }).done(function (resp) {
      if (resp && resp.status === 'success') {
        bustTemplateCache(template);
        msg('success', 'Reverted "' + template + '" to factory defaults. ' +
          'Reopen Add Node to see them.');
      } else {
        msg('danger', (resp && resp.message) || 'Revert failed.');
      }
    }).fail(function () { msg('danger', 'Revert request failed.'); });
  }

  /* ── capture the submitted node config and persist it as the default ───────── */
  function saveChecked() {
    var c = document.getElementById('pnq-td-save');
    return !!(c && c.checked);
  }

  function persistDefault(nodeData) {
    if (!nodeData || !nodeData.template) return;
    var template = nodeData.template;
    window.$.ajax({
      type: 'POST',
      url: encodeURI('/api/templatedefaults/' + template),
      contentType: 'application/json',
      data: JSON.stringify(nodeData),
      dataType: 'json'
    }).done(function (resp) {
      if (resp && resp.status === 'success') {
        bustTemplateCache(template);
        msg('success', 'Saved as the default for "' + template +
          '" — future nodes start from these values.');
      } else {
        msg('danger', (resp && resp.message) || 'Could not save template default.');
      }
    }).fail(function () { msg('danger', 'Saving template default failed.'); });
  }

  function wireAjaxTap() {
    if (!window.$ || !window.$.ajaxPrefilter || window.__pnqTdTapped) return;
    window.__pnqTdTapped = true;
    window.$.ajaxPrefilter(function (options, originalOptions, jqXHR) {
      if (!/\/api\/labs\/session\/nodes\/(add|edit)\b/.test(options.url || '')) return;
      // originalOptions.data is the raw node config object the modal submitted.
      var nodeData = originalOptions && originalOptions.data;
      if (!nodeData || typeof nodeData !== 'object') return;
      var wantSave = saveChecked();              // read the checkbox at submit time
      if (!wantSave) return;
      // shallow copy so later mutations of the form's object don't leak in
      var snapshot = {};
      for (var k in nodeData) {
        if (Object.prototype.hasOwnProperty.call(nodeData, k)) snapshot[k] = nodeData[k];
      }
      jqXHR.done(function (resp) {
        if (resp && resp.status === 'success') persistDefault(snapshot);
      });
    });
  }

  function injectStyle() {
    if (document.getElementById('pnq-td-style')) return;
    var st = document.createElement('style');
    st.id = 'pnq-td-style';
    st.textContent =
      '#form-node-buttons .pnq-td-wrap{float:left;display:inline-flex;align-items:center;gap:14px;}' +
      '#form-node-buttons .pnq-td-check{font-weight:normal;margin:0;cursor:pointer;white-space:nowrap;}' +
      '#form-node-buttons .pnq-td-check input{margin-right:5px;vertical-align:middle;}' +
      '#form-node-buttons #pnq-td-revert{vertical-align:middle;}';
    (document.head || document.documentElement).appendChild(st);
  }

  /* ── boot ─────────────────────────────────────────────────────────────────── */
  function init() {
    injectStyle();
    wireAjaxTap();
    injectControls();
    // the modal DOM is rebuilt on each open — re-inject the footer controls
    var mo = new MutationObserver(function () {
      if (document.getElementById('form-node-buttons') &&
          !document.getElementById('pnq-td-wrap')) {
        injectControls();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
