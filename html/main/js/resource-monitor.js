/* ============================================================================
   PNetLab dashboard — User Resources & Integrated Host Telemetry Log (admin-only)
   Combines live real-time SVG charts (CPU, RAM & Disk like History view),
   multi-range historical telemetry (Live, 1h, 6h, 24h, 7d, 30d),
   Per-User Resource Allocation, and Host Overload Incident Log with Disk metrics.
   CSP-safe: pure DOM construction, SVG vector rendering, no eval / inline handlers.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var SVGNS = 'http://www.w3.org/2000/svg';
	var RANGES = ['Live', '1h', '6h', '24h', '7d', '30d'];
	var currentRange = 'Live';
	var poller = null;
	var autoRefresh = true;
	var lastData = null;
	var searchQuery = '';
	var incidentSeverityFilter = 'all'; // 'all' | 'critical' | 'warning'
	var incidentList = [];
	var resizeHandler = null, resizeDebounce = null;
	var cachedHistory = {};

	// Rolling buffers for real-time SVG wave charts (up to 30 data points)
	var MAX_POINTS = 30;
	var liveCpuPoints = [];  // [{ts, v}]
	var liveRamPoints = [];  // [{ts, v}]
	var liveDiskPoints = []; // [{ts, v}]
	var maxRamMb = 8192;
	var maxDiskMb = 40960;

	function post(url, obj) {
		return App.api(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(obj || {})
		});
	}

	function svgEl(tag, attrs) {
		var e = document.createElementNS(SVGNS, tag);
		if (attrs) {
			for (var k in attrs) e.setAttribute(k, attrs[k]);
		}
		return e;
	}

	function viewTitle(text, icon) {
		var t = el('div', 'view-title');
		t.appendChild(el('i', 'fa ' + icon));
		t.appendChild(document.createTextNode(' ' + text));
		return t;
	}

	function fmtMb(mb) {
		if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
		return Math.round(mb) + ' MB';
	}

	function fmtTs(ts) {
		if (!ts) return '—';
		var d = new Date(ts * 1000);
		var pad = function (n) { return (n < 10 ? '0' : '') + n; };
		return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
			   pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
	}

	function fmtClock(ts, span) {
		if (!ts) return '';
		var d = new Date(ts * 1000);
		var pad = function (n) { return (n < 10 ? '0' : '') + n; };
		if (span && span > 172800) return (d.getMonth() + 1) + '/' + d.getDate();
		return pad(d.getHours()) + ':' + pad(d.getMinutes()) + (span && span > 3600 ? '' : (':' + pad(d.getSeconds())));
	}

	/* ---- SVG Polyline & Area Chart (Style identical to History) ---- */
	function renderSvgChart(pts, opts, widthPx) {
		var W = (widthPx && widthPx > 50) ? Math.round(widthPx) : 400;
		var H = 150, padL = 46, padR = 10, padT = 12, padB = 22;
		var svg = svgEl('svg', {
			viewBox: '0 0 ' + W + ' ' + H,
			preserveAspectRatio: 'none',
			'class': 'hist-chart'
		});
		svg.style.width = '100%';
		svg.style.height = '150px';
		svg.style.display = 'block';

		var ymax = opts.ymax || 100;
		if (pts.length) {
			var highest = 0;
			pts.forEach(function (p) { if (p.v > highest) highest = p.v; });
			if (opts.autoMax && highest > ymax) ymax = Math.ceil(highest * 1.15);
		}

		var iw = W - padL - padR, ih = H - padT - padB;
		var t0 = pts.length ? pts[0].ts : Math.floor(Date.now() / 1000) - 150;
		var t1 = pts.length ? pts[pts.length - 1].ts : Math.floor(Date.now() / 1000);
		var span = Math.max(1, t1 - t0);

		function X(ts) { return padL + (span ? (ts - t0) / span : 0) * iw; }
		function Y(v) { return padT + ih - Math.max(0, Math.min(1, v / ymax)) * ih; }

		// 4 Horizontal Gridlines & Y-axis labels
		for (var i = 0; i <= 4; i++) {
			var yv = ymax * i / 4;
			var y = Y(yv);
			svg.appendChild(svgEl('line', {
				x1: padL, y1: y, x2: W - padR, y2: y,
				stroke: 'var(--pnq-border, rgba(0,0,0,0.08))', 'stroke-width': '1'
			}));
			var lab = svgEl('text', {
				x: padL - 8, y: y + 4, 'text-anchor': 'end',
				'font-size': '10', fill: 'var(--pnq-text-dim, #6b7280)'
			});
			lab.textContent = opts.yfmt ? opts.yfmt(yv) : Math.round(yv);
			svg.appendChild(lab);
		}

		// 5 Time ticks along X-axis
		for (var j = 0; j <= 4; j++) {
			var ts = t0 + span * j / 4;
			var xl = svgEl('text', {
				x: X(ts), y: H - 5,
				'text-anchor': j === 0 ? 'start' : (j === 4 ? 'end' : 'middle'),
				'font-size': '10', fill: 'var(--pnq-text-dim, #6b7280)'
			});
			xl.textContent = fmtClock(ts, span);
			svg.appendChild(xl);
		}

		if (!pts.length) {
			var emptyMsg = svgEl('text', {
				x: W / 2, y: H / 2, 'text-anchor': 'middle',
				'font-size': '12', fill: 'var(--pnq-text-dim, #9ca3af)'
			});
			emptyMsg.textContent = 'Collecting telemetry…';
			svg.appendChild(emptyMsg);
			return svg;
		}

		// Polyline & Polygon Area Fill
		var line = '';
		pts.forEach(function (p, idx) {
			var pt = X(p.ts).toFixed(1) + ',' + Y(p.v).toFixed(1);
			line += (idx ? ' ' : '') + pt;
		});

		var area = padL + ',' + (padT + ih) + ' ' + line + ' ' + X(t1).toFixed(1) + ',' + (padT + ih);
		svg.appendChild(svgEl('polygon', {
			points: area,
			fill: opts.color || 'var(--pnq-accent, #2f81f7)',
			'fill-opacity': '0.12',
			stroke: 'none'
		}));

		svg.appendChild(svgEl('polyline', {
			points: line,
			fill: 'none',
			stroke: opts.color || 'var(--pnq-accent, #2f81f7)',
			'stroke-width': '1.8',
			'vector-effect': 'non-scaling-stroke',
			'stroke-linejoin': 'round'
		}));

		// Current value pulsing dot on latest point if live
		if (opts.showDot && pts.length) {
			var lastPt = pts[pts.length - 1];
			svg.appendChild(svgEl('circle', {
				cx: X(lastPt.ts), cy: Y(lastPt.v), r: '4',
				fill: opts.color || '#2f81f7',
				stroke: '#fff', 'stroke-width': '1.5'
			}));
		}

		return svg;
	}

	/* ---- KPI card builder ---- */
	function renderKpi(title, value, subtext, colorCls, progressPct) {
		var card = el('div', 'card');
		card.style.cssText = 'flex:1;min-width:180px;padding:14px;box-sizing:border-box;margin-bottom:0;';
		var titleEl = el('div', 'muted', title);
		titleEl.style.cssText = 'font-size:11px;text-transform:uppercase;font-weight:600;letter-spacing:0.5px;';
		card.appendChild(titleEl);

		var valEl = el('div', null, value);
		valEl.style.cssText = 'font-size:20px;font-weight:bold;margin:4px 0;color:' + (colorCls || 'inherit') + ';';
		card.appendChild(valEl);

		if (progressPct !== undefined && progressPct !== null) {
			var progWrap = el('div');
			progWrap.style.cssText = 'width:100%;height:5px;background:rgba(0,0,0,0.08);border-radius:3px;overflow:hidden;margin-bottom:4px;';
			var progBar = el('div');
			progBar.style.cssText = 'height:100%;width:' + Math.min(100, Math.max(0, progressPct)) + '%;background:' + (colorCls || '#3b82f6') + ';border-radius:3px;transition:width 0.3s;';
			progWrap.appendChild(progBar);
			card.appendChild(progWrap);
		}

		if (subtext) {
			var subEl = el('div', 'muted', subtext);
			subEl.style.fontSize = '11px';
			card.appendChild(subEl);
		}
		return card;
	}

	/* ---- Main unified view render ---- */
	function render(viewEl) {
		stopPolling();
		currentRange = 'Live';
		searchQuery = '';
		incidentSeverityFilter = 'all';

		var head = el('div', 'view-head vh-ruled');
		var left = el('div');
		left.style.cssText = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap;';
		left.appendChild(viewTitle('User Resources & Host Telemetry', 'fa-tachometer'));

		var pulseBadge = el('span', 'rl-livecount');
		pulseBadge.id = 'urm-pulse';
		pulseBadge.appendChild(el('span', 'rl-pulse'));
		pulseBadge.appendChild(document.createTextNode('Integrated Telemetry & Logs'));
		left.appendChild(pulseBadge);
		head.appendChild(left);

		var actions = el('div');
		actions.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';

		// Range selector buttons (Live + History 1h, 6h, 24h, 7d, 30d)
		var rangeGroup = el('div');
		rangeGroup.id = 'urm-range-group';
		rangeGroup.style.cssText = 'display:flex;gap:4px;';
		RANGES.forEach(function (r) {
			var btn = el('button', 'btn btn-sm btn-ghost' + (r === currentRange ? ' is-active' : ''));
			btn.type = 'button';
			btn.setAttribute('data-range', r);
			btn.appendChild(document.createTextNode(r));
			if (r === currentRange) {
				btn.style.cssText = 'border-color:var(--pnq-accent,#2f81f7);color:var(--pnq-accent,#2f81f7);font-weight:600;';
			}
			btn.addEventListener('click', function () {
				currentRange = r;
				rangeGroup.querySelectorAll('button').forEach(function (b) {
					b.style.cssText = '';
					if (b.getAttribute('data-range') === currentRange) {
						b.style.cssText = 'border-color:var(--pnq-accent,#2f81f7);color:var(--pnq-accent,#2f81f7);font-weight:600;';
					}
				});
				if (currentRange === 'Live') {
					renderLiveCharts();
				} else {
					loadHistoricalRange(currentRange);
				}
			});
			rangeGroup.appendChild(btn);
		});
		actions.appendChild(rangeGroup);

		var refreshBtn = el('button', 'btn btn-sm btn-ghost');
		refreshBtn.type = 'button';
		refreshBtn.appendChild(el('i', 'fa fa-refresh'));
		refreshBtn.appendChild(document.createTextNode(' Refresh'));
		refreshBtn.addEventListener('click', function () {
			refreshBtn.disabled = true;
			loadData().then(function () { refreshBtn.disabled = false; });
		});
		actions.appendChild(refreshBtn);

		var autoBtn = el('button', 'btn btn-sm ' + (autoRefresh ? 'btn-primary' : 'btn-ghost'));
		autoBtn.id = 'urm-auto-btn';
		autoBtn.type = 'button';
		autoBtn.appendChild(el('i', 'fa ' + (autoRefresh ? 'fa-play' : 'fa-pause')));
		autoBtn.appendChild(document.createTextNode(autoRefresh ? ' Auto (5s)' : ' Paused'));
		autoBtn.addEventListener('click', function () {
			autoRefresh = !autoRefresh;
			autoBtn.className = 'btn btn-sm ' + (autoRefresh ? 'btn-primary' : 'btn-ghost');
			autoBtn.innerHTML = '';
			autoBtn.appendChild(el('i', 'fa ' + (autoRefresh ? 'fa-play' : 'fa-pause')));
			autoBtn.appendChild(document.createTextNode(autoRefresh ? ' Auto (5s)' : ' Paused'));
			if (autoRefresh) startPolling();
			else stopPolling();
		});
		actions.appendChild(autoBtn);

		head.appendChild(actions);
		viewEl.appendChild(head);

		// Main Unified Wrapper
		var mainWrap = el('div');
		mainWrap.id = 'urm-unified-wrap';
		mainWrap.style.cssText = 'display:flex;flex-direction:column;gap:16px;margin-top:12px;';
		viewEl.appendChild(mainWrap);

		// 1. Telemetry Charts Row (CPU, Memory, Disk - 3 Cards Side-by-Side)
		var chartsRow = el('div');
		chartsRow.id = 'urm-charts-row';
		chartsRow.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;';

		// CPU Chart Pane
		var cpuPane = el('div', 'card');
		cpuPane.style.cssText = 'flex:1;min-width:280px;padding:14px;box-sizing:border-box;margin-bottom:0;';
		var cpuHead = el('div', 'card-title');
		cpuHead.appendChild(el('i', 'fa fa-microchip'));
		cpuHead.appendChild(document.createTextNode(' Host CPU'));
		cpuPane.appendChild(cpuHead);
		var cpuSub = el('p', 'muted', 'Host CPU utilization across cores • Loading…');
		cpuSub.id = 'urm-cpu-sub';
		cpuSub.style.marginBottom = '8px';
		cpuPane.appendChild(cpuSub);
		var cpuBody = el('div');
		cpuBody.id = 'urm-cpu-chart-body';
		cpuPane.appendChild(cpuBody);
		chartsRow.appendChild(cpuPane);

		// RAM Chart Pane
		var ramPane = el('div', 'card');
		ramPane.style.cssText = 'flex:1;min-width:280px;padding:14px;box-sizing:border-box;margin-bottom:0;';
		var ramHead = el('div', 'card-title');
		ramHead.appendChild(el('i', 'fa fa-database'));
		ramHead.appendChild(document.createTextNode(' Host Memory'));
		ramPane.appendChild(ramHead);
		var ramSub = el('p', 'muted', 'RAM allocation & usage • Loading…');
		ramSub.id = 'urm-ram-sub';
		ramSub.style.marginBottom = '8px';
		ramPane.appendChild(ramSub);
		var ramBody = el('div');
		ramBody.id = 'urm-ram-chart-body';
		ramPane.appendChild(ramBody);
		chartsRow.appendChild(ramPane);

		// Disk Chart Pane (NEW!)
		var diskPane = el('div', 'card');
		diskPane.style.cssText = 'flex:1;min-width:280px;padding:14px;box-sizing:border-box;margin-bottom:0;';
		var diskHead = el('div', 'card-title');
		diskHead.appendChild(el('i', 'fa fa-hdd-o'));
		diskHead.appendChild(document.createTextNode(' Root Filesystem (Disk)'));
		diskPane.appendChild(diskHead);
		var diskSub = el('p', 'muted', 'Root filesystem storage • Loading…');
		diskSub.id = 'urm-disk-sub';
		diskSub.style.marginBottom = '8px';
		diskPane.appendChild(diskSub);
		var diskBody = el('div');
		diskBody.id = 'urm-disk-chart-body';
		diskPane.appendChild(diskBody);
		chartsRow.appendChild(diskPane);

		mainWrap.appendChild(chartsRow);

		// 2. Server KPI Row (CPU, RAM, DISK, Nodes, Status)
		var kpiRow = el('div');
		kpiRow.id = 'urm-kpi-row';
		kpiRow.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;';
		mainWrap.appendChild(kpiRow);

		// 3. User Allocation Table Card
		var userCard = el('div', 'card');
		userCard.id = 'urm-user-card';
		userCard.style.padding = '0';

		var userBar = el('div');
		userBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--pnq-border, #e5e7eb);gap:12px;flex-wrap:wrap;';
		var userBarTitle = el('div');
		userBarTitle.style.fontWeight = '600';
		userBarTitle.id = 'urm-user-title';
		userBarTitle.appendChild(document.createTextNode('Per-User Resource Allocation'));
		userBar.appendChild(userBarTitle);

		var searchInput = el('input');
		searchInput.type = 'text';
		searchInput.placeholder = 'Search user, email, or pod…';
		searchInput.value = searchQuery;
		searchInput.style.cssText = 'padding:6px 12px;border:1px solid var(--pnq-border, #ccc);border-radius:4px;font-size:13px;width:240px;';
		searchInput.addEventListener('input', function (e) {
			searchQuery = e.target.value.toLowerCase();
			if (lastData && lastData.users) drawTableBody(lastData.users);
		});
		userBar.appendChild(searchInput);
		userCard.appendChild(userBar);

		var userTableWrap = el('div');
		userTableWrap.style.overflowX = 'auto';
		var userTable = el('table', 'table');
		userTable.style.cssText = 'width:100%;border-collapse:collapse;margin:0;';
		var uThead = el('thead');
		var uTr = el('tr');
		['User / Email', 'Active Labs', 'Running Nodes', 'Host CPU (%)', 'RAM Consumed', 'Health Status', 'Actions'].forEach(function (h) {
			var th = el('th');
			th.style.padding = '10px 14px';
			th.appendChild(document.createTextNode(h));
			uTr.appendChild(th);
		});
		uThead.appendChild(uTr);
		userTable.appendChild(uThead);

		var uTbody = el('tbody');
		uTbody.id = 'urm-table-body';
		userTable.appendChild(uTbody);
		userTableWrap.appendChild(userTable);
		userCard.appendChild(userTableWrap);
		mainWrap.appendChild(userCard);

		// 4. Host Overload Incident Log (with Disk column!)
		var incidentCard = el('div', 'card');
		incidentCard.id = 'urm-incident-card';
		incidentCard.style.padding = '0';

		var incBar = el('div');
		incBar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--pnq-border, #e5e7eb);gap:12px;flex-wrap:wrap;';
		var incBarTitle = el('div');
		incBarTitle.style.fontWeight = '600';
		incBarTitle.id = 'urm-incident-title';
		incBarTitle.appendChild(document.createTextNode('Host Overload Incident Log (Recorded when CPU/RAM >= 80% or Disk >= 90%)'));
		incBar.appendChild(incBarTitle);

		var incControls = el('div');
		incControls.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';

		// Severity filter dropdown
		var sevSelect = el('select');
		sevSelect.style.cssText = 'padding:5px 8px;border:1px solid var(--pnq-border, #ccc);border-radius:4px;font-size:12px;';
		var optAll = el('option', null, 'All Severities');
		optAll.value = 'all';
		var optCrit = el('option', null, 'Critical Only (>= 90%)');
		optCrit.value = 'critical';
		var optWarn = el('option', null, 'Warning Only (80-89%)');
		optWarn.value = 'warning';
		sevSelect.appendChild(optAll);
		sevSelect.appendChild(optCrit);
		sevSelect.appendChild(optWarn);
		sevSelect.value = incidentSeverityFilter;
		sevSelect.addEventListener('change', function () {
			incidentSeverityFilter = sevSelect.value;
			drawIncidentRows(incidentList);
		});
		incControls.appendChild(sevSelect);

		var expBtn = el('button', 'btn btn-sm btn-ghost');
		expBtn.type = 'button';
		expBtn.appendChild(el('i', 'fa fa-download'));
		expBtn.appendChild(document.createTextNode(' Export CSV'));
		expBtn.addEventListener('click', function () { exportHistoryCsv(incidentList); });
		incControls.appendChild(expBtn);

		var clearBtn = el('button', 'btn btn-sm btn-ghost');
		clearBtn.type = 'button';
		clearBtn.title = 'Clear incident records';
		clearBtn.appendChild(el('i', 'fa fa-trash'));
		clearBtn.appendChild(document.createTextNode(' Clear Log'));
		clearBtn.addEventListener('click', function () {
			if (!confirm('Are you sure you want to clear all recorded incident snapshots?')) return;
			post('/status/api.php?action=resource_incidents_clear').then(function () {
				loadIncidents();
			});
		});
		incControls.appendChild(clearBtn);

		incBar.appendChild(incControls);
		incidentCard.appendChild(incBar);

		var incTableWrap = el('div');
		incTableWrap.style.overflowX = 'auto';
		var incTable = el('table', 'table');
		incTable.style.cssText = 'width:100%;border-collapse:collapse;margin:0;';
		var incThead = el('thead');
		var incTr = el('tr');
		['Timestamp', 'Severity', 'Host CPU', 'Host RAM', 'Host Disk', 'Total Nodes', 'Top Resource Consumers'].forEach(function (h) {
			var th = el('th');
			th.style.padding = '10px 14px';
			th.appendChild(document.createTextNode(h));
			incTr.appendChild(th);
		});
		incThead.appendChild(incTr);
		incTable.appendChild(incThead);

		var incTbody = el('tbody');
		incTbody.id = 'urm-incident-tbody';
		incTable.appendChild(incTbody);
		incTableWrap.appendChild(incTable);
		incidentCard.appendChild(incTableWrap);

		// Guarantee footer note
		var noteBox = el('div');
		noteBox.style.cssText = 'padding:10px 16px;background:rgba(59,130,246,0.06);border-top:1px solid var(--pnq-border, #e5e7eb);font-size:12px;color:var(--pnq-text-dim, #4b5563);line-height:1.4;';
		noteBox.appendChild(document.createTextNode('📌 Safe Ring-Buffer Guarantee: Overload snapshots record top active consumers when CPU/RAM >= 80% or Disk >= 90%. Enforces a strict 1,000 incident FIFO cap and 14-day retention (~500 KB disk max) to protect host storage.'));
		incidentCard.appendChild(noteBox);

		mainWrap.appendChild(incidentCard);

		// Window resize listener to keep charts crisp 1:1
		resizeHandler = function () {
			if (resizeDebounce) clearTimeout(resizeDebounce);
			resizeDebounce = setTimeout(function () {
				if (document.getElementById('urm-cpu-chart-body')) {
					if (currentRange === 'Live') renderLiveCharts();
					else if (cachedHistory[currentRange]) renderHistoricalData(cachedHistory[currentRange]);
				}
			}, 180);
		};
		window.addEventListener('resize', resizeHandler);

		// Pre-populate initial wave buffer from history_sys if empty
		if (!liveCpuPoints.length) {
			App.api('/status/api.php?action=history_sys&range=1h').then(function (res) {
				var series = (res.body && res.body.data && res.body.data.series) ? res.body.data.series : [];
				if (series.length) {
					var recent = series.slice(-20);
					liveCpuPoints = recent.map(function (s) { return { ts: s.ts, v: s.cpu }; });
					liveRamPoints = recent.map(function (s) { return { ts: s.ts, v: s.ram_used }; });
					liveDiskPoints = recent.map(function (s) { return { ts: s.ts, v: s.disk_used }; });
					var last = recent[recent.length - 1];
					if (last.ram_total) maxRamMb = last.ram_total;
					if (last.disk_total) maxDiskMb = last.disk_total;
					if (currentRange === 'Live') renderLiveCharts();
				}
			}).catch(function () {});
		}

		loadData();
		if (autoRefresh) startPolling();
	}

	function startPolling() {
		stopPolling();
		poller = App.poll(loadData, { interval: 5000, maxInterval: 30000 });
		poller.start(true);
	}

	function stopPolling() {
		if (poller) { poller.stop(); poller = null; }
		if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
		if (resizeDebounce) { clearTimeout(resizeDebounce); resizeDebounce = null; }
	}

	/* ---- Fetch & Refresh Live Telemetry & Incidents ---- */
	function loadData() {
		var wrap = document.getElementById('urm-unified-wrap');
		if (!wrap) { stopPolling(); return Promise.resolve(); }

		var p1 = App.api('/status/api.php?action=user_resources').then(function (res) {
			if (!document.getElementById('urm-unified-wrap')) return;
			var data = (res.body && res.body.data) ? res.body.data : { server: {}, users: [] };
			lastData = data;
			updateLiveTelemetry(data);
		});

		var p2 = loadIncidents();

		return Promise.all([p1, p2]).catch(function () {});
	}

	function loadIncidents() {
		return App.api('/status/api.php?action=resource_incidents').then(function (res) {
			if (!document.getElementById('urm-incident-tbody')) return;
			incidentList = (res.body && res.body.data) ? res.body.data : [];
			drawIncidentRows(incidentList);
		}).catch(function () {});
	}

	/* ---- Load Historical Range (1h, 6h, 24h, 7d, 30d) ---- */
	function loadHistoricalRange(range) {
		var reqRange = range;
		App.api('/status/api.php?action=history_sys&range=' + reqRange).then(function (res) {
			var d = (res.body && res.body.data) || {};
			cachedHistory[reqRange] = d;
			if (currentRange === reqRange) {
				renderHistoricalData(d);
			}
		}).catch(function () {});
	}

	function renderHistoricalData(d) {
		var cpuBox = document.getElementById('urm-cpu-chart-body');
		var ramBox = document.getElementById('urm-ram-chart-body');
		var diskBox = document.getElementById('urm-disk-chart-body');
		if (!cpuBox || !ramBox || !diskBox) return;

		var series = d.series || [];
		if (!series.length) {
			cpuBox.innerHTML = '<p class="muted" style="padding:20px;text-align:center;">No samples in this range.</p>';
			ramBox.innerHTML = '<p class="muted" style="padding:20px;text-align:center;">No data.</p>';
			diskBox.innerHTML = '<p class="muted" style="padding:20px;text-align:center;">No data.</p>';
			return;
		}

		var cpuPts = series.map(function (s) { return { ts: s.ts, v: s.cpu }; });
		var ramPts = series.map(function (s) { return { ts: s.ts, v: s.ram_used }; });
		var dskPts = series.map(function (s) { return { ts: s.ts, v: s.disk_used }; });
		var last = series[series.length - 1];

		var cw = cpuBox.clientWidth || 360;
		var rw = ramBox.clientWidth || 360;
		var dw = diskBox.clientWidth || 360;

		cpuBox.innerHTML = '';
		cpuBox.appendChild(renderSvgChart(cpuPts, {
			ymax: 100, color: 'var(--pnq-accent, #2f81f7)',
			yfmt: function (v) { return Math.round(v) + '%'; }
		}, cw));
		var cpuSub = document.getElementById('urm-cpu-sub');
		if (cpuSub) cpuSub.textContent = 'Historical range: ' + currentRange + ' • Current: ' + last.cpu + '%';

		ramBox.innerHTML = '';
		ramBox.appendChild(renderSvgChart(ramPts, {
			ymax: last.ram_total || maxRamMb, autoMax: true, color: '#3fb950',
			yfmt: fmtMb
		}, rw));
		var ramSub = document.getElementById('urm-ram-sub');
		if (ramSub) ramSub.textContent = 'Used ' + fmtMb(last.ram_used) + ' of ' + fmtMb(last.ram_total);

		diskBox.innerHTML = '';
		diskBox.appendChild(renderSvgChart(dskPts, {
			ymax: last.disk_total || maxDiskMb, autoMax: true, color: '#d29922',
			yfmt: fmtMb
		}, dw));
		var diskSub = document.getElementById('urm-disk-sub');
		if (diskSub) diskSub.textContent = 'Used ' + fmtMb(last.disk_used) + ' of ' + fmtMb(last.disk_total);
	}

	/* ---- Update Live Metrics, Rolling Buffers & Charts ---- */
	function updateLiveTelemetry(data) {
		var server = data.server || {};
		var users = data.users || [];
		var now = Math.floor(Date.now() / 1000);

		var curCpu = (server.cpu !== undefined) ? server.cpu : 0;
		var curRamMb = server.ram_used_mb || 0;
		var curDiskMb = server.disk_used_mb || 0;

		if (server.ram_total_mb) maxRamMb = server.ram_total_mb;
		if (server.disk_total_mb) maxDiskMb = server.disk_total_mb;

		// Append to rolling buffers
		liveCpuPoints.push({ ts: now, v: curCpu });
		if (liveCpuPoints.length > MAX_POINTS) liveCpuPoints.shift();

		liveRamPoints.push({ ts: now, v: curRamMb });
		if (liveRamPoints.length > MAX_POINTS) liveRamPoints.shift();

		liveDiskPoints.push({ ts: now, v: curDiskMb });
		if (liveDiskPoints.length > MAX_POINTS) liveDiskPoints.shift();

		if (currentRange === 'Live') {
			renderLiveCharts();
		}

		// Update KPI Row
		drawKpiRow(server, users);

		// Update User Allocation Table
		drawTableBody(users);
	}

	function renderLiveCharts() {
		var cpuBox = document.getElementById('urm-cpu-chart-body');
		var ramBox = document.getElementById('urm-ram-chart-body');
		var diskBox = document.getElementById('urm-disk-chart-body');
		if (!cpuBox || !ramBox || !diskBox) return;

		var cw = cpuBox.clientWidth || 360;
		var rw = ramBox.clientWidth || 360;
		var dw = diskBox.clientWidth || 360;

		// 1. CPU
		cpuBox.innerHTML = '';
		cpuBox.appendChild(renderSvgChart(liveCpuPoints, {
			ymax: 100,
			color: 'var(--pnq-accent, #2f81f7)',
			showDot: true,
			yfmt: function (v) { return Math.round(v) + '%'; }
		}, cw));
		var cpuSub = document.getElementById('urm-cpu-sub');
		if (cpuSub && liveCpuPoints.length) {
			var curCpu = liveCpuPoints[liveCpuPoints.length - 1].v;
			var cpuPeak = 0;
			liveCpuPoints.forEach(function (p) { if (p.v > cpuPeak) cpuPeak = p.v; });
			cpuSub.textContent = 'Live Wave • Current: ' + curCpu + '% • Peak: ' + cpuPeak + '%';
		}

		// 2. RAM
		ramBox.innerHTML = '';
		ramBox.appendChild(renderSvgChart(liveRamPoints, {
			ymax: maxRamMb,
			autoMax: true,
			color: '#3fb950',
			showDot: true,
			yfmt: fmtMb
		}, rw));
		var ramSub = document.getElementById('urm-ram-sub');
		if (ramSub && liveRamPoints.length) {
			var curRam = liveRamPoints[liveRamPoints.length - 1].v;
			var ramPct = maxRamMb > 0 ? Math.round((curRam * 100) / maxRamMb) : 0;
			ramSub.textContent = 'Used ' + fmtMb(curRam) + ' of ' + fmtMb(maxRamMb) + ' (' + ramPct + '%)';
		}

		// 3. Disk
		diskBox.innerHTML = '';
		diskBox.appendChild(renderSvgChart(liveDiskPoints, {
			ymax: maxDiskMb,
			autoMax: true,
			color: '#d29922',
			showDot: true,
			yfmt: fmtMb
		}, dw));
		var diskSub = document.getElementById('urm-disk-sub');
		if (diskSub && liveDiskPoints.length) {
			var curDisk = liveDiskPoints[liveDiskPoints.length - 1].v;
			var diskPct = maxDiskMb > 0 ? Math.round((curDisk * 100) / maxDiskMb) : 0;
			diskSub.textContent = 'Used ' + fmtMb(curDisk) + ' of ' + fmtMb(maxDiskMb) + ' (' + diskPct + '%)';
		}
	}

	function drawKpiRow(server, users) {
		var kpiRow = document.getElementById('urm-kpi-row');
		if (!kpiRow) return;
		kpiRow.innerHTML = '';

		var totalUsers = users.length;
		var activeUsers = users.filter(function (u) { return (u.running_nodes || 0) > 0; }).length;

		// 1. CPU
		var cpuVal = server.cpu || 0;
		var cpuColor = cpuVal >= 85 ? '#ef4444' : (cpuVal >= 60 ? '#f59e0b' : '#10b981');
		kpiRow.appendChild(renderKpi('Host CPU Load', cpuVal + '%', 'Instantaneous load', cpuColor, cpuVal));

		// 2. RAM
		var ramVal = server.ram_percent || 0;
		var ramColor = ramVal >= 85 ? '#ef4444' : (ramVal >= 70 ? '#f59e0b' : '#10b981');
		var ramSub = fmtMb(server.ram_used_mb || 0) + ' / ' + fmtMb(server.ram_total_mb || 0);
		kpiRow.appendChild(renderKpi('Host RAM Used', ramVal + '%', ramSub, ramColor, ramVal));

		// 3. Disk (NEW!)
		var diskVal = server.disk_percent || 0;
		var diskColor = diskVal >= 90 ? '#ef4444' : (diskVal >= 75 ? '#f59e0b' : '#10b981');
		var diskSub = fmtMb(server.disk_used_mb || 0) + ' / ' + fmtMb(server.disk_total_mb || 0);
		kpiRow.appendChild(renderKpi('Host Root Disk', diskVal + '%', diskSub, diskColor, diskVal));

		// 4. Nodes
		kpiRow.appendChild(renderKpi('Active Nodes & Labs', (server.total_running_nodes || 0) + ' Nodes', activeUsers + ' active / ' + totalUsers + ' total users', '#3b82f6'));

		// 5. Health Status
		var highCount = users.filter(function (u) { return u.is_high_load; }).length;
		var warnCount = users.filter(function (u) { return u.is_warning; }).length;
		var alertColor = highCount > 0 ? '#ef4444' : (warnCount > 0 ? '#f59e0b' : '#10b981');
		var alertTitle = highCount > 0 ? (highCount + ' Overloaded!') : (warnCount > 0 ? (warnCount + ' Warning') : 'Healthy');
		var alertSub = highCount > 0 ? 'User exceeds safe threshold' : (warnCount > 0 ? 'Approaching threshold' : 'All users within safe thresholds');
		kpiRow.appendChild(renderKpi('Host Health Status', alertTitle, alertSub, alertColor));
	}

	function drawTableBody(users) {
		var tbody = document.getElementById('urm-table-body');
		if (!tbody) return;
		tbody.innerHTML = '';

		var uTitle = document.getElementById('urm-user-title');
		if (uTitle) {
			var activeCount = users.filter(function (u) { return (u.running_nodes || 0) > 0; }).length;
			uTitle.textContent = 'Per-User Resource Allocation (' + activeCount + ' active / ' + users.length + ' total users) • Updated ' + fmtClock(Math.floor(Date.now() / 1000));
		}

		var filtered = users.filter(function (u) {
			if (!searchQuery) return true;
			return (u.username && u.username.toLowerCase().indexOf(searchQuery) !== -1) ||
				   (u.name && u.name.toLowerCase().indexOf(searchQuery) !== -1) ||
				   (u.email && u.email.toLowerCase().indexOf(searchQuery) !== -1) ||
				   (String(u.pod).indexOf(searchQuery) !== -1);
		});

		if (!filtered.length) {
			var emptyTr = el('tr');
			var emptyTd = el('td', 'muted', 'No users found matching query.');
			emptyTd.colSpan = 7;
			emptyTd.style.cssText = 'text-align:center;padding:26px;';
			emptyTr.appendChild(emptyTd);
			tbody.appendChild(emptyTr);
			return;
		}

		filtered.forEach(function (u) {
			var r = el('tr');
			r.style.borderBottom = '1px solid var(--pnq-border, #f3f4f6)';

			// User info
			var userTd = el('td');
			userTd.style.padding = '10px 14px';
			var uName = el('div', null, u.username || ('Pod ' + u.pod));
			uName.style.fontWeight = '600';
			userTd.appendChild(uName);
			if (u.name || u.email) {
				var uSub = el('div', 'muted', (u.name ? u.name + ' ' : '') + (u.email ? '<' + u.email + '>' : ''));
				uSub.style.fontSize = '11px';
				userTd.appendChild(uSub);
			}
			r.appendChild(userTd);

			// Labs
			var labsTd = el('td');
			labsTd.style.padding = '10px 14px';
			if (u.labs && u.labs.length) {
				u.labs.forEach(function (l) {
					var labBadge = el('span');
					labBadge.style.cssText = 'display:inline-block;padding:2px 8px;background:rgba(59,130,246,0.1);color:#2563eb;border-radius:12px;font-size:12px;margin:2px 4px 2px 0;';
					labBadge.appendChild(document.createTextNode(l.lab_name));
					labsTd.appendChild(labBadge);
				});
			} else {
				labsTd.appendChild(el('span', 'muted', '—'));
			}
			r.appendChild(labsTd);

			// Nodes count
			var nodeCount = u.running_nodes || 0;
			var nodeTd = el('td', null, nodeCount > 0 ? (nodeCount + ' nodes') : '0 nodes');
			nodeTd.style.padding = '10px 14px';
			if (nodeCount === 0) nodeTd.className = 'muted';
			r.appendChild(nodeTd);

			// CPU
			var cpuTd = el('td');
			cpuTd.style.padding = '10px 14px';
			if (nodeCount > 0) {
				var cpuBadge = el('span');
				var isHighCpu = u.cpu_percent >= 80.0;
				var isMedCpu = u.cpu_percent >= 60.0;
				var cpuBg = isHighCpu ? 'rgba(239,68,68,0.15)' : (isMedCpu ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)');
				var cpuFg = isHighCpu ? '#dc2626' : (isMedCpu ? '#d97706' : '#059669');
				cpuBadge.style.cssText = 'display:inline-block;padding:2px 8px;border-radius:12px;font-weight:600;font-size:12px;background:' + cpuBg + ';color:' + cpuFg + ';';
				cpuBadge.appendChild(document.createTextNode(u.cpu_percent + '%'));
				cpuTd.appendChild(cpuBadge);
			} else {
				cpuTd.appendChild(el('span', 'muted', '0%'));
			}
			r.appendChild(cpuTd);

			// RAM
			var ramTd = el('td');
			ramTd.style.padding = '10px 14px';
			if (nodeCount > 0 && u.ram_mb > 0) {
				var isHighRam = u.ram_mb >= 5000;
				var isMedRam = u.ram_mb >= 3500;
				var ramBg = isHighRam ? 'rgba(239,68,68,0.15)' : (isMedRam ? 'rgba(245,158,11,0.15)' : 'rgba(16,185,129,0.15)');
				var ramFg = isHighRam ? '#dc2626' : (isMedRam ? '#d97706' : '#059669');
				var ramBadge = el('span');
				ramBadge.style.cssText = 'display:inline-block;padding:2px 8px;border-radius:12px;font-weight:600;font-size:12px;background:' + ramBg + ';color:' + ramFg + ';';
				ramBadge.appendChild(document.createTextNode(fmtMb(u.ram_mb)));
				ramTd.appendChild(ramBadge);
			} else {
				ramTd.appendChild(el('span', 'muted', '0 MB'));
			}
			r.appendChild(ramTd);

			// Health status
			var healthTd = el('td');
			healthTd.style.padding = '10px 14px';
			var hBadge = el('span');
			if (nodeCount > 0) {
				if (u.is_high_load) {
					hBadge.style.cssText = 'display:inline-block;padding:3px 8px;background:#ef4444;color:#fff;border-radius:4px;font-size:11px;font-weight:bold;';
					hBadge.appendChild(document.createTextNode('OVERLOADED'));
				} else if (u.is_warning) {
					hBadge.style.cssText = 'display:inline-block;padding:3px 8px;background:#f59e0b;color:#fff;border-radius:4px;font-size:11px;font-weight:bold;';
					hBadge.appendChild(document.createTextNode('Warning'));
				} else {
					hBadge.style.cssText = 'display:inline-block;padding:3px 8px;background:#10b981;color:#fff;border-radius:4px;font-size:11px;';
					hBadge.appendChild(document.createTextNode('Active'));
				}
			} else {
				hBadge.style.cssText = 'display:inline-block;padding:3px 8px;background:rgba(156,163,175,0.15);color:var(--pnq-text-muted, #6b7280);border-radius:4px;font-size:11px;';
				hBadge.appendChild(document.createTextNode('Idle'));
			}
			healthTd.appendChild(hBadge);
			r.appendChild(healthTd);

			// Actions
			var actTd = el('td');
			actTd.style.padding = '10px 14px';
			if (nodeCount > 0) {
				var stopBtn = el('button', 'btn btn-sm btn-danger');
				stopBtn.type = 'button';
				stopBtn.title = 'Stop all running nodes for this user to release host resources';
				stopBtn.appendChild(el('i', 'fa fa-stop-circle'));
				stopBtn.appendChild(document.createTextNode(' Stop Nodes'));
				stopBtn.addEventListener('click', function () {
					var uDisplayName = u.username || ('Pod ' + u.pod);
					if (!confirm('Are you sure you want to STOP ALL RUNNING NODES for user "' + uDisplayName + '" to protect server stability?')) return;
					stopBtn.disabled = true;
					stopBtn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Stopping...';
					post('/status/api.php?action=stop_user_nodes', { pod: u.pod }).then(function (res) {
						alert((res.body && res.body.message) || 'Nodes stopped successfully.');
						loadData();
					}).catch(function (err) {
						alert('Failed to stop nodes.');
						loadData();
					});
				});
				actTd.appendChild(stopBtn);
			} else {
				actTd.appendChild(el('span', 'muted', '—'));
			}
			r.appendChild(actTd);

			tbody.appendChild(r);
		});
	}

	/* ---- Draw Incident Snapshot History (with Disk column!) ---- */
	function drawIncidentRows(list) {
		var tbody = document.getElementById('urm-incident-tbody');
		if (!tbody) return;
		tbody.innerHTML = '';

		var titleEl = document.getElementById('urm-incident-title');
		if (titleEl) {
			titleEl.textContent = 'Host Overload Incident Log (' + list.length + ' recorded incidents)';
		}

		var filtered = list;
		if (incidentSeverityFilter !== 'all') {
			filtered = list.filter(function (inc) {
				return inc.severity === incidentSeverityFilter;
			});
		}

		if (!filtered.length) {
			var emptyTr = el('tr');
			var emptyTd = el('td', 'muted', list.length ? 'No incidents match filter.' : 'Excellent! No overload incidents recorded recently.');
			emptyTd.colSpan = 7;
			emptyTd.style.cssText = 'text-align:center;padding:26px;';
			emptyTr.appendChild(emptyTd);
			tbody.appendChild(emptyTr);
			return;
		}

		filtered.forEach(function (inc) {
			var r = el('tr');
			r.style.borderBottom = '1px solid var(--pnq-border, #f3f4f6)';

			var tsTd = el('td', null, fmtTs(inc.created_at));
			tsTd.style.padding = '10px 14px';
			r.appendChild(tsTd);

			var sevTd = el('td');
			sevTd.style.padding = '10px 14px';
			var sevBadge = el('span');
			var isCrit = inc.severity === 'critical';
			sevBadge.style.cssText = 'display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold;background:' + (isCrit ? '#ef4444' : '#f59e0b') + ';color:#fff;';
			sevBadge.appendChild(document.createTextNode(isCrit ? 'CRITICAL' : 'WARNING'));
			sevTd.appendChild(sevBadge);
			r.appendChild(sevTd);

			var cpuTd = el('td', null, inc.server_cpu + '%');
			cpuTd.style.cssText = 'padding:10px 14px;font-weight:600;color:' + (inc.server_cpu >= 85 ? '#dc2626' : 'inherit') + ';';
			r.appendChild(cpuTd);

			var ramTd = el('td', null, inc.server_ram + '%');
			ramTd.style.cssText = 'padding:10px 14px;font-weight:600;color:' + (inc.server_ram >= 85 ? '#dc2626' : 'inherit') + ';';
			r.appendChild(ramTd);

			// Disk (NEW!)
			var diskVal = (inc.server_disk !== undefined) ? inc.server_disk : 0;
			var diskTd = el('td', null, diskVal > 0 ? (diskVal + '%') : '—');
			diskTd.style.cssText = 'padding:10px 14px;font-weight:600;color:' + (diskVal >= 90 ? '#dc2626' : 'inherit') + ';';
			r.appendChild(diskTd);

			var nodeTd = el('td', null, inc.total_nodes + ' nodes');
			nodeTd.style.padding = '10px 14px';
			r.appendChild(nodeTd);

			var topTd = el('td');
			topTd.style.padding = '10px 14px';
			if (inc.top_users && inc.top_users.length) {
				var activeConsumers = inc.top_users.filter(function (tu) {
					return (tu.running_nodes > 0 || tu.cpu_percent > 0 || tu.ram_mb > 0);
				});
				if (activeConsumers.length) {
					activeConsumers.forEach(function (tu) {
						var item = el('div');
						item.style.fontSize = '12px';
						item.style.marginBottom = '2px';
						item.innerHTML = '<strong>' + (tu.username || ('Pod ' + tu.pod)) + '</strong>: ' +
										 '<span style="color:#dc2626;">' + tu.cpu_percent + '% CPU</span>, ' +
										 '<span style="color:#d97706;">' + fmtMb(tu.ram_mb) + ' RAM</span> (' +
										 tu.running_nodes + ' nodes)';
						topTd.appendChild(item);
					});
				} else {
					topTd.appendChild(el('span', 'muted', '—'));
				}
			} else {
				topTd.appendChild(el('span', 'muted', '—'));
			}
			r.appendChild(topTd);

			tbody.appendChild(r);
		});
	}

	function exportHistoryCsv(list) {
		if (!list || !list.length) {
			alert('No incident data available to export.');
			return;
		}
		var csv = 'Timestamp,Severity,Host CPU (%),Host RAM (%),Host Disk (%),Total Nodes,Top Resource Consumers\n';
		list.forEach(function (inc) {
			var topStr = '';
			if (inc.top_users && inc.top_users.length) {
				var activeTu = inc.top_users.filter(function (u) {
					return (u.running_nodes > 0 || u.cpu_percent > 0 || u.ram_mb > 0);
				});
				topStr = activeTu.map(function (u) {
					return (u.username || ('Pod ' + u.pod)) + ' (' + u.cpu_percent + '% CPU | ' + fmtMb(u.ram_mb) + ' RAM)';
				}).join('; ');
			}
			var diskVal = (inc.server_disk !== undefined) ? inc.server_disk : 0;
			csv += '"' + fmtTs(inc.created_at) + '","' + inc.severity.toUpperCase() + '","' + inc.server_cpu + '","' + inc.server_ram + '","' + diskVal + '","' + inc.total_nodes + '","' + topStr.replace(/"/g, '""') + '"\n';
		});
		var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
		var link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = 'pnetlab_resource_incidents_' + new Date().toISOString().slice(0, 10) + '.csv';
		link.click();
	}

	App.register('resource-monitor', {
		title: 'User Resources',
		icon: 'fa-tachometer',
		admin: true,
		render: render
	});
})();
