/* nodes/lifecycle.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

function deleteNode(id) {
    var deferred = $.Deferred();
    var type = 'POST';

    var url = '/api/labs/session/nodes/delete'
    var data = id != null ? { id } : {};

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
                console.log('DEBUG: node deleted.');
                App.topology.updateData(data['update']);
                deferred.resolve();
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            App.loading(false);
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}


// Export selected folders and labs
function start(node_id) {
   
    var url = '/api/labs/session/nodes/start';
    var type = 'POST';

    var node = App.topology.nodes[node_id];
    var comp = App.topology.nodes[node_id].get('component', false);
    if(comp) comp.attr('data-status', 5)

    return $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: { id: node_id },
        success: function (data) {
            
            if (data['status'] == 'success') {
                if(comp) comp.attr('data-status', 3)
                console.log('DEBUG: node(s) started.');
                addMessage('success', node.get('name') + ': ' + lang("started"));
                // Starting materialises runtime-only console metadata (port,
                // session and url). Status push/polling only carries `status`, so
                // refresh the full topology or console-open keeps the pre-start
                // node record until the browser is reloaded.
                App.topology.getTopoData().then(function () {
                    App.topology.printTopology();
                })
            } else {
                if(comp) comp.attr('data-status', 0)
                addMessage('danger', node.get('name') + ': ' + lang(data['message']));
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
            }
        },
        error: function (data) {
            if(comp) comp.attr('data-status', 0)
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            error_handle(data);
        }
    });
    
}

// Stop node(s)
function stop(node_id) {
    
    var url = '/api/labs/session/nodes/stop';
    var type = 'POST';

    var node = App.topology.nodes[node_id];
    var comp = App.topology.nodes[node_id].get('component', false);
    if(comp) comp.attr('data-status', 5)

    return $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: { id: node_id },
        success: function (data) {
            if (data['status'] == 'success') {
                if(comp) comp.attr('data-status', 0)
                addMessage('success', node.get('name') + ': ' + lang("stopped"));
                console.log('DEBUG: node(s) stopped.');
                $('#node' + node_id).removeClass('jsplumb-connected');
                return true;

            } else {
                // Application error
                if(comp) comp.attr('data-status', 3)
                addMessage('danger', node.get('name') + ': ' + data['message']);
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                return false;
            }
        },
        error: function (data) {
            // Server error
            if(comp) comp.attr('data-status', 3)
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addMessage('danger', node.get('name') + ': ' + message);
            return false;
        }
    });
}
// Shutdown node(s)
function shutdown(node_id) {
    
    var url = '/api/labs/session/nodes/shutdown';
    var type = 'POST';

    var node = App.topology.nodes[node_id];
    var comp = App.topology.nodes[node_id].get('component', false);
    if(comp) comp.attr('data-status', 5)

    return $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: { id: node_id },
        success: function (data) {
            if (data['status'] == 'success') {
                if(comp) comp.attr('data-status', 0)
                addMessage('success', node.get('name') + ': ' + lang("shutdown"));
                console.log('DEBUG: node(s) shutdown.');
                $('#node' + node_id).removeClass('jsplumb-connected');
                return true;

            } else {
                // Application error
                if(comp) comp.attr('data-status', 3)
                addMessage('danger', node.get('name') + ': ' + data['message']);
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                return false;
            }
        },
        error: function (data) {
            // Server error
            if(comp) comp.attr('data-status', 3)
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addMessage('danger', node.get('name') + ': ' + message);
            return false;
        }
    });
}
function isolate(node_id) {
    
    var url = '/api/labs/session/nodes/isolate';
    var type = 'POST';

    var node = App.topology.nodes[node_id];
    var comp = App.topology.nodes[node_id].get('component', false);
    if(comp) comp.attr('data-status', 5)
    return $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: { id: node_id },
        success: function (data) {
            if (data['status'] == 'success') {

                if(comp) comp.attr('data-status', 2)
                addMessage('success', node.get('name') + ': ' + lang("Pause/Resume all_nics"));
                console.log('DEBUG: node(s) isolate.');
                App.topology.getTopoData().then(function () {
                    App.topology.printTopology();
                })
                return true;

            } else {
                // Application error
                if(comp) comp.attr('data-status', 3)
                addMessage('danger', node.get('name') + ': ' + data['message']);
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                return false;
            }
        },
        error: function (data) {
            // Server error
            if(comp) comp.attr('data-status', 3)
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addMessage('danger', node.get('name') + ': ' + message);
            return false;
        }
    });
}
function freeze(node_id) {
    
    var url = '/api/labs/session/nodes/freeze';
    var type = 'POST';

    var node = App.topology.nodes[node_id];
    var comp = App.topology.nodes[node_id].get('component', false);
    if(comp) comp.attr('data-status', 5)
    return $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: { id: node_id },
        success: function (data) {
            if (data['status'] == 'success') {

                if(comp) comp.attr('data-status', 7)
                addMessage('success', node.get('name') + ': ' + lang("Freeze/Unfreeze"));
                console.log('DEBUG: node(s) freeze.');
                return true;

            } else {
                // Application error
                if(comp) comp.attr('data-status', 3)
                addMessage('danger', node.get('name') + ': ' + data['message']);
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                return false;
            }
        },
        error: function (data) {
            // Server error
            if(comp) comp.attr('data-status', 3)
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addMessage('danger', node.get('name') + ': ' + message);
            return false;
        }
    });
}
function hibernate(node_id) {
    
    var url = '/api/labs/session/nodes/hibernate';
    var type = 'POST';
    var node = App.topology.nodes[node_id];
    var comp = App.topology.nodes[node_id].get('component', false);
    if(comp) comp.attr('data-status', 5)
    return $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: { id: node_id },
        success: function (data) {
            if (data['status'] == 'success') {

                if(comp) comp.attr('data-status', 0)
                addMessage('success', node.get('name') + ': ' + lang("Freeze/Unfreeze"));
                console.log('DEBUG: node(s) hibernate.');
                $('#node' + node_id).removeClass('jsplumb-connected');

                return true;
            } else {
                // Application error
                if(comp) comp.attr('data-status',3)
                addMessage('danger', node.get('name') + ': ' + data['message']);
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                return false;
            }
        },
        error: function (data) {
            // Server error
            if(comp) comp.attr('data-status', 3)
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addMessage('danger', node.get('name') + ': ' + message);
            return false;
        }
    });
}



// Wipe node(s)
function wipe(node_id) {
    
    var url = '/api/labs/session/nodes/wipe';
    var type = 'POST';

    var node = App.topology.nodes[node_id];
    var comp = App.topology.nodes[node_id].get('component', false);
    if(comp) comp.attr('data-status', 5)

    var data = node_id != null ? { id: node_id } : {};
    return $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            if (data['status'] == 'success') {
                if(comp) comp.attr('data-status', 0)
                console.log('DEBUG: node(s) wiped.');
                addMessage('success', node.get('name') + ': ' + lang("wiped"));
            } else {
                // Application error
                if(comp) comp.attr('data-status', 3)
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                addMessage('danger', node.get('name') + ': ' + data['message']);
            }
        },
        error: function (data) {
            // Server error
            if(comp) comp.attr('data-status', 3)
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addMessage('danger', node.get('name') + ': ' + message);
        }
    });
    
}

// unlock node
function unlockNode(node_id) {
    
    var url = '/api/labs/session/nodes/unlock';
    var type = 'POST';

    var node = App.topology.nodes[node_id];
    var comp = App.topology.nodes[node_id].get('component', false);
    if(comp) comp.attr('data-status', 5)

    var data = node_id != null ? { id: node_id } : {};
    return $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            if (data['status'] == 'success') {
                if(comp) comp.attr('data-status', 0)
                console.log('DEBUG: node(s) unlock.');
                addMessage('success', node.get('name') + ': ' + lang("unlocked"));
            } else {
                // Application error
                if(comp) comp.attr('data-status', 3)
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                addMessage('danger', node.get('name') + ': ' + data['message']);
            }
        },
        error: function (data) {
            // Server error
            if(comp) comp.attr('data-status', 3)
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addMessage('danger', node.get('name') + ': ' + message);
        }
    });
    
}

/***************************************************************************
 * Print forms and pages
 **************************************************************************/
// Context menu

/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  deleteNode, start, stop, shutdown, isolate, freeze, hibernate, wipe, unlockNode,
});
