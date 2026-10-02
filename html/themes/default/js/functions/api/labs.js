/* api/labs.js — Phase 3 functions.js decomposition (Tier A).
 * Moved verbatim from functions.js; re-attached to window via the
 * transition shim so the ~40 pnetlab-* add-ons + golden javascript.js
 * keep resolving these as globals (bare-name -> window). CSP-clean. */

function getLabInfo() {
    var deferred = $.Deferred();
    var url = '/api/labs/session/info';
    var type = 'GET';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: lab found.');
                window.lab = data['data'];
                LOCK = data['data']['lock'];
                pnqApplyBgPref();   // global dark/3D background preference (across labs)
                deferred.resolve(data['data']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}



// Get lab endpoints
function getLabLinks() {
    var deferred = $.Deferred();
    var url = '/api/labs/session/links';
    var type = 'GET';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: got available links(s) from lab.');
                deferred.resolve(data['data']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}


// Get lab networks
function getNetworks(network_id) {
    var deferred = $.Deferred();
    var url = '/api/labs/session/networks'
    var type = 'GET';
    var data = network_id != null ? { id: network_id } : {};
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: got network(s) from lab ');

                deferred.resolve(data['data']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}


// Get available network types
function getNetworkTypes() {
    var deferred = $.Deferred();
    var url = '/api/list/networks';
    var type = 'GET';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: got network types.');
                deferred.resolve(data['data']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}



function getNodesStatus() {
    var deferred = $.Deferred();
    var url = '/api/labs/session/nodestatus'
    var type = 'POST';

    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        // users.lab_session is per-POD, so any concurrent login of the same
        // account (second tab, API scripting) repoints it and this poll would
        // silently track the wrong lab forever. Pin the session THIS page
        // shows (LAB = lab session id from the auth payload, frozen at load).
        data: (typeof LAB !== 'undefined' && LAB) ? { lab_session: LAB } : undefined,
        success: function (data) {
            if (data['status'] == 'success') {
                deferred.resolve(data['data']);
            } else {
                error_handle(data);
                deferred.reject(message);
            }
        },
        error: function (data) {
            error_handle(data.responseJSON);
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}



// Get the lab's startup-config state (per-node: config on/off, name, icon, …).
// canvas-flow amputation (b2 Wave 3): the store React lab.js — which defined
// getNodeConfigs — is no longer loaded, so the Startup Configs sidebar button's
// handler (actions.js `.action-configsget`) threw "getNodeConfigs is not defined"
// mid-dispatch and the modal never opened. Restored verbatim from lab.js: GET
// /api/labs/session/configs (id param optional; null = whole lab). Resolves with
// data (a {key: {config, icon, name, …}} map the action_configsget.ejs iterates).
function getNodeConfigs(id) {
    var deferred = $.Deferred();
    var url = '/api/labs/session/configs';
    var type = 'GET';
    var data = (id != null) ? { id: id } : {};
    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (res) {
            if (res['status'] == 'success') {
                console.log('DEBUG: got startup-config(s).');
                deferred.resolve(res['data']);
            } else {
                console.log('DEBUG: application error (' + res['status'] + ') on ' + type + ' ' + url + ' (' + res['message'] + ').');
                deferred.reject(res['message']);
            }
        },
        error: function (data) {
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}


// Get lab node interfaces
function getNodeInterfaces(node_id) {
    var deferred = $.Deferred();
    var url = '/api/labs/session/interfaces';
    var type = 'GET';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: { node_id: node_id },
        success: function (data) {
            if (data['status'] == 'success') {
                // console.log('DEBUG: got node(s) from lab.');
                deferred.resolve(data['data']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Get lab pictures
function getTopology(offline = false) {

    var deferred = $.Deferred();

    if (offline) {
        if (window.topology) {
            deferred.resolve(window.topology);
            return deferred.promise();
        }
    }

    var url = '/api/labs/session/topology';
    var type = 'GET';
    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: got topology from lab');
                window.topology = data['data'];
                window.nodes = data['data']['nodes'];
                window.lab = data['data']['labinfo'];
                LOCK = window.lab.lock;
                pnqApplyBgPref();   // global dark/3D background preference (across labs)

                deferred.resolve(data['data']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Get roles
function getTemplates(template, refresh = true) {

    if(!window.templates) window.templates = {};
    if(window.templates[template] && !refresh){
        return Promise.resolve(window.templates[template])
    }

    var url = (template == null) ? '/api/list/templates/' : '/api/list/templates/' + template;
    var type = 'GET';
    window.templates[template] = $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
    }).then(function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: got template(s).');
                return data['data'];
            } else {
                // Application error
               
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                return Promise.reject(lang(data['message'], data['data']));
            }
        }).catch(function (data) {
            // Server error
           
            var data = data['responseJSON'];
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            return Promise.reject(lang(data['message'], data['data']));
        })
    
    return window.templates[template];
}

// Get user info

/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  getLabInfo, getLabLinks, getNetworks, getNetworkTypes, getNodesStatus, getNodeConfigs, getNodeInterfaces, getTopology, getTemplates,
});
