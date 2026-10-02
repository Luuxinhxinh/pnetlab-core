/* canvas/zoom.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

// b2 Wave 3 amputation: zoomlab() removed — it drove the jsPlumb #lab-viewport
// scale transform (setZoom on lab_topology) from the classic zoom slider, which is
// gone. The flow island owns zoom; nothing calls zoomlab anymore.

// Size #lab-viewport so it always covers at least the visible window. The
// canvas right-click (context) menu is delegated to #lab-viewport, so without
// this the menu only appears inside the default boundary and the native browser
// menu shows everywhere else. Mirrors zoomlab()'s sizing (the viewport is the
// scaled canvas → window/zoom covers the window after the scale transform);
// called on lab open and on window resize. Safe no-op off the topology page.
function fitLabViewport() {
    var vp = $('#lab-viewport');
    if (!vp.length) return;
    var zoom = (typeof getZoomLab === 'function' ? (getZoomLab() / 100) : 1);
    if (!zoom || zoom <= 0 || isNaN(zoom)) zoom = 1;
    vp.width($(window).width() / zoom);
    vp.height($(window).height() / zoom);
    vp.css({ top: 0, left: 0, position: 'absolute' });
}

function zoompic(event, ui) {
    // Wave 1 (b2) — the pictures modal pan/zoom is now a plain CSS-transform
    // controller (functions/media/text-pictures.js: pnqPicturePanZoom), not a
    // jsPlumb `lab_picture` instance. The #picslider drives absolute zoom in percent
    // through it. Guarded so the slider is inert if the picture container isn't up.
    if (window.pnqPicturePanZoom && typeof window.pnqPicturePanZoom.setZoom === 'function') {
        window.pnqPicturePanZoom.setZoom(ui.value);
    }
    $('#picslider').slider({ value: ui.value })
}

// b2 amputation follow-up: window.setZoom() removed. It was jsPlumb-doc sample
// code — it defaulted its `instance` arg to a BARE `jsPlumb` global (gone with
// lab.js) and called instance.getContainer(), which the pnetlab-app-topology-stub
// lab_topology shim does NOT provide. Its only caller was adjustZoom() in
// ebs/functions.js, itself only reachable from hideContextmenu()'s
// `if (contextMenuOpen)` branch — and contextMenuOpen is initialised false
// (functions/core/globals.js:5) and never assigned true anywhere in the tree, so
// the whole chain was unreachable. The flow island owns zoom.

// Form upload node config
// Import external labs

/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  fitLabViewport, zoompic,
});
