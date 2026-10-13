/**
 * pnetlab-toast-manager.js — Modern Floating Toast Notification System
 * FE2 UI/UX Engineering — Boundary: /opt/unetlab/html/themes/default/js/pnetlab-toast-manager.js
 *
 * Replaces browser alert() and legacy #notification_container list popups.
 * - Max limit: 3 concurrent toasts.
 * - Auto-dismiss: 3s countdown with pause on hover & fast close (×).
 * - Standard status colors: Success, Error/Danger, Warning, Info.
 * - z-index >= 99999 (100250) over Canvas & HTML5 consoles.
 * - Legacy Deprecation: suppresses old popup containers.
 * - Batch & Deduplication: aggregates mass node actions (Set-based unique entity count).
 */
(function () {
  'use strict';

  var CONTAINER_ID = 'pnq-toast-container';
  var MAX_VISIBLE = 3;
  var TOAST_DURATION = 3000;
  var BATCH_DEBOUNCE_MS = 1600;
  var batchTrackers = {};

  var CFG = {
    success: {
      color: '#10b981', bg: 'rgba(6, 78, 59, 0.94)', border: 'rgba(16, 185, 129, 0.45)',
      glow: '0 8px 24px rgba(16, 185, 129, 0.25)', title: 'Success',
      icon: '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>'
    },
    danger: {
      color: '#ef4444', bg: 'rgba(127, 29, 29, 0.94)', border: 'rgba(239, 68, 68, 0.45)',
      glow: '0 8px 24px rgba(239, 68, 68, 0.25)', title: 'Error',
      icon: '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>'
    },
    warning: {
      color: '#f59e0b', bg: 'rgba(120, 53, 15, 0.94)', border: 'rgba(245, 158, 11, 0.45)',
      glow: '0 8px 24px rgba(245, 158, 11, 0.25)', title: 'Warning',
      icon: '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>'
    },
    info: {
      color: '#3b82f6', bg: 'rgba(30, 58, 138, 0.94)', border: 'rgba(59, 130, 246, 0.45)',
      glow: '0 8px 24px rgba(59, 130, 246, 0.25)', title: 'Info',
      icon: '<svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>'
    }
  };

  function normSev(s) {
    s = String(s || '').toLowerCase();
    if (s === 'danger' || s === 'error') return 'danger';
    if (s === 'success') return 'success';
    if (s === 'warning' || s === 'alert') return 'warning';
    return 'info';
  }

  function stripHtml(h) {
    var d = document.createElement('div');
    d.innerHTML = String(h == null ? '' : h);
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function injectStyles() {
    if (document.getElementById('pnq-toast-styles')) return;
    var s = document.createElement('style');
    s.id = 'pnq-toast-styles';
    s.textContent = '#' + CONTAINER_ID + '{position:fixed;top:60px;right:20px;z-index:100250;display:flex;flex-direction:column;gap:10px;pointer-events:none;max-width:380px;width:calc(100vw - 40px);box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}' +
      '.pnq-toast-item{position:relative;display:flex;flex-direction:column;padding:12px 14px 10px;border-radius:8px;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);pointer-events:auto;color:#fff;box-sizing:border-box;overflow:hidden;transition:transform .28s cubic-bezier(.16,1,.3,1),opacity .24s ease,max-height .28s ease,margin .28s ease;transform:translateX(110%);opacity:0;max-height:140px;box-shadow:0 10px 30px rgba(0,0,0,.45);}' +
      '.pnq-toast-item.pnq-toast-show{transform:translateX(0);opacity:1;}' +
      '.pnq-toast-item.pnq-toast-hide{transform:translateX(115%);opacity:0;max-height:0;margin-top:-10px;padding-top:0;padding-bottom:0;pointer-events:none;}' +
      '.pnq-toast-header{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;line-height:1.3;margin-bottom:4px;}' +
      '.pnq-toast-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;}' +
      '.pnq-toast-title{flex:1;display:flex;align-items:center;gap:6px;letter-spacing:.2px;}' +
      '.pnq-toast-badge{font-size:11px;font-weight:700;padding:1px 6px;border-radius:10px;background:rgba(255,255,255,.2);color:#fff;line-height:1.3;}' +
      '.pnq-toast-close{background:transparent;border:none;color:rgba(255,255,255,.7);font-size:18px;line-height:1;cursor:pointer;padding:0 2px;margin-left:4px;transition:color .15s,transform .15s;display:flex;align-items:center;justify-content:center;}' +
      '.pnq-toast-close:hover{color:#fff;transform:scale(1.15);}' +
      '.pnq-toast-body{font-size:12.5px;line-height:1.4;color:rgba(255,255,255,.92);word-break:break-word;padding-left:24px;margin-bottom:6px;}' +
      '.pnq-toast-progress{position:absolute;bottom:0;left:0;height:3px;width:100%;background:rgba(255,255,255,.75);transform-origin:left;transition:width .05s linear;}' +
      '#alert_container,#notification_container{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;}';
    document.head.appendChild(s);
  }

  function ensureContainer() {
    var c = document.getElementById(CONTAINER_ID);
    if (!c) {
      c = document.createElement('div');
      c.id = CONTAINER_ID;
      c.setAttribute('aria-live', 'polite');
      document.body.appendChild(c);
    }
    return c;
  }

  function Toast(opts) {
    this.severity = normSev(opts.severity);
    this.message = opts.message || '';
    this.title = opts.title || CFG[this.severity].title;
    this.badgeText = opts.badgeText || '';
    this.batchKey = opts.batchKey || null;
    this.duration = opts.duration || TOAST_DURATION;
    this.remaining = this.duration;
    this.isPaused = false;
    this.startTime = 0;
    this.timer = null;
    this.animFrame = null;
    this.create();
  }

  Toast.prototype.create = function () {
    var self = this, cfg = CFG[this.severity] || CFG.info, el = document.createElement('div');
    el.className = 'pnq-toast-item';
    el.style.backgroundColor = cfg.bg;
    el.style.border = '1px solid ' + cfg.border;
    el.style.boxShadow = cfg.glow;

    var head = document.createElement('div');
    head.className = 'pnq-toast-header';

    var icon = document.createElement('span');
    icon.className = 'pnq-toast-icon';
    icon.style.color = cfg.color;
    icon.innerHTML = cfg.icon;

    var tit = document.createElement('span');
    tit.className = 'pnq-toast-title';
    tit.appendChild(document.createTextNode(this.title));

    var badge = document.createElement('span');
    badge.className = 'pnq-toast-badge';
    badge.style.display = this.badgeText ? 'inline-block' : 'none';
    badge.textContent = this.badgeText;
    this.badgeEl = badge;
    tit.appendChild(badge);

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'pnq-toast-close';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '&times;';
    close.onclick = function (e) { e.stopPropagation(); self.dismiss(); };

    head.appendChild(icon);
    head.appendChild(tit);
    head.appendChild(close);

    var body = document.createElement('div');
    body.className = 'pnq-toast-body';
    body.textContent = this.message;
    this.bodyEl = body;

    var bar = document.createElement('div');
    bar.className = 'pnq-toast-progress';
    this.progressBar = bar;

    el.appendChild(head);
    el.appendChild(body);
    el.appendChild(bar);

    el.addEventListener('mouseenter', function () { self.pause(); });
    el.addEventListener('mouseleave', function () { self.resume(); });
    this.element = el;
  };

  Toast.prototype.mount = function (container) {
    var self = this;
    container.prepend(this.element);
    ToastManager.enforceLimit();
    requestAnimationFrame(function () { self.element.classList.add('pnq-toast-show'); });
    this.resume();
  };

  Toast.prototype.updateContent = function (msg, badgeText) {
    this.message = msg;
    if (this.bodyEl) this.bodyEl.textContent = msg;
    if (badgeText != null) {
      this.badgeText = badgeText;
      if (this.badgeEl) {
        this.badgeEl.textContent = badgeText;
        this.badgeEl.style.display = badgeText ? 'inline-block' : 'none';
      }
    }
    this.remaining = this.duration;
    this.startTime = Date.now();
  };

  Toast.prototype.pause = function () {
    if (this.isPaused) return;
    this.isPaused = true;
    if (this.timer) clearTimeout(this.timer);
    this.remaining -= (Date.now() - this.startTime);
    if (this.remaining < 0) this.remaining = 0;
  };

  Toast.prototype.resume = function () {
    if (!this.isPaused && this.timer) return;
    this.isPaused = false;
    this.startTime = Date.now();
    var self = this;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(function () { self.dismiss(); }, this.remaining);
    this.tickProgress();
  };

  Toast.prototype.tickProgress = function () {
    var self = this;
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    function step() {
      if (!self.element || !self.element.parentNode) return;
      if (!self.isPaused) {
        var elapsed = Date.now() - self.startTime;
        var curRem = self.remaining - elapsed;
        var pct = Math.max(0, Math.min(100, (curRem / self.duration) * 100));
        if (self.progressBar) self.progressBar.style.width = pct + '%';
        if (curRem <= 0) return;
      }
      self.animFrame = requestAnimationFrame(step);
    }
    this.animFrame = requestAnimationFrame(step);
  };

  Toast.prototype.dismiss = function () {
    if (this.timer) clearTimeout(this.timer);
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    if (!this.element) return;
    var el = this.element, self = this;
    el.classList.remove('pnq-toast-show');
    el.classList.add('pnq-toast-hide');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      if (self.batchKey && batchTrackers[self.batchKey] && batchTrackers[self.batchKey].toast === self) {
        batchTrackers[self.batchKey].toast = null;
      }
    }, 280);
  };

  var ToastManager = {
    init: function () { injectStyles(); ensureContainer(); },
    enforceLimit: function () {
      var c = ensureContainer();
      var items = c.querySelectorAll('.pnq-toast-item.pnq-toast-show');
      if (items.length > MAX_VISIBLE) {
        for (var i = MAX_VISIBLE; i < items.length; i++) {
          var oldEl = items[i];
          oldEl.classList.remove('pnq-toast-show');
          oldEl.classList.add('pnq-toast-hide');
          setTimeout(function (t) { if (t && t.parentNode) t.parentNode.removeChild(t); }.bind(null, oldEl), 280);
        }
      }
    },
    show: function (opts) {
      this.init();
      var t = new Toast(opts);
      t.mount(ensureContainer());
      return t;
    },
    success: function (m, tit) { return this.show({ severity: 'success', message: m, title: tit }); },
    error: function (m, tit) { return this.show({ severity: 'danger', message: m, title: tit }); },
    warning: function (m, tit) { return this.show({ severity: 'warning', message: m, title: tit }); },
    info: function (m, tit) { return this.show({ severity: 'info', message: m, title: tit }); },

    handleBatchNodeAction: function (action, nodeName) {
      var key = action.toLowerCase();
      var tracker = batchTrackers[key];
      if (!tracker) {
        tracker = { action: key, set: new Set(), firstNode: nodeName, toast: null, debounceTimer: null };
        batchTrackers[key] = tracker;
      }
      tracker.set.add(nodeName);
      var total = tracker.set.size;
      var msg = total === 1 ? (tracker.firstNode + ': ' + key) : (tracker.firstNode + ' and ' + (total - 1) + ' other node' + (total - 1 === 1 ? '' : 's') + ' ' + key);
      var badge = 'x' + total;

      if (tracker.toast && tracker.toast.element && tracker.toast.element.parentNode) {
        tracker.toast.updateContent(msg, badge);
      } else {
        var isErr = (key === 'error' || key === 'failed');
        tracker.toast = this.show({
          severity: isErr ? 'danger' : 'success',
          message: msg,
          title: isErr ? 'Error' : 'Success',
          badgeText: badge,
          batchKey: key
        });
      }

      if (tracker.debounceTimer) clearTimeout(tracker.debounceTimer);
      tracker.debounceTimer = setTimeout(function () {
        if (tracker.set) tracker.set.clear();
        batchTrackers[key] = null;
      }, BATCH_DEBOUNCE_MS);
    }
  };

  function parseNodeAction(msg) {
    var text = stripHtml(msg);
    var m = text.match(/^([^:]+):\s*(started|stopped|shutdown|wiped|start|stop)/i);
    if (m) {
      var action = m[2].trim().toLowerCase();
      if (action === 'start') action = 'started';
      if (action === 'stop') action = 'stopped';
      return { nodeName: m[1].trim(), action: action };
    }
    return null;
  }

  function hookAddMessage() {
    var orig = window.addMessage;
    if (orig && orig.__pnqToastIntercepted) return;
    var wrapped = function (severity, message) {
      try {
        var clean = stripHtml(message);
        var na = parseNodeAction(message);
        if (na) {
          ToastManager.handleBatchNodeAction(na.action, na.nodeName);
        } else {
          ToastManager.show({ severity: severity, message: clean });
        }
      } catch (e) {
        console.warn('[PNQToast]', e);
      }

      var legC = document.getElementById('notification_container');
      if (legC) { legC.style.setProperty('display', 'none', 'important'); legC.innerHTML = ''; }
      var alC = document.getElementById('alert_container');
      if (alC) { alC.style.setProperty('display', 'none', 'important'); }

      if (window.PNQNotifHistory && window.PNQNotifHistory.items) {
        var sNorm = normSev(severity);
        window.PNQNotifHistory.items.unshift({ sev: sNorm, text: clean, ts: Date.now() });
        if (window.PNQNotifHistory.items.length > 100) window.PNQNotifHistory.items.length = 100;
        var pill = document.getElementById('pnq-nh-pill');
        if (pill) {
          var counts = { success: 0, danger: 0, info: 0, warning: 0 }, tot = window.PNQNotifHistory.items.length;
          for (var i = 0; i < tot; i++) counts[window.PNQNotifHistory.items[i].sev]++;
          var html = '', sevs = ['success', 'danger', 'info', 'warning'];
          for (var j = 0; j < sevs.length; j++) {
            if (counts[sevs[j]]) html += '<span class="pnq-nh-badge pnq-nh-' + sevs[j] + '">' + counts[sevs[j]] + '</span>';
          }
          html += '<span class="pnq-nh-total' + (tot ? '' : ' pnq-nh-zero') + '">' + tot + '</span>';
          pill.innerHTML = '<i class="glyphicon glyphicon-bell" aria-hidden="true"></i>' + html;
          pill.title = 'Message History (' + tot + ')';
        }
      }
      return true;
    };
    wrapped.__pnqToastIntercepted = true;
    window.addMessage = wrapped;
  }

  function hookAlert() {
    window.alert = function (msg) { ToastManager.warning(String(msg || ''), 'Notice'); };
  }

  window.PNQToast = ToastManager;
  injectStyles();
  hookAddMessage();
  hookAlert();

  var hookInterval = setInterval(hookAddMessage, 200);
  setTimeout(function () { clearInterval(hookInterval); }, 5000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { ToastManager.init(); hookAddMessage(); });
  } else {
    ToastManager.init();
  }
})();
