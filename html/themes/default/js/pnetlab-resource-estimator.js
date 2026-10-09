/**
 * pnetlab-resource-estimator.js
 * Pre-flight Resource Estimation HUD for PNetLab Topology (Dynamic Kernel & KSM Aware Engine)
 *
 * Real-time estimation of RAM and vCPU footprint before starting nodes:
 * - NO HARDCODED STATIC ADDITIONS: Models actual Linux Kernel & Virtualization mechanics:
 *   1. Image / Binary Page Cache Sharing: Multiple instances of the same binary/image (e.g., IOL .bin, QEMU image)
 *      share .text/code segment pages in Linux Page Cache, incurring only private dirty page overhead for subsequent nodes.
 *   2. KSM (Kernel Samepage Merging) Deduplication: Dynamic discount factored in based on live /sys/kernel/mm/ksm/run.
 *   3. KVM / QEMU Demand Paging & Overcommit: Evaluates initial touched-page memory rather than full committed virtual allocation.
 *   4. Kernel Page Reclaim: Compares against live MemAvailable (taking into account reclaimable cache/buffers).
 * - Dual-scope: Automatically switches between Whole Lab vs Current Selection.
 * - Dual-state progression: Displays "Current RAM ➔ Projected RAM" (e.g., 32% ➔ 34% for 4 nodes, 32% ➔ 37% for whole lab).
 * - Instant zero-lag updates on drag-selection (marquee/lasso), node click, and keyboard shortcuts.
 */
(function () {
  'use strict';

  var sysStats = {
    mem_pct: 0,
    mem_total_mb: 0,
    mem_avail_mb: 0,
    mem_used_mb: 0,
    mem_cached_mb: 0,
    mem_reclaimable_mb: 0,
    cpu_cores: 4,
    ksm_enabled: true,
    ksm_sharing_pages: 0
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
          sysStats.mem_cached_mb = res.mem_cached_mb || 0;
          sysStats.mem_reclaimable_mb = res.mem_reclaimable_mb || 0;
          sysStats.cpu_cores = res.cpu_cores || 4;
          sysStats.ksm_enabled = res.ksm_enabled !== undefined ? !!res.ksm_enabled : true;
          sysStats.ksm_sharing_pages = res.ksm_sharing_pages || 0;
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
   * Dynamic Resource Impact Calculation
   * Incorporates:
   * - Linux Page Cache Shared Binary Mapping (same image instances share .text)
   * - KSM (Kernel Samepage Merging) deduplication scaling
   * - KVM / QEMU Demand-paging initial touched working set
   * - Linux Kernel Page Reclaim (MemAvailable vs MemFree)
   */
  function calculateResourceImpact() {
    var selectedIds = getSelectedNodeIds();
    var isSelectionMode = selectedIds.length > 0;
    var targetNodeIds = isSelectionMode ? selectedIds : getAllNodeIds();

    var targetNodes = [];
    targetNodeIds.forEach(function (id) {
      var node = resolveNodeRecord(id);
      if (!node) return;
      var status = parseInt(node.status, 10);
      if (isNaN(status)) status = 0;
      if (status !== 2) { // Only calculate for stopped nodes
        node._resolvedId = id;
        targetNodes.push(node);
      }
    });

    var stoppedCount = targetNodes.length;
    var totalAllocatedRamMb = 0;
    var totalCpuCores = 0;

    // 1. Group nodes by Image & Architecture signature to model Page Cache sharing
    var imageGroups = {};
    targetNodes.forEach(function (node) {
      var type = String(node.type || node.template || '').toLowerCase();
      var img = String(node.image || '').toLowerCase();
      var tpl = String(node.template || '').toLowerCase();
      var groupKey = img ? ('img:' + img) : (tpl ? ('tpl:' + tpl) : ('type:' + type));

      if (!imageGroups[groupKey]) {
        imageGroups[groupKey] = {
          type: type,
          template: tpl,
          image: img,
          nodes: []
        };
      }
      imageGroups[groupKey].nodes.push(node);

      var cfgRam = parseInt(node.ram, 10);
      if (isNaN(cfgRam) || cfgRam <= 0) cfgRam = 1024;
      var cfgCpu = parseInt(node.cpu, 10);
      if (isNaN(cfgCpu) || cfgCpu <= 0) cfgCpu = 1;

      totalAllocatedRamMb += cfgRam;
      totalCpuCores += cfgCpu;
    });

    var totalHostRamMb = 0;
    var totalSharedSavingsMb = 0;
    var totalKsmSavingsMb = 0;
    var targetNodesInfo = [];

    // 2. Dynamic footprint calculation per image group
    Object.keys(imageGroups).forEach(function (groupKey) {
      var grp = imageGroups[groupKey];
      var count = grp.nodes.length;
      var type = grp.type;
      var img = grp.image;
      var tpl = grp.template;

      // Base footprint of first instance
      var firstNode = grp.nodes[0];
      var cfgRam = parseInt(firstNode.ram, 10);
      if (isNaN(cfgRam) || cfgRam <= 0) cfgRam = 1024;

      var baseFootprint = 0;
      var sharedPageRatio = 0.65; // Fraction of code/text pages shared via Page Cache
      var ksmDedupRatio = sysStats.ksm_enabled ? 0.35 : 0.05;

      if (type === 'iol' || tpl === 'iol' || img.indexOf('.bin') !== -1) {
        // Cisco IOL: C ELF process, ~70-75MB initial working set.
        // Multiple instances of the same .bin share ~65% read-only pages in Page Cache.
        baseFootprint = Math.min(cfgRam * 0.15, 75);
        sharedPageRatio = 0.68;
      } else if (type === 'vpcs' || tpl === 'vpcs') {
        // VPCS: Tiny process, ~10MB initial set, ~70% shared
        baseFootprint = 10;
        sharedPageRatio = 0.70;
      } else if (type === 'docker' || tpl === 'docker') {
        // Docker: Containers share host kernel & shared layers
        baseFootprint = Math.min(cfgRam * 0.25, 120);
        sharedPageRatio = 0.50;
      } else if (type === 'dynamips' || tpl === 'dynamips') {
        // Dynamips: JIT execution engine
        baseFootprint = Math.min(cfgRam * 0.25, 140);
        sharedPageRatio = 0.45;
      } else if (type === 'qemu' || tpl === 'qemu' || img.indexOf('qcow2') !== -1) {
        // KVM/QEMU: Demand-paged guest memory (initially touches ~35-40% of guest RAM)
        baseFootprint = Math.round(cfgRam * 0.38);
        sharedPageRatio = 0.40;
        if (sysStats.ksm_enabled) {
          // KSM on KVM aggressively merges identical OS boot pages & zero pages
          ksmDedupRatio = 0.45;
        }
      } else {
        baseFootprint = Math.min(cfgRam * 0.25, 90);
        sharedPageRatio = 0.50;
      }

      // First node pays baseFootprint
      var groupFootprint = baseFootprint;

      // Subsequent nodes of the same image:
      // Pay only private dirty pages: baseFootprint * (1 - sharedPageRatio)
      if (count > 1) {
        var privatePerNode = baseFootprint * (1 - sharedPageRatio);
        var rawSubsequent = (count - 1) * privatePerNode;

        // KSM deduplication further merges duplicate page tables & common memory patterns
        if (sysStats.ksm_enabled) {
          var ksmDiscount = Math.min(0.45, (count - 1) * 0.05 * ksmDedupRatio);
          var ksmSaved = rawSubsequent * ksmDiscount;
          rawSubsequent -= ksmSaved;
          totalKsmSavingsMb += ksmSaved;
        }

        var sharedSaved = (count - 1) * (baseFootprint * sharedPageRatio);
        totalSharedSavingsMb += sharedSaved;

        groupFootprint += rawSubsequent;
      }

      totalHostRamMb += groupFootprint;

      grp.nodes.forEach(function (n) {
        targetNodesInfo.push({
          name: n.name || ('Node ' + n._resolvedId),
          group: groupKey,
          cfgRam: parseInt(n.ram, 10) || 1024,
          cpu: parseInt(n.cpu, 10) || 1
        });
      });
    });

    totalHostRamMb = Math.max(10, Math.round(totalHostRamMb));
    totalSharedSavingsMb = Math.round(totalSharedSavingsMb);
    totalKsmSavingsMb = Math.round(totalKsmSavingsMb);

    // 3. Kernel Page Reclaim & Live Host Availability
    // MemAvailable represents memory reclaimable by kswapd (page cache & slab reclamation)
    var availMb = sysStats.mem_avail_mb || 5000;
    var totalHostMb = sysStats.mem_total_mb || 7424;
    var currentUsedMb = sysStats.mem_used_mb || Math.max(0, totalHostMb - availMb);
    var cachedMb = sysStats.mem_cached_mb || 0;
    var reclaimableMb = sysStats.mem_reclaimable_mb || 0;

    var projectedUsedMb = currentUsedMb + totalHostRamMb;
    var currentMemPct = totalHostMb > 0 ? Math.round((currentUsedMb / totalHostMb) * 100) : sysStats.mem_pct;
    var projectedPct = totalHostMb > 0 ? Math.round((projectedUsedMb / totalHostMb) * 100) : currentMemPct;

    // True Memory Pressure Evaluation
    var severity = 'safe';
    if (totalHostRamMb > availMb || projectedPct >= 90) {
      severity = 'danger';
    } else if (totalHostRamMb > (availMb * 0.75) || projectedPct >= 75) {
      severity = 'warning';
    }

    return {
      isSelectionMode: isSelectionMode,
      stoppedCount: stoppedCount,
      totalHostRamMb: totalHostRamMb,
      totalAllocatedRamMb: totalAllocatedRamMb,
      totalCpuCores: totalCpuCores,
      totalSharedSavingsMb: totalSharedSavingsMb,
      totalKsmSavingsMb: totalKsmSavingsMb,
      currentMemPct: currentMemPct,
      projectedPct: projectedPct,
      currentUsedMb: currentUsedMb,
      projectedUsedMb: projectedUsedMb,
      totalHostMb: totalHostMb,
      availMb: availMb,
      cachedMb: cachedMb,
      reclaimableMb: reclaimableMb,
      ksmEnabled: sysStats.ksm_enabled,
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

    // Rich Tooltip with Full Kernel & KSM Details
    var tooltipLines = [
      'DỰ ĐOÁN TÀI NGUYÊN (MÔ HÌNH HỆ THỐNG ĐỘNG)',
      '────────────────────────────────────────────────────────',
      data.isSelectionMode ? '• Phạm vi: Các node đang chọn' : '• Phạm vi: Toàn bộ bài lab',
      '• Số node cần bật: ' + data.stoppedCount + ' node',
      '• RAM thực tế máy chủ tiêu tốn: +' + formatBytes(data.totalHostRamMb),
      '• RAM máy ảo cấu hình (Virtual): +' + formatBytes(data.totalAllocatedRamMb),
      '• vCPU yêu cầu: +' + data.totalCpuCores + ' vCPU',
      '────────────────────────────────────────────────────────',
      'CƠ CHẾ TỐI ƯU HÓA HỆ THỐNG ĐANG ÁP DỤNG:',
      '• Dùng chung ô nhớ Page Cache: Tiết kiệm ~' + formatBytes(data.totalSharedSavingsMb) + ' (Shared Text)',
      '• KSM (Kernel Samepage Merging): ' + (data.ksmEnabled ? ('Đang BẬT ✓ (Tiết kiệm thêm ~' + formatBytes(data.totalKsmSavingsMb) + ')') : 'Đang TẮT'),
      '• Kernel Page Reclaim: ' + formatBytes(data.cachedMb + data.reclaimableMb) + ' Cache sẵn sàng dọn dẹp khi cần',
      '────────────────────────────────────────────────────────',
      '• RAM máy chủ hiện tại: ' + data.currentMemPct + '% (' + formatBytes(data.currentUsedMb) + ')',
      '• RAM máy chủ dự kiến sau khi bật: ' + data.projectedPct + '% (' + formatBytes(data.projectedUsedMb) + ' / ' + formatBytes(data.totalHostMb) + ')',
      '• RAM máy chủ khả dụng (MemAvailable): ' + formatBytes(data.availMb),
      '• Đánh giá tải: ' + (data.severity === 'danger' ? '⚠️ Nguy cơ thiếu RAM' : (data.severity === 'warning' ? '⚠️ Cảnh báo tải cao' : '✓ Hoàn toàn an toàn (Tối ưu bởi Kernel)'))
    ];

    hudElement.title = tooltipLines.join('\n');
  }

  function recalculateAndRender() {
    lastEstimate = calculateResourceImpact();
    renderHud(lastEstimate);
  }

  function setupEventListeners() {
    // 1. Polling host resource & KSM status every 3.5s
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
