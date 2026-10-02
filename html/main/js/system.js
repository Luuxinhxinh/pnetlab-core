/* ============================================================================
   PNetLab dashboard — System view
   Talks to the new engine shim status/api.php (token-cookie auth):
     GET  ?action=system   CPU/RAM/Swap/Disk      (cpu+disk admin-only)
     GET  ?action=nodes    running node counts     (admin-only)
     GET  ?action=info     qemu/cores/KSM/UKSM/cpulimit
     POST ?action=ksm|uksm|cpulimit {state}        (admin-only, via broker)
   Resources + node counts poll every 5s while the view is on screen.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var poller = null;

	function human(kb) {
		var mb = kb / 1024;
		if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
		return Math.round(mb) + ' MB';
	}
	function level(pct) { return pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : ''; }

	function gauge(label, pct, sub) {
		pct = Math.max(0, Math.min(100, Math.round(pct || 0)));
		var g = el('div', 'gauge');
		var head = el('div', 'gauge-head');
		head.appendChild(el('span', 'label', label));
		head.appendChild(el('span', 'val', sub != null ? sub : pct + '%'));
		g.appendChild(head);
		var bar = el('div', 'gauge-bar');
		var fill = el('div', 'gauge-fill ' + level(pct));
		fill.style.width = pct + '%';
		bar.appendChild(fill);
		g.appendChild(bar);
		return g;
	}
	function viewTitle(text, icon) {
		var t = el('div', 'view-title');
		t.appendChild(el('i', 'fa ' + icon));
		t.appendChild(document.createTextNode(' ' + text));
		return t;
	}
	function kv(k, v) {
		var r = el('div', 'kv');
		r.appendChild(el('span', 'k', k));
		r.appendChild(el('span', 'v', v));
		return r;
	}

	function render(view) {
		stopPolling();
		var head = el('div', 'view-head vh-ruled');
		var left = el('div');
		left.style.cssText = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap';
		left.appendChild(viewTitle('System', 'fa-tachometer'));
		// Header signature: a live "N running" chip (nodes are live state, so it
		// reuses the green live-count language from Running Labs). Admin-only, as
		// the node counts are.
		if (App.isAdmin) {
			var chip = el('span', 'rl-livecount is-idle'); chip.id = 'sys-livecount';
			chip.appendChild(el('span', 'rl-pulse'));
			chip.appendChild(el('span', null, 'Loading…'));
			left.appendChild(chip);
		}
		head.appendChild(left);
		var refresh = el('button', 'btn btn-ghost'); refresh.type = 'button';
		refresh.appendChild(el('i', 'fa fa-refresh'));
		refresh.appendChild(document.createTextNode(' Refresh'));
		refresh.addEventListener('click', function () { tick().catch(function () {}); loadInfo(); });
		head.appendChild(refresh);
		view.appendChild(head);

		var res = el('div', 'card');
		res.appendChild(el('div', 'card-title', 'Resources'));
		var resBody = el('div'); resBody.id = 'sys-res-body';
		resBody.appendChild(el('p', 'muted', 'Loading…'));
		res.appendChild(resBody);
		// Running-node counts fold in as a compact inline summary under the gauges
		// (was a big-number stat-tile grid — an off-the-shelf hero-metric template).
		if (App.isAdmin) {
			var nsHead = el('div'); nsHead.id = 'sys-nodes-head';
			nsHead.style.cssText = 'margin-top:16px;padding-top:14px;border-top:1px solid var(--pnq-border)';
			// The endpoint counts host processes with pgrep. An IOL node can
			// legitimately be iol_wrapper -> iol_wrapper -> sh; ovfstartup.sh
			// grants that supervisor chain cap_net_admin, so it is not an orphan
			// to reconcile or reap merely because the process total is higher.
			// Owner ruling 2026-08-05: this reads "Running nodes". The count is
			// really a host PROCESS count (the endpoint pgreps), and one IOL node
			// legitimately uses a supervisor chain, so the total can exceed the
			// number of logical nodes. That nuance belongs in the tooltip, NOT in
			// the label -- "Emulator processes" is jargon and makes the primary
			// reading worse. Perf item #4's accepted clause was to document the
			// semantics, which the tooltip does; the rejected reconciler is not
			// built and must not be, because reaping on that premise kills live
			// nodes.
			var nodesTitle = el('div', 'card-title', 'Running nodes');
			nodesTitle.title = 'Counts host emulator processes. One node can use more than one process '
				+ '(an IOL node runs a supervisor chain), so this can read higher than the node count.';
			nsHead.appendChild(nodesTitle);
			var nb = el('div'); nb.id = 'sys-nodes';
			nb.appendChild(el('p', 'muted', 'Loading…'));
			nsHead.appendChild(nb);
			res.appendChild(nsHead);
		}
		view.appendChild(res);

		var info = el('div', 'card');
		info.appendChild(el('div', 'card-title', 'Platform'));
		var ib = el('div'); ib.id = 'sys-info';
		ib.appendChild(el('p', 'muted', 'Loading…'));
		info.appendChild(ib);
		view.appendChild(info);

		// Appearance is appliance-wide. The lab canvas keeps its own local
		// light/dark control, so changing this profile never flips a running lab.
		view.appendChild(themeCard());

		// Server power + disk expand (admin-only) — grouped into a clearly
		// danger-framed section so their blast radius is obvious before confirm.
		if (App.isAdmin) {
			view.appendChild(dangerZoneHead());
			view.appendChild(diskExpandCard());
			view.appendChild(powerCard());
		}

		loadInfo();
		startPolling();
	}

	function themeCard() {
		var c = el('div', 'card theme-card');
		c.appendChild(el('div', 'card-title', 'Themes'));
		c.appendChild(el('p', 'muted', 'Choose the appliance-wide color profile for the dashboard, sign-in page, and lab chrome. The lab canvas light/dark toggle remains independent.'));
		var options = el('div', 'theme-options');
		options.setAttribute('role', 'radiogroup');
		options.setAttribute('aria-label', 'Appliance color theme');
		var status = el('p', 'theme-status');
		status.setAttribute('aria-live', 'polite');
		if (!App.isAdmin) status.textContent = 'Only administrators can change the appliance theme.';
		var profiles = window.PnqTheme && window.PnqTheme.list ? window.PnqTheme.list : Object.keys(App.themeProfiles).map(function (id) { return App.themeProfiles[id]; });

		function paint() {
			var selected = App.getTheme ? App.getTheme() : document.documentElement.dataset.theme;
			options.querySelectorAll('[data-theme-profile]').forEach(function (button) {
				var active = button.getAttribute('data-theme-profile') === selected;
				button.classList.toggle('is-selected', active);
				button.setAttribute('aria-checked', active ? 'true' : 'false');
				button.tabIndex = App.isAdmin && active ? 0 : -1;
				button.disabled = !App.isAdmin || options.getAttribute('aria-busy') === 'true';
			});
		}
		function busy(on) {
			options.setAttribute('aria-busy', on ? 'true' : 'false');
			options.querySelectorAll('[data-theme-profile]').forEach(function (button) { button.disabled = on || !App.isAdmin; });
			if (!on) paint();
		}
		function moveSelection(current, key) {
			var buttons = Array.prototype.slice.call(options.querySelectorAll('[data-theme-profile]'));
			var index = buttons.indexOf(current);
			if (index < 0 || !buttons.length) return;
			if (key === 'Home') index = 0;
			else if (key === 'End') index = buttons.length - 1;
			else {
				var delta = (key === 'ArrowRight' || key === 'ArrowDown') ? 1 : -1;
				index = (index + delta + buttons.length) % buttons.length;
			}
			buttons[index].focus();
			buttons[index].click();
		}

		profiles.forEach(function (profile) {
			var button = el('button', 'theme-option');
			button.type = 'button';
			button.setAttribute('role', 'radio');
			button.setAttribute('data-theme-profile', profile.id);
			button.setAttribute('aria-label', profile.label + ' theme');
			var swatch = el('span', 'theme-swatch');
			swatch.setAttribute('aria-hidden', 'true');
			var name = el('span', 'theme-option-name', profile.label);
			var desc = el('span', 'theme-option-desc', profile.description || '');
			button.appendChild(swatch);
			button.appendChild(name);
			button.appendChild(desc);
			button.addEventListener('click', function () {
				if (!App.isAdmin || !App.setTheme) return;
				busy(true);
				status.className = 'theme-status';
				status.textContent = 'Saving ' + profile.label + ' for the appliance…';
				App.setTheme(profile.id).then(function () {
					paint();
					status.textContent = profile.label + ' is now active appliance-wide.';
					App.toast(profile.label + ' theme saved.', 'ok');
				}).catch(function (error) {
					paint();
					status.className = 'theme-status is-error';
					status.textContent = (error && error.message) || 'Could not save the appliance theme.';
					App.toast(status.textContent, 'error');
				}).then(function () {
					busy(false);
					button.focus();
				});
			});
			button.addEventListener('keydown', function (event) {
				if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].indexOf(event.key) === -1) return;
				event.preventDefault();
				moveSelection(button, event.key);
			});
			options.appendChild(button);
		});
		c.appendChild(options);
		c.appendChild(status);
		paint();
		// Keep the selected tile truthful when a confirmed server refresh changes
		// the profile while this route is visible. The self-removing guard avoids
		// retaining one listener for every visit to the System route.
		function onThemeEvent() {
			if (!options.isConnected) {
				document.removeEventListener('pnq:theme-applied', onThemeEvent);
				window.removeEventListener('pnq:theme-change', onThemeEvent);
				return;
			}
			paint();
		}
		document.addEventListener('pnq:theme-applied', onThemeEvent);
		window.addEventListener('pnq:theme-change', onThemeEvent);
		return c;
	}

	// A distinct, danger-vocabulary header that escalates the server power /
	// disk-expand cards (whole-appliance blast radius) above routine gauges.
	function dangerZoneHead() {
		var wrap = el('div');
		var h = el('div', 'danger-zone-head');
		h.appendChild(el('i', 'fa fa-exclamation-triangle'));
		h.appendChild(document.createTextNode('Danger zone'));
		wrap.appendChild(h);
		var a = el('div', 'alert alert-danger');
		a.appendChild(el('i', 'fa fa-exclamation-triangle'));
		var body = el('div');
		body.appendChild(el('div', 'alert-title', 'These actions affect the whole appliance'));
		body.appendChild(document.createTextNode('Restarting, shutting down, or resizing the root filesystem stops every running lab and drops all connections. Each action asks for confirmation first.'));
		a.appendChild(body);
		wrap.appendChild(a);
		return wrap;
	}

	/* ---- server power: restart / shutdown (admin-only, via status shim) ---- */
	function powerCard() {
		var c = el('div', 'card is-danger');
		c.appendChild(el('div', 'card-title', 'Server power'));
		c.appendChild(el('p', 'muted', 'Restart or shut down the ' + App.brandName() + ' server. All running labs will stop.'));
		var row = el('div');
		row.style.cssText = 'display:flex;gap:10px;margin-top:8px;flex-wrap:wrap';
		var restart = el('button', 'btn btn-ghost'); restart.type = 'button';
		restart.appendChild(el('i', 'fa fa-refresh'));
		restart.appendChild(document.createTextNode(' Restart'));
		var shutdown = el('button', 'btn btn-danger'); shutdown.type = 'button';
		shutdown.appendChild(el('i', 'fa fa-power-off'));
		shutdown.appendChild(document.createTextNode(' Shut down'));
		var btns = [restart, shutdown];
		restart.addEventListener('click', function () { serverPower('reboot', 'Restart', btns); });
		shutdown.addEventListener('click', function () { serverPower('shutdown', 'Shut down', btns); });
		row.appendChild(restart); row.appendChild(shutdown);
		c.appendChild(row);
		return c;
	}
	function serverPower(op, label, btns) {
		App.confirm(label + ' the ' + App.brandName() + ' server now? All running labs will stop and you will lose connection to the box.',
			{ danger: true, okLabel: label }).then(function (yes) {
			if (!yes) return;
			btns.forEach(function (b) { b.disabled = true; });
			App.api('/status/api.php?action=power', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ op: op })
			}).then(function (res) {
				if (res.status === 200 && res.body && res.body.ok) {
					stopPolling();
					App.toast('Server is ' + (op === 'reboot' ? 'restarting' : 'shutting down') + '…', 'ok');
				} else {
					var reason = res.body && (res.body.error || res.body.message);
					App.toast('Could not ' + label.toLowerCase() + ' the server' + (reason ? ': ' + reason : ''), 'error');
					btns.forEach(function (b) { b.disabled = false; });
				}
			}).catch(function () {
				App.toast('Could not ' + label.toLowerCase() + ' the server', 'error');
				btns.forEach(function (b) { b.disabled = false; });
			});
		});
	}

	/* ---- disk expand: detect / expand root fs (admin-only, via status shim) -- */
	function diskExpandCard() {
		var c = el('div', 'card is-danger');
		c.appendChild(el('div', 'card-title', 'Disk expand'));
		c.appendChild(el('p', 'muted',
			'Expand the root filesystem to use the full virtual disk after enlarging it in your hypervisor. ' +
			'Click Detect to see the current layout and the exact commands, then Expand to apply.'));

		var row = el('div');
		row.style.cssText = 'display:flex;gap:10px;margin-top:8px;flex-wrap:wrap';

		var detectBtn = el('button', 'btn btn-ghost'); detectBtn.type = 'button';
		detectBtn.appendChild(el('i', 'fa fa-search'));
		detectBtn.appendChild(document.createTextNode(' Detect'));

		var expandBtn = el('button', 'btn btn-ghost'); expandBtn.type = 'button';
		expandBtn.appendChild(el('i', 'fa fa-expand'));
		expandBtn.appendChild(document.createTextNode(' Expand'));
		expandBtn.disabled = true;

		var resultBox = el('div');
		resultBox.id = 'disk-expand-result';
		resultBox.style.cssText = 'margin-top:10px';

		detectBtn.addEventListener('click', function () {
			diskExpand('detect', [detectBtn, expandBtn], expandBtn, resultBox);
		});
		expandBtn.addEventListener('click', function () {
			App.confirm(
				'Apply disk expansion now? The root filesystem will be grown to fill the virtual disk.',
				{ okLabel: 'Expand' }
			).then(function (yes) {
				if (!yes) return;
				diskExpand('expand', [detectBtn, expandBtn], expandBtn, resultBox);
			});
		});

		row.appendChild(detectBtn);
		row.appendChild(expandBtn);
		c.appendChild(row);
		c.appendChild(resultBox);
		return c;
	}

	function diskExpand(op, btns, expandBtn, resultBox) {
		btns.forEach(function (b) { b.disabled = true; });
		resultBox.innerHTML = '<p class="muted">Working…</p>';
		App.api('/status/api.php?action=disk_expand', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ op: op })
		}).then(function (res) {
			btns.forEach(function (b) { b.disabled = false; });
			var d = (res.body && res.body.data) || {};
			resultBox.innerHTML = '';
			if (res.status !== 200 || !res.body || !res.body.ok) {
				var errMsg = (res.body && res.body.error) ? res.body.error : 'Request failed';
				App.toast(errMsg, 'error');
				resultBox.appendChild(el('p', 'muted', errMsg));
				expandBtn.disabled = true;
				return;
			}
			if (op === 'detect') {
				var info = el('div');
				info.appendChild(kv('Device', (d.dev || '—') + (d.part ? '  partition ' + d.part : '')));
				info.appendChild(kv('Filesystem', d.fstype || '—'));
				if (d.is_lvm) {
					info.appendChild(kv('Type', 'LVM  (VG: ' + (d.vg || '?') + '  LV: ' + (d.lv || '?') + ')'));
				} else {
					info.appendChild(kv('Type', 'Plain partition'));
				}
				info.appendChild(kv('Current size', (d.fs_size_gb != null ? d.fs_size_gb + ' GB' : '—')));
				info.appendChild(kv('Disk total', (d.disk_total_gb != null ? d.disk_total_gb + ' GB' : '—')));
				info.appendChild(kv('Expandable by', (d.growable_gb != null ? d.growable_gb + ' GB' : '—')));
				info.appendChild(kv('Expandable', d.expandable ? 'Yes' : 'No'));
				if (d.commands && d.commands.length) {
					var cmdTitle = el('p'); cmdTitle.style.cssText = 'margin:8px 0 4px;font-weight:bold';
					cmdTitle.appendChild(document.createTextNode('Commands that will run:'));
					info.appendChild(cmdTitle);
					var pre = el('pre');
					pre.style.cssText = 'background:var(--pnq-surface-2);border:1px solid var(--pnq-border);color:var(--pnq-text);padding:8px;border-radius:4px;overflow-x:auto;font-size:12px;white-space:pre-wrap;word-break:break-all';
					pre.appendChild(document.createTextNode(d.commands.join('\n')));
					info.appendChild(pre);
				}
				resultBox.appendChild(info);
				expandBtn.disabled = !d.expandable;
				App.toast('Detect complete', 'ok');
			} else {
				// expand result
				var xinfo = el('div');
				xinfo.appendChild(kv('Before', (d.before_gb != null ? d.before_gb + ' GB' : '—')));
				xinfo.appendChild(kv('After', (d.after_gb != null ? d.after_gb + ' GB' : '—')));
				if (d.steps && d.steps.length) {
					var stTitle = el('p'); stTitle.style.cssText = 'margin:8px 0 4px;font-weight:bold';
					stTitle.appendChild(document.createTextNode('Steps completed:'));
					xinfo.appendChild(stTitle);
					var ul = el('ul');
					ul.style.cssText = 'margin:0;padding-left:18px;font-size:13px';
					d.steps.forEach(function (s) {
						var li = el('li'); li.appendChild(document.createTextNode(s));
						ul.appendChild(li);
					});
					xinfo.appendChild(ul);
				}
				resultBox.appendChild(xinfo);
				App.toast('Disk expanded: ' + (d.before_gb || '?') + ' GB → ' + (d.after_gb || '?') + ' GB', 'ok');
				// re-detect so the card reflects the new state
				expandBtn.disabled = true;
				diskExpand('detect', btns, expandBtn, resultBox);
			}
		}).catch(function () {
			btns.forEach(function (b) { b.disabled = false; });
			expandBtn.disabled = true;
			App.toast('Disk expand request failed', 'error');
			resultBox.innerHTML = '<p class="muted">Request failed.</p>';
		});
	}

	function startPolling() {
		stopPolling();
		poller = App.poll(tick, { interval: 5000, maxInterval: 60000 });
		poller.start(true);
	}
	function stopPolling() { if (poller) { poller.stop(); poller = null; } }

	function tick() {
		if (!document.getElementById('sys-res-body')) { stopPolling(); return; }  // view left
		var requests = [App.api('/status/api.php?action=system').then(function (res) {
			if (res.status !== 200) throw new Error('system request failed');
			var b = document.getElementById('sys-res-body'); if (!b) return;
			var d = (res.body && res.body.data) || {};
			b.innerHTML = '';
			if (App.isAdmin) b.appendChild(gauge('CPU', d.cpu, (d.cpu || 0) + '%'));
			b.appendChild(gauge('Memory', d.ram, (d.ram || 0) + '%  ·  ' + human(d.total_ram || 0)));
			if ((d.total_swap || 0) > 0) b.appendChild(gauge('Swap', d.swap, (d.swap || 0) + '%  ·  ' + human(d.total_swap || 0)));
			if (App.isAdmin) b.appendChild(gauge('Disk', d.disk, (d.disk || 0) + '%  ·  ' + (d.total_disk || '')));
		})];
		if (App.isAdmin) {
			requests.push(App.api('/status/api.php?action=nodes').then(function (res) {
				if (res.status !== 200) throw new Error('node process request failed');
				var nb = document.getElementById('sys-nodes'); if (!nb) return;
				var d = (res.body && res.body.data) || {};
				var kinds = [['QEMU', 'qemu'], ['IOL', 'iol'], ['Dynamips', 'dynamips'], ['Docker', 'docker'], ['VPCS', 'vpcs']];
				var total = kinds.reduce(function (a, p) { return a + (d[p[1]] || 0); }, 0);
				nb.innerHTML = '';
				// Compact inline summary: a single running-node line with small
				// type-labelled counts (replaces the big-number stat-tile grid).
				var sum = el('div', 'node-summary');
				var tot = el('div', 'ns-total');
				tot.appendChild(el('span', 'n' + (total > 0 ? ' live' : ''), String(total)));
				tot.appendChild(el('span', 'muted', total === 1 ? 'node running' : 'nodes running'));
				sum.appendChild(tot);
				if (total > 0) {
					sum.appendChild(el('span', 'ns-sep'));
					var items = el('div', 'ns-items');
					kinds.forEach(function (p) {
						var n = d[p[1]] || 0;
						if (!n) return;                       // only surface kinds that are actually running
						var it = el('div', 'ns-item is-live');
						it.appendChild(el('span', 'ns-n', String(n)));
						it.appendChild(document.createTextNode(p[0]));
						items.appendChild(it);
					});
					sum.appendChild(items);
				}
				nb.appendChild(sum);
				updateLiveChip(total);
			}));
		}
		return Promise.all(requests);
	}

	// Header live-count chip mirrors the Running Labs treatment: green + pulse
	// when nodes are running, quiet/idle when none are.
	function updateLiveChip(total) {
		var chip = document.getElementById('sys-livecount'); if (!chip) return;
		chip.className = 'rl-livecount' + (total > 0 ? '' : ' is-idle');
		chip.innerHTML = '';
		chip.appendChild(el('span', 'rl-pulse'));
		var lbl = el('span');
		if (total > 0) {
			lbl.appendChild(el('span', 'n', String(total)));
			lbl.appendChild(document.createTextNode(' running'));
		} else {
			lbl.textContent = 'Idle';
		}
		chip.appendChild(lbl);
	}

	function loadInfo() {
		App.api('/status/api.php?action=info').then(function (res) {
			var ib = document.getElementById('sys-info'); if (!ib) return;
			var d = (res.body && res.body.data) || {};
			ib.innerHTML = '';
			ib.appendChild(kv('Engine version', d.engine_version || '—'));
			ib.appendChild(kv('QEMU version', d.qemu_version || '—'));
			ib.appendChild(kv('CPU cores', String(d.cores || '—')));
			if (App.isAdmin) {
				ib.appendChild(toggleRow('KSM', 'ksm', d.ksm));
				ib.appendChild(toggleRow('UKSM', 'uksm', d.uksm));
				ib.appendChild(toggleRow('CPU limit', 'cpulimit', d.cpulimit));
				ib.appendChild(idleTimeoutRow(d.idle_timeout));
			} else {
				ib.appendChild(kv('KSM', d.ksm || '—'));
				ib.appendChild(kv('UKSM', d.uksm || '—'));
				ib.appendChild(kv('CPU limit', d.cpulimit || '—'));
			}
		});
	}

	// Site-wide idle/session timeout (minutes in the UI, seconds on the wire —
	// see includes/functions.php::getSessionTimeoutSeconds()). Every
	// authenticated request slides this window forward, so it governs how long
	// a user can sit idle anywhere in the app — including a lab's console/login
	// screen — before being logged back out. Admin-only, like the toggles above.
	function idleTimeoutRow(seconds) {
		var r = el('div', 'kv');
		r.appendChild(el('span', 'k', 'Idle timeout (minutes)'));
		var group = el('div');
		group.style.cssText = 'display:flex;gap:8px;align-items:center';
		var input = el('input'); input.type = 'number'; input.min = '1'; input.max = '1440';
		input.style.cssText = 'width:80px';
		input.value = String(Math.max(1, Math.round((seconds || 3600) / 60)));
		var saveBtn = el('button', 'btn btn-ghost'); saveBtn.type = 'button';
		saveBtn.appendChild(document.createTextNode('Save'));
		saveBtn.addEventListener('click', function () {
			var minutes = parseInt(input.value, 10);
			if (!minutes || minutes < 1 || minutes > 1440) {
				App.toast('Enter a value between 1 and 1440 minutes', 'error');
				return;
			}
			saveBtn.disabled = true;
			App.api('/status/api.php?action=idle_timeout', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ seconds: minutes * 60 })
			}).then(function (res) {
				saveBtn.disabled = false;
				if (res.status === 200 && res.body && res.body.ok) {
					App.toast('Idle timeout saved — applies on each user\'s next authenticated request', 'ok');
				} else {
					var reason = res.body && (res.body.error || res.body.message);
					App.toast('Could not save idle timeout' + (reason ? ': ' + reason : ''), 'error');
				}
			}).catch(function () { saveBtn.disabled = false; });
		});
		group.appendChild(input); group.appendChild(saveBtn);
		r.appendChild(group);
		return r;
	}

	function toggleRow(label, key, state) {
		var r = el('div', 'kv');
		r.appendChild(el('span', 'k', label));
		if (state === 'unsupported') {
			r.appendChild(el('span', 'badge badge-off', 'unsupported'));
			return r;
		}
		var sw = el('label', 'switch');
		var cb = el('input'); cb.type = 'checkbox'; cb.checked = (state === 'enabled');
		sw.appendChild(cb);
		sw.appendChild(el('span', 'slider'));
		cb.addEventListener('change', function () {
			cb.disabled = true;
			App.api('/status/api.php?action=' + key, {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ state: cb.checked })
			}).then(function (res) {
				cb.disabled = false;
				if (res.status === 200 && res.body && res.body.ok) {
					App.toast(label + ' ' + (cb.checked ? 'enabled' : 'disabled'), 'ok');
				} else {
					var reason = res.body && (res.body.error || res.body.message);
					App.toast('Could not change ' + label + (reason ? ': ' + reason : ''), 'error');
					cb.checked = !cb.checked;
				}
				loadInfo();
			}).catch(function () { cb.disabled = false; cb.checked = !cb.checked; });
		});
		r.appendChild(sw);
		return r;
	}

	App.register('system', { title: 'System', icon: 'fa-tachometer', render: render });
})();
