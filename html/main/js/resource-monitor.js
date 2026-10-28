/* ============================================================================
   PNetLab dashboard — User Resource Monitor view (admin-only)
   Monitors per-user live CPU & RAM consumption to detect who is overloading the host.
   Also includes incident snapshot history (recorded automatically when host is overloaded).
   CSP-safe: pure DOM construction, no eval / inline handlers.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var poller = null;
	var currentTab = 'live'; // 'live' | 'history'
	var autoRefresh = true;
	var lastData = null;
	var searchQuery = '';

	function post(url, obj) {
		return App.api(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(obj || {})
		});
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

	/* ---- KPI card builder ---- */
	function renderKpi(title, value, subtext, colorCls, progressPct) {
		var card = el('div', 'card');
		card.style.cssText = 'flex:1;min-width:210px;padding:16px;box-sizing:border-box;margin-bottom:0;';
		var titleEl = el('div', 'muted', title);
		titleEl.style.cssText = 'font-size:12px;text-transform:uppercase;font-weight:600;letter-spacing:0.5px;';
		card.appendChild(titleEl);

		var valEl = el('div', null, value);
		valEl.style.cssText = 'font-size:24px;font-weight:bold;margin:6px 0;color:' + (colorCls || 'inherit') + ';';
		card.appendChild(valEl);

		if (progressPct !== undefined && progressPct !== null) {
			var progWrap = el('div');
			progWrap.style.cssText = 'width:100%;height:6px;background:rgba(0,0,0,0.08);border-radius:3px;overflow:hidden;margin-bottom:6px;';
			var progBar = el('div');
			progBar.style.cssText = 'height:100%;width:' + Math.min(100, Math.max(0, progressPct)) + '%;background:' + (colorCls || '#3b82f6') + ';border-radius:3px;transition:width 0.3s;';
			progWrap.appendChild(progBar);
			card.appendChild(progWrap);
		}

		if (subtext) {
			var subEl = el('div', 'muted', subtext);
			subEl.style.fontSize = '12px';
			card.appendChild(subEl);
		}
		return card;
	}

	/* ---- Main view render ---- */
	function render(viewEl) {
		stopPolling();
		currentTab = 'live';
		searchQuery = '';

		var head = el('div', 'view-head vh-ruled');
		var left = el('div');
		left.style.cssText = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap;';
		left.appendChild(viewTitle('User Resource Monitor', 'fa-tachometer'));

		var pulseBadge = el('span', 'rl-livecount');
		pulseBadge.id = 'urm-pulse';
		pulseBadge.appendChild(el('span', 'rl-pulse'));
		pulseBadge.appendChild(document.createTextNode('Live Telemetry'));
		left.appendChild(pulseBadge);
		head.appendChild(left);

		var actions = el('div');
		actions.style.cssText = 'display:flex;gap:8px;align-items:center;';

		var refreshBtn = el('button', 'btn btn-ghost');
		refreshBtn.type = 'button';
		refreshBtn.appendChild(el('i', 'fa fa-refresh'));
		refreshBtn.appendChild(document.createTextNode(' Refresh'));
		refreshBtn.addEventListener('click', function () {
			if (currentTab === 'live') loadLive();
			else loadHistory();
		});
		actions.appendChild(refreshBtn);

		var autoBtn = el('button', 'btn ' + (autoRefresh ? 'btn-primary' : 'btn-ghost'));
		autoBtn.id = 'urm-auto-btn';
		autoBtn.type = 'button';
		autoBtn.appendChild(el('i', 'fa ' + (autoRefresh ? 'fa-play' : 'fa-pause')));
		autoBtn.appendChild(document.createTextNode(autoRefresh ? ' Auto (5s)' : ' Paused'));
		autoBtn.addEventListener('click', function () {
			autoRefresh = !autoRefresh;
			autoBtn.className = 'btn ' + (autoRefresh ? 'btn-primary' : 'btn-ghost');
			autoBtn.innerHTML = '';
			autoBtn.appendChild(el('i', 'fa ' + (autoRefresh ? 'fa-play' : 'fa-pause')));
			autoBtn.appendChild(document.createTextNode(autoRefresh ? ' Auto (5s)' : ' Paused'));
			if (autoRefresh) startPolling();
			else stopPolling();
		});
		actions.appendChild(autoBtn);

		head.appendChild(actions);
		viewEl.appendChild(head);

		// Navigation Sub-tabs
		var navTabs = el('div');
		navTabs.style.cssText = 'display:flex;gap:4px;border-bottom:1px solid var(--pnq-border, #e5e7eb);margin-bottom:16px;';

		var tabLive = el('button', 'btn btn-ghost active');
		tabLive.id = 'urm-tab-live';
		tabLive.style.cssText = 'border-radius:4px 4px 0 0;padding:8px 16px;border-bottom:2px solid #2563eb;font-weight:600;';
		tabLive.appendChild(el('i', 'fa fa-bolt'));
		tabLive.appendChild(document.createTextNode(' Live Users (Realtime)'));

		var tabHistory = el('button', 'btn btn-ghost');
		tabHistory.id = 'urm-tab-history';
		tabHistory.style.cssText = 'border-radius:4px 4px 0 0;padding:8px 16px;font-weight:500;color:inherit;';
		tabHistory.appendChild(el('i', 'fa fa-history'));
		tabHistory.appendChild(document.createTextNode(' Incident Log (Overload History)'));

		tabLive.addEventListener('click', function () {
			currentTab = 'live';
			tabLive.style.borderBottom = '2px solid #2563eb';
			tabLive.style.fontWeight = '600';
			tabHistory.style.borderBottom = 'none';
			tabHistory.style.fontWeight = '500';
			document.getElementById('urm-live-container').style.display = 'block';
			document.getElementById('urm-history-container').style.display = 'none';
			loadLive();
		});

		tabHistory.addEventListener('click', function () {
			currentTab = 'history';
			tabHistory.style.borderBottom = '2px solid #2563eb';
			tabHistory.style.fontWeight = '600';
			tabLive.style.borderBottom = 'none';
			tabLive.style.fontWeight = '500';
			document.getElementById('urm-live-container').style.display = 'none';
			document.getElementById('urm-history-container').style.display = 'block';
			loadHistory();
		});

		navTabs.appendChild(tabLive);
		navTabs.appendChild(tabHistory);
		viewEl.appendChild(navTabs);

		// Containers
		var liveContainer = el('div');
		liveContainer.id = 'urm-live-container';
		viewEl.appendChild(liveContainer);

		var historyContainer = el('div');
		historyContainer.id = 'urm-history-container';
		historyContainer.style.display = 'none';
		viewEl.appendChild(historyContainer);

		loadLive();
		if (autoRefresh) startPolling();
	}

	function startPolling() {
		stopPolling();
		poller = App.poll(function () {
			if (currentTab === 'live') return loadLive();
			return Promise.resolve();
		}, { interval: 5000, maxInterval: 30000 });
		poller.start(true);
	}

	function stopPolling() {
		if (poller) { poller.stop(); poller = null; }
	}

	/* ---- Load & Draw Live Users ---- */
	function loadLive() {
		var c = document.getElementById('urm-live-container');
		if (!c) { stopPolling(); return Promise.resolve(); }

		return App.api('/status/api.php?action=user_resources').then(function (res) {
			if (!document.getElementById('urm-live-container')) return;
			var data = (res.body && res.body.data) ? res.body.data : { server: {}, users: [] };
			lastData = data;
			drawLive(data);
		}).catch(function (err) {
			var cont = document.getElementById('urm-live-container');
			if (cont && !lastData) {
				cont.innerHTML = '';
				cont.appendChild(el('p', 'muted', 'Could not load resource telemetry.'));
			}
		});
	}

	function drawLive(data) {
		var c = document.getElementById('urm-live-container');
		if (!c) return;
		c.innerHTML = '';

		var server = data.server || {};
		var users = data.users || [];
		var totalUsers = users.length;
		var activeUsers = users.filter(function (u) { return (u.running_nodes || 0) > 0; }).length;

		// Server KPI row
		var kpiRow = el('div');
		kpiRow.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;';

		var cpuVal = server.cpu || 0;
		var cpuColor = cpuVal >= 85 ? '#ef4444' : (cpuVal >= 60 ? '#f59e0b' : '#10b981');
		kpiRow.appendChild(renderKpi('Host CPU Load', cpuVal + '%', 'Overall system CPU utilization', cpuColor, cpuVal));

		var ramVal = server.ram_percent || 0;
		var ramColor = ramVal >= 85 ? '#ef4444' : (ramVal >= 70 ? '#f59e0b' : '#10b981');
		var ramSub = fmtMb(server.ram_used_mb || 0) + ' / ' + fmtMb(server.ram_total_mb || 0);
		kpiRow.appendChild(renderKpi('Host RAM Used', ramVal + '%', ramSub, ramColor, ramVal));

		kpiRow.appendChild(renderKpi('Active Nodes & Users', (server.total_running_nodes || 0) + ' Nodes', activeUsers + ' active / ' + totalUsers + ' total users', '#3b82f6'));

		var highCount = users.filter(function (u) { return u.is_high_load; }).length;
		var warnCount = users.filter(function (u) { return u.is_warning; }).length;
		var alertColor = highCount > 0 ? '#ef4444' : (warnCount > 0 ? '#f59e0b' : '#10b981');
		var alertTitle = highCount > 0 ? (highCount + ' Overloaded!') : (warnCount > 0 ? (warnCount + ' Warning') : 'Healthy');
		var alertSub = highCount > 0 ? 'User exceeds safe CPU/RAM capacity' : (warnCount > 0 ? 'User approaching high resource load' : 'All users within safe thresholds');
		kpiRow.appendChild(renderKpi('Overload Alerts', alertTitle, alertSub, alertColor));

		c.appendChild(kpiRow);

		// Table Shell
		var card = el('div', 'card');
		card.style.padding = '0';

		var bar = el('div');
		bar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--pnq-border, #e5e7eb);gap:12px;flex-wrap:wrap;';

		var barTitle = el('div');
		barTitle.style.fontWeight = '600';
		barTitle.appendChild(document.createTextNode('Per-User Resource Allocation (' + activeUsers + ' active / ' + totalUsers + ' total users)'));
		var updatedSpan = el('span', 'muted');
		updatedSpan.style.cssText = 'font-size:12px;font-weight:normal;margin-left:8px;';
		updatedSpan.textContent = '• Updated: ' + fmtTs(Math.floor(Date.now() / 1000));
		barTitle.appendChild(updatedSpan);
		bar.appendChild(barTitle);

		var searchInput = el('input');
		searchInput.type = 'text';
		searchInput.placeholder = 'Search user or email...';
		searchInput.value = searchQuery;
		searchInput.style.cssText = 'padding:6px 12px;border:1px solid var(--pnq-border, #ccc);border-radius:4px;font-size:13px;width:240px;';
		searchInput.addEventListener('input', function (e) {
			searchQuery = e.target.value.toLowerCase();
			drawTableBody(users);
		});
		bar.appendChild(searchInput);
		card.appendChild(bar);

		var tableWrap = el('div');
		tableWrap.style.overflowX = 'auto';
		var table = el('table', 'table');
		table.style.cssText = 'width:100%;border-collapse:collapse;margin:0;';

		var thead = el('thead');
		var tr = el('tr');
		['User / Email', 'Active Labs', 'Running Nodes', 'CPU Usage (%)', 'RAM Usage', 'Status', 'Actions'].forEach(function (h) {
			var th = el('th');
			th.style.padding = '10px 14px';
			th.appendChild(document.createTextNode(h));
			tr.appendChild(th);
		});
		thead.appendChild(tr);
		table.appendChild(thead);

		var tbody = el('tbody');
		tbody.id = 'urm-table-body';
		table.appendChild(tbody);
		tableWrap.appendChild(table);
		card.appendChild(tableWrap);
		c.appendChild(card);

		drawTableBody(users);
	}

	function drawTableBody(users) {
		var tbody = document.getElementById('urm-table-body');
		if (!tbody) return;
		tbody.innerHTML = '';

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
			emptyTd.style.cssText = 'text-align:center;padding:28px;';
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
			var uName = el('div', null, u.username || ('User #' + u.pod));
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
						loadLive();
					}).catch(function (err) {
						alert('Failed to stop nodes.');
						loadLive();
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

	/* ---- Load & Draw Incident History ---- */
	function loadHistory() {
		var c = document.getElementById('urm-history-container');
		if (!c) return;
		c.innerHTML = '<p class="muted" style="padding:16px;">Loading incident snapshot history…</p>';

		App.api('/status/api.php?action=resource_incidents').then(function (res) {
			if (!document.getElementById('urm-history-container')) return;
			var list = (res.body && res.body.data) ? res.body.data : [];
			drawHistory(list);
		}).catch(function () {
			var cont = document.getElementById('urm-history-container');
			if (cont) cont.innerHTML = '<p class="muted" style="padding:16px;">Could not load incident history.</p>';
		});
	}

	function exportHistoryCsv(list) {
		if (!list || !list.length) {
			alert('No incident data available to export.');
			return;
		}
		var csv = 'Timestamp,Severity,Host CPU (%),Host RAM (%),Total Nodes,Top Resource Consumers\n';
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
			csv += '"' + fmtTs(inc.created_at) + '","' + inc.severity.toUpperCase() + '","' + inc.server_cpu + '","' + inc.server_ram + '","' + inc.total_nodes + '","' + topStr.replace(/"/g, '""') + '"\n';
		});
		var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
		var link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = 'pnetlab_resource_incidents_' + new Date().toISOString().slice(0, 10) + '.csv';
		link.click();
	}

	function drawHistory(list) {
		var c = document.getElementById('urm-history-container');
		if (!c) return;
		c.innerHTML = '';

		var noteBox = el('div');
		noteBox.style.cssText = 'padding:12px 16px;background:rgba(59,130,246,0.08);border-left:4px solid #2563eb;border-radius:4px;margin-bottom:16px;font-size:13px;line-height:1.5;';
		noteBox.appendChild(document.createTextNode('📌 Safe Storage Guarantee: Snapshots are captured automatically when Host CPU >= 80% or RAM >= 80%. Enforces a strict 1,000 incident ring-buffer and 14-day retention (~500 KB max) — guaranteed never to exhaust disk space.'));
		c.appendChild(noteBox);

		var card = el('div', 'card');
		card.style.padding = '0';

		var bar = el('div');
		bar.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid var(--pnq-border, #e5e7eb);gap:8px;flex-wrap:wrap;';
		bar.appendChild(el('div', null, 'Host Overload Incident Log (' + list.length + ' recorded incidents)'));

		var expBtn = el('button', 'btn btn-sm btn-ghost');
		expBtn.type = 'button';
		expBtn.appendChild(el('i', 'fa fa-download'));
		expBtn.appendChild(document.createTextNode(' Export CSV'));
		expBtn.addEventListener('click', function () { exportHistoryCsv(list); });
		bar.appendChild(expBtn);

		card.appendChild(bar);

		var tableWrap = el('div');
		tableWrap.style.overflowX = 'auto';
		var table = el('table', 'table');
		table.style.cssText = 'width:100%;border-collapse:collapse;margin:0;';

		var thead = el('thead');
		var tr = el('tr');
		['Timestamp', 'Severity', 'Host CPU', 'Host RAM', 'Total Nodes', 'Top Resource Consumers'].forEach(function (h) {
			var th = el('th');
			th.style.padding = '10px 14px';
			th.appendChild(document.createTextNode(h));
			tr.appendChild(th);
		});
		thead.appendChild(tr);
		table.appendChild(thead);

		var tbody = el('tbody');
		if (!list.length) {
			var emptyTr = el('tr');
			var emptyTd = el('td', 'muted', 'Excellent! No overload incidents recorded recently.');
			emptyTd.colSpan = 6;
			emptyTd.style.cssText = 'text-align:center;padding:28px;';
			emptyTr.appendChild(emptyTd);
			tbody.appendChild(emptyTr);
		} else {
			list.forEach(function (inc) {
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
		table.appendChild(tbody);
		tableWrap.appendChild(table);
		card.appendChild(tableWrap);
		c.appendChild(card);
	}

	App.register('resource-monitor', {
		title: 'User Resources',
		icon: 'fa-tachometer',
		admin: true,
		render: render
	});
})();
