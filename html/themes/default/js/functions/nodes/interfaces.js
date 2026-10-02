/* nodes/interfaces.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

function updateSuspendStatus(nodeId, ifId, status) {
    $('#context-menu').remove();
    var deferred = $.Deferred();
    var type = 'POST';
    var url = '/api/labs/session/interfaces/setSuspend';

    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: {
            'node_id' : nodeId,
            'interface_id' : ifId,
            'status' : status,
        },
        success: function (data) {
            if (data['status'] == 'success') {
                App.topology.updateData(data['update']);
                App.topology.printTopology();
                deferred.resolve(data['message']);
            } else {
                App.topology.printTopology();
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            App.topology.printTopology();
            deferred.reject(message);
        }
    });
    return deferred.promise();
}
function updateSuspendStatustwo_way(nodeId, ifId, status) {
    $('#context-menu').remove();
    var deferred = $.Deferred();
    var type = 'POST';
    var url = '/api/labs/session/interfaces/setSuspendtwo_way';

    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: {
            'node_id' : nodeId,
            'interface_id' : ifId,
            'status' : status,
        },
        success: function (data) {
            if (data['status'] == 'success') {
                App.topology.updateData(data['update']);
                App.topology.printTopology();
                deferred.resolve(data['message']);
            } else {
                App.topology.printTopology();
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            App.topology.printTopology();
            deferred.reject(message);
        }
    });
    return deferred.promise();
}



/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  updateSuspendStatus, updateSuspendStatustwo_way,
});
