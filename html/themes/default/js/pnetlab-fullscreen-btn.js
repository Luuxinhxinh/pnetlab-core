/*
 * pnetlab-fullscreen-btn.js — adds a Fullscreen toggle to the left quickbar
 * (#pnq-buttons, next to the Pan button). Click puts the whole browser tab into
 * fullscreen (Fullscreen API on the document element); the same button then reads
 * "Exit Fullscreen" and exits. The label/icon stay in sync via fullscreenchange,
 * so it's correct even if the user exits with Esc/F11. CSP-safe, additive.
 */
(function () {
  'use strict';
  var BTN_ID = 'pnq-fs-btn';

  function inFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  }
  function enter() {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (fn) { try { fn.call(el); } catch (e) {} }
  }
  function exit() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (fn) { try { fn.call(document); } catch (e) {} }
  }
  function toggle() { if (inFullscreen()) exit(); else enter(); }

  function render() {
    var b = document.getElementById(BTN_ID);
    if (!b) return;
    var fs = inFullscreen();
    var label = fs ? 'Exit Fullscreen' : 'Fullscreen';
    b.innerHTML = '<i class="fa ' + (fs ? 'fa-compress' : 'fa-expand') + '" aria-hidden="true"></i>' +
      '<span class="pnq-label">' + label + '</span>';
    b.title = fs ? 'Exit fullscreen' : 'Fullscreen (whole browser tab)';
    b.setAttribute('aria-label', label);
  }

  function ensureButton() {
    var bar = document.getElementById('pnq-buttons');
    if (!bar || document.getElementById(BTN_ID)) return;
    // Pass 1 a11y hardening: real <button> (was a div) for Tab/Enter/Space.
    var b = document.createElement('button');
    b.type = 'button';
    b.id = BTN_ID;
    b.className = 'pnq-btn';
    b.addEventListener('click', toggle);
    bar.appendChild(b);
    render();
  }

  function init() {
    ensureButton();
    // the quickbar can render late / rebuild on lab open — keep trying.
    new MutationObserver(ensureButton).observe(document.body, { childList: true, subtree: true });
    ['fullscreenchange', 'webkitfullscreenchange', 'msfullscreenchange'].forEach(function (ev) {
      document.addEventListener(ev, render);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
