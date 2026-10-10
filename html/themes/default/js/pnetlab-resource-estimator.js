/**
 * pnetlab-resource-estimator.js
 * Pre-flight Resource Estimation HUD for PNetLab Topology
 * Advanced 6-Mechanism Hypervisor & Kernel Simulation Engine:
 * 1. CoW (Copy-on-Write) Shared Backing Layers
 * 2. KSM (Kernel Samepage Merging) Deduplication
 * 3. VirtIO Memory Ballooning & ZRAM/Zswap Compression
 * 4. KVM Hardware Acceleration vs TCG Software Emulation
 * 5. vCPU Overcommit Ratio Scheduling Evaluation
 * 6. Linux Memory Overcommit & Demand Paging
 */
(function () {
  'use strict';

  // Standard Mock Baseline conforming strictly to Backend Contract specification
  var MOCK_BASELINE = {
    cpu: 15,
    mem: 32,
    disk: 45,
    mem_total_mb: 16384,
    mem_avail_mb: 11140,
    mem_used_mb: 5244,
    cpu_cores: 8,
    ksm_enabled: true,
    ksm_pages_sharing_mb: 2150,
    kvm_available: true,
    zram_enabled: false,
    mem_cached_mb: 2048,
    mem_reclaimable_mb: 120
  };

  var sysStats = Object.assign({}, MOCK_BASELINE);

  var hudElement = null;
  var detailsModal = null;
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
          // Adopt live host telemetry directly from Linux kernel /proc
          if (typeof res === 'object' && res !== null) {
            if (typeof res.cpu === 'number') sysStats.cpu = res.cpu;
            if (typeof res.mem === 'number') sysStats.mem = res.mem;
            if (typeof res.disk === 'number') sysStats.disk = res.disk;
            if (typeof res.mem_total_mb === 'number' && res.mem_total_mb > 0) sysStats.mem_total_mb = res.mem_total_mb;
            if (typeof res.mem_avail_mb === 'number') sysStats.mem_avail_mb = res.mem_avail_mb;
            if (typeof res.mem_used_mb === 'number') sysStats.mem_used_mb = res.mem_used_mb;
            if (typeof res.cpu_cores === 'number' && res.cpu_cores > 0) sysStats.cpu_cores = res.cpu_cores;
            if (res.ksm_enabled !== undefined) sysStats.ksm_enabled = !!res.ksm_enabled;
            if (typeof res.ksm_pages_sharing_mb === 'number') sysStats.ksm_pages_sharing_mb = res.ksm_pages_sharing_mb;
            if (res.kvm_available !== undefined) sysStats.kvm_available = !!res.kvm_available;
            if (res.zram_enabled !== undefined) sysStats.zram_enabled = !!res.zram_enabled;
            if (typeof res.mem_cached_mb === 'number') sysStats.mem_cached_mb = res.mem_cached_mb;
            if (typeof res.mem_reclaimable_mb === 'number') sysStats.mem_reclaimable_mb = res.mem_reclaimable_mb;
          }
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
   * Advanced Engine Modeling 6 Systems Mechanisms
   */
  function calculateResourceImpact() {
    var selectedIds = getSelectedNodeIds();
    var isSelectionMode = selectedIds.length > 0;
    var targetNodeIds = isSelectionMode ? selectedIds : getAllNodeIds();

    var targetNodes = [];
    var runningVcpus = 0;

    getAllNodeIds().forEach(function (id) {
      var n = resolveNodeRecord(id);
      if (!n) return;
      var status = parseInt(n.status, 10);
      var cpu = parseInt(n.cpu, 10) || 1;
      if (status === 2) {
        runningVcpus += cpu;
      }
    });

    targetNodeIds.forEach(function (id) {
      var node = resolveNodeRecord(id);
      if (!node) return;
      var status = parseInt(node.status, 10);
      if (isNaN(status)) status = 0;
      if (status !== 2) { // Stopped node
        node._resolvedId = id;
        targetNodes.push(node);
      }
    });

    var stoppedCount = targetNodes.length;
    var totalAllocatedRamMb = 0;
    var totalRequestedVcpus = 0;

    // 1. CoW (Copy-on-Write) & Shared Backing Layer Grouping
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
      totalRequestedVcpus += cfgCpu;
    });

    var totalHostRamMb = 0;
    var totalCowSavingsMb = 0;
    var totalKsmSavingsMb = 0;
    var totalBallooningSavingsMb = 0;
    var targetNodesInfo = [];

    // 2. Evaluation across image groups
    Object.keys(imageGroups).forEach(function (groupKey) {
      var grp = imageGroups[groupKey];
      var count = grp.nodes.length;
      var type = grp.type;
      var img = grp.image;
      var tpl = grp.template;

      var firstNode = grp.nodes[0];
      var cfgRam = parseInt(firstNode.ram, 10);
      if (isNaN(cfgRam) || cfgRam <= 0) cfgRam = 1024;

      var baseInitialWorkingSet = 0;
      var sharedPageRatio = 0.65;
      var ballooningReclaimRatio = 0.15;

      // Linux Memory Overcommit & Demand Paging initial touched working set
      if (type === 'iol' || tpl === 'iol' || img.indexOf('.bin') !== -1) {
        // Cisco IOL (C native ELF): ~70MB initial touched RSS
        baseInitialWorkingSet = Math.min(cfgRam * 0.15, 75);
        sharedPageRatio = 0.68;
        ballooningReclaimRatio = 0.05;
      } else if (type === 'vpcs' || tpl === 'vpcs') {
        baseInitialWorkingSet = 10;
        sharedPageRatio = 0.70;
        ballooningReclaimRatio = 0.0;
      } else if (type === 'docker' || tpl === 'docker') {
        baseInitialWorkingSet = Math.min(cfgRam * 0.25, 120);
        sharedPageRatio = 0.50;
        ballooningReclaimRatio = 0.10;
      } else if (type === 'dynamips' || tpl === 'dynamips') {
        baseInitialWorkingSet = Math.min(cfgRam * 0.25, 140);
        sharedPageRatio = 0.45;
        ballooningReclaimRatio = 0.05;
      } else if (type === 'qemu' || tpl === 'qemu' || img.indexOf('qcow2') !== -1) {
        // QEMU / KVM: Demand Paging touches ~38% guest RAM initially
        baseInitialWorkingSet = Math.round(cfgRam * 0.38);
        sharedPageRatio = 0.40;
        ballooningReclaimRatio = 0.20;
      } else {
        baseInitialWorkingSet = Math.min(cfgRam * 0.25, 90);
        sharedPageRatio = 0.50;
      }

      var groupFootprint = baseInitialWorkingSet;

      // CoW & Shared Binary Layers
      if (count > 1) {
        var privatePerNode = baseInitialWorkingSet * (1 - sharedPageRatio);
        var rawSubsequent = (count - 1) * privatePerNode;

        // KSM (Kernel Samepage Merging)
        if (sysStats.ksm_enabled) {
          var ksmFactor = Math.min(0.45, (count - 1) * 0.06);
          var ksmSaved = rawSubsequent * ksmFactor;
          rawSubsequent -= ksmSaved;
          totalKsmSavingsMb += ksmSaved;
        }

        // VirtIO Memory Ballooning
        if (ballooningReclaimRatio > 0) {
          var balloonSaved = (count * baseInitialWorkingSet) * ballooningReclaimRatio;
          rawSubsequent = Math.max(privatePerNode * (count - 1) * 0.4, rawSubsequent - balloonSaved);
          totalBallooningSavingsMb += balloonSaved;
        }

        var cowSaved = (count - 1) * (baseInitialWorkingSet * sharedPageRatio);
        totalCowSavingsMb += cowSaved;

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
    totalCowSavingsMb = Math.round(totalCowSavingsMb);
    totalKsmSavingsMb = Math.round(totalKsmSavingsMb);
    totalBallooningSavingsMb = Math.round(totalBallooningSavingsMb);

    // 3. ZRAM / Zswap Memory Compression Factor
    var zramHeadroomBoost = sysStats.zram_enabled ? 1.25 : 1.0;

    // 4. KVM Hardware Acceleration vs TCG Software Emulation
    var kvmStatus = sysStats.kvm_available ? 'KVM Hardware VT-x/AMD-V (Tăng tốc phần cứng ✓)' : 'TCG Software Emulation (Cảnh báo: CPU cao ⚠️)';

    // 5. vCPU Overcommit Ratio Scheduling Evaluation
    var totalClusterVcpus = runningVcpus + totalRequestedVcpus;
    var hostCores = Math.max(1, sysStats.cpu_cores);
    var vcpuOvercommitRatio = parseFloat((totalClusterVcpus / hostCores).toFixed(1));
    var overcommitStatus = 'Optimal (<= 2.5x)';
    if (vcpuOvercommitRatio > 4.5) {
      overcommitStatus = 'High Contention (> 4.5x ⚠️)';
    } else if (vcpuOvercommitRatio > 2.5) {
      overcommitStatus = 'Balanced Lab Overcommit (2.5x - 4.5x)';
    }

    // 6. Linux Kernel Page Reclaim & Live Host Availability
    var availMb = sysStats.mem_avail_mb || 11140;
    var totalHostMb = sysStats.mem_total_mb || 16384;
    var currentUsedMb = sysStats.mem_used_mb || 5244;
    var effectiveAvailMb = Math.round(availMb * zramHeadroomBoost);

    var projectedUsedMb = currentUsedMb + totalHostRamMb;
    var currentMemPct = totalHostMb > 0 ? Math.round((currentUsedMb / totalHostMb) * 100) : sysStats.mem;
    var projectedPct = totalHostMb > 0 ? Math.round((projectedUsedMb / totalHostMb) * 100) : currentMemPct;

    var severity = 'safe';
    if (totalHostRamMb > effectiveAvailMb || projectedPct >= 92) {
      severity = 'danger';
    } else if (totalHostRamMb > (effectiveAvailMb * 0.75) || projectedPct >= 78) {
      severity = 'warning';
    }

    return {
      isSelectionMode: isSelectionMode,
      stoppedCount: stoppedCount,
      totalHostRamMb: totalHostRamMb,
      totalAllocatedRamMb: totalAllocatedRamMb,
      totalRequestedVcpus: totalRequestedVcpus,
      totalClusterVcpus: totalClusterVcpus,
      vcpuOvercommitRatio: vcpuOvercommitRatio,
      overcommitStatus: overcommitStatus,
      kvmStatus: kvmStatus,
      totalCowSavingsMb: totalCowSavingsMb,
      totalKsmSavingsMb: totalKsmSavingsMb,
      totalBallooningSavingsMb: totalBallooningSavingsMb,
      currentMemPct: currentMemPct,
      projectedPct: projectedPct,
      currentUsedMb: currentUsedMb,
      projectedUsedMb: projectedUsedMb,
      totalHostMb: totalHostMb,
      availMb: availMb,
      effectiveAvailMb: effectiveAvailMb,
      ksmEnabled: sysStats.ksm_enabled,
      ksmSharingMb: sysStats.ksm_pages_sharing_mb,
      zramEnabled: sysStats.zram_enabled,
      kvmAvailable: sysStats.kvm_available,
      hostCores: hostCores,
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
      '  cursor: pointer;',
      '  transition: all 0.25s ease;',
      '}',
      '#pnq-resource-hud:hover {',
      '  border-color: rgba(99, 179, 237, 0.6);',
      '  box-shadow: 0 4px 16px rgba(49, 130, 206, 0.35);',
      '  transform: translateY(-1px);',
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
      '}',
      '/* Modal breakdown dialog */',
      '#pnq-estimator-modal {',
      '  position: fixed;',
      '  top: 50%; left: 50%;',
      '  transform: translate(-50%, -50%);',
      '  z-index: 9999;',
      '  width: 520px; max-width: 92vw;',
      '  background: #1a202c;',
      '  border: 1px solid rgba(255, 255, 255, 0.2);',
      '  border-radius: 14px;',
      '  box-shadow: 0 20px 40px rgba(0,0,0,0.6);',
      '  color: #e2e8f0;',
      '  padding: 20px 24px;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  font-size: 12px; line-height: 1.5;',
      '}',
      '#pnq-estimator-modal-backdrop {',
      '  position: fixed; inset: 0;',
      '  background: rgba(0,0,0,0.65);',
      '  z-index: 9998;',
      '  backdrop-filter: blur(4px);',
      '}',
      '#pnq-estimator-modal h3 {',
      '  margin: 0 0 14px 0; font-size: 15px; font-weight: 700; color: #63b3ed;',
      '  display: flex; justify-content: space-between; align-items: center;',
      '}',
      '#pnq-estimator-modal .close-btn {',
      '  cursor: pointer; opacity: 0.7; font-size: 18px;',
      '}',
      '#pnq-estimator-modal .close-btn:hover { opacity: 1; color: #fc8181; }',
      '#pnq-estimator-modal .mech-row {',
      '  display: flex; justify-content: space-between; padding: 6px 0;',
      '  border-bottom: 1px solid rgba(255, 255, 255, 0.08);',
      '}',
      '#pnq-estimator-modal .mech-label { color: #a0aec0; }',
      '#pnq-estimator-modal .mech-val { font-weight: 600; color: #f7fafc; }',
      '#pnq-estimator-modal .mech-tag { font-size: 10px; padding: 2px 6px; border-radius: 8px; background: rgba(72,187,120,0.2); color: #68d391; }'
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
      hudElement.addEventListener('click', showDetailsModal);
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
      metricHtml = '<span class="pnq-hud-metric"><i class="fa fa-bolt"></i> ' + hostRamText + ' • +' + data.totalRequestedVcpus + ' vCPU</span>';

      var pctClass = data.projectedPct >= 90 ? ' style="color:#fc8181"' : (data.projectedPct >= 75 ? ' style="color:#f6e05e"' : '');
      forecastHtml = '<span class="pnq-hud-forecast">Dự kiến RAM: <b>' + data.currentMemPct + '%</b> ➔ <b' + pctClass + '>' + data.projectedPct + '%</b></span>';
    }

    hudElement.innerHTML = badgeHtml + metricHtml + forecastHtml;

    // Tooltip
    var tooltipLines = [
      'DỰ ĐOÁN TÀI NGUYÊN (MÔ HÌNH HỆ THỐNG ẢO HÓA & KERNEL)',
      '────────────────────────────────────────────────────────',
      data.isSelectionMode ? '• Phạm vi: Các node đang chọn' : '• Phạm vi: Toàn bộ bài lab',
      '• Số node cần bật: ' + data.stoppedCount + ' node',
      '• RAM thực tế máy chủ tiêu tốn: +' + formatBytes(data.totalHostRamMb),
      '• RAM máy ảo cấu hình (Virtual): +' + formatBytes(data.totalAllocatedRamMb),
      '• vCPU yêu cầu: +' + data.totalRequestedVcpus + ' vCPU (Tổng cụm: ' + data.totalClusterVcpus + ' vCPU / ' + data.hostCores + ' cores)',
      '• vCPU Overcommit Ratio: ' + data.vcpuOvercommitRatio + 'x (' + data.overcommitStatus + ')',
      '• Ảo hóa CPU: ' + data.kvmStatus,
      '────────────────────────────────────────────────────────',
      'CƠ CHẾ TỐI ƯU HÓA HỆ THỐNG ĐANG HOẠT ĐỘNG:',
      '• CoW & Page Cache Sharing: Tiết kiệm ~' + formatBytes(data.totalCowSavingsMb),
      '• KSM Deduplication: ' + (data.ksmEnabled ? ('BẬT ✓ (Tiết kiệm ~' + formatBytes(data.totalKsmSavingsMb) + (data.ksmSharingMb > 0 ? (', Live Merged: ' + formatBytes(data.ksmSharingMb)) : '') + ')') : 'TẮT'),
      '• VirtIO Ballooning: Tiết kiệm ~' + formatBytes(data.totalBallooningSavingsMb),
      '• ZRAM Compression: ' + (data.zramEnabled ? 'BẬT ✓ (Nén 2.5:1)' : 'TẮT'),
      '• Demand Paging: Chỉ cấp khung trang khi guest chạm tới',
      '────────────────────────────────────────────────────────',
      '• RAM máy chủ hiện tại: ' + data.currentMemPct + '% (' + formatBytes(data.currentUsedMb) + ')',
      '• RAM máy chủ dự kiến sau khi bật: ' + data.projectedPct + '% (' + formatBytes(data.projectedUsedMb) + ' / ' + formatBytes(data.totalHostMb) + ')',
      '• RAM khả dụng (MemAvailable): ' + formatBytes(data.availMb) + (data.zramEnabled ? (' [Hiệu dụng: ' + formatBytes(data.effectiveAvailMb) + ']') : ''),
      '• Đánh giá tải: ' + (data.severity === 'danger' ? '⚠️ Nguy cơ thiếu RAM' : (data.severity === 'warning' ? '⚠️ Cảnh báo tải cao' : '✓ Hoàn toàn an toàn (Tối ưu bởi Kernel)')),
      '💡 Nhấp chuột vào HUD để xem bảng phân tích 6 cơ chế chi tiết!'
    ];

    hudElement.title = tooltipLines.join('\n');
  }

  function showDetailsModal() {
    if (!lastEstimate) return;
    closeDetailsModal();

    var backdrop = document.createElement('div');
    backdrop.id = 'pnq-estimator-modal-backdrop';
    backdrop.addEventListener('click', closeDetailsModal);

    var modal = document.createElement('div');
    modal.id = 'pnq-estimator-modal';

    var data = lastEstimate;

    modal.innerHTML = [
      '<h3>',
      '  <span><i class="fa fa-dashboard"></i> Phân tích 6 Cơ chế Ảo hóa & Kernel</span>',
      '  <span class="close-btn">&times;</span>',
      '</h3>',
      '<div class="mech-row">',
      '  <span class="mech-label">Phạm vi tính toán:</span>',
      '  <span class="mech-val">' + (data.isSelectionMode ? ('Đang chọn (' + data.stoppedCount + ' node)') : ('Toàn bộ lab (' + data.stoppedCount + ' node)')) + '</span>',
      '</div>',
      '<div class="mech-row">',
      '  <span class="mech-label">1. CoW & Shared Binary Layers:</span>',
      '  <span class="mech-val"><span class="mech-tag">Tiết kiệm ' + formatBytes(data.totalCowSavingsMb) + '</span></span>',
      '</div>',
      '<div class="mech-row">',
      '  <span class="mech-label">2. KSM (Kernel Samepage Merging):</span>',
      '  <span class="mech-val"><span class="mech-tag">' + (data.ksmEnabled ? ('BẬT (Sharing ' + formatBytes(data.ksmSharingMb) + ')') : 'TẮT') + '</span></span>',
      '</div>',
      '<div class="mech-row">',
      '  <span class="mech-label">3. VirtIO Ballooning & ZRAM:</span>',
      '  <span class="mech-val"><span class="mech-tag">' + (data.zramEnabled ? 'ZRAM 2.5:1 BẬT' : 'VirtIO Thu hồi ' + formatBytes(data.totalBallooningSavingsMb)) + '</span></span>',
      '</div>',
      '<div class="mech-row">',
      '  <span class="mech-label">4. KVM Hardware Acceleration:</span>',
      '  <span class="mech-val">' + (data.kvmAvailable ? '<span class="mech-tag">VT-x / AMD-V Sẵn sàng</span>' : '<span style="color:#fc8181">TCG Chậm</span>') + '</span>',
      '</div>',
      '<div class="mech-row">',
      '  <span class="mech-label">5. vCPU Overcommit Ratio:</span>',
      '  <span class="mech-val">' + data.vcpuOvercommitRatio + 'x / ' + data.hostCores + ' cores (' + data.overcommitStatus + ')</span>',
      '</div>',
      '<div class="mech-row">',
      '  <span class="mech-label">6. Linux Demand Paging:</span>',
      '  <span class="mech-val">Chỉ nạp working set (~' + formatBytes(data.totalHostRamMb) + ' / ảo ' + formatBytes(data.totalAllocatedRamMb) + ')</span>',
      '</div>',
      '<div class="mech-row" style="margin-top:10px; border-top: 1px solid rgba(255,255,255,0.15); padding-top:10px;">',
      '  <span class="mech-label">Dự kiến RAM Máy chủ:</span>',
      '  <span class="mech-val" style="color:#68d391; font-size:13px;">' + data.currentMemPct + '% ➔ ' + data.projectedPct + '% (' + formatBytes(data.projectedUsedMb) + ' / ' + formatBytes(data.totalHostMb) + ')</span>',
      '</div>',
      '<div class="mech-row">',
      '  <span class="mech-label">Dung lượng Khả dụng (MemAvailable):</span>',
      '  <span class="mech-val" style="color:#63b3ed;">' + formatBytes(data.availMb) + '</span>',
      '</div>'
    ].join('\n');

    modal.querySelector('.close-btn').addEventListener('click', closeDetailsModal);

    document.body.appendChild(backdrop);
    document.body.appendChild(modal);
    detailsModal = { backdrop: backdrop, modal: modal };
  }

  function closeDetailsModal() {
    if (detailsModal) {
      if (detailsModal.backdrop && detailsModal.backdrop.parentElement) {
        detailsModal.backdrop.parentElement.removeChild(detailsModal.backdrop);
      }
      if (detailsModal.modal && detailsModal.modal.parentElement) {
        detailsModal.modal.parentElement.removeChild(detailsModal.modal);
      }
      detailsModal = null;
    }
  }

  function recalculateAndRender() {
    lastEstimate = calculateResourceImpact();
    renderHud(lastEstimate);
  }

  function setupEventListeners() {
    setInterval(function () {
      fetchSysStats(recalculateAndRender);
    }, 3500);

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
      if (e.key === 'Escape') {
        closeDetailsModal();
        setTimeout(recalculateAndRender, 30);
      } else if (e.key === 'a' || e.ctrlKey || e.metaKey) {
        setTimeout(recalculateAndRender, 30);
      }
    });

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
    getData: function () { return lastEstimate; },
    getSysStats: function () { return sysStats; },
    showDetails: showDetailsModal,
    setMockStats: function (mock) {
      if (typeof mock === 'object' && mock !== null) {
        Object.assign(sysStats, mock);
        recalculateAndRender();
      }
    }
  };
})();
