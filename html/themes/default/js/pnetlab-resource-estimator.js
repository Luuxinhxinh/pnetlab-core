/**
 * pnetlab-resource-estimator.js — Pre-flight Resource Estimation & Safety Guard
 * 
 * Predicts and visualizes host RAM/CPU consumption BEFORE powering on nodes.
 * Supports dual-scope reactivity:
 *   1. Global Scope: Aggregates all stopped nodes in the lab (predicts "Start All").
 *   2. Selection Scope: Reacts in real-time (<16ms) when 1 or more nodes are selected.
 */
(function () {
  'use strict';

  var SYSMON_URL = '/pnq-sysmon.php';
  var POLL_INTERVAL = 4000;
  var sysStats = { cpu_pct: 0, cpu_cores: 1, mem_pct: 0, mem_total_mb: 0, mem_avail_mb: 0 };
  var lastCalculation = null;
  var hudElement = null;

  function formatBytes(mb) {
    if (mb >= 1024) {
      return (mb / 1024).toFixed(1) + ' GB';
    }
    return mb + ' MB';
  }

  function fetchSystemStats() {
    fetch(SYSMON_URL, { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data) return;
        sysStats.cpu_pct = parseInt(data.cpu, 10) || 0;
        sysStats.cpu_cores = parseInt(data.cpu_cores, 10) || 1;
        sysStats.mem_pct = parseInt(data.mem, 10) || 0;
        sysStats.mem_total_mb = parseInt(data.mem_total_mb, 10) || 0;
        sysStats.mem_avail_mb = parseInt(data.mem_avail_mb, 10) || 0;
        recalculateAndRender();
      })
      .catch(function () {});
  }

  function getSelectedNodeIds() {
    var ids = [];
    if (Array.isArray(window.freeSelectedNodes) && window.freeSelectedNodes.length > 0) {
      window.freeSelectedNodes.forEach(function (item) {
        if (item && item.path != null) ids.push(String(item.path));
      });
    }
    var domSelected = document.querySelectorAll('.node_frame.ui-selected, .svelte-flow__node.selected');
    domSelected.forEach(function (el) {
      var id = el.getAttribute('nid') || el.getAttribute('data-path') || el.getAttribute('data-id') || (el.id || '').replace(/^node/, '');
      if (id && ids.indexOf(id) === -1) ids.push(id);
    });
    return ids;
  }

  function calculateResourceImpact() {
    var allNodes = (window.PNQStore && window.PNQStore.state && window.PNQStore.state.nodes) || window.nodes || {};
    var selectedIds = getSelectedNodeIds();
    var isSelectionMode = selectedIds.length > 0;

    var targetNodeIds = [];
    if (isSelectionMode) {
      targetNodeIds = selectedIds;
    } else {
      targetNodeIds = Object.keys(allNodes);
    }

    var totalRamMb = 0;
    var totalCpuCores = 0;
    var stoppedCount = 0;
    var targetNodesInfo = [];

    targetNodeIds.forEach(function (id) {
      var node = allNodes[id];
      if (!node) return;
      var status = parseInt(node.status, 10) || 0;
      if (status !== 2) { // Not running
        stoppedCount++;
        var ram = parseInt(node.ram, 10) || 0;
        var cpu = parseInt(node.cpu, 10) || 1;
        totalRamMb += ram;
        totalCpuCores += cpu;
        targetNodesInfo.push({ name: node.name || ('Node ' + id), ram: ram, cpu: cpu });
      }
    });

    var availMb = sysStats.mem_avail_mb;
    var totalHostMb = sysStats.mem_total_mb;
    var currentUsedMb = Math.max(0, totalHostMb - availMb);
    var projectedUsedMb = currentUsedMb + totalRamMb;
    var projectedPct = totalHostMb > 0 ? Math.min(100, Math.round((projectedUsedMb / totalHostMb) * 100)) : 0;

    var severity = 'safe';
    if (totalRamMb > availMb || (totalHostMb > 0 && projectedPct >= 90)) {
      severity = 'danger';
    } else if (totalHostMb > 0 && projectedPct >= 75) {
      severity = 'warn';
    }

    return {
      isSelectionMode: isSelectionMode,
      targetCount: targetNodeIds.length,
      stoppedCount: stoppedCount,
      totalRamMb: totalRamMb,
      totalCpuCores: totalCpuCores,
      targetNodesInfo: targetNodesInfo,
      currentMemPct: sysStats.mem_pct,
      projectedPct: projectedPct,
      availMb: availMb,
      totalHostMb: totalHostMb,
      severity: severity
    };
  }

  function injectStyles() {
    if (document.getElementById('pnq-resource-estimator-style')) return;
    var style = document.createElement('style');
    style.id = 'pnq-resource-estimator-style';
    style.textContent = [
      '#pnq-resource-hud {',
      '  display: inline-flex; align-items: center; gap: 8px;',
      '  padding: 4px 12px; margin-left: 10px;',
      '  background: rgba(18, 24, 38, 0.85); backdrop-filter: blur(10px);',
      '  border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 20px;',
      '  font: 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  color: #e2e8f0; vertical-align: middle; user-select: none;',
      '  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25); transition: all 0.2s ease;',
      '}',
      '#pnq-resource-hud:hover { border-color: rgba(255, 255, 255, 0.25); }',
      '#pnq-resource-hud .pnq-hud-badge {',
      '  display: flex; align-items: center; gap: 4px; font-weight: 600;',
      '  padding: 2px 8px; border-radius: 12px; font-size: 11px;',
      '  background: rgba(255, 255, 255, 0.08);',
      '}',
      '#pnq-resource-hud.mode-selection .pnq-hud-badge {',
      '  background: rgba(59, 130, 246, 0.25); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.35);',
      '}',
      '#pnq-resource-hud .pnq-hud-metrics { display: flex; align-items: center; gap: 6px; }',
      '#pnq-resource-hud .pnq-hud-dot {',
      '  width: 8px; height: 8px; border-radius: 50%; display: inline-block;',
      '}',
      '#pnq-resource-hud.safe .pnq-hud-dot { background: #10b981; box-shadow: 0 0 6px #10b981; }',
      '#pnq-resource-hud.warn .pnq-hud-dot { background: #f59e0b; box-shadow: 0 0 6px #f59e0b; }',
      '#pnq-resource-hud.danger .pnq-hud-dot { background: #ef4444; box-shadow: 0 0 8px #ef4444; animation: pnqPulse 1.2s infinite; }',
      '@keyframes pnqPulse { 0% { opacity: 0.5; } 50% { opacity: 1; } 100% { opacity: 0.5; } }',
      '#pnq-resource-hud .pnq-hud-impact {',
      '  font-size: 11px; opacity: 0.8; margin-left: 4px;',
      '}',
      '#pnq-resource-hud.danger .pnq-hud-impact { color: #fca5a5; font-weight: 600; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  function renderHud(data) {
    if (!hudElement) {
      hudElement = document.createElement('div');
      hudElement.id = 'pnq-resource-hud';
      var container = document.getElementById('pnq-buttons') || document.getElementById('pnetlab-quickbar');
      if (container) {
        container.appendChild(hudElement);
      } else {
        document.body.appendChild(hudElement);
      }
    }

    hudElement.className = (data.isSelectionMode ? 'mode-selection ' : 'mode-global ') + data.severity;

    var scopeLabel = data.isSelectionMode
      ? '<i class="fa fa-mouse-pointer"></i> Đang chọn: ' + data.stoppedCount + ' node tắt'
      : '<i class="fa fa-cubes"></i> Toàn Lab: ' + data.stoppedCount + ' node tắt';

    var metricsText = '+' + formatBytes(data.totalRamMb) + ' • +' + data.totalCpuCores + ' vCPU';
    var impactText = data.totalHostMb > 0
      ? 'Dự kiến RAM: ' + data.currentMemPct + '% ➔ ' + data.projectedPct + '%'
      : '';

    var statusHint = data.severity === 'danger'
      ? '⚠️ Cảnh báo: Nguy cơ thiếu RAM (OOM)!'
      : (data.severity === 'warn' ? 'Tải cao sau khi bật' : 'Tài nguyên an toàn');

    hudElement.innerHTML = [
      '<div class="pnq-hud-badge">' + scopeLabel + '</div>',
      '<div class="pnq-hud-metrics">',
      '  <span class="pnq-hud-dot"></span>',
      '  <span>' + metricsText + '</span>',
      '  <span class="pnq-hud-impact">(' + impactText + ')</span>',
      '</div>'
    ].join('');

    hudElement.title = [
      statusHint,
      '--------------------------------',
      data.isSelectionMode ? 'Phạm vi: Các node đang chọn' : 'Phạm vi: Toàn bộ bài lab',
      'Số node cần bật: ' + data.stoppedCount,
      'RAM cần cấp: ' + formatBytes(data.totalRamMb),
      'vCPU cần cấp: ' + data.totalCpuCores,
      'RAM máy chủ còn trống: ' + formatBytes(data.availMb) + ' / ' + formatBytes(data.totalHostMb)
    ].join('\n');
  }

  function recalculateAndRender() {
    var data = calculateResourceImpact();
    lastCalculation = data;
    renderHud(data);
  }

  function setupWatchers() {
    // 1. Reactive Store changes
    if (window.PNQStore && typeof window.PNQStore.subscribe === 'function') {
      window.PNQStore.subscribe(function () {
        recalculateAndRender();
      });
    }

    // 2. Selection changes via DOM & Mouse interaction
    document.addEventListener('mouseup', function () {
      setTimeout(recalculateAndRender, 50);
    });
    document.addEventListener('keyup', function (e) {
      if (e.key === 'Escape' || e.key === 'a' || e.ctrlKey || e.metaKey) {
        setTimeout(recalculateAndRender, 50);
      }
    });

    // 3. Selection change observer
    var observer = new MutationObserver(function () {
      recalculateAndRender();
    });
    var flowWrapper = document.getElementById('body') || document.body;
    observer.observe(flowWrapper, { attributes: true, subtree: true, attributeFilter: ['class'] });

    // 4. Polling system memory
    setInterval(fetchSystemStats, POLL_INTERVAL);
  }

  function init() {
    injectStyles();
    fetchSystemStats();
    setupWatchers();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
