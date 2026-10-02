/* networks/edit.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

function deleteNetwork(id) {
    var deferred = $.Deferred();
    var type = 'POST';
    var url = '/api/labs/session/networks/delete';
    var data = id != null ? { id: id } : {};

    App.loading(false)
    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            App.loading(false)
            if (data['status'] == 'success') {
                console.log('DEBUG: network deleted.');
                App.topology.updateData(data['update'])
                deferred.resolve(data);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            App.loading(false)
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Delete node
function setNetwork(nodeName, left, top) {
    var deferred = $.Deferred();
    var form_data = {};

    form_data['name'] = 'Net-' + nodeName;
    form_data['type'] = 'bridge';
    form_data['left'] = left;
    form_data['top'] = top;
    form_data['visibility'] = 1;
    form_data['postfix'] = 0;

    var url = '/api/labs/session/networks/add';
    var type = 'POST';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: form_data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: new network created.');
                App.topology.updateData(data['update'])
                deferred.resolve(data);
            } else {
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
            addMessage(data['status'], lang(data['message']));

        },
        error: function (data) {
            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// set cpulimit
function setNetworkiVisibility(networkId, visibility) {
    var deferred = $.Deferred();
    var form_data = {};
    form_data['id'] = networkId;
    form_data['visibility'] = visibility;
    var url = '/api/labs/session/networks/edit';
    var type = 'POST';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: form_data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: network visibility updated.');
                App.topology.updateData(data['update'])
                deferred.resolve(data);
            } else {
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
            addMessage(data['status'], lang(data['message']));

        },
        error: function (data) {
            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Set network position
function setNetworkPosition(network_id, left, top) {
    var deferred = $.Deferred();

    form_data['left'] = left;
    form_data['top'] = top;
    form_data['id'] = network_id;
    var url = '/api/labs/session/networks/edit';
    var type = 'POST';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: form_data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: network position updated.');
                App.topology.updateData(data['update'])
                deferred.resolve();
            } else {
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
            //addMessage(data['status'], lang(data['message'], data['data']));

        },
        error: function (data) {
            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Set multiple network position
function setNetworksPosition(networks) {
    var deferred = $.Deferred();
    if (networks.length == 0) { deferred.resolve(); return deferred.promise(); }

    var form_data = {};
    form_data.data = networks;
    var url = '/api/labs/session/networks/edit';
    var type = 'POST';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: form_data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: network position updated.');
                App.topology.updateData(data['update'])
                deferred.resolve();
            } else {
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
            //addMessage(data['status'], lang(data['message'], data['data']));

        },
        error: function (data) {
            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Set node boot

/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  deleteNetwork, setNetwork, setNetworkiVisibility, setNetworkPosition, setNetworksPosition,
});
