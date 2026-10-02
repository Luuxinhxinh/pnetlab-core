/* ============================================================================
   PNetLab dashboard — Clusters view (admin)
   Wraps the existing engine cluster backend cluster/api.php:
     GET  ?action=status                 → {psk_set,master_version,satellites[]}
     POST ?action=genpsk                 → {psk}  (shown once)
     POST ?action=deploy  {ip,user,pass,sudo_pass,host_id,name} → {job}
     GET  ?action=sync_status&job=<16hex> → {state,pct,msg}
     POST ?action=remove  {host}         → {ok}
     POST ?action=sync_sat {host}        → {job}  (push matching satellite +
                                                   bridge debs + restart satd)
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var jobTimer = null;
	var masterVersion = '';

	function viewTitle(t, i) { var d = el('div', 'view-title'); d.appendChild(el('i', 'fa ' + i)); d.appendChild(document.createTextNode(' ' + t)); return d; }
	function kv(k) { var r = el('div', 'kv'); r.appendChild(el('span', 'k', k)); return r; }
	function btn(icon, label, cls, fn) { var b = el('button', cls); b.type = 'button'; b.appendChild(el('i', 'fa ' + icon)); if (label) b.appendChild(document.createTextNode(' ' + label)); b.addEventListener('click', fn); return b; }
	function actBtn(icon, title, fn, kind) { var b = el('button', 'btn btn-sm btn-icon' + (kind ? ' btn-' + kind : ' btn-ghost')); b.type = 'button'; b.title = title; b.appendChild(el('i', 'fa ' + icon)); b.addEventListener('click', function (e) { e.stopPropagation(); fn(); }); return b; }
	function stopJob() { if (jobTimer) { jobTimer.stop(); jobTimer = null; } }
	function online(s) { return (s === 1 || s === '1' || s === true); }

	function render(view) {
		stopJob();
		var head = el('div', 'view-head vh-ruled');
		var left = el('div');
		left.style.cssText = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap';
		left.appendChild(viewTitle('Clusters', 'fa-server'));
		var chip = el('span', 'vh-chip'); chip.id = 'cl-satcount'; chip.style.display = 'none';
		chip.appendChild(el('i', 'fa fa-server'));
		chip.appendChild(el('span', 'n', '0'));
		chip.appendChild(document.createTextNode('satellites'));
		left.appendChild(chip);
		head.appendChild(left);
		head.appendChild(btn('fa-plus', 'Add satellite', 'btn btn-primary', addSatellite));
		view.appendChild(head);
		var status = el('div', 'card'); status.id = 'cl-status'; status.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(status);
		var sats = el('div', 'card'); sats.id = 'cl-sats'; sats.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(sats);
		load();
	}

	function load() {
		App.api('/cluster/api.php?action=status').then(function (res) {
			if (res.status !== 200) { App.toast((res.body && res.body.error) || 'Could not load cluster status', 'error'); return; }
			var d = res.body || {};
			// Display shows the friendly release (d.master_version); version-skew
			// detection for satellite sync compares the deb package version.
			masterVersion = d.master_pkg || d.master_version || '';
			renderStatus(d);
			renderSats(d.satellites || []);
		});
	}

	function renderStatus(d) {
		var c = document.getElementById('cl-status'); if (!c) return;
		c.innerHTML = '';
		c.appendChild(el('div', 'card-title', 'Cluster'));
		var mv = kv('Master version'); mv.appendChild(el('span', 'v', d.master_version || '—')); c.appendChild(mv);
		var psk = kv('Pre-shared key');
		var right = el('span'); right.style.cssText = 'display:flex;align-items:center;gap:10px;';
		right.appendChild(el('span', 'badge ' + (d.psk_set ? 'badge-ok' : 'badge-off'), d.psk_set ? 'set' : 'not set'));
		right.appendChild(btn('fa-key', d.psk_set ? 'Regenerate' : 'Generate', 'btn btn-sm', genpsk));
		psk.appendChild(right);
		c.appendChild(psk);
		var help = el('p', 'muted'); help.style.marginTop = '10px';
		help.textContent = 'Generate a pre-shared key, then add a satellite — the master deploys ' + App.brandName() + ' to it over SSH and it joins the cluster.';
		c.appendChild(help);
		var help2 = el('p', 'muted'); help2.style.marginTop = '6px';
		help2.textContent = 'A satellite just needs to be a clean Ubuntu 26.04 ("27H1 Resolute") host reachable from this master, with SSH login already set up (root, or a sudo user — only needed if not root); nothing else has to be pre-installed, since the master pushes the bundle, runs the installer, and reboots it. The SSH credentials are used once, only to perform that install. The pre-shared key is separate: it authenticates ongoing master↔satellite control-plane traffic after the join, not the SSH step itself — it does not secure lab traffic or database access, so keep satellites on a trusted network segment.';
		c.appendChild(help2);
	}

	// Extract the M.N.P numeric core from a version string (e.g. "6.8.25-resolute" → "6.8.25").
	function versionCore(v) {
		var m = String(v || '').match(/(\d+\.\d+\.\d+)/);
		return m ? m[1] : '';
	}

	function renderSats(sats) {
		var c = document.getElementById('cl-sats'); if (!c) return;
		var chip = document.getElementById('cl-satcount');
		if (chip) {
			if (sats.length) {
				chip.style.display = '';
				chip.querySelector('.n').textContent = String(sats.length);
				chip.lastChild.textContent = sats.length === 1 ? 'satellite' : 'satellites';
			} else { chip.style.display = 'none'; }
		}
		c.innerHTML = '';
		c.appendChild(el('div', 'card-title', 'Satellites'));
		if (!sats.length) {
			var e = el('div', 'empty');
			e.appendChild(el('i', 'fa fa-server'));
			e.appendChild(el('div', null, 'No satellites joined yet.'));
			var sub = el('div', 'muted'); sub.style.marginTop = '6px';
			sub.textContent = 'Add a satellite host — the master deploys ' + App.brandName() + ' to it over SSH and it joins the cluster.';
			e.appendChild(sub);
			var cta = btn('fa-plus', 'Add satellite', 'btn btn-primary', addSatellite);
			cta.style.marginTop = '14px';
			e.appendChild(cta);
			c.appendChild(e); return;
		}
		var t = el('table', 'fm-table'); var thead = el('thead'); var hr = el('tr');
		['Slot', 'Name', 'IP', 'Status', 'Version', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
		thead.appendChild(hr); t.appendChild(thead);
		var tb = el('tbody');
		sats.forEach(function (s) {
			var tr = el('tr');
			tr.appendChild(el('td', null, String(s.host_id)));
			tr.appendChild(el('td', null, s.host_name || ''));
			tr.appendChild(el('td', 'mono', s.host_ip || ''));
			var st = el('td'); st.appendChild(el('span', 'badge ' + (online(s.host_status) ? 'badge-ok' : 'badge-off'), online(s.host_status) ? 'online' : 'offline')); tr.appendChild(st);
			tr.appendChild(el('td', null, s.host_version || ''));
			var act = el('td', 'fm-actions');
			// Capture loop vars for closures
			(function (sat) {
				act.appendChild(actBtn('fa-refresh', 'Sync', function () { syncSat(sat.host_id, sat.host_name, sat.host_version); }, null));
				act.appendChild(actBtn('fa-trash-o', 'Remove', function () { removeSat(sat.host_id, sat.host_name); }, 'danger'));
			}(s));
			tr.appendChild(act);
			tb.appendChild(tr);
		});
		t.appendChild(tb); c.appendChild(t);
	}

	function genpsk() {
		App.confirm('Generate a new cluster pre-shared key? Any existing satellites must rejoin with the new key.', { okLabel: 'Generate' }).then(function (yes) {
			if (!yes) return;
			App.loading(true);
			App.api('/cluster/api.php?action=genpsk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function (res) {
				App.loading(false);
				if (res.status === 200 && res.body && res.body.psk) { showPsk(res.body.psk); load(); }
				else App.toast((res.body && res.body.error) || 'Could not generate PSK', 'error');
			});
		});
	}

	function showPsk(psk) {
		var body = el('div');
		body.appendChild(el('p', 'muted', 'Copy this key now — it is shown only once. Use it when joining a satellite.'));
		var box = el('div', 'mono'); box.style.cssText = 'background:var(--pnq-surface-2);padding:12px;border-radius:7px;word-break:break-all;user-select:all;';
		box.textContent = psk;
		body.appendChild(box);
		App.modal({ title: 'Cluster pre-shared key', body: body, buttons: [{ label: 'Done', kind: 'primary', onClick: function (c) { c(); } }] });
	}

	function addSatellite() {
		App.prompt({
			title: 'Add satellite', okLabel: 'Deploy', fields: [
				{ name: 'ip', label: 'Satellite IP', required: true, placeholder: '192.168.x.x' },
				{ name: 'user', label: 'SSH user', value: 'root' },
				{ name: 'pass', label: 'SSH password', type: 'password', required: true },
				{ name: 'sudo_pass', label: 'sudo password (if SSH user is not root)', type: 'password' },
				{ name: 'host_id', label: 'Slot', type: 'select', value: '1', options: [{ label: 'Slot 1', value: '1' }, { label: 'Slot 2', value: '2' }, { label: 'Slot 3', value: '3' }, { label: 'Slot 4', value: '4' }, { label: 'Slot 5', value: '5' }] },
				{ name: 'name', label: 'Display name (optional)' }
			]
		}).then(function (vv) {
			if (!vv) return;
			var payload = { ip: (vv.ip || '').trim(), user: (vv.user || 'root').trim(), pass: vv.pass, sudo_pass: vv.sudo_pass || '', host_id: parseInt(vv.host_id, 10) || 1, name: (vv.name || '').trim() };
			App.api('/cluster/api.php?action=deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (res) {
				if (res.status === 200 && res.body && res.body.job) pollDeploy(res.body.job);
				else App.toast((res.body && res.body.error) || 'Deploy failed to start', 'error');
			});
		});
	}

	function pollDeploy(job) {
		var anchor = document.getElementById('cl-sats'); var view = document.getElementById('view');
		var prog = el('div', 'card'); prog.id = 'cl-deploy';
		prog.appendChild(el('div', 'card-title', 'Deploying satellite'));
		var bar = el('div', 'progress'); var fill = el('div', 'progress-bar'); bar.appendChild(fill);
		var label = el('div', 'muted', 'Starting…');
		prog.appendChild(bar); prog.appendChild(label);
		if (anchor && view) view.insertBefore(prog, anchor); else if (view) view.appendChild(prog);
		stopJob();
		jobTimer = App.poll(function () {
			return App.api('/cluster/api.php?action=sync_status&job=' + encodeURIComponent(job)).then(function (res) {
				if (res.status !== 200) throw new Error('cluster job status request failed');
				var j = res.body || {};
				fill.style.width = (j.pct || 0) + '%';
				label.textContent = j.msg || j.state || '';
				if (j.state === 'done') { fill.className = 'progress-bar done'; fill.style.width = '100%'; label.textContent = 'Satellite deployed'; stopJob(); App.toast('Satellite deployed', 'ok'); load(); }
				else if (j.state === 'error') { fill.className = 'progress-bar err'; label.textContent = 'Error: ' + (j.msg || ''); stopJob(); App.toast('Deploy failed', 'error'); }
			});
		}, { interval: 2000, maxInterval: 30000 });
		jobTimer.start(true);
	}

	function syncSat(host, name, satVersion) {
		var satCore = versionCore(satVersion);
		var mCore   = versionCore(masterVersion);
		var label = name || ('slot ' + host);
		var msg;
		if (satCore && mCore && satCore === mCore) {
			// A same-version satellite may predate pnetlab-bridge-dkms (or have
			// lost it during a kernel update), so Sync remains an explicit repair
			// action instead of being hidden behind the version-skew fast path.
			msg = 'Satellite "' + label + '" already has engine version ' + satCore +
			      '.\n\nRe-apply the matching satellite package and pnetlab-bridge-dkms LACP module, then restart satd?';
		} else {
			msg = 'Satellite "' + label + '" is on version ' +
			      (satVersion || '(unknown)') + ', master is ' + (masterVersion || '(unknown)') +
			      '.\n\nPush the matching satellite package and pnetlab-bridge-dkms LACP module, then restart satd?';
		}
		App.confirm(msg, { okLabel: 'Sync' }).then(function (yes) {
			if (!yes) return;
			App.api('/cluster/api.php?action=sync_sat', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ host: host }),
			}).then(function (res) {
				if (res.status === 200 && res.body && res.body.job) {
					pollSatSync(res.body.job, label);
				} else {
					App.toast((res.body && res.body.error) || 'Satellite sync failed to start', 'error');
				}
			});
		});
	}

	function pollSatSync(job, label) {
		var anchor = document.getElementById('cl-sats'); var view = document.getElementById('view');
		var prog = el('div', 'card'); prog.id = 'cl-satsync';
		prog.appendChild(el('div', 'card-title', 'Syncing satellite — ' + label));
		var bar = el('div', 'progress'); var fill = el('div', 'progress-bar'); bar.appendChild(fill);
		var lbl = el('div', 'muted', 'Starting…');
		prog.appendChild(bar); prog.appendChild(lbl);
		if (anchor && view) view.insertBefore(prog, anchor); else if (view) view.appendChild(prog);
		stopJob();
		jobTimer = App.poll(function () {
			return App.api('/cluster/api.php?action=sync_status&job=' + encodeURIComponent(job)).then(function (res) {
				if (res.status !== 200) throw new Error('cluster job status request failed');
				var j = res.body || {};
				fill.style.width = (j.pct || 0) + '%';
				lbl.textContent = j.msg || j.state || '';
				if (j.state === 'done') {
					fill.className = 'progress-bar done'; fill.style.width = '100%';
					lbl.textContent = 'Satellite and LACP bridge updated';
					stopJob();
					App.toast('Satellite and LACP bridge ' + label + ' updated', 'ok');
					load();
				} else if (j.state === 'error') {
					fill.className = 'progress-bar err';
					lbl.textContent = 'Error: ' + (j.msg || '');
					stopJob();
					App.toast('Satellite sync failed: ' + (j.msg || ''), 'error');
				}
			});
		}, { interval: 2000, maxInterval: 30000 });
		jobTimer.start(true);
	}

	function removeSat(host, name) {
		App.confirm('Remove satellite "' + (name || ('slot ' + host)) + '"? Stop its running labs first.', { danger: true, okLabel: 'Remove' }).then(function (yes) {
			if (!yes) return;
			App.loading(true);
			App.api('/cluster/api.php?action=remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: host }) }).then(function (res) {
				App.loading(false);
				if (res.status === 200 && res.body && res.body.ok) { App.toast('Satellite removed', 'ok'); load(); }
				else App.toast((res.body && res.body.error) || 'Could not remove satellite', 'error');
			});
		});
	}

	App.register('clusters', { title: 'Clusters', icon: 'fa-server', admin: true, render: render });
})();
