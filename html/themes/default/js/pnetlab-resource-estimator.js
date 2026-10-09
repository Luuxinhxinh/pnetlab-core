/**
 * pnetlab-resource-estimator.js
 * Pre-flight Resource Estimation HUD for PNetLab Topology (v3.0 Realistic Footprint)
 *
 * Real-time estimation of RAM and vCPU footprint before starting nodes:
 * - Accurately predicts REAL Linux Host RSS Footprint (Cisco IOL ~75MB, VPCS ~10MB, Docker ~120MB, QEMU ~45%),
 *   avoiding inflated 100% false OOM alarms.
 * - Dual-scope: Automatically switches between Whole Lab vs Current Selection.
 * - Displays clear progression: "Current RAM ➔ Projected RAM" (e.g. 32% ➔ 36% for 4 nodes, 32% ➔ 44% for whole lab).
 * - Instant zero-lag updates on drag-selection (marquee/lasso), node click, and keyboard shortcuts.
 */
(function () {
  'use strict';

  var sysStats = {
    mem_pct: 0,
    mem_total_mb: 0,
    mem_avail_mb: 0,
    mem_used_mb: 0,
    cpu_cores: 4
  };

  var hudElement = null;
  var lastEstimate = null;

  function formatBytes(mb) {
    if (isNaN(mb) || mb <= 0) return '0 MB';
    if (mb >= 1024) {
      return (mb / 1024).toFixed(1).replace(/\.0$/, '') + ' GB';
    }
    return Math.round(mb) + ' MB';
  }

  function fetchSysStats(callback) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/pnq-sysmon.php?t=' + Date.now(), true);
    xhr.timeout = 2500;
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var res = JSON.parse(xhr.responseText);
          sysStats.mem_pct = typeof res.mem === 'number' && res.mem >= 0 ? res.mem : 0;
          sysStats.mem_total_mb = res.mem_total_mb || 7424;
          sysStats.mem_avail_mb = res.mem_avail_mb || Math.round(sysStats.mem_total_mb * (1 - sysStats.mem_pct / 100));
          sysStats.mem_used_mb = res.mem_used_mb || (sysStats.mem_total_mb - sysStats.mem_avail_mb);
          sysStats.cpu_cores = res.cpu_cores || 4;
        } catch (e) {}
      }
      if (typeof callback === 'function') callback();
    };
    xhr.onerror = function () {
      if (typeof callback === 'function') callback();
    };
    xhr.send();
  }

  function getSelectedNodeIds() {
    var ids = [];
    // 1. Check Svelte Flow / DOM elements
    var sel = document.querySelectorAll(
      '.svelte-flow__node.selected, .node_frame.selected, .node_frame.active, .node_frame.ui-selected, [data-selected="true"]'
    );
    sel.forEach(function (el) {
      var id = el.getAttribute('data-id') || el.getAttribute('nid') || el.getAttribute('data-path') || (el.id || '').replace(/^node/, '');
      if (id && ids.indexOf(String(id)) === -1) ids.push(String(id));
    });

    var innerSel = document.querySelectorAll('.svelte-flow__node .selected, .selected');
    innerSel.forEach(function (el) {
      var nodeEl = el.closest ? el.closest('.svelte-flow__node, .node_frame') : null;
      if (nodeEl) {
        var id = nodeEl.getAttribute('data-id') || nodeEl.getAttribute('nid') || nodeEl.getAttribute('data-path') || (nodeEl.id || '').replace(/^node/, '');
        if (id && ids.indexOf(String(id)) === -1) ids.push(String(id));
      }
    });

    // 2. Check window.freeSelectedNodes if available
    if (!ids.length && Array.isArray(window.freeSelectedNodes)) {
      window.freeSelectedNodes.forEach(function (n) {
        if (n && n.path != null && ids.indexOf(String(n.path)) === -1) {
          ids.push(String(n.path));
        }
      });
    }

    return ids;
  }

  function resolveNodeRecord(id) {
    var raw = (window.__pnqCanvas && window.__pnqCanvas.rawNodes && window.__pnqCanvas.rawNodes[id]) || {};
    var win = (window.nodes && window.nodes[id]) || {};
    var app = (window.App && window.App.topology && window.App.topology.nodes && window.App.topology.nodes[id] && typeof window.App.topology.nodes[id].getAll === 'function')
      ? window.App.topology.nodes[id].getAll() : {};
    var store = (window.PNQStore && window.PNQStore.state && window.PNQStore.state.nodes && window.PNQStore.state.nodes[id]) || {};
    return Object.assign({}, raw, win, app, store);
  }

  function getAllNodeIds() {
    var ids = {};
    if (window.nodes) Object.keys(window.nodes).forEach(function (k) { ids[k] = true; });
    if (window.__pnqCanvas && window.__pnqCanvas.rawNodes) Object.keys(window.__pnqCanvas.rawNodes).forEach(function (k) { ids[k] = true; });
    if (window.PNQStore && window.PNQStore.state && window.PNQStore.state.nodes) Object.keys(window.PNQStore.state.nodes).forEach(function (k) { ids[k] = true; });
    return Object.keys(ids);
  }

  /**
   * Realistic host memory footprint model (Resident Set Size on Linux)
   */
  function estimateNodeFootprint(node) {
    var type = String(node.type || node.template || '').toLowerCase();
    var img = String(node.image || '').toLowerCase();
    var tpl = String(node.template || '').toLowerCase();
    var cfgRam = parseInt(node.ram, 10);
    if (isNaN(cfgRam) || cfgRam <= 0) cfgRam = 1024;
    var cfgCpu = parseInt(node.cpu, 10);
    if (isNaN(cfgCpu) || cfgCpu <= 0) cfgCpu = 1;

    var hostRamMb = 0;

    // 1. Cisco IOL (IOU): compiled C ELF process, ~70-75MB RSS on Linux host
    if (type === 'iol' || tpl === 'iol' || img.indexOf('.bin') !== -1 || img.indexOf('iol') !== -1) {
      hostRamMb = 75;
    }
    // 2. VPCS: ultra-lightweight ping/traceroute emulator ~10MB
    else if (type === 'vpcs' || tpl === 'vpcs' || (!img && (type === '' || type === 'vpcs'))) {
      hostRamMb = 10;
    }
    // 3. Docker container: shared Linux kernel ~100-120MB
    else if (type === 'docker' || tpl === 'docker') {
      hostRamMb = Math.min(cfgRam, 120);
    }
    // 4. Dynamips Cisco emulation: ~140MB
    else if (type === 'dynamips' || tpl === 'dynamips') {
      hostRamMb = Math.min(cfgRam, 140);
    }
    // 5. QEMU / KVM: Linux demand paging initial boot ~45% of configured RAM
    else if (type === 'qemu' || tpl === 'qemu' || img.indexOf('qcow2') !== -1) {
      hostRamMb = Math.round(cfgRam * 0.45);
    }
    // 6. Default fallback
    else {
      hostRamMb = Math.min(cfgRam, 100);
    }

    return {
      hostRamMb: hostRamMb,
      configuredRamMb: cfgRam,
      hostCpu: cfgCpu
    };
  }

  function calculateResourceImpact() {
    var selectedIds = getSelectedNodeIds();
    var isSelectionMode = selectedIds.length > 0;
    var targetNodeIds = isSelectionMode ? selectedIds : getAllNodeIds();

    var totalHostRamMb = 0;
    var totalAllocatedRamMb = 0;
    var totalCpuCores = 0;
    var stoppedCount = 0;
    var targetNodesInfo = [];

    targetNodeIds.forEach(function (id) {
      var node = resolveNodeRecord(id);
      if (!node) return;
      var status = parseInt(node.status, 10);
      if (isNaN(status)) status = 0;

      // Status 2 is running in PNetLab
      if (status !== 2) {
        stoppedCount++;
        var fp = estimateNodeFootprint(node);
        totalHostRamMb += fp.hostRamMb;
        totalAllocatedRamMb += fp.configuredRamMb;
        totalCpuCores += fp.hostCpu;
        targetNodesInfo.push({
          name: node.name || ('Node ' + id),
          hostRam: fp.hostRamMb,
          cfgRam: fp.configuredRamMb,
          cpu: fp.hostCpu
        });
      }
    });

    var availMb = sysStats.mem_avail_mb || 0;
    var totalHostMb = sysStats.mem_total_mb || 7424;
    var currentUsedMb = sysStats.mem_used_mb || 0;
    if (currentUsedMb <= 0 && totalHostMb > 0) {
      currentUsedMb = availMb > 0 ? Math.max(0, totalHostMb - availMb) : Math.round((totalHostMb * sysStats.mem_pct) / 100);
    }

    var projectedUsedMb = currentUsedMb + totalHostRamMb;
    var currentMemPct = totalHostMb > 0 ? Math.round((currentUsedMb / totalHostMb) * 100) : sysStats.mem_pct;
    var projectedPct = totalHostMb > 0 ? Math.round((projectedUsedMb / totalHostMb) * 100) : currentMemPct;

    var severity = 'safe';
    if (projectedPct >= 90 || totalHostRamMb > availMb) {
      severity = 'danger';
    } else if (projectedPct >= 75) {
      severity = 'warning';
    }

    return {
      isSelectionMode: isSelectionMode,
      stoppedCount: stoppedCount,
      totalHostRamMb: totalHostRamMb,
      totalAllocatedRamMb: totalAllocatedRamMb,
      totalCpuCores: totalCpuCores,
      currentMemPct: currentMemPct,
      projectedPct: projectedPct,
      currentUsedMb: currentUsedMb,
      projectedUsedMb: projectedUsedMb,
      totalHostMb: totalHostMb,
      availMb: availMb,
      severity: severity,
      targetNodesInfo: targetNodesInfo
    };
  }

  function injectStyles() {
    if (document.getElementById('pnq-resource-hud-style')) return;
    var style = document.createElement('style');
    style.id = 'pnq-resource-hud-style';
    style.textContent = [
      '#pnq-resource-hud {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 10px;',
      '  padding: 4px 12px;',
      '  margin: 0 8px;',
      '  border-radius: 20px;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '  line-height: 1.4;',
      '  background: rgba(26, 32, 44, 0.88);',
      '  backdrop-filter: blur(8px);',
      '  -webkit-backdrop-filter: blur(8px);',
      '  border: 1px solid rgba(255, 255, 255, 0.12);',
      '  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);',
      '  color: #e2e8f0;',
      '  user-select: none;',
      '  transition: all 0.25s ease;',
      '}',
      '#pnq-resource-hud.mode-selection {',
      '  border-color: #3182ce;',
      '  background: rgba(20, 36, 60, 0.92);',
      '}',
      '#pnq-resource-hud.warning {',
      '  border-color: #d69e2e;',
      '  box-shadow: 0 4px 12px rgba(214, 158, 46, 0.2);',
      '}',
      '#pnq-resource-hud.danger {',
      '  border-color: #e53e3e;',
      '  box-shadow: 0 4px 12px rgba(229, 62, 62, 0.3);',
      '}',
      '.pnq-hud-badge {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  font-weight: 600;',
      '  padding: 2px 7px;',
      '  border-radius: 12px;',
      '  background: rgba(255, 255, 255, 0.08);',
      '  color: #f7fafc;',
      '}',
      '#pnq-resource-hud.mode-selection .pnq-hud-badge {',
      '  background: rgba(49, 130, 206, 0.3);',
      '  color: #63b3ed;',
      '}',
      '.pnq-hud-metric {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  color: #68d391;',
      '  font-weight: 600;',
      '}',
      '.pnq-hud-forecast {',
      '  font-size: 11px;',
      '  color: #cbd5e0;',
      '  font-variant-numeric: tabular-nums;',
      '}',
      '.pnq-hud-forecast b {',
      '  color: #f7fafc;',
      '}',
      '#pnq-resource-hud.warning .pnq-hud-forecast b {',
      '  color: #f6e05e;',
      '}',
      '#pnq-resource-hud.danger .pnq-hud-forecast b {',
      '  color: #fc8181;',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function renderHud(data) {
    var container = document.getElementById('pnq-buttons') || document.getElementById('pnetlab-quickbar');
    if (!hudElement) {
      hudElement = document.createElement('div');
      hudElement.id = 'pnq-resource-hud';
      if (container) {
        container.appendChild(hudElement);
      } else {
        document.body.appendChild(hudElement);
      }
    } else if (container && hudElement.parentElement !== container) {
      container.appendChild(hudElement);
    }

    hudElement.className = (data.isSelectionMode ? 'mode-selection ' : 'mode-global ') + data.severity;

    var badgeHtml = '';
    var metricHtml = '';
    var forecastHtml = '';

    if (data.stoppedCount === 0) {
      badgeHtml = '<span class="pnq-hud-badge" style="color:#68d391"><i class="fa fa-check-circle"></i> Toàn Lab: Đang chạy hết</span>';
      forecastHtml = '<span class="pnq-hud-forecast">RAM Host: <b>' + data.currentMemPct + '%</b> (' + formatBytes(data.currentUsedMb) + ' / ' + formatBytes(data.totalHostMb) + ')</span>';
    } else {
      if (data.isSelectionMode) {
        badgeHtml = '<span class="pnq-hud-badge"><i class="fa fa-mouse-pointer"></i> Đang chọn: ' + data.stoppedCount + ' node tắt</span>';
      } else {
        badgeHtml = '<span class="pnq-hud-badge"><i class="fa fa-cubes"></i> Toàn Lab: ' + data.stoppedCount + ' node tắt</span>';
      }

      var hostRamText = '+' + formatBytes(data.totalHostRamMb);
      metricHtml = '<span class="pnq-hud-metric"><i class="fa fa-bolt"></i> ' + hostRamText + ' • +' + data.totalCpuCores + ' vCPU</span>';

      var pctClass = data.projectedPct >= 90 ? ' style="color:#fc8181"' : (data.projectedPct >= 75 ? ' style="color:#f6e05e"' : '');
      forecastHtml = '<span class="pnq-hud-forecast">Dự kiến RAM: <b>' + data.currentMemPct + '%</b> ➔ <b' + pctClass + '>' + data.projectedPct + '%</b></span>';
    }

    hudElement.innerHTML = badgeHtml + metricHtml + forecastHtml;

    // Rich Tooltip
    var tooltipLines = [
      'DỰ ĐOÁN TIÊU TỐN TÀI NGUYÊN (SÁT THỰC TẾ)',
      '───────────────────────────────────────',
      data.isSelectionMode ? '• Phạm vi: Các node đang chọn' : '• Phạm vi: Toàn bộ bài lab',
      '• Số node cần bật: ' + data.stoppedCount + ' node',
      '• RAM thực tế máy chủ tiêu tốn: +' + formatBytes(data.totalHostRamMb),
      '• RAM máy ảo cấu hình (Virtual): +' + formatBytes(data.totalAllocatedRamMb),
      '• vCPU yêu cầu: +' + data.totalCpuCores + ' vCPU',
      '───────────────────────────────────────',
      '• RAM máy chủ hiện tại: ' + data.currentMemPct + '% (' + formatBytes(data.currentUsedMb) + ')',
      '• RAM máy chủ dự kiến sau khi bật: ' + data.projectedPct + '% (' + formatBytes(data.projectedUsedMb) + ' / ' + formatBytes(data.totalHostMb) + ')',
      '• RAM máy chủ còn trống: ' + formatBytes(data.availMb),
      '• Trạng thái: ' + (data.severity === 'danger' ? '⚠️ Nguy cơ thiếu RAM' : (data.severity === 'warning' ? '⚠️ Cảnh báo tải cao' : '✓ Hoàn toàn an toàn'))
    ];

    hudElement.title = tooltipLines.join('\n');
  }

  function recalculateAndRender() {
    lastEstimate = calculateResourceImpact();
    renderHud(lastEstimate);
  }

  function setupEventListeners() {
    // 1. Polling host resource usage every 3.5s
    setInterval(function () {
      fetchSysStats(recalculateAndRender);
    }, 3500);

    // 2. Immediate selection change tracking (Mouse, pointer, click)
    document.addEventListener('mouseup', function () {
      setTimeout(recalculateAndRender, 30);
    });
    document.addEventListener('pointerup', function () {
      setTimeout(recalculateAndRender, 30);
    });
    document.addEventListener('click', function () {
      setTimeout(recalculateAndRender, 30);
    });
    document.addEventListener('keyup', function (e) {
      if (e.key === 'Escape' || e.key === 'a' || e.ctrlKey || e.metaKey) {
        setTimeout(recalculateAndRender, 30);
      }
    });

    // 3. Topology canvas / store state observer
    var canvas = document.querySelector('.pnq-canvas-flow') || document.getElementById('topology-canvas');
    if (canvas && window.MutationObserver) {
      var obs = new MutationObserver(function () {
        recalculateAndRender();
      });
      obs.observe(canvas, { attributes: true, subtree: true, attributeFilter: ['class', 'data-selected'] });
    }
  }

  function init() {
    injectStyles();
    fetchSysStats(function () {
      recalculateAndRender();
      setupEventListeners();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.__pnqResourceEstimator = {
    recalculate: recalculateAndRender,
    getData: function () { return lastEstimate; }
  };
})();
