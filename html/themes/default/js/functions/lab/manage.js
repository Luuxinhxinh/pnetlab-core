/* lab/manage.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

function cfg_export(node_id) {
    var deferred = $.Deferred();
    var url = '/api/labs/session/nodes/export';
    var data = node_id != null ? { id: node_id } : {};
    var type = 'POST';
    $.ajax({
        cache: false,
        timeout: TIMEOUT * 10,  // Takes a lot of time
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: config exported.');
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

// // Export node(s) config recursive
function recursive_cfg_export(nodes, i) {

    i = i - 1
    addMessage('info', nodes[Object.keys(nodes)[i]]['name'] + ': ' + lang('Starting export, please wait'))
    var deferred = $.Deferred();

    var data = (typeof (nodes[Object.keys(nodes)[i]]['path']) === 'undefined')
        ? { id: Object.keys(nodes)[i] }
        : { id: nodes[Object.keys(nodes)[i]]['path'] };

    var url = '/api/labs/session/nodes/export';
    console.log('DEBUG: ' + url);
    var type = 'POST';
    $.ajax({
        cache: false,
        timeout: TIMEOUT * 10 * i,  // Takes a lot of time
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: config exported.');
                addMessage('success', nodes[Object.keys(nodes)[i]]['name'] + ': ' + lang('config exported'))
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                addMessage('danger', nodes[Object.keys(nodes)[i]]['name'] + ': ' + lang(data['message']));
            }
            if (i > 0) {
                recursive_cfg_export(nodes, i);
            } else {
                addMessage('info', lang('Export all') + ':' + lang('done'));
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addMessage('danger', nodes[Object.keys(nodes)[i]]['name'] + ': ' + lang(message));
            if (i > 0) {
                recursive_cfg_export(nodes, i);
            } else {
                addMessage('info', lang('Export all') + ':' + lang('done'));
            }
        }
    });
    return deferred.promise();
}

// Clone selected labs
function cloneLab(form_data) {
    var deferred = $.Deferred();
    var type = 'POST';
    var url = '/api/labs';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: JSON.stringify(form_data),
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: created lab "' + form_data['name'] + '" from "' + form_data['source'] + '".');
                deferred.resolve();
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


// Delete network
function exportObjects(form_data) {
    var deferred = $.Deferred();
    var type = 'POST';
    var url = '/api/export';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: JSON.stringify(form_data),
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: objects exported into "' + data['data'] + '".');
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

// HTML Form to array
function closeLab() {
    var deferred = $.Deferred();
    $.ajax({
        cache: false,

        type: 'POST',
        url: '/api/labs/session/factory/leave',
        dataType: 'json',
        success: function (data) {
            console.log(data);
            deferred.resolve(data);
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Destroy the current lab session (stop all nodes + free the session). Mirrors
// closeLab() but hits factory/destroy, which — unlike leave — reads the session
// from the request body, so we must send {lab_session}. (Admin/Host only, the
// server enforces checkDestroy.) Fixes the left-pane "Destroy Lab" button, whose
// old handler called an undefined destroyLabSession() and threw silently.
//
// window.lab is NOT reliably populated on the canvas-flow lab page (the island
// keeps labinfo in module-local state and never re-hydrates the legacy global),
// so a stale/missing window.lab.session used to serialize the POST body to {},
// and the server rejected it with NO_LAB_SESSION even though a lab was open.
// Always refresh from GET /api/labs/session/info (via getLabInfo(), which sets
// window.lab as a side effect) unless window.lab.session is already present.
function destroyLab() {
    var deferred = $.Deferred();

    function doDestroy(sessionId) {
        $.ajax({
            cache: false,
            type: 'POST',
            url: '/api/labs/session/factory/destroy',
            contentType: 'application/json',
            data: JSON.stringify({ lab_session: sessionId }),
            dataType: 'json',
            success: function (data) {
                deferred.resolve(data);
            },
            error: function (data) {
                var message = getJsonMessage(data['responseText']);
                deferred.reject(message);
            }
        });
    }

    if (window.lab && window.lab.session) {
        doDestroy(window.lab.session);
    } else {
        $.when(getLabInfo()).done(function (labData) {
            var sessionId = labData && labData.session;
            if (!sessionId) {
                deferred.reject('No active lab session found.');
                return;
            }
            doDestroy(sessionId);
        }).fail(function (message) {
            deferred.reject(message);
        });
    }

    return deferred.promise();
}

// Post login
function newUIreturn(param) {
    if (UPDATEID != null) {
        // Stop updating node_status
        clearInterval(UPDATEID);
    }
    $('body').removeClass('login');
    window.location.href = "/";
}

//set Network

function printFormUploadNodeConfig(path) {
    var html = '<form id="form-upload-node-config" class="form-horizontal form-upload-node-config">' +
        '<div class="form-group">' +
        '<label class="col-md-3 control-label">' + lang('File') + '</label>' +
        '<div class="col-md-5">' +
        '<input class="form-control" name="upload[path]" value="" disabled="" placeholder="' + lang("No file selected") + '" "type="text"/>' +
        '</div>' +
        '</div>' +
        '<div class="form-group">' +
        '<div class="col-md-7 col-md-offset-3">' +
        '<span class="btn btn-default btn-file btn-success">' + lang("Browse") +
        '<input accept="text/plain" class="form-control" name="upload[file]" value="" type="file">' +
        '</span>' +
        '<button type="submit" class="btn btn-flat">' + lang("Upload") + '</button>' +
        '<button type="button" class="btn btn-flat" data-dismiss="modal">' + lang('Cancel') + '</button>' +
        '</div>' +
        '</div>' +
        '</form>';
    console.log('DEBUG: popping up the upload form.');
    addModal(lang("Upload Config File"), html, '', 'upload-modal');
    validateImport();
}



/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  cfg_export, recursive_cfg_export, cloneLab, exportObjects, closeLab, destroyLab, newUIreturn, printFormUploadNodeConfig,
});
