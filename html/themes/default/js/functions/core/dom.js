/* core/dom.js — Phase 3 functions.js decomposition (Tier A).
 * Moved verbatim from functions.js; re-attached to window via the
 * transition shim so the ~40 pnetlab-* add-ons + golden javascript.js
 * keep resolving these as globals (bare-name -> window). CSP-clean. */

function basename(path) {
    return path.replace(/\\/g, '/').replace(/.*\//, '');
}

// Dirname: given /a/b/c return /a/b
function dirname(path) {
    var dir = path.replace(/\\/g, '/').replace(/\/[^\/]*$/, '');
    if (dir == '') {
        return '/';
    } else {
        return dir;
    }
}

// Alert management
function addMessage(severity, message, notFromLabviewport) {
    // Severity can be success (green), info (blue), warning (yellow) and danger (red)
    // Param 'notFromLabviewport' is used to filter notification
    $('#alert_container').show();
    var timeout = 10000;        // by default close messages after 10 seconds
    if (severity == 'danger') timeout = 5000;
    if (severity == 'alert') timeout = 10000;
    if (severity == 'warning') timeout = 10000;

    // canvas-flow amputation (b2 Wave 3): the classic #lab-viewport is retired; the
    // lab page is now marked by #pnq-lab-page (rendered by printPageLabOpen). Gate on
    // its EXISTENCE so lab-page notifications (node start/stop/wipe/etc.) still show.
    if ($("#pnq-lab-page").length || (!$("#pnq-lab-page").length && notFromLabviewport)) {
        //if (severity == "danger" )
        if (severity != "") {
            var notification_alert = $('<div class="alert alert-' + severity.toLowerCase() + ' fade in" style="margin-bottom:5px; padding:10px">' + message + '<button type="button" class="close" data-dismiss="alert" style="font-size:18px">&times;</button></div>');

            $('#notification_container').prepend(notification_alert);
            if (timeout) {
                window.setTimeout(function () {
                    notification_alert.alert("close");
                }, timeout);
            } 
        }
    }
    $('#alert_container').next().first().slideDown();
}

/* Add Modal
@param prop - helping classes. E.g prop = "red-text capitalize-title"
*/
function addModal(title, body, footer, prop) {
    var html = $(`<div aria-hidden="false" style="display: block;z-index: 1049;" class="modal ${prop} fade in" tabindex="-1" role="dialog">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <button type="button" class="close" data-dismiss="modal" aria-hidden="true">&times;</button>
                    <h4 class="modal-title">${title}</h4>
                </div>
                <div class="modal-body">
                    ${body}
                </div>
               <div class="modal-footer">${footer}</div>
            </div>
        </div>
    </div>`);
    $('body').append(html);
    html.modal('show');
    html.draggable({ handle: ".modal-header" });
}

function addWaring(title, body, footer, prop) {
    var html = $(`<div aria-hidden="false" style="display: block;z-index: 9999;" class="modal ${prop} fade in" tabindex="-1" role="dialog">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <button type="button" class="close" data-dismiss="modal" aria-hidden="true">&times;</button>
                    <h4 class="modal-title">${title}</h4>
                </div>
                <div class="modal-body">
                    <div class="alert alert-warning" role="alert" style="margin-bottom : 0px">
                    ${body}
                    </div>  
                </div>
                ${footer != '' ? `<div class="modal-footer">${footer}</div>` : ''}
            </div>
        </div>
    </div>`);
    $('body').append(html);
    html.modal('show');
    html.draggable({ handle: ".modal-header" });
}

// Add Modal
function addModalError(message) {
    var html = $(`<div aria-hidden="false" style="display: block; z-index: 99999" class="modal fade in" tabindex="-1" role="dialog">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <button type="button" class="close" data-dismiss="modal" aria-hidden="true">&times;</button>
                        <h4 class="modal-title">${lang('Error')}</h4>
                    </div>
                    <div class="modal-body">
                        <div class="alert alert-danger" role="alert" style="margin-bottom : 0px">
                        ${lang(message)}
                        </div>
                    </div>        
                </div>
            </div>
        </div>`);
    $('body').append(html);
    html.modal('show');
}

// Add Modal
function addModalWide(title, body, footer, property, cb) {
    // avoid open wide modal twice
    //if ($('.modal.fade.in').length > 0 && property.match('/second-win/') != null) return;
    var prop = property || "";
    var isStartupConfigs = prop.split(/\s+/).indexOf('pnq-startup-configs') !== -1;
    var addittionalHeaderBtns = "";
    if (isStartupConfigs || title.toUpperCase() == "STARTUP-CONFIGS" || title.toUpperCase() == "STARTUP CONFIGURATIONS" || title.toUpperCase() == "CONFIGURED NODES" ||
        title.toUpperCase() == "CONFIGURED TEXT OBJECTS" ||
        title.toUpperCase() == "CONFIGURED NETWORKS" || title.toUpperCase() == "CONFIGURED NODES" ||
        title.toUpperCase() == "STATUS" || title.toUpperCase() == "PICTURES") {
        addittionalHeaderBtns = '<i title="Make transparent" class="glyphicon glyphicon-certificate pull-right action-changeopacity"></i>'
    }
    var panelClass = isStartupConfigs ? ' pnq-panel' : '';
    // Scoped deliberately: every other Panel Shell class here is gated on
    // isStartupConfigs, so the close button is too. Applying .pnq-icon-button
    // unconditionally would resize the close control on every addModalWide
    // surface (Pictures, Status, Configured Nodes/Networks/Text Objects) —
    // plausibly an improvement, but not this change's scope, and unverified.
    var closeClass = isStartupConfigs ? 'close pnq-icon-button' : 'close';
    var headerClass = isStartupConfigs ? 'modal-header pnq-panel__header' : 'modal-header';
    var footerClass = isStartupConfigs ? 'modal-footer pnq-panel__footer' : 'modal-footer';
    var html = $('<div aria-hidden="false" style="display: block; z-index:1049" class="modal click active modal-wide ' + prop + ' fade in" tabindex="-1" role="dialog"><div class="modal-dialog"><div class="modal-content' + panelClass + '"><div class="' + headerClass + '"><button type="button" class="' + closeClass + '" data-dismiss="modal" aria-hidden="true">&times;</button>' + addittionalHeaderBtns + '<h4 class="modal-title">' + lang(title) + '</h4></div><div class="modal-body">' + body + '</div><div class="' + footerClass + '">' + footer + '</div></div></div></div>');
    $('body').append(html);
    html.modal('show');
    cb && cb();
}

// Export node(s) config
function logger(severity, message) {
    if (DEBUG >= severity) {
        console.log(message);
    }
    $('#alert_container').next().first().slideDown();
}

// Logout user

/* error_handle — shared API-failure sink. RESTORED: it was defined by the retired
 * store lab.js and lost in the store decommission, so the seven callers
 * (status/render.js poll, api/labs.js, nodes/lifecycle.js, nodes/mutate.js,
 * actions.js, capture-console, node-duplicate) each threw
 * "ReferenceError: error_handle is not defined" on any API failure. Worst case:
 * a REPLACED session (single-session-per-user kick -> every API answers 412).
 * The 5s nodestatus poll then died in its own fail handler forever — no redirect,
 * no message — leaving the lab page rendering STALE node LEDs until a manual
 * refresh. Classic behavior = 412 hands the browser back to the login page.
 *
 * data shapes seen at the call sites: the engine's JSON error body
 * ({code,status,message}), an xhr.responseJSON (same), or undefined. */
// Single, idempotent "session died → back to login" redirect. Both error_handle
// and getJsonMessage (util/misc.js) can observe the same 412; routing both through
// this one guarded function stops the double-navigation that otherwise produced a
// nested /login/?link=%2Flogin%2F%3Flink%3D... chain. Stops the feeders (poll +
// labstate WS) so nothing keeps hammering a dead session, then returns to the
// login page with a same-origin ?link= back to this page (login.js honors it).
function pnqRedirectToLogin() {
    if (window.__pnqLoginRedirecting) return;
    window.__pnqLoginRedirecting = true;
    try { if (window.UPDATEID != null) clearInterval(window.UPDATEID); } catch (e) { /* keep going */ }
    try { if (window.PNQLabState && typeof PNQLabState.stop === 'function') PNQLabState.stop(); } catch (e) { /* keep going */ }
    window.location.href = '/login/?link=' + encodeURIComponent(window.location.pathname + window.location.search);
}

function error_handle(data) {
    // Normalize the shapes callers actually pass: the parsed JSON body
    // ({code,status,message}); a jQuery jqXHR (has .responseJSON/.responseText/
    // .status but NO .code); or a bare string. The node lifecycle/mutate error:
    // callbacks pass the raw jqXHR, so without this normalization error_handle
    // silently no-op'd there (no .code) and the 412→login redirect never fired
    // from those sites — the very thing this handler was restored to provide.
    var body = data;
    if (typeof data === 'string') {
        body = { message: data };
    } else if (data && typeof data === 'object' && !('code' in data)) {
        if (data.responseJSON && typeof data.responseJSON === 'object') {
            body = data.responseJSON;
        } else if (typeof data.responseText === 'string' && data.responseText !== '') {
            try { body = JSON.parse(data.responseText); } catch (e) { body = {}; }
        } else if (typeof data.status === 'number') {
            body = { code: data.status };   // jqXHR with no JSON body — carry HTTP status
        }
    }
    var code = body && body.code;
    var msg = (body && body.message) ? body.message : '';
    if (code == 412 || code == 401) {
        pnqRedirectToLogin();
        return;
    }
    if (msg) {
        try { addMessage('danger', (typeof lang === 'function') ? lang(msg) : msg); }
        catch (e) { console.warn('[api]', msg); }
    }
}

/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  basename, dirname, addMessage, addModal, addWaring, addModalError, addModalWide, logger, error_handle, pnqRedirectToLogin,
});
