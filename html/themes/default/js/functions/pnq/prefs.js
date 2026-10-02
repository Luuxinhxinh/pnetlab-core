/* pnq/prefs.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

function changeEditNetworkIcon(event){
    value = event.target.value;
        if (value  == 'nat0')
        {
            icon = 'global.png'
        }
        else if (value == 'dot1q') {
            icon = 'EVE-NG-Switch-Blue.png';
        }
        else if (value == 'wireless') {
            icon = 'Wireless LAN Controller.png';
        }
        else if (value == 'router') {
            icon = 'Router.png';
        }
        else {
                    icon = 'cloud.png';

        }    $('#networkimage').val(icon);
    $('#networkimage_preview').attr('src', '/images/icons/' + icon);
    $('#networkicon_name').text(icon);
}

// ── Global background preference (dark / 3D / no-grid) ──────────────────────
// Stock PNetLab stores the Background panel choice PER LAB. We mirror the user's
// last choice into localStorage and re-apply it to window.lab on every lab open,
// so the canvas looks the same in every lab and every NEW lab inherits it. The
// canvas class is driven by window.lab.darkmode/mode3d/nogrid, so overriding those
// right after window.lab is set (before the React background render reads them) is
// enough. Default when nothing is stored yet: dark + 3D + grid.
function pnqBgPrefGet() {
    try {
        var v = JSON.parse(localStorage.getItem('pnq_bg_pref') || '');
        return (v && typeof v === 'object') ? v : null;
    } catch (e) { return null; }
}
function pnqBgPrefSet(d, m, n) {
    try {
        localStorage.setItem('pnq_bg_pref', JSON.stringify({
            darkmode: d ? 1 : 0, mode3d: m ? 1 : 0, nogrid: n ? 1 : 0
        }));
    } catch (e) {}
}
function pnqApplyBgPref() {
    if (!window.lab) return;
    var p = pnqBgPrefGet();
    if (!p) { pnqBgPrefSet(1, 1, 0); p = pnqBgPrefGet(); }   // seed: dark + 3D + grid
    if (!p) return;
    window.lab.darkmode = p.darkmode;
    window.lab.mode3d = p.mode3d;
    window.lab.nogrid = p.nogrid;
}
// Capture the Background panel's save (PUT .../background/edit) and remember it
// globally, so the next lab (and new labs) inherit the same look.
$(document).ajaxSend(function (e, xhr, settings) {
    if (!settings || !/background\/edit/.test(settings.url || '')) return;
    var d = settings.data, v = {};
    if (typeof d === 'string') {
        d.split('&').forEach(function (kv) {
            var pr = kv.split('='); v[decodeURIComponent(pr[0])] = decodeURIComponent(pr[1] || '');
        });
    } else if (d && typeof d === 'object') { v = d; }
    if ('darkmode' in v || 'mode3d' in v || 'nogrid' in v) {
        pnqBgPrefSet(Number(v.darkmode), Number(v.mode3d), Number(v.nogrid));
    }
});

// ── delegated bindings replacing inline on* attributes (CSP forbids those) ──
// numeric-only inputs (was inline oninput on the VLAN field)
$(document).on('input', '.pnq-numeric-input', function () {
    this.value = this.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
});
// sidebar pin (was inline onClick="gimMenu()" on the thumb-tack icon)
$(document).on('click', '#gim', function (e) {
    e.preventDefault();
    gimMenu();
});
// Nodes-PRO cell editors (was onblur/onchange="updateNodeData/updateNodePort…")
function pnqCellUpdate() {
    var t = $(this), id = t.attr('data-nodeid'), mode = t.attr('data-pnq-update');
    if (mode == 'port')    return updateNodePort(id, this.value);
    if (mode == 'port2nd') return updateNodePort_2nd(id, this.value);
    if (mode == 'runon')   return pnqNodeRunOnChange(id, this);
    var data = {};
    data[t.attr('data-path')] = this.value;
    updateNodeData(id, data);
}
$(document).on('blur', 'input[data-pnq-update]', pnqCellUpdate);
$(document).on('change', 'select[data-pnq-update]', pnqCellUpdate);

// Network edit modal: type select swaps the icon preview (was inline onchange)
$(document).on('change', 'select.pnq-networktype', changeEditNetworkIcon);

// dot1q switch config: the allowed-VLAN list applies to trunk ports only —
// enable it for trunk, grey it out for access (kept in-row so columns align)
$(document).on('change', 'select.pnq-dot1q-mode', function () {
    var row = $(this).attr('data-row');
    var inp = $('.pnq-dot1q-allowed[data-row="' + row + '"]');
    inp.prop('disabled', this.value != 'trunk');
});

// soft-router config: CSP-safe delegated handlers (no inline onchange/onclick)
$(document).on('change', 'select.pnq-rtr-uplink', function () {
    $('#form-network-manage .pnq-rtr-uplink-net')
        .toggle(this.value == 'net');
});
$(document).on('change', 'input.pnq-rtr-dhcp', function () {
    $('#form-network-manage .pnq-rtr-dhcp-rows').toggle(this.checked);
});
$(document).on('click', '.pnq-rtr-route-add', function (e) {
    e.preventDefault();
    $('#form-network-manage .pnq-rtr-routes-body')
        .append(rtrRouteRowHtml('', ''));
});
$(document).on('click', '.pnq-rtr-route-del', function (e) {
    e.preventDefault();
    $(this).closest('tr.pnq-rtr-route-row').remove();
});

// Network edit modal: icon picker (was inline onclick="selectImage(…)")
$(document).on('click', '.action-networkicon', function (e) {
    e.preventDefault();
    selectImage(function (value) {
        $('#networkimage').val(value);
        $('#networkimage_preview').attr('src', '/images/icons/' + value);
        $('#networkicon_name').text(value);
    });
});

// Nodes-PRO table: per-node icon picker (was inline onclick="selectImage(…)")
$(document).on('click', '.action-nodeicon', function (e) {
    e.preventDefault();
    var id = $(this).attr('data-nodeid'), path = $(this).attr('data-path');
    selectImage(function (value) {
        var data = {};
        data[path] = value;
        updateNodeData(id, data);
        $('#tablenode_icon_img' + id).attr('src', '/images/icons/' + value);
        $('#tablenode_icon_name' + id).text(value);
    });
});


/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  changeEditNetworkIcon, pnqBgPrefGet, pnqBgPrefSet, pnqApplyBgPref, pnqCellUpdate,
});
