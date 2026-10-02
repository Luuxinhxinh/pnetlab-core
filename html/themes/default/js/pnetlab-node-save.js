/**
 * pnetlab-node-save.js — "Save" for the Nodes modal: wipe nodes whose image / CPU /
 * RAM changed (those only take effect after a disk wipe), behind a confirmation.
 *
 * functions.js::updateNodeData() calls window.pnqMarkNodeWipe(id) when image/cpu/ram
 * is edited while the Nodes modal (.configured-nodes) is open. The footer "Save"
 * button (.pnq-nodes-save) then warns and wipes the flagged nodes via the engine's
 * wipe(id). The flag set is reset each time the modal (re)opens.
 */
(function () {
  'use strict';

  var wipeSet = {};
  window.pnqMarkNodeWipe = function (id) { if (id != null) { wipeSet[String(id)] = true; syncSaveBtn(); } };
  function reset() { wipeSet = {}; syncSaveBtn(); }
  function ids() { return Object.keys(wipeSet); }

  // Show the Save button + footer only when something (image/cpu/ram) has changed.
  function syncSaveBtn() {
    var b = document.querySelector('.pnq-nodes-save'); if (!b) return;
    var show = ids().length > 0;
    b.style.display = show ? 'inline-block' : 'none';
    var ft = b.closest('.modal-footer'); if (ft) ft.style.display = show ? 'block' : 'none';
  }

  function L(s) { return (typeof lang === 'function') ? lang(s) : s; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nodeName(id) {
    return (window.nodes && window.nodes[id] && window.nodes[id].name) ? window.nodes[id].name : ('Node ' + id);
  }

  // Reset the flag set each time the Nodes modal (re)opens.
  function watch() {
    var present = !!document.querySelector('.configured-nodes');
    new MutationObserver(function () {
      var now = !!document.querySelector('.configured-nodes');
      if (now && !present) reset();
      present = now;
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Save → confirm → wipe the flagged nodes.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.pnq-nodes-save');
    if (!btn) return;
    e.preventDefault();

    var list = ids();
    if (!list.length) {
      if (window.addMessage) addMessage('info', L('No image/CPU/RAM changes to apply.'));
      return;
    }
    var names = list.map(nodeName);
    var body =
      '<div class="form-group"><div class="question" style="text-align:left">' +
        '<b>' + names.length + ' node' + (names.length > 1 ? 's' : '') + '</b> had the image, CPU or RAM changed. ' +
        'These changes only take effect after the node is <b>wiped</b>, which <b>erases the node&rsquo;s disk and any unsaved configuration</b>.' +
        '<br><br>Wipe &amp; apply to: <b>' + names.map(esc).join(', ') + '</b>?' +
      '</div><div style="text-align:center;margin-top:12px">' +
        '<button id="pnq-nodes-save-confirm" class="btn btn-success" data-dismiss="modal">' + L('Yes, wipe & apply') + '</button>&nbsp; ' +
        '<button type="button" class="btn" data-dismiss="modal">' + L('Cancel') + '</button>' +
      '</div></div>';
    addWaring(L('Warning'), body, '', 'make-red make-small');

    $('#pnq-nodes-save-confirm').on('click', function () {
      var toWipe = ids();
      reset();
      if (window.App && App.loading) App.loading(true);
      var promises = [];
      toWipe.forEach(function (id) { try { promises.push(wipe(id)); } catch (err) {} });
      $.when.apply($, promises).always(function () {
        if (window.App && App.loading) App.loading(false);
        if (window.addMessage) addMessage('success', toWipe.length + ' node' + (toWipe.length > 1 ? 's' : '') + ' ' + L('wiped & applied'));
      });
    });
  }, true);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();
})();
