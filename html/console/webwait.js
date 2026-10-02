// webwait.js — polls the server-side portcheck endpoint until a docker node's
// http/https web GUI is actually listening, then redirects to it. Loaded as a
// classic external script (CSP script-src 'self' blocks inline <script>).
//
// Query params:
//   node  = node id (required)
//   url   = urlencoded target http(s) URL (required)
//   name  = node display name (optional, cosmetic)
//   which = '2' for the second console lane (optional, default primary)
(function () {
  'use strict';

  var POLL_MS = 1500;
  var GRACE_MS = 500;
  var TIMEOUT_MS = 90000;
  var MAX_CONSECUTIVE_ERRORS = 3;

  var params = new URLSearchParams(window.location.search);
  var nodeId = params.get('node') || '';
  var rawUrl = params.get('url') || '';
  var name = params.get('name') || '';
  var which = params.get('which') === '2' ? '2' : '1';

  var elTitle = document.getElementById('title');
  var elElapsed = document.getElementById('elapsed');
  var elSpinner = document.getElementById('spinner');
  var elStatus = document.getElementById('status-line');
  var elActions = document.getElementById('actions');
  var btnRetry = document.getElementById('btn-retry');
  var btnOpen = document.getElementById('btn-open');

  // Only ever redirect to an http(s) target — reject anything else (e.g. a
  // javascript: URL) so this page can never be turned into an open redirector.
  function safeTarget(u) {
    try {
      var parsed = new URL(u, window.location.origin);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch (e) {}
    return null;
  }

  var target = safeTarget(rawUrl);
  var displayName = name || ('node ' + nodeId);

  var pollTimer = null;
  var startedAt = Date.now();
  var elapsedTimer = null;
  var stopped = false;
  var consecutiveErrors = 0;

  function setTitle(text) { elTitle.textContent = text; }
  function setStatus(text) {
    if (!text) { elStatus.classList.add('hidden'); elStatus.textContent = ''; return; }
    elStatus.textContent = text;
    elStatus.classList.remove('hidden');
  }
  function showActions(show) {
    elActions.classList.toggle('show', !!show);
  }
  function showSpinner(show) {
    elSpinner.classList.toggle('hidden', !show);
  }

  function tickElapsed() {
    var secs = Math.floor((Date.now() - startedAt) / 1000);
    elElapsed.textContent = secs + 's';
  }

  function goToTarget() {
    stopPolling();
    window.location.replace(target);
  }

  function stopPolling() {
    stopped = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function giveUpNoTarget() {
    showSpinner(false);
    setTitle('Cannot open this console');
    setStatus('The console URL is not a valid http/https address.');
    showActions(false);
  }

  function giveUpFallback(reason) {
    stopPolling();
    showSpinner(false);
    setTitle('Could not check ' + displayName + ' — starting…');
    setStatus(reason || 'Unable to reach the check endpoint.');
    showActions(true);
  }

  function timedOut() {
    stopPolling();
    showSpinner(false);
    setTitle('Still not answering');
    setStatus(displayName + ' has not started listening after 90s.');
    showActions(true);
  }

  function poll() {
    if (stopped) return;
    var qs = '?id=' + encodeURIComponent(nodeId) + '&which=' + encodeURIComponent(which);
    fetch('/api/labs/session/portcheck' + qs, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json();
      })
      .then(function (json) {
        if (stopped) return;
        if (json && json.status === 'success') {
          consecutiveErrors = 0;
          var up = !!(json.data && json.data.up);
          if (up) {
            stopPolling();
            setTitle(displayName + ' is ready — opening…');
            setTimeout(goToTarget, GRACE_MS);
            return;
          }
          scheduleNext();
          return;
        }
        // auth/session error or unexpected shape
        onPollError();
      })
      .catch(function () {
        onPollError();
      });
  }

  function onPollError() {
    if (stopped) return;
    consecutiveErrors++;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      giveUpFallback('Lost the session while checking — it may have expired.');
      return;
    }
    scheduleNext();
  }

  function scheduleNext() {
    if (stopped) return;
    if (Date.now() - startedAt >= TIMEOUT_MS) { timedOut(); return; }
    pollTimer = setTimeout(poll, POLL_MS);
  }

  function startPolling() {
    stopped = false;
    consecutiveErrors = 0;
    startedAt = Date.now();
    showSpinner(true);
    showActions(false);
    setStatus('');
    setTitle('Starting ' + displayName + ' — waiting for the web GUI…');
    tickElapsed();
    elapsedTimer = setInterval(tickElapsed, 1000);
    poll();
  }

  btnRetry.addEventListener('click', function () { startPolling(); });
  btnOpen.addEventListener('click', function () { if (target) goToTarget(); });

  if (!target || !nodeId) {
    giveUpNoTarget();
    return;
  }
  startPolling();
})();
