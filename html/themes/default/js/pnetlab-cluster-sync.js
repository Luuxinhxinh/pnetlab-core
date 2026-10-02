/**
 * pnetlab-cluster-sync.js — image-sync progress + auto-retry for cluster
 * satellite node starts.
 *
 * When a node placed on a satellite is started and the satellite lacks the
 * image, apiStartLabNode fails with a `cluster_sync:{job,host,image}` payload
 * (cluster_image_gate kicked a pnet-imgsync job). The React lab.js shows its
 * normal failure message; this overlay additionally watches every node-start
 * response (XHR + fetch), and on a cluster_sync failure shows a progress
 * toast polling /cluster/api.php?action=sync_status, then RE-ISSUES the same
 * start request when the sync completes — so the click "just works", only
 * slower the first time an image lands on a satellite.
 */
(function () {
  'use strict';

  var API = '/cluster/api.php';
  var POLL_MS = 2000;
  // Both start lanes: REST-style /nodes/<id>/start (React lab.js) AND the
  // legacy-theme /api/labs/session/nodes/start whose node id rides in the
  // POST body — /legacy/topology uses the latter exclusively.
  var START_RX = /\/nodes\/\d+\/start(\?|$)|\/labs\/session\/nodes\/start(\?|$)/;
  var active = {};   // job -> {card, timer, url, method, body}

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureStyle() {
    if (document.getElementById('pnq-cs-style')) return;
    var css =
      '#pnq-cs-stack{position:fixed;right:18px;bottom:18px;z-index:100060;display:flex;' +
        'flex-direction:column;gap:10px;font-family:-apple-system,BlinkMacSystemFont,' +
        '"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}' +
      '.pnq-cs-card{width:320px;background:#fff;color:#1d1d1f;border-radius:12px;' +
        'border:1px solid rgba(0,0,0,.12);box-shadow:0 12px 32px rgba(0,0,0,.25);' +
        'padding:12px 14px;}' +
      '.pnq-cs-title{font-size:13px;font-weight:600;display:flex;justify-content:space-between;' +
        'align-items:center;gap:8px;}' +
      '.pnq-cs-title .x{cursor:pointer;border:0;background:none;color:#86868b;font-size:16px;line-height:1;}' +
      '.pnq-cs-bar{height:8px;border-radius:5px;background:rgba(0,0,0,.10);overflow:hidden;margin:10px 0 6px;}' +
      '.pnq-cs-bar>i{display:block;height:100%;background:#3c708a;width:0;transition:width .4s ease;}' +
      '.pnq-cs-msg{font-size:12px;color:#515154;}' +
      '.pnq-cs-card.ok .pnq-cs-bar>i{background:#2e9e44;}' +
      '.pnq-cs-card.err .pnq-cs-bar>i{background:#d64541;}';
    var st = el('style'); st.id = 'pnq-cs-style'; st.textContent = css;
    document.head.appendChild(st);
  }
  function stack() {
    var s = document.getElementById('pnq-cs-stack');
    if (!s) { s = el('div'); s.id = 'pnq-cs-stack'; document.body.appendChild(s); }
    return s;
  }

  function dismiss(job, delay) {
    var a = active[job];
    if (!a) return;
    if (a.timer) { clearTimeout(a.timer); a.timer = null; }
    setTimeout(function () {
      if (a.card && a.card.parentNode) a.card.parentNode.removeChild(a.card);
      delete active[job];
    }, delay || 0);
  }

  function handle(url, sync, message, method, body) {
    ensureStyle();
    var job = String(sync.job || '');
    if (!/^[a-f0-9]{16}$/.test(job)) return;
    if (active[job]) {   // second node joins the job
      active[job].url = url;
      active[job].method = method;
      active[job].body = body;
      return;
    }

    var card = el('div', 'pnq-cs-card');
    var title = el('div', 'pnq-cs-title',
      '<span>Syncing ' + esc(sync.image || 'image') + ' → Satellite ' + esc(sync.host) + '</span>');
    var x = el('button', 'x', '&times;'); x.title = 'Hide (sync continues)';
    x.addEventListener('click', function () { dismiss(job); });
    title.appendChild(x);
    card.appendChild(title);
    var bar = el('div', 'pnq-cs-bar'); bar.appendChild(el('i'));
    card.appendChild(bar);
    var msg = el('div', 'pnq-cs-msg', esc(message || 'starting…'));
    card.appendChild(msg);
    stack().appendChild(card);
    active[job] = { card: card, timer: null, url: url, method: method, body: body };

    function poll() {
      fetch(API + '?action=sync_status&job=' + job, {
        credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' }
      }).then(function (r) { return r.json(); }).then(function (j) {
        var a = active[job];
        if (!a) return;
        var pct = Math.max(0, Math.min(100, parseInt(j.pct, 10) || 0));
        bar.firstChild.style.width = pct + '%';
        msg.textContent = j.msg || '';
        if (j.state === 'done') {
          card.className = 'pnq-cs-card ok';
          bar.firstChild.style.width = '100%';
          msg.textContent = 'Synced — starting the node…';
          retry(job);
          return;
        }
        if (j.state === 'error') {
          card.className = 'pnq-cs-card err';
          msg.textContent = 'Sync failed: ' + (j.msg || 'unknown error');
          dismiss(job, 12000);
          return;
        }
        a.timer = setTimeout(poll, POLL_MS);
      }).catch(function () {
        var a = active[job];
        if (a) a.timer = setTimeout(poll, POLL_MS);
      });
    }

    function retry(jobId) {
      var a = active[jobId];
      if (!a || !a.url) { dismiss(jobId, 4000); return; }
      // Replay the ORIGINAL start request: the legacy lane is a POST whose
      // node id rides in the urlencoded body, so method+body must survive.
      var opts = {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
      };
      if (a.method && a.method.toUpperCase() !== 'GET') {
        opts.method = a.method;
        if (typeof a.body === 'string' && a.body !== '') {
          opts.body = a.body;
          opts.headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        } else if (a.body != null) {
          opts.body = a.body;
        }
      }
      fetch(a.url, opts).then(function (r) { return r.json(); }).then(function (j) {
        var card2 = active[jobId] && active[jobId].card;
        if (!card2) return;
        var m = card2.querySelector('.pnq-cs-msg');
        if (j && j.status === 'success') {
          m.textContent = 'Node started.';
          if (window.addMessage) addMessage('success', 'Image synced — node started');
          // repaint the topology badge now instead of waiting for the poll
          if (typeof printLabStatus === 'function') {
            try { printLabStatus(); } catch (e) {}
          }
        } else {
          m.textContent = 'Node start after sync: ' + esc((j && j.message) || 'failed');
        }
        dismiss(jobId, 6000);
      }).catch(function () { dismiss(jobId, 6000); });
    }

    poll();
  }

  function inspect(url, text, method, body) {
    if (!START_RX.test(url)) return;
    try {
      var j = JSON.parse(text);
      if (j && j.cluster_sync) handle(url, j.cluster_sync, j.message, method, body);
    } catch (e) { /* not JSON — ignore */ }
  }

  /* watch XHR (both the React lab.js and legacy jQuery lanes) */
  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__pnqUrl = url;
    this.__pnqMethod = method;
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__pnqUrl && START_RX.test(this.__pnqUrl)) {
      this.__pnqBody = body;
      this.addEventListener('load', function () {
        try { inspect(this.__pnqUrl, this.responseText, this.__pnqMethod, this.__pnqBody); } catch (e) {}
      });
    }
    return XS.apply(this, arguments);
  };

  /* watch fetch (future-proofing; clone so the page's reader is untouched) */
  var OF = window.fetch;
  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var p = OF.apply(this, arguments);
    if (START_RX.test(url)) {
      var method = (init && init.method) || (input && input.method) || 'GET';
      var body = (init && init.body) || null;
      p.then(function (resp) {
        try {
          resp.clone().text().then(function (t) { inspect(url, t, method, body); });
        } catch (e) {}
      });
    }
    return p;
  };
})();
