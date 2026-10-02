/* nodes/mutate.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

function setNodeBoot(node_id, config) {
    var deferred = $.Deferred();

    var form_data = {};
    form_data['id'] = node_id;
    form_data['config'] = config;
    var url = '/api/labs/session/nodes/edit';
    var type = 'POST';
    App.loading(false);
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: form_data,
        success: function (data) {
            App.loading(false)
            if (data['status'] == 'success') {
                console.log('DEBUG: node bootflag updated.');
                App.topology.updateData(data['update']);
                deferred.resolve();
            } else {
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            App.loading(false);
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Set node position
function setNodePosition(node_id, left, top) {
    var deferred = $.Deferred();

    var form_data = {};
    form_data['id'] = node_id;
    form_data['left'] = left;
    form_data['top'] = top;
    var url = '/api/labs/session/nodes/edit';
    var type = 'POST';
    
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: form_data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: node position updated.');
                App.topology.updateData(data['update']);
                // Phase 3 incr 7: mirror the new position into PNQStore (source of
                // truth). Additive — jsPlumb still renders; this records geometry so
                // future consumers (minimap / undo / align) can read it from one place.
                if (window.PNQStore) {
                    var __p = {}; __p[node_id] = { left: Number(left), top: Number(top) };
                    PNQStore.apply({ nodes: __p });
                }
                deferred.resolve();
            } else {
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Set multiple node position
function setNodesPosition(nodes) {

    var deferred = $.Deferred();
    if (nodes.length == 0) { deferred.resolve(); return deferred.promise(); }
    var form_data = {};
    form_data.data = nodes;
    var url = '/api/labs/session/nodes/edit';
    var type = 'POST';

    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: form_data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: node position updated.');
                App.topology.updateData(data['update']);
                // Phase 3 incr 7: mirror the batch positions into PNQStore.
                if (window.PNQStore) {
                    var __p = {};
                    for (var __i = 0; __i < nodes.length; __i++) {
                        var __n = nodes[__i];
                        if (__n && __n.id != null && __n.left != null && __n.top != null) {
                            __p[__n.id] = { left: Number(__n.left), top: Number(__n.top) };
                        }
                    }
                    if (Object.keys(__p).length) PNQStore.apply({ nodes: __p });
                }
                deferred.resolve();
            } else {
                // Application error
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
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
function setNodeData(id) {

    var form_data = form2ArrayByRow('node', id);
    var promises = [];
    console.log('DEBUG: posting form-node-edit form.');
    var url = '/api/labs/session/nodes/edit';
    var type = 'POST';
    form_data['id'] = id;
    form_data['count'] = 1;
    form_data['postfix'] = 0;
    for (var i = 0; i < form_data['count']; i++) {
        form_data['left'] = parseInt(form_data['left']) + i * 10;
        form_data['top'] = parseInt(form_data['top']) + i * 10;
        var request = $.ajax({
            cache: false,

            type: type,
            url: encodeURI(url),
            dataType: 'json',
            data: form_data,
            success: function (data) {
                if (data['status'] == 'success') {
                    console.log('DEBUG: node "' + form_data['name'] + '" saved.');
                    // Close the modal
                    App.topology.updateData(data['update']);
                    App.topology.printTopology();
                    addMessage(data['status'], lang(data['message']));
                } else {
                    // Application error
                    console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                    error_handle(data)
                }
            },
            error: function (data) {
                // Server error
                var message = getJsonMessage(data['responseText']);
                console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
                console.log('DEBUG: ' + message);
                error_handle(data)
            }
        });
        promises.push(request);
    }

    $.when.apply(null, promises).done(function () {
        console.log("data is sent");
    });
    return false;
}


function updateNodeData(id, data){
    // Image / CPU / RAM changes only take effect after the node's disk is wiped, so
    // flag the node for the Nodes modal's Save button (which wipes, after a warning).
    // Scoped to while that modal is open so other edit flows are unaffected.
    if (data && window.pnqMarkNodeWipe && document.querySelector('.configured-nodes') &&
        (('image' in data) || ('cpu' in data) || ('ram' in data))) {
        window.pnqMarkNodeWipe(id);
    }
    App.loading(false)
    var form_data = {...get(window.nodes[id], {}), ...data};
    $.ajax({
        cache: false,
        type: 'post',
        url: encodeURI('/api/labs/session/nodes/edit'),
        dataType: 'json',
        data: form_data,
        success: function (data) {

            App.loading(false)
            if (data['status'] == 'success') {
                // Close the modal
                App.topology.updateData(data['update']);
                App.topology.printTopology();
                addMessage(data['status'], lang(data['message']));
            } else {
                // Application error
                error_handle(data)
            }
        },
        error: function (data) {
            // Server error
            App.loading(false)
            var message = getJsonMessage(data['responseText']);
            error_handle(data)
        }
    });
}

function updateNodePort(id, port ){
    App.loading(false)
    $.ajax({
        cache: false,
        type: 'post',
        url: encodeURI('/api/labs/session/nodes/port'),
        dataType: 'json',
        data: {
            id: id,
            port: port
        },
        success: function (data) {
            console.log('atata')
            console.log(data);
            App.loading(false)
            if (data['status'] == 'success') {
                // Close the modal
                App.topology.updateData(data['update']);
                App.topology.printTopology();
                addMessage(data['status'], lang(data['message']));
            } else {
                // Application error
                error_handle(data)
            }
        },
        error: function (data) {
            // Server error
            App.loading(false)
            var message = getJsonMessage(data['responseText']);
            error_handle(data)
        }
    });
}
function updateNodePort_2nd(id, port_2nd ){
    App.loading(false)
    $.ajax({
        cache: false,
        type: 'post',
        url: encodeURI('/api/labs/session/nodes/port_2nd'),
        dataType: 'json',
        data: {
            id: id,
            port_2nd: port_2nd
        },
        success: function (data) {
            console.log('atata')
            console.log(data);
            App.loading(false)
            if (data['status'] == 'success') {
                // Close the modal
                App.topology.updateData(data['update']);
                App.topology.printTopology();
                addMessage(data['status'], lang(data['message']));
            } else {
                // Application error
                error_handle(data)
            }
        },
        error: function (data) {
            // Server error
            App.loading(false)
            var message = getJsonMessage(data['responseText']);
            error_handle(data)
        }
    });
}

//set note interface
function setNodeInterface(node_id, network_id, interface_id) {

    var deferred = $.Deferred();

    var form_data = {};
    form_data[interface_id] = network_id;

    var url = '/api/labs/session/interfaces/edit';
    var type = 'POST';
    var data = {
        node_id: node_id,
        data: form_data,
    };
    App.loading(false);
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            App.loading(false);
            if (data['status'] == 'success') {
                console.log('DEBUG: node interface updated.');
                addMessage('success', lang(data['message']));
                App.topology.updateData(data['update']);
                App.topology.printTopology();
                deferred.resolve(data);
            } else {
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            App.loading(false);
            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();

}


//set note interface
function createNetworkP2P(name, src_id, src_if, dest_id, dest_if) {
    var deferred = $.Deferred();
    var url = '/api/labs/session/networks/p2p';
    var type = 'POST';
    var data = {
        name: name,
        src_id: src_id,
        src_if: src_if,
        dest_id: dest_id,
        dest_if: dest_if
    };
    App.loading(false);
    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            App.loading(false);
            
            if (data['status'] == 'success') {
                addMessage('success', lang(data['message']));
                App.topology.updateData(data['update']);
                App.topology.printTopology();
                deferred.resolve(data);
            } else {
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            App.loading(false);
            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();

}

// Start node(s)

/* Phase 3 incr 7: one-time seed of all node positions into PNQStore from the
 * runtime canvas model (App.topology.nodes), so the store holds geometry for every
 * node — not only ones moved since load. Best-effort: if the model isn't ready or
 * doesn't expose left/top, positions still populate on the first move (the
 * setNode(s)Position feed above). Safe to call repeatedly. */
function pnqSeedNodePositions() {
    if (!window.PNQStore || !window.App || !App.topology || !App.topology.nodes) return;
    var nodes = App.topology.nodes, patch = {};
    for (var id in nodes) {
        if (!Object.prototype.hasOwnProperty.call(nodes, id)) continue;
        var n = nodes[id];
        var left = (n && n.get) ? n.get('left') : (n ? n.left : null);
        var top  = (n && n.get) ? n.get('top')  : (n ? n.top  : null);
        if (left != null && top != null) patch[id] = { left: Number(left), top: Number(top) };
    }
    if (Object.keys(patch).length) PNQStore.apply({ nodes: patch });
}

/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  setNodeBoot, setNodePosition, setNodesPosition, setNodeData, updateNodeData, updateNodePort, updateNodePort_2nd, setNodeInterface, createNetworkP2P,
  pnqSeedNodePositions,
});
