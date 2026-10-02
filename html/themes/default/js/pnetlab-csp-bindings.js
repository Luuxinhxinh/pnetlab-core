/* pnetlab-csp-bindings.js — delegated replacements for the inline onclick
   attributes the React bundles emit as HTML strings (lab.js capture menu +
   multiConfig modal buttons, main.js / admin-Lab_sessionsView capture menu).
   CSP blocks inline handler attributes however they enter the DOM, so the
   bundles were patched to emit data-pnet-call / data-pnet-capture instead,
   and this file dispatches them. Loaded by the engine topology page
   (index.html) AND the store react blades — keep it dependency-free. */
(function () {
  'use strict';
  if (window.__pnqCspBindings) return;   // included by both the engine page and the store shell
  window.__pnqCspBindings = 1;

  function numeric(s) {
    var n = Number(s);
    return (s !== '' && !isNaN(n)) ? n : s;
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    /* <button data-pnet-call="multiConfigAdd"> → window.multiConfigAdd() */
    var call = t.closest('[data-pnet-call]');
    if (call) {
      var fn = window[call.getAttribute('data-pnet-call')];
      if (typeof fn === 'function') {
        e.preventDefault();
        fn();
      }
      return;
    }

    /* <a data-pnet-capture="<if>,<nodeid>"> → window.wireshark_capture(if, id)
       (arg order/types match the original onclick="wireshark_capture(i, id)") */
    var cap = t.closest('[data-pnet-capture]');
    if (cap) {
      e.preventDefault();
      var args = (cap.getAttribute('data-pnet-capture') || '').split(',');
      if (typeof window.wireshark_capture === 'function' && args.length >= 2) {
        window.wireshark_capture(numeric(args[0]), numeric(args[1]));
      }
    }
  });
})();
