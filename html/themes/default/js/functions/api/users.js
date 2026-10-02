/* api/users.js — Phase 3 functions.js decomposition (Tier A).
 * Moved verbatim from functions.js; re-attached to window via the
 * transition shim so the ~40 pnetlab-* add-ons + golden javascript.js
 * keep resolving these as globals (bare-name -> window). CSP-clean. */

/* getRoles()/getUsers() REMOVED (store-decomm cleanup): they targeted
 * GET /api/list/roles and GET /api/users/<pod> — routes that never existed in
 * the engine api.php (they were store-era endpoints) — so every call 404'd.
 * Their only callers were the never-defined printFormUser() handlers in
 * actions.js (also removed). Role/user management lives at /users/api.php
 * (main dashboard Users view) since the store decommission. */

// Get templates
function getUserInfo() {
    window.LANGUAGE = get(localStorage.getItem('language'), '');
    var deferred = $.Deferred();
    var url = `/api/auth?lang=${window.LANGUAGE}`;
    var type = 'GET';
    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        beforeSend: function (jqXHR) {
            if (window.BASE_URL) {
                jqXHR.crossDomain = true;
            }
        },
        success: function (data) {

            if (data['status'] == 'success') {
                console.log('DEBUG: user is authenticated.');
                EMAIL = data['data']['email'];
                FOLDER = (data['data']['folder'] == null) ? '/' : data['data']['folder'];
                LAB = data['data']['lab'];
                LANG = data['data']['lang'];
                NAME = data['data']['name'];
                ROLE = data['data']['role'];
                // (TENANT removed: GET /api/auth never returns a 'tenant' key —
                // indentify::getUserByCookie has no such column — so it was
                // always undefined and nothing reads it.)
                USERNAME = data['data']['username'];
                HTML5 = data['data']['html5'];
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

// Logging
function logoutUser() {
    var deferred = $.Deferred();
    var url = '/api/auth/logout';
    var type = 'GET';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: user is logged off.');
                if (UPDATEID != null) {
                    // Stop updating node_status
                    clearInterval(UPDATEID);
                }
                deferred.resolve();
            } else {
                // Authentication error
                console.log('DEBUG: internal error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Authentication error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: Ajax error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}


// Delete picture
function postLogin(param) {
    if (UPDATEID != null) {
        // Stop updating node_status
        clearInterval(UPDATEID);
    }
    $('body').removeClass('login');
    if (LAB == null && param == null) {
        window.location.href = "/";
        console.log('DEBUG: loading folder "' + FOLDER + '".');

    } else {
        LAB = LAB || param;
        console.log('DEBUG: loading lab "' + LAB + '".');
        printPageLabOpen(LAB);
        UPDATEID = setInterval(printLabStatus, STATUSINTERVAL);   // string form = implicit eval, blocked by CSP

    }


}


/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  getUserInfo, logoutUser, postLogin,
});
