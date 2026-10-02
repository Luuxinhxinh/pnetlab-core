/* ============================================================================
   PNetLab dashboard — Docker Devices view (admin)
   Talks to the engine shim devices-factory/api.php (token-cookie authed) — the
   store's DevicesController re-homed engine-side (store decommission C4):
     POST /devices-factory/api.php?action=filter       → {result,data:[{device_id,
                                                          device_name,device_des,
                                                          device_img,device_version,
                                                          available}]}
     POST …?action=get     {device_id,overwritten}     → start pull
     POST …?action=delete  {device_id}                 → start remove
     POST …?action=pull    {ref}                       → start an ad-hoc `docker pull <ref>`
     POST …?action=process {device_id}                 → {finish,data:{log}}
     POST …?action=images                               → {result,data:[{id,repository,tag,
                                                          size,created,in_use}]} (local images)
     POST …?action=rmi     {ref}                       → `docker rmi <ref-or-id>` (no force)
   The catalog (ishare2/devices.json) is a set of ready-made Docker Hub images
   that become docker node types. Pulls run as root via the privilege broker.
   The "pull any image" box below the catalog reuses the same process/log
   lane for an ad-hoc ref that is not in the catalog at all.
   The "Installed images" list below that is the raw local Docker image
   store (docker images) — every pulled image, catalog or ad-hoc — with a
   per-row Delete so users can reclaim disk without touching a shell.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var devices = [], timers = {}, localImages = [];

	// Mirrors devices-factory/api.php's PNQ_REF_RE — keep both in sync. Strict
	// docker image reference: optional registry[:port]/, lowercase repo path
	// segments, optional :tag, optional @sha256:digest. No whitespace or shell
	// metacharacters can match this, so a ref that passes is safe to hand to
	// `docker pull` server-side (which also escapeshellarg()s it besides).
	var REF_RE = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

	function viewTitle(t, i) { var d = el('div', 'view-title'); d.appendChild(el('i', 'fa ' + i)); d.appendChild(document.createTextNode(' ' + t)); return d; }
	function btn(icon, label, cls, fn) { var b = el('button', cls); b.type = 'button'; b.appendChild(el('i', 'fa ' + icon)); if (label) b.appendChild(document.createTextNode(' ' + label)); b.addEventListener('click', fn); return b; }
	function stopAll() { Object.keys(timers).forEach(function (k) { timers[k].stop(); }); timers = {}; }
	function post(url, obj) { return App.api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) }); }
	function disable(foot, v) { foot.querySelectorAll('button').forEach(function (b) { b.disabled = v; }); }

	function render(view) {
		stopAll();
		var head = el('div', 'view-head vh-ruled');
		var left = el('div');
		left.style.cssText = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap';
		left.appendChild(viewTitle('Docker Devices', 'fa-cube'));
		var chip = el('span', 'vh-chip'); chip.id = 'dev-count'; chip.style.display = 'none';
		chip.appendChild(el('i', 'fa fa-check-circle'));
		chip.appendChild(el('span', 'n', '0'));
		chip.appendChild(document.createTextNode('installed'));
		left.appendChild(chip);
		head.appendChild(left);
		head.appendChild(btn('fa-refresh', 'Refresh', 'btn btn-ghost', load));
		view.appendChild(head);
		var card = el('div', 'card');
		card.appendChild(el('p', 'muted', 'Pull ready-made Docker container images to use as nodes in your labs.'));
		var groups = el('div'); groups.id = 'dev-grid';
		groups.appendChild(el('p', 'muted', 'Loading…'));
		card.appendChild(groups);
		view.appendChild(card);
		view.appendChild(pullCard());
		view.appendChild(localImagesCard());
		load();
		loadImages();
	}

	function load() {
		post('/devices-factory/api.php?action=filter', {}).then(function (res) {
			var host = document.getElementById('dev-grid'); if (!host) return;
			if (res.status !== 200 || !res.body || !res.body.result) {
				host.innerHTML = ''; host.appendChild(el('p', 'muted', (res.body && res.body.message) || 'Failed to load devices.')); return;
			}
			devices = res.body.data || [];
			updateCountChip();
			host.innerHTML = '';
			if (!devices.length) { host.appendChild(el('p', 'muted', 'No devices in the catalog.')); return; }
			// Group the flat icon-card grid into Installed vs Available so the
			// screen reads as two short lists instead of one long undifferentiated
			// wall of identical tiles.
			var installed = devices.filter(isInstalled);
			var available = devices.filter(function (d) { return !isInstalled(d); });
			if (installed.length) host.appendChild(groupSection('Installed', 'fa-check-circle', installed));
			if (available.length) host.appendChild(groupSection('Available', 'fa-download', available));
		});
	}

	function groupSection(title, icon, list) {
		var wrap = el('div');
		var h = el('div', 'group-head');
		h.appendChild(el('i', 'fa ' + icon));
		h.appendChild(document.createTextNode(title));
		h.appendChild(el('span', 'gh-count', String(list.length)));
		wrap.appendChild(h);
		var g = el('div', 'tile-cards');
		list.forEach(function (d) { g.appendChild(devTile(d)); });
		wrap.appendChild(g);
		return wrap;
	}

	function isInstalled(d) { return (String(d.device_available) === '1' || String(d.available) === '1'); }
	function updateCountChip() {
		var chip = document.getElementById('dev-count'); if (!chip) return;
		var n = devices.filter(isInstalled).length;
		if (!n) { chip.style.display = 'none'; return; }
		chip.style.display = '';
		chip.querySelector('.n').textContent = String(n);
	}

	function devTile(d) {
		var installed = isInstalled(d);
		var t = el('div', 'tile');
		var top = el('div', 'tile-top');
		var ic = el('span', 'tile-icon'); ic.style.cssText = 'font-size:0;padding:0;';
		if (d.device_img) { var im = el('img'); im.src = d.device_img; im.alt = ''; im.style.height = '30px'; ic.appendChild(im); }
		else { ic.style.fontSize = '28px'; ic.appendChild(el('i', 'fa fa-cube')); }
		top.appendChild(ic);
		top.appendChild(el('span', 'badge ' + (installed ? 'badge-ok' : 'badge-off'), installed ? 'installed' : 'not installed'));
		t.appendChild(top);
		t.appendChild(el('div', 'tile-name', d.device_name));
		// Description clamps to two lines; the long image tag + full description
		// are disclosed on hover (tile title) rather than always-visible noise.
		if (d.device_des) t.appendChild(el('div', 'tile-des clamp', d.device_des));
		var tip = [d.device_version, d.device_des].filter(Boolean).join('\n');
		if (tip) t.title = tip;
		var log = el('div', 'dev-log');
		var foot = el('div', 'tile-foot');
		foot.appendChild(el('span'));   // spacer
		if (installed) foot.appendChild(btn('fa-trash-o', 'Remove', 'btn btn-sm btn-danger', function () { doDelete(d, foot, log); }));
		else foot.appendChild(btn('fa-download', 'Install', 'btn btn-sm btn-primary', function () { doInstall(d, foot, log, false); }));
		t.appendChild(foot);
		t.appendChild(log);
		return t;
	}

	function doInstall(d, foot, log, overwritten) {
		disable(foot, true);
		post('/devices-factory/api.php?action=get', { device_id: d.device_id, overwritten: overwritten }).then(function (res) {
			var b = res.body || {};
			if (!b.result) {
				if (b.data && b.data.confirm) {
					App.confirm('"' + d.device_name + '" is already present. Re-pull it?', { okLabel: 'Re-pull' }).then(function (yes) {
						if (yes) doInstall(d, foot, log, true); else disable(foot, false);
					});
				} else { App.toast(b.message || 'Install failed', 'error'); disable(foot, false); }
				return;
			}
			App.toast('Pulling ' + d.device_name + '…');
			pollProcess(d, log);
		});
	}

	function doDelete(d, foot, log) {
		App.confirm('Remove Docker device "' + d.device_name + '"?', { danger: true, okLabel: 'Remove' }).then(function (yes) {
			if (!yes) return;
			disable(foot, true);
			post('/devices-factory/api.php?action=delete', { device_id: d.device_id }).then(function (res) {
				if (!res.body || !res.body.result) { App.toast((res.body && res.body.message) || 'Remove failed', 'error'); disable(foot, false); return; }
				pollProcess(d, log);
			});
		});
	}

	function pollProcess(d, log) {
		pollJob(d.device_id, log, function () { App.toast(d.device_name + ' — done', 'ok'); load(); loadImages(); });
	}

	// Generic poller shared by catalog installs/removes AND the ad-hoc pull box
	// below — same {finish,data:{log}} shape either way since both ride the
	// devices-factory job lane. onDone runs once the job's process_device row
	// disappears (the factory script deletes it on completion, success or not).
	function pollJob(id, log, onDone) {
		log.style.display = 'block'; log.textContent = 'Working…';
		if (timers[id]) timers[id].stop();
		var watcher = App.poll(function () {
			return post('/devices-factory/api.php?action=process', { device_id: id }).then(function (res) {
				if (res.status !== 200) throw new Error('device job status request failed');
				var p = (res.body && res.body.data) || {};
				if (p.data) log.textContent = p.data.log || p.data.process_device_log || log.textContent;
				if (p.finish) { watcher.stop(); if (timers[id] === watcher) delete timers[id]; onDone(); }
			});
		}, { interval: 1500, maxInterval: 30000 });
		timers[id] = watcher;
		watcher.start(true);
	}

	/* ---- ad-hoc "pull any image" box ---------------------------------------- */
	function pullCard() {
		var card = el('div', 'card');
		card.appendChild(el('div', 'card-title', 'Pull an image'));
		card.appendChild(el('p', 'muted', 'Pull any Docker Hub image by reference — not just the catalog above. Accepts a bare ref or a pasted "docker pull …" command.'));
		var row = el('div'); row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap';
		var input = el('input', 'input'); input.type = 'text'; input.placeholder = 'docker pull rspnet/pnet-browser:1.0'; input.autocomplete = 'off'; input.spellcheck = false;
		input.style.cssText = 'flex:1 1 320px;min-width:220px';
		input.setAttribute('aria-label', 'Docker image reference to pull');
		var pull = btn('fa-download', 'Pull image', 'btn btn-primary', doPull);
		row.appendChild(input); row.appendChild(pull);
		card.appendChild(row);
		var status = el('div', 'muted'); status.style.cssText = 'margin-top:8px;min-height:16px'; status.id = 'pull-status';
		card.appendChild(status);
		var log = el('div', 'dev-log'); log.id = 'pull-log';
		card.appendChild(log);

		input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doPull(); });

		function parseRef() {
			var raw = input.value.trim();
			if (/^docker\s+pull\s+/i.test(raw)) raw = raw.replace(/^docker\s+pull\s+/i, '').trim();
			return raw;
		}

		function doPull() {
			var ref = parseRef();
			if (!ref || !REF_RE.test(ref)) {
				status.textContent = '';
				App.toast('Not a valid image reference (e.g. rspnet/pnet-browser:1.0).', 'error');
				input.focus();
				return;
			}
			pull.disabled = true; input.disabled = true;
			status.textContent = 'Pulling ' + ref + '…';
			log.style.display = 'none'; log.textContent = '';
			post('/devices-factory/api.php?action=pull', { ref: ref }).then(function (res) {
				var b = res.body || {};
				if (!b.result || !b.data || !b.data.job_id) {
					status.textContent = '';
					App.toast(b.message || b.error || 'Pull failed to start.', 'error');
					pull.disabled = false; input.disabled = false;
					return;
				}
				pollJob(b.data.job_id, log, function () {
					status.textContent = '';
					pull.disabled = false; input.disabled = false;
					var ok = /done\./i.test(log.textContent || '') && !/failed/i.test(log.textContent || '');
					App.toast(ok ? (ref + ' — pulled') : ((log.textContent || '').trim().split('\n').pop() || (ref + ' — pull failed')), ok ? 'ok' : 'error');
					load();
					loadImages();
				});
			}).catch(function () {
				status.textContent = '';
				App.toast('Pull failed to start.', 'error');
				pull.disabled = false; input.disabled = false;
			});
		}

		return card;
	}

	/* ---- installed images -----------------------------------------------------
	   Raw local Docker image store (docker images), independent of the catalog
	   above — shows every pulled image (catalog installs AND ad-hoc pulls) so
	   users can see what is actually on disk and delete what they don't need.
	   ------------------------------------------------------------------------- */
	function localImagesCard() {
		var card = el('div', 'card');
		var head = el('div');
		head.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px';
		head.appendChild(el('div', 'card-title', 'Installed images'));
		var chip = el('span', 'gh-count'); chip.id = 'localimg-count'; chip.style.marginLeft = 'auto';
		head.appendChild(chip);
		head.appendChild(btn('fa-refresh', '', 'btn btn-ghost btn-sm', loadImages));
		card.appendChild(head);
		card.appendChild(el('p', 'muted', 'Every Docker image currently pulled on this server — from the catalog above or an ad-hoc pull.'));
		var list = el('div'); list.id = 'localimg-list';
		list.appendChild(el('p', 'muted', 'Loading…'));
		card.appendChild(list);
		return card;
	}

	function loadImages() {
		var host = document.getElementById('localimg-list'); if (!host) return;
		post('/devices-factory/api.php?action=images', {}).then(function (res) {
			host = document.getElementById('localimg-list'); if (!host) return;   // view may have changed while in flight
			if (res.status !== 200 || !res.body || !res.body.result) {
				host.innerHTML = ''; host.appendChild(el('p', 'muted', (res.body && res.body.message) || 'Failed to load local images.'));
				return;
			}
			localImages = res.body.data || [];
			var chip = document.getElementById('localimg-count');
			if (chip) chip.textContent = localImages.length ? String(localImages.length) : '';
			renderImagesList(host);
		}).catch(function () {
			host = document.getElementById('localimg-list'); if (!host) return;
			host.innerHTML = ''; host.appendChild(el('p', 'muted', 'Local images request failed.'));
		});
	}

	function renderImagesList(host) {
		host.innerHTML = '';
		if (!localImages.length) { host.appendChild(el('p', 'muted', 'No local images yet — pull one above.')); return; }
		var cl = el('div', 'checklist');
		var body = el('div', 'checklist-body'); body.style.maxHeight = '360px';
		localImages.forEach(function (img) { body.appendChild(imageRow(img)); });
		cl.appendChild(body);
		host.appendChild(cl);
	}

	function imageRow(img) {
		var row = el('div', 'checklist-item');
		row.appendChild(el('i', 'fa fa-cube'));
		var ref = imageRef(img);
		var name = el('span', 'ci-name mono', ref);
		row.appendChild(name);
		if (img.in_use) row.appendChild(el('span', 'badge badge-warn', 'in use'));
		if (img.size) row.appendChild(el('span', 'ci-meta', img.size));
		if (img.created) row.appendChild(el('span', 'ci-meta', img.created));
		if (img.id) row.appendChild(el('span', 'ci-meta mono', img.id));
		var del = btn('fa-trash-o', '', 'btn btn-sm btn-danger', function () { doDeleteImage(img, row, del); });
		del.setAttribute('aria-label', 'Delete image ' + ref);
		del.title = 'Delete ' + ref;
		row.appendChild(del);
		return row;
	}

	// repository:tag reads better than a bare id, but "<none>:<none>" (dangling
	// build layers) is not a valid docker ref — fall back to the short id, which
	// the server also accepts (PNQ_REF_RE OR a hex-id pattern).
	function imageRef(img) {
		if (img.repository && img.repository !== '<none>' && img.tag && img.tag !== '<none>') return img.repository + ':' + img.tag;
		return img.id || '';
	}

	function doDeleteImage(img, row, delBtn) {
		var ref = imageRef(img);
		if (!ref) return;
		App.confirm('Delete Docker image "' + ref + '"? This cannot be undone.', { danger: true, okLabel: 'Delete' }).then(function (yes) {
			if (!yes) return;
			delBtn.disabled = true;
			post('/devices-factory/api.php?action=rmi', { ref: ref }).then(function (res) {
				var b = res.body || {};
				if (res.status !== 200 || !b.result) {
					App.toast((b.message || b.error || 'Delete failed') + '', 'error');
					delBtn.disabled = false;
					return;
				}
				App.toast(ref + ' — deleted', 'ok');
				loadImages();
			}).catch(function () {
				App.toast('Delete failed to start.', 'error');
				delBtn.disabled = false;
			});
		});
	}

	App.register('devices', { title: 'Docker Devices', icon: 'fa-cube', admin: true, render: render });
})();
