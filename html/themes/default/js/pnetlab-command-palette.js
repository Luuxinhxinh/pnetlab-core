/**
 * pnetlab-command-palette.js
 * 
 * Command Palette (Ctrl + K / Cmd + K) cho PNetLab
 * Tìm kiếm & điều khiển thiết bị nhanh trong bài lab:
 * 1. Phím tắt kích hoạt & điều hướng:
 *    - Ctrl + K (hoặc Cmd + K trên macOS) mở/đóng popup
 *    - Esc hoặc click ra ngoài backdrop để đóng lại
 *    - Phím mũi tên ↑ / ↓ duyệt danh sách, Enter chọn & phát sáng tại chỗ, Shift + Enter mở ngay Web Console
 * 2. Tìm kiếm & Phát sáng tại chỗ (Highlight Node):
 *    - Lọc tức thì theo tên thiết bị (R1, SW), Node ID, loại thiết bị (IOL, QEMU, Docker), hoặc image
 *    - Chỉ phát sáng nổi bật tại chỗ (viền sáng nhấp nháy đa sắc #38bdf8 trong 4s), KHÔNG di chuyển/cuộn canvas
 * 3. Mở nhanh Web Console / Telnet:
 *    - Tích hợp pnqOpenConsoleAuto / pnqOpenWebConsole / openNodeConsole
 *    - Kích hoạt bằng Shift + Enter hoặc nút Console trên từng dòng
 * 4. Xem nhanh thông tin tóm tắt (Quick Info):
 *    - Badge trạng thái: Running (xanh lá kèm đèn LED sáng) hoặc Stopped (xám)
 *    - Loại thiết bị (Template/Type: IOL, QEMU, DOCKER...) và Image (đã bỏ thông tin Ports theo yêu cầu)
 * 5. Điều khiển nguồn & Dữ liệu riêng lẻ (Node Actions):
 *    - Hiển thị đầy đủ cả 2 nút Start VÀ Stop (cùng Restart, Wipe) để thao tác tức thì
 *    - Start / Stop: Gọi API /api/labs/session/nodes/start và stop
 *    - Restart: Tự động stop và khởi động lại sau 1.2s
 *    - Wipe node: Gọi API /api/labs/session/nodes/wipe kèm hộp thoại xác nhận an toàn
 *
 * FE2 UI/UX Design Token Compliance
 */

(function () {
  'use strict';

  var MODAL_ID = 'pnq-command-palette';
  var STYLE_ID = 'pnq-command-palette-styles';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #pnq-command-palette {
        position: fixed;
        inset: 0;
        z-index: 100060;
        display: none;
        align-items: flex-start;
        justify-content: center;
        padding-top: 10vh;
        background: rgba(7, 5, 14, 0.75);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        font-family: var(--pnq-font, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
        opacity: 0;
        transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      #pnq-command-palette.open {
        display: flex;
        opacity: 1;
      }
      .pnq-cp-dialog {
        width: 100%;
        max-width: 680px;
        background: var(--pnq-popover-bg, rgba(22, 16, 43, 0.96));
        border: 1px solid var(--pnq-card-border, rgba(168, 85, 247, 0.35));
        border-radius: 14px;
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7), 0 0 45px var(--pnq-primary-glow, rgba(139, 92, 246, 0.25));
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transform: translateY(-12px) scale(0.98);
        transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      #pnq-command-palette.open .pnq-cp-dialog {
        transform: translateY(0) scale(1);
      }
      .pnq-cp-search-wrap {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--pnq-card-border, rgba(168, 85, 247, 0.2));
        background: rgba(255, 255, 255, 0.02);
      }
      .pnq-cp-search-icon {
        color: #38bdf8;
        font-size: 16px;
        flex-shrink: 0;
      }
      .pnq-cp-input {
        flex: 1;
        background: transparent;
        border: none;
        outline: none;
        color: var(--pnq-text, #ffffff);
        font-size: 16px;
        font-weight: 500;
      }
      .pnq-cp-input::placeholder {
        color: var(--pnq-text-muted, rgba(255, 255, 255, 0.45));
        font-weight: 400;
      }
      .pnq-cp-badge-esc {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: var(--pnq-text-muted, #c4b5fd);
        padding: 2px 7px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      .pnq-cp-list {
        max-height: 420px;
        overflow-y: auto;
        padding: 8px;
        list-style: none;
        margin: 0;
      }
      .pnq-cp-list::-webkit-scrollbar {
        width: 6px;
      }
      .pnq-cp-list::-webkit-scrollbar-thumb {
        background: rgba(168, 85, 247, 0.3);
        border-radius: 3px;
      }
      .pnq-cp-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.15s ease;
        border: 1px solid transparent;
        margin-bottom: 4px;
      }
      .pnq-cp-item:hover, .pnq-cp-item.selected {
        background: rgba(139, 92, 246, 0.16);
        border-color: rgba(56, 189, 248, 0.45);
      }
      .pnq-cp-item-main {
        display: flex;
        align-items: center;
        gap: 12px;
        flex: 1;
        min-width: 0;
      }
      .pnq-cp-item-icon {
        width: 34px;
        height: 34px;
        object-fit: contain;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.05);
        padding: 3px;
        flex-shrink: 0;
      }
      .pnq-cp-item-details {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .pnq-cp-item-header {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .pnq-cp-item-name {
        color: var(--pnq-text, #ffffff);
        font-size: 14px;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pnq-cp-node-id {
        font-size: 10px;
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.12);
        border: 1px solid rgba(56, 189, 248, 0.25);
        padding: 1px 5px;
        border-radius: 4px;
        font-weight: 600;
      }
      .pnq-cp-status-pill {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        font-size: 11px;
        font-weight: 600;
        padding: 1px 7px;
        border-radius: 9999px;
      }
      .pnq-cp-status-pill.running {
        background: rgba(34, 197, 94, 0.15);
        color: #4ade80;
        border: 1px solid rgba(34, 197, 94, 0.35);
      }
      .pnq-cp-status-pill.stopped {
        background: rgba(148, 163, 184, 0.12);
        color: #94a3b8;
        border: 1px solid rgba(148, 163, 184, 0.25);
      }
      .pnq-cp-status-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .running .pnq-cp-status-dot {
        background: #22c55e;
        box-shadow: 0 0 8px #22c55e;
      }
      .stopped .pnq-cp-status-dot {
        background: #94a3b8;
      }
      .pnq-cp-item-sub {
        font-size: 12px;
        color: var(--pnq-text-muted, #c4b5fd);
        margin-top: 3px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pnq-cp-item-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-left: 10px;
        flex-shrink: 0;
      }
      .pnq-cp-btn {
        padding: 5px 9px;
        border-radius: 6px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.05);
        color: var(--pnq-text, #ffffff);
        font-size: 11px;
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .pnq-cp-btn:hover {
        background: rgba(255, 255, 255, 0.14);
        border-color: rgba(255, 255, 255, 0.25);
      }
      .pnq-cp-btn-console {
        background: rgba(56, 189, 248, 0.18);
        border-color: rgba(56, 189, 248, 0.45);
        color: #7dd3fc;
      }
      .pnq-cp-btn-console:hover {
        background: rgba(56, 189, 248, 0.32);
        border-color: #38bdf8;
        color: #ffffff;
      }
      .pnq-cp-btn-start {
        color: #4ade80;
        border-color: rgba(34, 197, 94, 0.3);
      }
      .pnq-cp-btn-start:hover {
        background: rgba(34, 197, 94, 0.2);
        border-color: #22c55e;
      }
      .pnq-cp-btn-stop {
        color: #f87171;
        border-color: rgba(239, 68, 68, 0.3);
      }
      .pnq-cp-btn-stop:hover {
        background: rgba(239, 68, 68, 0.2);
        border-color: #ef4444;
      }
      .pnq-cp-btn-wipe {
        color: #fb923c;
        border-color: rgba(249, 115, 22, 0.3);
      }
      .pnq-cp-btn-wipe:hover {
        background: rgba(249, 115, 22, 0.2);
        border-color: #f97316;
      }
      .pnq-cp-footer {
        padding: 10px 18px;
        background: rgba(0, 0, 0, 0.25);
        border-top: 1px solid var(--pnq-card-border, rgba(168, 85, 247, 0.15));
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: var(--pnq-text-muted, #c4b5fd);
      }
      .pnq-cp-footer-hints {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .pnq-cp-hint-key {
        display: inline-block;
        padding: 1px 5px;
        background: rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        font-weight: 600;
        margin-right: 4px;
        color: var(--pnq-text, #ffffff);
      }
      .pnq-cp-empty {
        padding: 32px 16px;
        text-align: center;
        color: var(--pnq-text-muted, #c4b5fd);
        font-size: 14px;
      }

      .pnq-cp-type-badge {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        padding: 1px 6px;
        border-radius: 4px;
        letter-spacing: 0.5px;
        background: rgba(168, 85, 247, 0.16);
        color: #c084fc;
        border: 1px solid rgba(168, 85, 247, 0.35);
      }
      .pnq-cp-type-badge.iol {
        background: rgba(59, 130, 246, 0.16);
        color: #60a5fa;
        border-color: rgba(59, 130, 246, 0.35);
      }
      .pnq-cp-type-badge.qemu {
        background: rgba(245, 158, 11, 0.16);
        color: #fbbf24;
        border-color: rgba(245, 158, 11, 0.35);
      }
      .pnq-cp-type-badge.docker {
        background: rgba(14, 165, 233, 0.16);
        color: #38bdf8;
        border-color: rgba(14, 165, 233, 0.35);
      }
      .pnq-cp-type-badge.dynamips {
        background: rgba(236, 72, 153, 0.16);
        color: #f472b6;
        border-color: rgba(236, 72, 153, 0.35);
      }

      /* Pulse glow animation #38bdf8 in 4 seconds - NO transform: scale to avoid overriding Svelte Flow inline translate() */
      @keyframes pnqNodePulseHighlight38bdf8 {
        0% {
          outline: 4px solid #38bdf8;
          box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.85), 0 0 35px #38bdf8;
        }
        25% {
          outline: 6px solid #7dd3fc;
          box-shadow: 0 0 0 16px rgba(56, 189, 248, 0.25), 0 0 50px #38bdf8;
        }
        50% {
          outline: 4px solid #38bdf8;
          box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.8), 0 0 35px #38bdf8;
        }
        75% {
          outline: 6px solid #7dd3fc;
          box-shadow: 0 0 0 16px rgba(56, 189, 248, 0), 0 0 45px #38bdf8;
        }
        100% {
          outline: 4px solid rgba(56, 189, 248, 0);
          box-shadow: 0 0 0 0 rgba(56, 189, 248, 0), 0 0 0 transparent;
        }
      }
      .pnq-node-highlight {
        animation: pnqNodePulseHighlight38bdf8 4s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
        z-index: 1000 !important;
      }
      .pnq-node-highlight .pnq-node__icon,
      .pnq-node-highlight img {
        filter: drop-shadow(0 0 15px #38bdf8) !important;
      }
    `;
    document.head.appendChild(style);
  }

  var currentSelectedIndex = 0;
  var filteredNodes = [];

  function getRawNodes() {
    var raw = {};
    if (window.__pnqCanvas && window.__pnqCanvas.rawNodes) {
      Object.assign(raw, window.__pnqCanvas.rawNodes);
    }
    if (window.nodes) {
      // In classic or stub, window.nodes may have objects or accessors
      Object.keys(window.nodes).forEach(function (k) {
        var nodeObj = window.nodes[k];
        if (nodeObj && typeof nodeObj.getAll === 'function') {
          raw[k] = Object.assign({}, raw[k] || {}, nodeObj.getAll());
        } else if (nodeObj && typeof nodeObj === 'object') {
          raw[k] = Object.assign({}, raw[k] || {}, nodeObj);
        }
      });
    }
    if (window.PNQStore && window.PNQStore.state && window.PNQStore.state.nodes) {
      Object.keys(window.PNQStore.state.nodes).forEach(function (k) {
        raw[k] = Object.assign({}, raw[k] || {}, window.PNQStore.state.nodes[k]);
      });
    }
    return raw;
  }

  function resolveNodeType(n, stNode, rawNode) {
    var candidate = (n.type || (rawNode && rawNode.type) || n.template || (rawNode && rawNode.template) || (stNode && stNode.type) || '').toLowerCase();
    
    // Check known keywords in type or template
    if (candidate.indexOf('qemu') !== -1) return 'QEMU';
    if (candidate.indexOf('iol') !== -1) return 'IOL';
    if (candidate.indexOf('docker') !== -1) return 'DOCKER';
    if (candidate.indexOf('dynamips') !== -1) return 'DYNAMIPS';
    if (candidate.indexOf('vpcs') !== -1) return 'VPCS';

    // Fallback: deduce from image name or extension
    var img = (n.image || (rawNode && rawNode.image) || (stNode && stNode.image) || '').toLowerCase();
    if (img.endsWith('.bin') || img.indexOf('adventerprise') !== -1 || img.indexOf('iron') !== -1) {
      return 'IOL';
    }
    if (img.endsWith('.qcow2') || img.endsWith('.img') || img.endsWith('.vmdk')) {
      return 'QEMU';
    }

    if (candidate) return candidate.toUpperCase();
    return '';
  }

  function getFullNodeList() {
    var raw = getRawNodes();
    var list = [];
    var storeNodes = (window.PNQStore && window.PNQStore.state && window.PNQStore.state.nodes) || {};

    Object.keys(raw).forEach(function (id) {
      var n = raw[id] || {};
      var stNode = storeNodes[id] || {};

      var iconPath = n.icon || stNode.icon || 'Router.png';
      if (!iconPath.includes('/')) {
        iconPath = '/images/icons/' + iconPath;
      }

      var status = (stNode.status !== undefined) ? stNode.status : (n.status !== undefined ? n.status : 0);
      var isRunning = (status === 2 || status === 3);

      var typeStr = resolveNodeType(n, stNode, raw[id]);

      list.push({
        id: String(id),
        name: n.name || stNode.name || ('Node ' + id),
        type: typeStr,
        image: n.image || stNode.image || '',
        status: status,
        isRunning: isRunning,
        icon: iconPath,
        left: (stNode.left !== undefined) ? stNode.left : (n.left || 0),
        top: (stNode.top !== undefined) ? stNode.top : (n.top || 0),
        console: n.console || 'telnet'
      });
    });

    list.sort(function (a, b) {
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });

    return list;
  }

  function createPaletteDOM() {
    if (document.getElementById(MODAL_ID)) return;
    injectStyles();

    var overlay = document.createElement('div');
    overlay.id = MODAL_ID;

    overlay.innerHTML = `
      <div class="pnq-cp-dialog" role="dialog" aria-modal="true">
        <div class="pnq-cp-search-wrap">
          <i class="fa fa-search pnq-cp-search-icon"></i>
          <input type="text" class="pnq-cp-input" placeholder="Search device name, ID (e.g. 1), type (IOL, QEMU), or image..." autocomplete="off" spellcheck="false" />
          <span class="pnq-cp-badge-esc" title="Close (Esc)">ESC</span>
        </div>
        <ul class="pnq-cp-list" id="pnq-cp-results"></ul>
        <div class="pnq-cp-footer">
          <div class="pnq-cp-footer-hints">
            <span><span class="pnq-cp-hint-key">↵</span> Highlight</span>
            <span><span class="pnq-cp-hint-key">⇧↵</span> Web Console</span>
            <span><span class="pnq-cp-hint-key">↑↓</span> Navigate</span>
          </div>
          <div><span id="pnq-cp-count">0</span> nodes found</div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    var input = overlay.querySelector('.pnq-cp-input');
    var escBadge = overlay.querySelector('.pnq-cp-badge-esc');

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        closePalette();
      }
    });

    escBadge.addEventListener('click', function () {
      closePalette();
    });

    input.addEventListener('input', function () {
      renderResults(input.value.trim());
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filteredNodes.length > 0) {
          var targetNode = filteredNodes[currentSelectedIndex];
          if (targetNode) {
            if (e.shiftKey) {
              openConsole(targetNode.id);
            } else {
              highlightNodeInPlace(targetNode.id);
            }
            closePalette();
          }
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closePalette();
      }
    });
  }

  function moveSelection(step) {
    if (filteredNodes.length === 0) return;
    currentSelectedIndex = (currentSelectedIndex + step + filteredNodes.length) % filteredNodes.length;
    updateSelectionHighlight();
  }

  function updateSelectionHighlight() {
    var items = document.querySelectorAll('#pnq-cp-results .pnq-cp-item');
    items.forEach(function (el, idx) {
      if (idx === currentSelectedIndex) {
        el.classList.add('selected');
        el.scrollIntoView({ block: 'nearest' });
      } else {
        el.classList.remove('selected');
      }
    });
  }

  function renderResults(filterText) {
    var list = getFullNodeList();
    if (filterText) {
      var query = filterText.toLowerCase();
      filteredNodes = list.filter(function (node) {
        var matchName = node.name.toLowerCase().includes(query);
        var matchId = node.id === query || ('node ' + node.id) === query || ('#' + node.id) === query;
        var matchType = node.type.toLowerCase().includes(query);
        var matchImage = node.image.toLowerCase().includes(query);
        return matchName || matchId || matchType || matchImage;
      });
    } else {
      filteredNodes = list;
    }

    currentSelectedIndex = 0;
    var container = document.getElementById('pnq-cp-results');
    var countEl = document.getElementById('pnq-cp-count');
    if (countEl) countEl.textContent = String(filteredNodes.length);

    if (!container) return;
    container.innerHTML = '';

    if (filteredNodes.length === 0) {
      container.innerHTML = '<div class="pnq-cp-empty">No matching devices found in this lab</div>';
      return;
    }

    filteredNodes.forEach(function (node, idx) {
      var li = document.createElement('li');
      li.className = 'pnq-cp-item' + (idx === 0 ? ' selected' : '');
      li.dataset.nodeId = node.id;

      var badgeHtml = '';
      if (node.type && node.type !== 'DEVICE') {
        var badgeCls = node.type.toLowerCase();
        badgeHtml = `<span class="pnq-cp-type-badge ${badgeCls}">${escapeHtml(node.type)}</span>`;
      }

      li.innerHTML = `
        <div class="pnq-cp-item-main">
          <img class="pnq-cp-item-icon" src="${node.icon}" alt="" onerror="this.src='/images/icons/Router.png'" />
          <div class="pnq-cp-item-details">
            <div class="pnq-cp-item-header">
              <span class="pnq-cp-item-name">${escapeHtml(node.name)}</span>
              <span class="pnq-cp-node-id">#${node.id}</span>
              ${badgeHtml}
              <span class="pnq-cp-status-pill ${node.isRunning ? 'running' : 'stopped'}">
                <span class="pnq-cp-status-dot"></span>
                ${node.isRunning ? 'Running' : 'Stopped'}
              </span>
            </div>
            <div class="pnq-cp-item-sub">${escapeHtml(node.image ? node.image : '')}</div>
          </div>
        </div>
        <div class="pnq-cp-item-actions">
          <button class="pnq-cp-btn pnq-cp-btn-console" title="Open Web Console (Shift+Enter)">
            <i class="fa fa-terminal"></i> Console
          </button>
          <button class="pnq-cp-btn pnq-cp-btn-start" title="Start device"><i class="fa fa-play"></i> Start</button>
          <button class="pnq-cp-btn pnq-cp-btn-stop" title="Stop device"><i class="fa fa-stop"></i> Stop</button>
          <button class="pnq-cp-btn" data-action="restart" title="Restart device"><i class="fa fa-refresh"></i></button>
          <button class="pnq-cp-btn pnq-cp-btn-wipe" data-action="wipe" title="Wipe node configurations"><i class="fa fa-eraser"></i> Wipe</button>
        </div>
      `;

      // Item click = Phát sáng tại chỗ (KHÔNG cuộn canvas)
      li.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        highlightNodeInPlace(node.id);
        closePalette();
      });

      // Actions click
      var btnConsole = li.querySelector('.pnq-cp-btn-console');
      if (btnConsole) {
        btnConsole.addEventListener('click', function (e) {
          e.stopPropagation();
          openConsole(node.id);
          closePalette();
        });
      }

      var btnStart = li.querySelector('.pnq-cp-btn-start');
      if (btnStart) {
        btnStart.addEventListener('click', function (e) {
          e.stopPropagation();
          startNode(node.id, li);
        });
      }

      var btnStop = li.querySelector('.pnq-cp-btn-stop');
      if (btnStop) {
        btnStop.addEventListener('click', function (e) {
          e.stopPropagation();
          stopNode(node.id, li);
        });
      }

      var btnRestart = li.querySelector('[data-action="restart"]');
      if (btnRestart) {
        btnRestart.addEventListener('click', function (e) {
          e.stopPropagation();
          restartNode(node.id, li);
        });
      }

      var btnWipe = li.querySelector('[data-action="wipe"]');
      if (btnWipe) {
        btnWipe.addEventListener('click', function (e) {
          e.stopPropagation();
          wipeNode(node.id, li);
        });
      }

      container.appendChild(li);
    });
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function openPalette() {
    createPaletteDOM();
    var palette = document.getElementById(MODAL_ID);
    if (!palette) return;

    var input = palette.querySelector('.pnq-cp-input');
    if (input) input.value = '';
    
    renderResults('');
    palette.classList.add('open');
    setTimeout(function () {
      if (input) input.focus();
    }, 50);
  }

  function closePalette() {
    var palette = document.getElementById(MODAL_ID);
    if (palette) {
      palette.classList.remove('open');
    }
  }

  /* 2. Phát sáng tại chỗ (#38bdf8 trong 4s) - KHÔNG di chuyển/cuộn canvas */
  function highlightNodeInPlace(nodeId) {
    var idStr = String(nodeId);
    
    // Check flow island node
    var island = document.getElementById('pnq-island-canvas-flow');
    var nodeEl = null;

    if (island) {
      nodeEl = island.querySelector('.svelte-flow__node[data-id="' + idStr + '"]');
    }
    if (!nodeEl) {
      nodeEl = document.getElementById('node' + idStr);
    }

    if (nodeEl) {
      applyHighlight(nodeEl);
    }
  }

  function applyHighlight(element) {
    if (!element) return;
    // Prefer inner wrapper/icon if inside Svelte Flow so the root node's transform is completely untouched
    var target = element.querySelector('.pnq-node__body') ||
                 element.querySelector('.pnq-node') ||
                 element.querySelector('.pnq-node__icon') ||
                 element.querySelector('img') ||
                 element;

    target.classList.remove('pnq-node-highlight');
    void target.offsetWidth; // Force CSS animation reflow
    target.classList.add('pnq-node-highlight');
    setTimeout(function () {
      target.classList.remove('pnq-node-highlight');
    }, 4000);
  }

  /* 3. Mở nhanh Web Console / Telnet */
  function openConsole(nodeId) {
    if (typeof window.pnqOpenConsoleAuto === 'function') {
      window.pnqOpenConsoleAuto(nodeId);
    } else if (typeof window.pnqOpenWebConsole === 'function') {
      window.pnqOpenWebConsole(nodeId);
    } else if (typeof window.openNodeConsole === 'function') {
      window.openNodeConsole(nodeId);
    } else {
      window.open('/console/console.html?node=' + encodeURIComponent(nodeId), '_blank');
    }
  }

  /* 4. Điều khiển nguồn & Dữ liệu riêng lẻ */
  function notify(type, text) {
    if (typeof window.addMessage === 'function') {
      window.addMessage(type, text);
    } else {
      console.log('[' + type + '] ' + text);
    }
  }

  function startNode(nodeId, itemEl) {
    if (typeof window.start === 'function') {
      window.start(nodeId);
    } else {
      $.ajax({
        url: '/api/labs/session/nodes/start',
        type: 'POST',
        data: { id: nodeId },
        dataType: 'json',
        success: function (res) {
          if (res && res.status === 'success') {
            notify('success', 'Device started successfully');
          } else {
            notify('danger', (res && res.message) || 'Failed to start device');
          }
        }
      });
    }
    updateNodeStatusPill(itemEl, true);
  }

  function stopNode(nodeId, itemEl) {
    if (typeof window.stop === 'function') {
      window.stop(nodeId);
    } else {
      $.ajax({
        url: '/api/labs/session/nodes/stop',
        type: 'POST',
        data: { id: nodeId },
        dataType: 'json',
        success: function (res) {
          if (res && res.status === 'success') {
            notify('success', 'Device stopped successfully');
          } else {
            notify('danger', (res && res.message) || 'Failed to stop device');
          }
        }
      });
    }
    updateNodeStatusPill(itemEl, false);
  }

  function restartNode(nodeId, itemEl) {
    notify('info', 'Restarting node ' + nodeId + '...');
    stopNode(nodeId, itemEl);
    setTimeout(function () {
      startNode(nodeId, itemEl);
    }, 1200);
  }

  function wipeNode(nodeId, itemEl) {
    if (confirm('Are you sure you want to wipe configuration for this node?')) {
      if (typeof window.wipe === 'function') {
        window.wipe(nodeId);
      } else {
        $.ajax({
          url: '/api/labs/session/nodes/wipe',
          type: 'POST',
          data: { id: nodeId },
          dataType: 'json',
          success: function (res) {
            if (res && res.status === 'success') {
              notify('success', 'Node wiped clean');
            } else {
              notify('danger', (res && res.message) || 'Failed to wipe node');
            }
          }
        });
      }
      updateNodeStatusPill(itemEl, false);
    }
  }

  function updateNodeStatusPill(itemEl, isRunning) {
    if (!itemEl) return;
    var pill = itemEl.querySelector('.pnq-cp-status-pill');
    if (pill) {
      pill.className = 'pnq-cp-status-pill ' + (isRunning ? 'running' : 'stopped');
      pill.innerHTML = '<span class="pnq-cp-status-dot"></span>' + (isRunning ? 'Running' : 'Stopped');
    }
  }

  // Global Keyboard Listener: Ctrl+K / Cmd+K
  document.addEventListener('keydown', function (e) {
    var isCtrlK = (e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K');
    if (isCtrlK) {
      e.preventDefault();
      var palette = document.getElementById(MODAL_ID);
      if (palette && palette.classList.contains('open')) {
        closePalette();
      } else {
        openPalette();
      }
    }
  });

  // Export to window for programmatic access
  window.pnqCommandPalette = {
    open: openPalette,
    close: closePalette,
    highlightNode: highlightNodeInPlace,
    openConsole: openConsole
  };

})();
