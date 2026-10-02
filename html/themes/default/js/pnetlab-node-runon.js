/**
 * pnetlab-node-runon.js — "Run on" host change in the Nodes pane.
 *
 * When the user picks a different satellite (or master) for a node, this
 * module confirms, then performs: stop (if running) → wipe → update placement
 * → start (if it was running). On any hard failure it reverts the select.
 *
 * Satellite-gated image sync (cluster_sync payload from /start) is intercepted
 * automatically by pnetlab-cluster-sync.js; no extra work needed here.
 *
 * v1 limitation: satellite-hosted nodes' taps live on the satellite, so the
 * traffic-glow sensor (pnetlab-egress-glow.js) does not see them. Noted there.
 */

/* global $, App, lang, stop, wipe, start, addMessage, printLabStatus, LOCK */

/**
 * Called by pnqCellUpdate() in functions.js when mode === 'runon'.
 * @param {string|number} nodeId
 * @param {HTMLSelectElement} selectEl
 */
function pnqNodeRunOnChange(nodeId, selectEl) {
    // "Auto (least loaded)": resolve to the lowest-load host — MASTER or an
    // online satellite, compared by CPU+RAM — point the select at it, then fall
    // through with the concrete host (host 0 = master).
    if (selectEl.value === 'auto') {
        pnqResolveAutoHost(selectEl, function (hostId, hostName) {
            if (hostId == null) { selectEl.value = selectEl.getAttribute('data-prev') || '0'; return; }
            selectEl.value = String(hostId);
            addMessage('info', 'Auto-selected least-loaded host: ' + hostName);
            pnqNodeRunOnChange(nodeId, selectEl);
        });
        return;
    }
    var newHost = parseInt(selectEl.value, 10);
    var prevHost = parseInt(selectEl.getAttribute('data-prev') || '0', 10);
    if (newHost === prevHost) return;

    var node = App.topology.nodes[nodeId];
    if (!node) return;

    var nodeName = node.get('name') || ('Node ' + nodeId);
    var hostLabel = selectEl.options[selectEl.selectedIndex]
        ? selectEl.options[selectEl.selectedIndex].text
        : String(newHost);
    var prevLabel = selectEl.querySelector('option[value="' + prevHost + '"]')
        ? selectEl.querySelector('option[value="' + prevHost + '"]').text
        : String(prevHost);

    var wasRunning = (parseInt(node.get('status'), 10) === 2 ||
                     parseInt(node.get('status'), 10) === 3);

    var msg = nodeName + ' will be WIPED and redeployed on ' + hostLabel +
        (wasRunning ? ' — running node will be stopped, moved and started.' : '.') +
        ' Continue?';

    if (!window.confirm(msg)) {
        // Revert select
        selectEl.value = String(prevHost);
        return;
    }

    selectEl.disabled = true;

    function revert(errMsg) {
        selectEl.value = String(prevHost);
        selectEl.disabled = false;
        if (errMsg) addMessage('danger', nodeName + ': ' + errMsg);
    }

    function doMove() {
        // 1. Wipe (non-fatal for never-started nodes)
        wipe(nodeId).always(function () {
            // 2. Update placement via nodes/edit
            var nodeData = $.extend({}, App.topology.nodes[nodeId] ? App.topology.nodes[nodeId].getAll() : {});
            nodeData.id = nodeId;
            nodeData.cluster_host = newHost;
            $.ajax({
                cache: false,
                type: 'POST',
                url: encodeURI('/api/labs/session/nodes/edit'),
                dataType: 'json',
                data: nodeData,
                success: function (res) {
                    if (res.status !== 'success') {
                        revert(res.message || 'Placement update failed.');
                        return;
                    }
                    if (res.update) App.topology.updateData(res.update);
                    // Update data-prev so subsequent changes start from new host
                    selectEl.setAttribute('data-prev', String(newHost));
                    selectEl.disabled = (LOCK !== 0);

                    if (wasRunning) {
                        // 3. Restart on new host
                        start(nodeId).always(function () {
                            printLabStatus();
                        });
                    } else {
                        printLabStatus();
                    }
                    addMessage('success', nodeName + ': moved to ' + hostLabel);
                },
                error: function (xhr) {
                    revert('Could not update placement.');
                }
            });
        });
    }

    if (wasRunning) {
        stop(nodeId).then(doMove, function () { revert('Stop failed.'); });
    } else {
        doMove();
    }
}

/**
 * Resolve "Auto (least loaded)" → the lowest-load host by CPU+RAM %, choosing
 * between the MASTER (host 0) and every ONLINE satellite. Master load comes from
 * the engine status endpoint; satellite load from the cached cluster sysinfo.
 * Both are fetched in parallel; cb(hostId, hostName), hostId 0 = master, null on
 * total failure. The master is always a candidate (local is the safe default),
 * so this never aborts just because no satellite is online.
 */
function pnqResolveAutoHost(selectEl, cb) {
    selectEl.disabled = true;
    var pending = 2, sats = [], masterLoad = null;

    function load(s) {
        var cpu = parseFloat(s.cpu) || 0;
        var ram = parseFloat(s.ram != null ? s.ram : s.mem) || 0;
        return cpu + ram;
    }
    function finish() {
        if (--pending > 0) return;
        selectEl.disabled = (typeof LOCK !== 'undefined' && LOCK !== 0);
        // Candidates: master (0) + online satellites, each as {id,name,load}.
        // master defaults to load 0 if its probe failed (prefer running local).
        var cands = [{ id: 0, name: 'Master', load: masterLoad == null ? 0 : masterLoad }];
        sats.forEach(function (s) {
            cands.push({ id: s.id, name: s.name || ('Satellite ' + s.id), load: load(s) });
        });
        cands.sort(function (a, b) { return a.load - b.load; });
        var best = cands[0];
        cb(best.id, best.name);
    }

    // satellites (online only) + their CPU/RAM
    $.ajax({
        cache: false, type: 'GET', dataType: 'json',
        url: '/status/api.php?action=getClusterInfo',
        success: function (res) {
            var data = res && res.data ? res.data : null;
            sats = (data && data.satellites) ? data.satellites.filter(function (s) { return s.online; }) : [];
            finish();
        },
        error: function () { sats = []; finish(); }
    });
    // master CPU/RAM (engine System endpoint; admin-gated, same token cookie)
    $.ajax({
        cache: false, type: 'GET', dataType: 'json',
        url: '/status/api.php?action=system',
        success: function (res) {
            var d = res && res.data ? res.data : null;
            if (d) masterLoad = (parseFloat(d.cpu) || 0) + (parseFloat(d.ram) || 0);
            finish();
        },
        error: function () { masterLoad = null; finish(); }
    });
}
