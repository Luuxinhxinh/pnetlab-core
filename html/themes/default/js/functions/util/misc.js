/* util/misc.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

function form2Array(form_name) {

    var form_array = {};
    $('form :input[name^="' + form_name + '["]').each(function (id, object) {
        // INPUT name is in the form of "form_name[value]", get value only
        var key = $(this).attr('name').substr(form_name.length + 1, $(this).attr('name').length - form_name.length - 2);
        if (this.type == 'checkbox') {
            form_array[key] = this.checked ? '1' : '0';
        } else {
            form_array[key] = $(this).val();
        }

    });
    console.log(form_array);
    return form_array;
}

// HTML Form to array by row
function form2ArrayByRow(form_name, id) {
    var form_array = {};

    $('form :input[name^="' + form_name + '["][data-path="' + id + '"]').each(function (id, object) {
        // INPUT name is in the form of "form_name[value]", get value only
        var key = $(this).attr('name').substr(form_name.length + 1, $(this).attr('name').length - form_name.length - 2);
        if (this.type == 'checkbox') {
            form_array[key] = this.checked ? '1' : '0';
        } else {
            form_array[key] = $(this).val();
        }
    });
    return form_array;
}

// Get JSon message from HTTP response
function getJsonMessage(response) {
    var message = '';
    try {
        message = JSON.parse(response)['message'];
        code = JSON.parse(response)['code'];
        if (code == 412) {
            // Session expired: hand off to the single idempotent redirect in
            // core/dom.js (shared with error_handle) so two mechanisms observing
            // the same 412 can't double-navigate into a nested ?link= chain.
            // Fallback (dom.js not loaded on this page) uses pathname+search — NOT
            // the full href — to avoid self-encoding an already-redirected URL.
            if (typeof window.pnqRedirectToLogin === 'function') {
                window.pnqRedirectToLogin();
            } else {
                location.href = '/login/?link=' + encodeURIComponent(window.location.pathname + window.location.search);
            }
        }
    } catch (e) {
        if (response != '') {
            message = response;
        } else {
            message = 'Undefined message, check if the UNetLab VM is powered on. If it is, see <a href="/Logs" target="_blank">logs</a>.';
        }
    }
    return message;
}

// Get lab info
function bodyAddClass(cl) {
    $('body').attr('class', cl);
}

function autoheight() {
    if ($('#main').height() < window.innerHeight - $('#main').offset().top) {
        $('#main').height(function (index, height) {
            return window.innerHeight - $(this).offset().top;
        });
    }
}

function toogleDruggable(topology, elem) {
    return topology.toggleDraggable(elem)
}

function sleep(milliseconds) {
    var start = new Date().getTime();
    for (var i = 0; i < 1e7; i++) {
        if ((new Date().getTime() - start) > milliseconds) {
            break;
        }
    }
}

function openNodeCons(url) {
    var nw = window.open(url);
    nw.blur();
    $(nw).ready(function () { nw.close(); });
}

function natSort(as, bs) {
    var a, b, a1, b1, i = 0, L, rx = /(\d+)|(\D+)/g, rd = /\d/;
    if (isFinite(as) && isFinite(bs)) return as - bs;
    a = String(as).toLowerCase();
    b = String(bs).toLowerCase();
    if (a === b) return 0;
    if (!(rd.test(a) && rd.test(b))) return a > b ? 1 : -1;
    a = a.match(rx);
    b = b.match(rx);
    L = a.length > b.length ? b.length : a.length;
    while (i < L) {
        a1 = a[i];
        b1 = b[i++];
        if (a1 !== b1) {
            if (isFinite(a1) && isFinite(b1)) {
                if (a1.charAt(0) === "0") a1 = "." + a1;
                if (b1.charAt(0) === "0") b1 = "." + b1;
                return a1 - b1;
            }
            else return a1 > b1 ? 1 : -1;
        }
    }
    return a.length - b.length;
}


/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  form2Array, form2ArrayByRow, getJsonMessage, bodyAddClass, autoheight, toogleDruggable, sleep, openNodeCons, natSort,
});
