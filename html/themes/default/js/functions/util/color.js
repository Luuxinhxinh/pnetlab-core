/* util/color.js — Phase 3 functions.js decomposition (Tier A).
 * Moved verbatim from functions.js; re-attached to window via the
 * transition shim so the ~40 pnetlab-* add-ons + golden javascript.js
 * keep resolving these as globals (bare-name -> window). CSP-clean. */

function rgb2hex(color) {
    if (color.substr(0, 1) === '#') {
        return color;
    }
    var digits = /(.*?)rgba{0,1}\((\d+), (\d+), (\d+)\)/.exec(color);

    if (digits == null) {
        digits = /(.*?)rgba\((\d+), (\d+), (\d+), (\d+)\)/.exec(color);
    }

    var red = parseInt(digits[2]);
    var green = parseInt(digits[3]);
    var blue = parseInt(digits[4]);

    var rgb = blue | (green << 8) | (red << 16);
    return digits[1] + '#' + ("000000" + rgb.toString(16)).slice(-6);
}

// Change from Hex to RGB color
function hex2rgb(hex, opacity) {
    hex = hex.replace('#', '');
    var r = parseInt(hex.substring(0, 2), 16);
    var g = parseInt(hex.substring(2, 4), 16);
    var b = parseInt(hex.substring(4, 6), 16);

    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + opacity + ')';
}

function getElementsAngle(selector) {
    var el = document.querySelector(selector)
        , st = window.getComputedStyle(el, null)
        , tr = st.getPropertyValue("-webkit-transform") ||
            st.getPropertyValue("-moz-transform") ||
            st.getPropertyValue("-ms-transform") ||
            st.getPropertyValue("-o-transform") ||
            st.getPropertyValue("transform") ||
            "FAIL";

    if (tr === "FAIL" || tr === "none") {
        return 0;
    }

    // With rotate(30deg)...
    // matrix(0.866025, 0.5, -0.5, 0.866025, 0px, 0px)
    // rotation matrix - http://en.wikipedia.org/wiki/Rotation_matrix

    var values = tr.split('(')[1].split(')')[0].split(',')
        , a = values[0]
        , b = values[1]
        , c = values[2]
        , d = values[3]
        , scale = Math.sqrt(a * a + b * b)
        // arc sin, convert from radians to degrees, round
        , sin = b / scale
        , angle = Math.round(Math.atan2(b, a) * (180 / Math.PI))
        ;

    return angle;
}


// Add class to body

/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  rgb2hex, hex2rgb, getElementsAngle,
});
