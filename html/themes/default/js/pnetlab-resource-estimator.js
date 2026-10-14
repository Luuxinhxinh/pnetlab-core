/**
 * pnetlab-resource-estimator.js
 * Pre-flight Resource Estimation & Smart Node Optimizer for PNetLab Topology
 * Advanced 6-Mechanism Hypervisor & Kernel Simulation Engine:
 * 1. CoW (Copy-on-Write) Shared Backing Layers
 * 2. KSM (Kernel Samepage Merging) Deduplication
 * 3. VirtIO Memory Ballooning & ZRAM/Zswap Compression
 * 4. KVM Hardware Acceleration vs TCG Software Emulation
 * 5. vCPU Overcommit Ratio Scheduling Evaluation
 * 6. Linux Memory Overcommit & Demand Paging
 * 
 * + SMART NODE OPTIMIZER & FUNCTIONAL EQUIVALENCE ENGINE:
 * Tra cứu bảng ánh xạ tương đương chức năng (CSR1000v -> IOL L3, Cat9kv -> IOL L2,
 * Windows -> VPCS/Docker, ...) & tính toán mức tiết kiệm RAM/vCPU, cung cấp giao diện
 * đề xuất thay thế thông minh kèm thao tác 1-Click tối ưu.
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
  var activeModalTab = 'mechanisms'; // 'mechanisms' or 'recommendations'

  // Bảng ánh xạ tương đương chức năng (Functional Equivalence Matrix)
  var ALTERNATIVE_MATRIX = [
    {
      id: 'cisco_l3',
      category: 'Cisco L3 Routing',
      roleIcon: 'fa-random',
      description: 'Định tuyến Core/Edge: BGP, OSPF, EIGRP, MPLS, VRF, NAT',
      matches: function (node) {
        var t = String(node.template || node.type || '').toLowerCase();
        var img = String(node.image || '').toLowerCase();
        if (t === 'iol' || t === 'vios') return false;
        return (
          t === 'csr1000v' || t === 'csr1000vng' || t === 'csr8000v' ||
          t === 'catalyst8000v' || t === 'c8000v' || t === 'c8000vcm' ||
          t === 'catc8k' || t === 'isrv' ||
          img.indexOf('csr1000v') !== -1 || img.indexOf('c8000v') !== -1 || img.indexOf('isrv') !== -1
        );
      },
      suggested: {
        name: 'Cisco IOL L3 (IOU AdvEnterprise)',
        template: 'iol',
        type: 'iol',
        image: 'L3-ADVENTERPRISEK9-M-15.4-2T.bin',
        icon: 'Router.png',
        estRamMb: 75,
        estCpu: 1,
        defaultRam: 1024,
        savingsText: 'Tiết kiệm ~98% RAM (chỉ tốn ~75 MB thay vì ~4 GB)',
        features: ['BGP Full', 'OSPFv2/v3', 'EIGRP', 'MPLS / L3VPN', 'VRF-Lite', 'NAT', 'ACL'],
        createPayload: { template: 'iol', type: 'iol', ram: 1024, nvram: 1024, ethernet: 4, serial: 0 }
      },
      alternative: {
        name: 'vIOS-L3',
        template: 'vios',
        estRamMb: 512,
        estCpu: 1
      }
    },
    {
      id: 'cisco_l2',
      category: 'Cisco L2/L3 Switching',
      roleIcon: 'fa-sitemap',
      description: 'Chuyển mạch: VLAN, 802.1Q Trunking, STP/RSTP, EtherChannel, SVI',
      matches: function (node) {
        var t = String(node.template || node.type || '').toLowerCase();
        var img = String(node.image || '').toLowerCase();
        if (t === 'iol' || t === 'viosl2') return false;
        return (
          t === 'cat9kv' || t === 'cat9kvq200' || t === 'cat9kvuadp' ||
          t === 'nxosv9k' || t === 'titanium' ||
          img.indexOf('cat9k') !== -1 || img.indexOf('nxosv') !== -1
        );
      },
      suggested: {
        name: 'Cisco IOL L2 (IOU L2 AdvEnterprise)',
        template: 'iol',
        type: 'iol',
        image: 'L2-ADVENTERPRISEK9-M-15.2-20150703.bin',
        icon: 'Switch.png',
        estRamMb: 100,
        estCpu: 1,
        defaultRam: 1024,
        savingsText: 'Tiết kiệm ~99% RAM (chỉ tốn ~100 MB thay vì 8 - 18 GB)',
        features: ['VLAN 802.1Q', 'STP / RSTP / MSTP', 'EtherChannel LACP', 'L3 SVI', 'DHCP Snooping'],
        createPayload: { template: 'iol', type: 'iol', ram: 1024, nvram: 1024, ethernet: 4, serial: 0 }
      },
      alternative: {
        name: 'vIOS-L2',
        template: 'viosl2',
        estRamMb: 1024,
        estCpu: 1
      }
    },
    {
      id: 'end_host',
      category: 'End Host / Client Test',
      roleIcon: 'fa-desktop',
      description: 'Host kiểm thử: Ping, Trace, IP, DHCP, HTTP, DNS',
      matches: function (node) {
        var t = String(node.template || node.type || '').toLowerCase();
        var img = String(node.image || '').toLowerCase();
        var ram = parseInt(node.ram, 10) || 0;
        if (t === 'vpcs' || t === 'docker') return false;
        return (
          t === 'win' || t === 'win10' || t === 'win11' || t === 'winserver' ||
          (t === 'linux' && (ram >= 2048 || img.indexOf('desktop') !== -1 || img.indexOf('gui') !== -1)) ||
          img.indexOf('win') !== -1
        );
      },
      suggested: {
        name: 'VPCS (Virtual PC Simulator)',
        template: 'vpcs',
        type: 'vpcs',
        image: '',
        icon: 'Desktop.png',
        estRamMb: 10,
        estCpu: 1,
        defaultRam: 128,
        savingsText: 'Tiết kiệm ~99.8% RAM (chỉ tốn ~10 MB thay vì 4 - 8 GB)',
        features: ['Ping ICMP', 'Traceroute', 'DHCP Client', 'Static IP / Gateway', 'DNS resolution'],
        createPayload: { template: 'vpcs', type: 'vpcs', ram: 128, ethernet: 1 }
      },
      alternative: {
        name: 'Docker Alpine / Netshoot',
        template: 'docker',
        type: 'docker',
        estRamMb: 64,
        estCpu: 1,
        features: ['curl', 'iperf3', 'nmap', 'python', 'scapy', 'web testing']
      }
    },
    {
      id: 'high_scale_routing',
      category: 'High-Scale BGP / Core Daemon',
      roleIcon: 'fa-server',
      description: 'Routing quy mô lớn: BGP Route Reflector, OSPF/ISIS',
      matches: function (node) {
        var t = String(node.template || node.type || '').toLowerCase();
        var img = String(node.image || '').toLowerCase();
        return (
          t === 'xrv9k' || t === 'xrv' || t === 'vjunosevo' || t === 'huaweice12800' ||
          img.indexOf('xrv9k') !== -1
        );
      },
      suggested: {
        name: 'FRRouting (Docker FRR)',
        template: 'frr',
        type: 'docker',
        estRamMb: 128,
        estCpu: 1,
        defaultRam: 256,
        savingsText: 'Tiết kiệm ~99% RAM (chỉ tốn ~128 MB thay vì 16 GB)',
        features: ['Hàng triệu BGP Routes', 'EVPN-VxLAN', 'OSPFv2/v3', 'IS-IS', 'BFD', 'Segment Routing'],
        createPayload: { template: 'docker', type: 'docker', ram: 256, ethernet: 4 }
      }
    },
    {
      id: 'firewall',
      category: 'Firewall & Security Gateway',
      roleIcon: 'fa-shield',
      description: 'Tường lửa bảo mật: L3/L4 Stateful Filter, NAT, IPsec',
      matches: function (node) {
        var t = String(node.template || node.type || '').toLowerCase();
        var img = String(node.image || '').toLowerCase();
        return (
          t === 'firepower' || t === 'firepower6' || t === 'ftd7' ||
          img.indexOf('ftd') !== -1 || img.indexOf('firepower') !== -1
        );
      },
      suggested: {
        name: 'Cisco ASAv / pfSense',
        template: 'asav',
        type: 'qemu',
        estRamMb: 1024,
        estCpu: 1,
        defaultRam: 2048,
        savingsText: 'Tiết kiệm ~75% - 85% RAM (chỉ tốn ~1 - 2 GB thay vì 8 GB+)',
        features: ['Stateful Packet Inspection', 'NAT / PAT', 'ACL Rule', 'IPsec VPN', 'Remote Access'],
        createPayload: { template: 'asav', type: 'qemu', ram: 2048, ethernet: 4 }
      }
    },
    {
      id: 'rightsize_ram',
      category: 'Cấu hình RAM dư thừa',
      roleIcon: 'fa-sliders',
      description: 'Hạ dung lượng RAM cấu hình về mức tiêu chuẩn lab',
      matches: function (node) {
        var ram = parseInt(node.ram, 10) || 0;
        var t = String(node.template || node.type || '').toLowerCase();
        return (
          ram >= 3072 &&
          t !== 'cat9kv' && t !== 'cat9kvq200' && t !== 'cat9kvuadp' &&
          t !== 'nxosv9k' && t !== 'xrv9k' && t !== 'csr1000v' &&
          t !== 'win' && t !== 'win10' && t !== 'winserver' && t !== 'firepower' && t !== 'ftd7'
        );
      },
      suggested: {
        name: 'Right-sized RAM (1,024 MB)',
        isRightSize: true,
        targetRam: 1024,
        estRamMb: 400,
        estCpu: 1,
        savingsText: 'Hạ RAM cấu hình về 1,024 MB (chuẩn lab mượt mà)',
        features: ['Bảo toàn 100% image', 'Giữ nguyên cấu hình khởi động', 'Giữ nguyên cổng kết nối cáp']
      }
    }
  ];

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

  function getNodeWorkingSet(node) {
    var type = String(node.type || node.template || '').toLowerCase();
    var img = String(node.image || '').toLowerCase();
    var tpl = String(node.template || '').toLowerCase();
    var cfgRam = parseInt(node.ram, 10);
    if (isNaN(cfgRam) || cfgRam <= 0) cfgRam = 1024;

    if (type === 'iol' || tpl === 'iol' || img.indexOf('.bin') !== -1) {
      return Math.min(cfgRam * 0.15, 75);
    } else if (type === 'vpcs' || tpl === 'vpcs') {
      return 10;
    } else if (type === 'docker' || tpl === 'docker') {
      return Math.min(cfgRam * 0.25, 120);
    } else if (type === 'dynamips' || tpl === 'dynamips') {
      return Math.min(cfgRam * 0.25, 140);
    } else if (type === 'qemu' || tpl === 'qemu' || img.indexOf('qcow2') !== -1) {
      return Math.round(cfgRam * 0.38);
    } else {
      return Math.min(cfgRam * 0.25, 90);
    }
  }

  /**
   * Đánh giá đề xuất thay thế node nhẹ hơn tương đương chức năng
   * Phân biệt rõ:
   * - Host RAM: Dung lượng RAM vật lý thực sự giải phóng trên máy chủ Linux
   * - Allocated RAM: Dung lượng RAM cấu hình ảo được cắt giảm
   */
  function evaluateNodeRecommendations(targetNodes, currentProjectedUsedMb, totalHostMb, currentUsedMb) {
    var recs = [];
    var totalSavedHostRamMb = 0;
    var totalSavedAllocatedRamMb = 0;
    var totalSavedCpu = 0;

    targetNodes.forEach(function (node) {
      for (var i = 0; i < ALTERNATIVE_MATRIX.length; i++) {
        var rule = ALTERNATIVE_MATRIX[i];
        if (rule.matches(node)) {
          var curRam = parseInt(node.ram, 10) || 1024;
          var curCpu = parseInt(node.cpu, 10) || 1;
          var curHostRam = getNodeWorkingSet(node);
          var sugHostRam = rule.suggested.estRamMb || 75;
          var sugAllocatedRam = rule.suggested.defaultRam || (rule.suggested.isRightSize ? rule.suggested.targetRam : rule.suggested.estRamMb);

          var savedHostRam = Math.max(0, curHostRam - sugHostRam);
          var savedAllocatedRam = Math.max(0, curRam - sugAllocatedRam);
          var savedCpu = Math.max(0, curCpu - (rule.suggested.estCpu || 1));

          // Bỏ qua nếu node không tiết kiệm được dung lượng RAM nào (đã tối ưu)
          if (savedHostRam <= 0 && savedAllocatedRam <= 0) {
            continue;
          }

          recs.push({
            nodeId: node._resolvedId,
            nodeName: node.name || ('Node ' + node._resolvedId),
            currentType: node.type || node.template || 'unknown',
            currentTemplate: node.template || node.type || '',
            currentImage: node.image || '',
            currentRam: curRam,
            currentHostRam: Math.round(curHostRam),
            currentCpu: curCpu,
            rule: rule,
            suggested: rule.suggested,
            alternative: rule.alternative,
            savedHostRamMb: Math.round(savedHostRam),
            savedAllocatedRamMb: Math.round(savedAllocatedRam),
            savedRamMb: Math.round(savedAllocatedRam), // backward compatibility
            savedCpu: savedCpu
          });

          totalSavedHostRamMb += savedHostRam;
          totalSavedAllocatedRamMb += savedAllocatedRam;
          totalSavedCpu += savedCpu;
          break; // Ưu tiên rule phù hợp đầu tiên
        }
      }
    });

    var baseUsedMb = typeof currentUsedMb === 'number' ? currentUsedMb : 0;
    var optimizedProjectedUsedMb = Math.max(baseUsedMb, Math.round(currentProjectedUsedMb - totalSavedHostRamMb));
    var optimizedProjectedPct = totalHostMb > 0 ? Math.round((optimizedProjectedUsedMb / totalHostMb) * 100) : 0;

    return {
      items: recs,
      totalSavedHostRamMb: Math.round(totalSavedHostRamMb),
      totalSavedAllocatedRamMb: Math.round(totalSavedAllocatedRamMb),
      totalSavedRamMb: Math.round(totalSavedAllocatedRamMb), // backward compatibility
      totalSavedCpu: totalSavedCpu,
      optimizedProjectedUsedMb: optimizedProjectedUsedMb,
      optimizedProjectedPct: optimizedProjectedPct
    };
  }

  /**
   * Advanced Engine Modeling 6 Systems Mechanisms + Smart Alternatives
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
      if (status !== 2) { // Node đang tắt
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

    // Smart Optimizer & Alternatives Evaluation
    var recommendations = evaluateNodeRecommendations(targetNodes, projectedUsedMb, totalHostMb, currentUsedMb);

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
      targetNodesInfo: targetNodesInfo,
      recommendations: recommendations
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
      '  background: rgba(26, 32, 44, 0.90);',
      '  backdrop-filter: blur(10px);',
      '  -webkit-backdrop-filter: blur(10px);',
      '  border: 1px solid rgba(255, 255, 255, 0.14);',
      '  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);',
      '  color: #e2e8f0;',
      '  user-select: none;',
      '  cursor: pointer;',
      '  transition: all 0.25s ease;',
      '}',
      '#pnq-resource-hud:hover {',
      '  border-color: rgba(99, 179, 237, 0.6);',
      '  box-shadow: 0 4px 18px rgba(49, 130, 206, 0.35);',
      '  transform: translateY(-1px);',
      '}',
      '#pnq-resource-hud.mode-selection {',
      '  border-color: #3182ce;',
      '  background: rgba(20, 36, 60, 0.94);',
      '}',
      '#pnq-resource-hud.warning {',
      '  border-color: #d69e2e;',
      '  box-shadow: 0 4px 14px rgba(214, 158, 46, 0.25);',
      '}',
      '#pnq-resource-hud.danger {',
      '  border-color: #e53e3e;',
      '  box-shadow: 0 4px 16px rgba(229, 62, 62, 0.4);',
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
      '/* Glowing Optimizer Pill Badge on HUD */',
      '.pnq-hud-opt-badge {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 5px;',
      '  font-size: 11px;',
      '  font-weight: 600;',
      '  padding: 2px 8px;',
      '  border-radius: 12px;',
      '  background: linear-gradient(135deg, rgba(236, 201, 75, 0.22), rgba(72, 187, 120, 0.25));',
      '  border: 1px solid rgba(236, 201, 75, 0.6);',
      '  color: #fbd38d;',
      '  cursor: pointer;',
      '  box-shadow: 0 0 10px rgba(236, 201, 75, 0.25);',
      '  transition: all 0.2s ease;',
      '}',
      '.pnq-hud-opt-badge:hover {',
      '  background: linear-gradient(135deg, rgba(236, 201, 75, 0.35), rgba(72, 187, 120, 0.35));',
      '  border-color: #ecc94b;',
      '  color: #fff;',
      '  transform: scale(1.04);',
      '}',
      '/* Modal breakdown dialog */',
      '#pnq-estimator-modal {',
      '  position: fixed;',
      '  top: 50%; left: 50%;',
      '  transform: translate(-50%, -50%);',
      '  z-index: 9999;',
      '  width: 660px; max-width: 94vw;',
      '  max-height: 88vh;',
      '  display: flex;',
      '  flex-direction: column;',
      '  background: #1a202c;',
      '  border: 1px solid rgba(255, 255, 255, 0.18);',
      '  border-radius: 14px;',
      '  box-shadow: 0 24px 48px rgba(0,0,0,0.7);',
      '  color: #e2e8f0;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  font-size: 12px; line-height: 1.5;',
      '  overflow: hidden;',
      '}',
      '#pnq-estimator-modal-backdrop {',
      '  position: fixed; inset: 0;',
      '  background: rgba(0,0,0,0.68);',
      '  z-index: 9998;',
      '  backdrop-filter: blur(5px);',
      '}',
      '#pnq-estimator-modal-header {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  padding: 16px 20px 12px 20px;',
      '  border-bottom: 1px solid rgba(255, 255, 255, 0.1);',
      '}',
      '#pnq-estimator-modal-header h3 {',
      '  margin: 0; font-size: 15px; font-weight: 700; color: #63b3ed;',
      '  display: flex; align-items: center; gap: 8px;',
      '}',
      '#pnq-estimator-modal .close-btn {',
      '  cursor: pointer; opacity: 0.7; font-size: 20px; color: #a0aec0;',
      '  transition: color 0.15s ease;',
      '}',
      '#pnq-estimator-modal .close-btn:hover { opacity: 1; color: #fc8181; }',
      '/* Tab Navigation */',
      '.pnq-modal-tabs {',
      '  display: flex;',
      '  gap: 8px;',
      '  padding: 8px 20px 0 20px;',
      '  background: rgba(0, 0, 0, 0.2);',
      '  border-bottom: 1px solid rgba(255, 255, 255, 0.08);',
      '}',
      '.pnq-modal-tab {',
      '  background: transparent;',
      '  border: none;',
      '  border-bottom: 2px solid transparent;',
      '  color: #a0aec0;',
      '  padding: 8px 14px;',
      '  font-size: 12px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  transition: all 0.2s ease;',
      '}',
      '.pnq-modal-tab:hover { color: #e2e8f0; }',
      '.pnq-modal-tab.active {',
      '  color: #63b3ed;',
      '  border-bottom-color: #63b3ed;',
      '}',
      '.pnq-modal-tab.tab-opt.active {',
      '  color: #ecc94b;',
      '  border-bottom-color: #ecc94b;',
      '}',
      '.pnq-tab-counter {',
      '  font-size: 10px;',
      '  padding: 1px 6px;',
      '  border-radius: 10px;',
      '  background: rgba(236, 201, 75, 0.25);',
      '  color: #ecc94b;',
      '}',
      '/* Tab Panes */',
      '.pnq-tab-content {',
      '  padding: 16px 20px;',
      '  overflow-y: auto;',
      '  max-height: calc(88vh - 120px);',
      '}',
      '.pnq-tab-pane { display: none; }',
      '.pnq-tab-pane.active { display: block; }',
      '/* Mechanism breakdown */',
      '#pnq-estimator-modal .mech-row {',
      '  display: flex; justify-content: space-between; padding: 7px 0;',
      '  border-bottom: 1px solid rgba(255, 255, 255, 0.06);',
      '}',
      '#pnq-estimator-modal .mech-label { color: #a0aec0; }',
      '#pnq-estimator-modal .mech-val { font-weight: 600; color: #f7fafc; }',
      '#pnq-estimator-modal .mech-tag { font-size: 10px; padding: 2px 7px; border-radius: 8px; background: rgba(72,187,120,0.2); color: #68d391; }',
      '/* Smart Optimizer Cards & Elements */',
      '.pnq-opt-summary-box {',
      '  background: linear-gradient(135deg, rgba(236, 201, 75, 0.12), rgba(49, 130, 206, 0.12));',
      '  border: 1px solid rgba(236, 201, 75, 0.35);',
      '  border-radius: 10px;',
      '  padding: 12px 16px;',
      '  margin-bottom: 14px;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '}',
      '.pnq-opt-summary-title { font-size: 13px; font-weight: 700; color: #fbd38d; margin-bottom: 4px; }',
      '.pnq-opt-summary-desc { font-size: 11px; color: #cbd5e0; }',
      '.pnq-opt-summary-stat { text-align: right; }',
      '.pnq-opt-summary-stat-val { font-size: 18px; font-weight: 800; color: #68d391; }',
      '.pnq-opt-summary-stat-sub { font-size: 10px; color: #a0aec0; }',
      '.pnq-opt-card {',
      '  background: rgba(255, 255, 255, 0.03);',
      '  border: 1px solid rgba(255, 255, 255, 0.09);',
      '  border-radius: 10px;',
      '  padding: 12px 14px;',
      '  margin-bottom: 10px;',
      '  transition: all 0.2s ease;',
      '}',
      '.pnq-opt-card:hover {',
      '  border-color: rgba(236, 201, 75, 0.4);',
      '  background: rgba(255, 255, 255, 0.05);',
      '}',
      '.pnq-opt-card-header {',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  margin-bottom: 8px;',
      '}',
      '.pnq-opt-card-title {',
      '  font-size: 13px; font-weight: 700; color: #f7fafc;',
      '  display: flex; align-items: center; gap: 7px;',
      '}',
      '.pnq-opt-card-badge {',
      '  font-size: 10px; padding: 2px 7px; border-radius: 6px;',
      '  background: rgba(49, 130, 206, 0.2); color: #63b3ed; font-weight: 600;',
      '}',
      '.pnq-opt-card-grid {',
      '  display: grid;',
      '  grid-template-columns: 1fr auto 1.3fr;',
      '  gap: 10px;',
      '  align-items: center;',
      '  background: rgba(0, 0, 0, 0.2);',
      '  padding: 8px 12px;',
      '  border-radius: 8px;',
      '  margin-bottom: 8px;',
      '}',
      '.pnq-opt-col-cur { color: #fc8181; }',
      '.pnq-opt-col-cur b { color: #fff; font-size: 12px; }',
      '.pnq-opt-arrow { color: #ecc94b; font-size: 14px; text-align: center; }',
      '.pnq-opt-col-sug { color: #68d391; }',
      '.pnq-opt-col-sug b { color: #fff; font-size: 12px; }',
      '.pnq-opt-features {',
      '  display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px;',
      '}',
      '.pnq-opt-feat-chip {',
      '  font-size: 10px; padding: 1px 6px; border-radius: 4px;',
      '  background: rgba(255, 255, 255, 0.06); color: #cbd5e0;',
      '}',
      '.pnq-opt-card-actions {',
      '  display: flex; justify-content: flex-end; gap: 8px; align-items: center;',
      '}',
      '.pnq-opt-btn {',
      '  padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600;',
      '  border: none; cursor: pointer; transition: all 0.2s ease;',
      '  display: inline-flex; align-items: center; gap: 5px;',
      '}',
      '.pnq-opt-btn-primary {',
      '  background: #3182ce; color: #fff;',
      '}',
      '.pnq-opt-btn-primary:hover { background: #2b6cb0; }',
      '.pnq-opt-btn-success {',
      '  background: #38a169; color: #fff;',
      '}',
      '.pnq-opt-btn-success:hover { background: #2f855a; }',
      '.pnq-opt-btn-gold {',
      '  background: #d69e2e; color: #fff;',
      '}',
      '.pnq-opt-btn-gold:hover { background: #b7791f; }',
      '.pnq-opt-batch-bar {',
      '  display: flex; justify-content: space-between; align-items: center;',
      '  margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.1);',
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
      hudElement.addEventListener('click', function (e) {
        var optBtn = e.target.closest('#pnq-hud-opt-trigger');
        if (optBtn) {
          showDetailsModal('recommendations');
        } else {
          // Nếu đang có cảnh báo tải hoặc có đề xuất, ưu tiên mở tab recommendations
          if (data.severity !== 'safe' && data.recommendations && data.recommendations.items.length > 0) {
            showDetailsModal('recommendations');
          } else {
            showDetailsModal('mechanisms');
          }
        }
      });
    } else if (container && hudElement.parentElement !== container) {
      container.appendChild(hudElement);
    }

    hudElement.className = (data.isSelectionMode ? 'mode-selection ' : 'mode-global ') + data.severity;

    var badgeHtml = '';
    var metricHtml = '';
    var forecastHtml = '';
    var optBadgeHtml = '';

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

      // Nút đề xuất tối ưu nếu có node nặng hoặc RAM dư thừa
      if (data.recommendations && data.recommendations.items.length > 0) {
        optBadgeHtml = '<span class="pnq-hud-opt-badge" id="pnq-hud-opt-trigger" title="Nhấp để xem ' + data.recommendations.items.length + ' đề xuất thay thế node nhẹ hơn"><i class="fa fa-lightbulb-o"></i> Tối ưu: Tiết kiệm ' + formatBytes(data.recommendations.totalSavedRamMb) + '</span>';
      }
    }

    hudElement.innerHTML = badgeHtml + metricHtml + forecastHtml + optBadgeHtml;

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
      '• Đánh giá tải: ' + (data.severity === 'danger' ? '⚠️ Nguy cơ thiếu RAM' : (data.severity === 'warning' ? '⚠️ Cảnh báo tải cao' : '✓ Hoàn toàn an toàn (Tối ưu bởi Kernel)'))
    ];

    if (data.recommendations && data.recommendations.items.length > 0) {
      tooltipLines.push('────────────────────────────────────────────────────────');
      tooltipLines.push('💡 CÓ ' + data.recommendations.items.length + ' ĐỀ XUẤT THAY THẾ NODE NHẸ HƠN: Tiết kiệm tới ' + formatBytes(data.recommendations.totalSavedRamMb) + ' RAM!');
    }

    tooltipLines.push('👉 Nhấp chuột vào HUD để xem bảng phân tích & danh sách đề xuất thay thế!');
    hudElement.title = tooltipLines.join('\n');
  }

  // Thực hiện hạ RAM cấu hình của 1 node qua API
  function applyNodeRamOptimization(nodeId, targetRamMb, btnEl) {
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Đang lưu...';
    }
    var base = (window.nodes && window.nodes[nodeId]) || {};
    var postData = Object.assign({}, base, { id: nodeId, ram: targetRamMb });

    if (window.$ && typeof window.$.ajax === 'function') {
      window.$.ajax({
        cache: false,
        type: 'post',
        url: encodeURI('/api/labs/session/nodes/edit'),
        dataType: 'json',
        data: postData,
        success: function (res) {
          if (res && res.status === 'success') {
            if (res.update && window.App && window.App.topology && window.App.topology.updateData) {
              try { window.App.topology.updateData(res.update); } catch (e) {}
            }
            if (window.nodes && window.nodes[nodeId]) {
              window.nodes[nodeId].ram = targetRamMb;
            }
            if (typeof window.addMessage === 'function') {
              window.addMessage('success', 'Đã tối ưu RAM cho ' + (base.name || ('Node ' + nodeId)) + ' về ' + targetRamMb + ' MB!');
            }
            recalculateAndRender();
            showDetailsModal('recommendations');
          } else {
            alert('Không thể cập nhật node: ' + ((res && res.message) || 'Lỗi không xác định'));
            if (btnEl) {
              btnEl.disabled = false;
              btnEl.innerHTML = 'Thử lại';
            }
          }
        },
        error: function () {
          alert('Lỗi kết nối khi gửi yêu cầu cập nhật node.');
          if (btnEl) {
            btnEl.disabled = false;
            btnEl.innerHTML = 'Thử lại';
          }
        }
      });
    }
  }

  // Thay thế node nặng bằng node nhẹ: Hoán đổi tại chỗ (in-place atomic swap), bảo toàn 100% dây kết nối và vị trí
  function swapWithAlternativeNode(oldNodeId, suggested, btnEl) {
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Đang thay thế...';
    }

    var src = resolveNodeRecord(oldNodeId);
    var oldName = src.name || ('Node ' + oldNodeId);

    // Tính toán tên mới và icon mới phù hợp trực quan với thiết bị đã chọn
    var newName = oldName;
    if (suggested.type === 'vpcs') {
      newName = oldName.replace(/win\d*/i, 'VPCS').replace(/qemu/i, 'vpcs');
      if (newName === oldName && newName.indexOf('VPCS') === -1) {
        newName = oldName + '_VPCS';
      }
      newName = newName.replace(/(_VPCS)+/g, '_VPCS');
    } else if (suggested.template === 'iol') {
      if (suggested.image && suggested.image.indexOf('L2') !== -1) {
        newName = oldName.replace(/cat9k\w*/i, 'IOL_L2').replace(/qemu/i, 'iol_l2');
        if (newName === oldName && newName.indexOf('IOL_L2') === -1) {
          newName = oldName + '_IOL_L2';
        }
        newName = newName.replace(/(_IOL_L2)+/g, '_IOL_L2');
      } else {
        newName = oldName.replace(/csr1000\w*/i, 'IOL_L3').replace(/qemu/i, 'iol_l3');
        if (newName === oldName && newName.indexOf('IOL_L3') === -1) {
          newName = oldName + '_IOL_L3';
        }
        newName = newName.replace(/(_IOL_L3)+/g, '_IOL_L3');
      }
    } else if (suggested.template === 'docker' || suggested.type === 'docker') {
      newName = oldName + '_Docker';
      newName = newName.replace(/(_Docker)+/g, '_Docker');
    }

    var targetIcon = suggested.icon || 'Router.png';
    if (suggested.type === 'vpcs') {
      targetIcon = 'Desktop.png';
    } else if (suggested.template === 'iol') {
      if (suggested.image && suggested.image.indexOf('L2') !== -1) {
        targetIcon = 'Switch.png';
      } else {
        targetIcon = 'Router.png';
      }
    }

    var swapPayload = {
      id: parseInt(oldNodeId, 10),
      name: newName,
      template: suggested.template || 'iol',
      type: suggested.type || 'iol',
      image: suggested.image || '',
      ram: suggested.targetRam || (suggested.createPayload && suggested.createPayload.ram) || suggested.estRamMb || 1024,
      cpu: suggested.estCpu || 1,
      icon: targetIcon
    };

    window.$.ajax({
      cache: false,
      type: 'POST',
      url: encodeURI('/api/labs/session/nodes/swap'),
      contentType: 'application/json',
      dataType: 'json',
      data: JSON.stringify(swapPayload),
      success: function (res) {
        if (!res || res.status !== 'success') {
          alert('Không thể thay thế node: ' + ((res && res.message) || 'Lỗi xử lý'));
          if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = 'Thử lại'; }
          return;
        }

        if (typeof window.addMessage === 'function') {
          window.addMessage('success', 'Đã thay thế ' + oldName + ' sang ' + suggested.name + ' tại chỗ, bảo toàn 100% dây kết nối!');
        }

        closeDetailsModal();
        setTimeout(function () {
          if (window.location && typeof window.location.reload === 'function') {
            window.location.reload();
          } else {
            recalculateAndRender();
          }
        }, 400);
      },
      error: function (xhr) {
        var msg = (xhr && xhr.responseJSON && xhr.responseJSON.message) || xhr.statusText || 'Lỗi kết nối';
        alert('Lỗi thay thế node: ' + msg);
        if (btnEl) { btnEl.disabled = false; btnEl.innerHTML = 'Thử lại'; }
      }
    });
  }

  // Tạo node nhẹ tương đương (alias)
  function createAlternativeNode(srcNodeId, suggested, btnEl) {
    swapWithAlternativeNode(srcNodeId, suggested, btnEl);
  }

  // Tối ưu hàng loạt RAM cho các node có RAM dư thừa
  function applyBatchRightSize(btnEl) {
    if (!lastEstimate || !lastEstimate.recommendations || !lastEstimate.recommendations.items) return;
    var candidates = lastEstimate.recommendations.items.filter(function (it) {
      return it.suggested && it.suggested.isRightSize;
    });
    if (!candidates.length) {
      alert('Không có node nào có RAM dư thừa cần hạ cấu hình.');
      return;
    }
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Đang tối ưu ' + candidates.length + ' node...';
    }

    var pending = candidates.length;
    var successCount = 0;

    candidates.forEach(function (c) {
      var base = (window.nodes && window.nodes[c.nodeId]) || {};
      var postData = Object.assign({}, base, { id: c.nodeId, ram: c.suggested.targetRam || 1024 });

      window.$.ajax({
        cache: false,
        type: 'post',
        url: encodeURI('/api/labs/session/nodes/edit'),
        dataType: 'json',
        data: postData,
        complete: function () {
          pending--;
          successCount++;
          if (pending === 0) {
            if (typeof window.addMessage === 'function') {
              window.addMessage('success', 'Đã tối ưu RAM cho ' + successCount + ' node thành công!');
            }
            recalculateAndRender();
            showDetailsModal('recommendations');
          }
        }
      });
    });
  }

  function showDetailsModal(initialTab) {
    if (!lastEstimate) return;
    closeDetailsModal();

    if (initialTab) {
      activeModalTab = initialTab;
    }

    var backdrop = document.createElement('div');
    backdrop.id = 'pnq-estimator-modal-backdrop';
    backdrop.addEventListener('click', closeDetailsModal);

    var modal = document.createElement('div');
    modal.id = 'pnq-estimator-modal';

    var data = lastEstimate;
    var recs = (data.recommendations && data.recommendations.items) || [];
    var recCount = recs.length;

    // Render HTML modal với 2 tab
    modal.innerHTML = [
      '<div id="pnq-estimator-modal-header">',
      '  <h3><i class="fa fa-dashboard"></i> Phân tích Tài nguyên & Tối ưu hóa Node</h3>',
      '  <span class="close-btn">&times;</span>',
      '</div>',
      '<div class="pnq-modal-tabs">',
      '  <button class="pnq-modal-tab ' + (activeModalTab === 'mechanisms' ? 'active' : '') + '" data-tab="mechanisms"><i class="fa fa-cogs"></i> 6 Cơ chế Hypervisor</button>',
      '  <button class="pnq-modal-tab tab-opt ' + (activeModalTab === 'recommendations' ? 'active' : '') + '" data-tab="recommendations"><i class="fa fa-lightbulb-o"></i> Đề xuất thay thế Node <span class="pnq-tab-counter">' + recCount + '</span></button>',
      '</div>',
      '<div class="pnq-tab-content">',
      '  <!-- TAB 1: 6 CƠ CHẾ KERNEL -->',
      '  <div id="pane-mechanisms" class="pnq-tab-pane ' + (activeModalTab === 'mechanisms' ? 'active' : '') + '">',
      '    <div class="mech-row">',
      '      <span class="mech-label">Phạm vi tính toán:</span>',
      '      <span class="mech-val">' + (data.isSelectionMode ? ('Đang chọn (' + data.stoppedCount + ' node)') : ('Toàn bộ lab (' + data.stoppedCount + ' node)')) + '</span>',
      '    </div>',
      '    <div class="mech-row">',
      '      <span class="mech-label">1. CoW & Shared Binary Layers:</span>',
      '      <span class="mech-val"><span class="mech-tag">Tiết kiệm ' + formatBytes(data.totalCowSavingsMb) + '</span></span>',
      '    </div>',
      '    <div class="mech-row">',
      '      <span class="mech-label">2. KSM (Kernel Samepage Merging):</span>',
      '      <span class="mech-val"><span class="mech-tag">' + (data.ksmEnabled ? ('BẬT (Sharing ' + formatBytes(data.ksmSharingMb) + ')') : 'TẮT') + '</span></span>',
      '    </div>',
      '    <div class="mech-row">',
      '      <span class="mech-label">3. VirtIO Ballooning & ZRAM:</span>',
      '      <span class="mech-val"><span class="mech-tag">' + (data.zramEnabled ? 'ZRAM 2.5:1 BẬT' : 'VirtIO Thu hồi ' + formatBytes(data.totalBallooningSavingsMb)) + '</span></span>',
      '    </div>',
      '    <div class="mech-row">',
      '      <span class="mech-label">4. KVM Hardware Acceleration:</span>',
      '      <span class="mech-val">' + (data.kvmAvailable ? '<span class="mech-tag">VT-x / AMD-V Sẵn sàng</span>' : '<span style="color:#fc8181">TCG Chậm</span>') + '</span>',
      '    </div>',
      '    <div class="mech-row">',
      '      <span class="mech-label">5. vCPU Overcommit Ratio:</span>',
      '      <span class="mech-val">' + data.vcpuOvercommitRatio + 'x / ' + data.hostCores + ' cores (' + data.overcommitStatus + ')</span>',
      '    </div>',
      '    <div class="mech-row">',
      '      <span class="mech-label">6. Linux Demand Paging:</span>',
      '      <span class="mech-val">Chỉ nạp working set (~' + formatBytes(data.totalHostRamMb) + ' / ảo ' + formatBytes(data.totalAllocatedRamMb) + ')</span>',
      '    </div>',
      '    <div class="mech-row" style="margin-top:10px; border-top: 1px solid rgba(255,255,255,0.15); padding-top:10px;">',
      '      <span class="mech-label">Dự kiến RAM Máy chủ:</span>',
      '      <span class="mech-val" style="color:#68d391; font-size:13px;">' + data.currentMemPct + '% ➔ ' + data.projectedPct + '% (' + formatBytes(data.projectedUsedMb) + ' / ' + formatBytes(data.totalHostMb) + ')</span>',
      '    </div>',
      '    <div class="mech-row">',
      '      <span class="mech-label">Dung lượng Khả dụng (MemAvailable):</span>',
      '      <span class="mech-val" style="color:#63b3ed;">' + formatBytes(data.availMb) + '</span>',
      '    </div>',
      '  </div>',
      '  <!-- TAB 2: ĐỀ XUẤT THAY THẾ NODE THÔNG MINH -->',
      '  <div id="pane-recommendations" class="pnq-tab-pane ' + (activeModalTab === 'recommendations' ? 'active' : '') + '">',
      recCount === 0 ? [
        '    <div style="text-align: center; padding: 30px 10px; color: #a0aec0;">',
        '      <i class="fa fa-check-circle" style="font-size: 36px; color: #68d391; margin-bottom: 10px; display: block;"></i>',
        '      <b style="color: #fff; font-size: 14px;">Không có node nào cần tối ưu hiện tại</b>',
        '      <p style="margin-top: 6px; font-size: 11px;">Toàn bộ node đã ở cấu hình tối ưu hoặc không có node nào tiêu thụ tài nguyên đột biến.</p>',
        '    </div>'
      ].join('\n') : [
        '    <div class="pnq-opt-summary-box">',
        '      <div>',
        '        <div class="pnq-opt-summary-title"><i class="fa fa-bolt"></i> Dự phóng tải Máy chủ sau khi Tối ưu</div>',
        '        <div class="pnq-opt-summary-desc">RAM máy chủ dự kiến: <b style="color:#fc8181">' + data.projectedPct + '%</b> ➔ <b style="color:#68d391">' + data.recommendations.optimizedProjectedPct + '%</b> (' + formatBytes(data.recommendations.optimizedProjectedUsedMb) + ' / ' + formatBytes(data.totalHostMb) + ')</div>',
        '      </div>',
        '      <div class="pnq-opt-summary-stat">',
        '        <div class="pnq-opt-summary-stat-val">-' + formatBytes(data.recommendations.totalSavedHostRamMb) + '</div>',
        '        <div class="pnq-opt-summary-stat-sub">RAM Host thực tế giải phóng</div>',
        '      </div>',
        '    </div>',
        '    <div class="pnq-opt-list">',
        recs.map(function (item) {
          var sug = item.suggested;
          var featuresHtml = (sug.features || []).map(function (f) {
            return '<span class="pnq-opt-feat-chip"><i class="fa fa-check" style="color:#68d391"></i> ' + f + '</span>';
          }).join(' ');

          var actionBtnHtml = '';
          if (sug.isRightSize) {
            actionBtnHtml = '<button class="pnq-opt-btn pnq-opt-btn-gold" data-action="rightsize" data-node="' + item.nodeId + '" data-ram="' + sug.targetRam + '"><i class="fa fa-magic"></i> Hạ RAM về ' + sug.targetRam + ' MB</button>';
          } else {
            actionBtnHtml = '<button class="pnq-opt-btn pnq-opt-btn-success" data-action="swap-node" data-node="' + item.nodeId + '"><i class="fa fa-refresh"></i> Thay thế & Xóa node cũ</button>';
          }

          return [
            '<div class="pnq-opt-card">',
            '  <div class="pnq-opt-card-header">',
            '    <div class="pnq-opt-card-title">',
            '      <i class="fa ' + (item.rule.roleIcon || 'fa-server') + '" style="color:#63b3ed"></i>',
            '      <span>' + item.nodeName + '</span>',
            '      <span style="font-weight:normal; font-size:11px; color:#a0aec0">(' + item.currentTemplate + ')</span>',
            '    </div>',
            '    <span class="pnq-opt-card-badge">' + item.rule.category + '</span>',
            '  </div>',
            '  <div class="pnq-opt-card-grid">',
            '    <div class="pnq-opt-col-cur">',
            '      <div>Hiện tại (RAM thực ~' + formatBytes(item.currentHostRam) + '):</div>',
            '      <b>' + formatBytes(item.currentRam) + ' cấu hình • ' + item.currentCpu + ' vCPU</b>',
            '    </div>',
            '    <div class="pnq-opt-arrow"><i class="fa fa-arrow-right"></i></div>',
            '    <div class="pnq-opt-col-sug">',
            '      <div>Đề xuất: <b>' + sug.name + '</b></div>',
            '      <b>RAM thực ~' + formatBytes(sug.estRamMb) + ' • ' + sug.estCpu + ' vCPU</b>',
            '      <div style="font-size:10px; color:#ecc94b; margin-top:2px;">Tiết kiệm ' + formatBytes(item.savedHostRamMb) + ' RAM Host (' + sug.savingsText + ')</div>',
            '    </div>',
            '  </div>',
            '  <div class="pnq-opt-features">' + featuresHtml + '</div>',
            '  <div class="pnq-opt-card-actions">' + actionBtnHtml + '</div>',
            '</div>'
          ].join('\n');
        }).join('\n'),
        '    </div>',
        '    <div class="pnq-opt-batch-bar">',
        '      <span style="font-size: 11px; color: #a0aec0;">Đề xuất bảo toàn 100% tính năng định tuyến & kiểm thử của bài lab.</span>',
        recs.some(function (r) { return r.suggested && r.suggested.isRightSize; }) ?
          '<button class="pnq-opt-btn pnq-opt-btn-gold" id="pnq-batch-rightsize-btn"><i class="fa fa-flash"></i> Tự động tối ưu toàn bộ RAM các node</button>' : '',
        '    </div>'
      ].join('\n'),
      '  </div>',
      '</div>'
    ].join('\n');

    // Sự kiện đóng modal
    modal.querySelector('.close-btn').addEventListener('click', closeDetailsModal);

    // Chuyển Tab
    var tabBtns = modal.querySelectorAll('.pnq-modal-tab');
    tabBtns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = this.getAttribute('data-tab');
        activeModalTab = tab;
        tabBtns.forEach(function (b) { b.classList.remove('active'); });
        this.classList.add('active');

        var panes = modal.querySelectorAll('.pnq-tab-pane');
        panes.forEach(function (p) { p.classList.remove('active'); });
        var targetPane = modal.querySelector('#pane-' + tab);
        if (targetPane) targetPane.classList.add('active');
      });
    });

    // Sự kiện Click hành động trên thẻ
    modal.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-action]');
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      var nodeId = btn.getAttribute('data-node');

      if (action === 'rightsize') {
        var ram = parseInt(btn.getAttribute('data-ram'), 10) || 1024;
        applyNodeRamOptimization(nodeId, ram, btn);
      } else if (action === 'swap-node' || action === 'create-alt') {
        var item = recs.find(function (r) { return String(r.nodeId) === String(nodeId); });
        if (item && item.suggested) {
          swapWithAlternativeNode(nodeId, item.suggested, btn);
        }
      }
    });

    // Sự kiện Batch Right-size
    var batchBtn = modal.querySelector('#pnq-batch-rightsize-btn');
    if (batchBtn) {
      batchBtn.addEventListener('click', function () {
        applyBatchRightSize(this);
      });
    }

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
    applyNodeRamOptimization: applyNodeRamOptimization,
    createAlternativeNode: createAlternativeNode,
    swapWithAlternativeNode: swapWithAlternativeNode,
    applyBatchRightSize: applyBatchRightSize,
    setMockStats: function (mock) {
      if (typeof mock === 'object' && mock !== null) {
        Object.assign(sysStats, mock);
        recalculateAndRender();
      }
    }
  };
})();
