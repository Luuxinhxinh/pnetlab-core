/* ============================================================================
   PNetLab dashboard — Images view  (P1: manage; P2+P3: chunked upload)
   Wraps two backends:
     /ishare2/api.php        — remote catalog download (unchanged)
     /images-manage/api.php  — local image manager (list/mkdir/rename/delete/
                               download_file/download_folder + chunked upload)
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var catalog = [], meta = {}, timers = {};
	var mode         = localStorage.getItem('pnq-images-view') || 'list';
	var typeFilter   = localStorage.getItem('pnq-images-type') || 'all';
	var installedOnly = localStorage.getItem('pnq-images-installed') === '1';
	var sel = {};                        // catalog selection: key -> item (bulk actions)
	function selKey(it) { return it.type + ':' + it.id; }

	/* ---- shared tiny helpers ------------------------------------------------ */
	function viewTitle(t, i) { var d = el('div', 'view-title'); d.appendChild(el('i', 'fa ' + i)); d.appendChild(document.createTextNode(' ' + t)); return d; }
	function btn(icon, label, cls, fn) { var b = el('button', cls); b.type = 'button'; b.appendChild(el('i', 'fa ' + icon)); if (label) b.appendChild(document.createTextNode(' ' + label)); b.addEventListener('click', fn); return b; }
	function stopAll() { Object.keys(timers).forEach(function (k) { timers[k].stop(); }); timers = {}; }
	function mgApi(qs, opts) { return App.api('/images-manage/api.php' + qs, opts); }
	function mgPost(qs, body) {
		return mgApi(qs, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	}

	/* ---- Fix Permissions — same endpoint the lab-page sidebar uses --------- */
	// POST /system/api.php?action=fixPermission (admin-gated server-side; runs
	// unl_wrapper -a fixpermissions + iol_keygen via the broker). Can take a
	// while on large installs — keep the button disabled with a spinner until
	// the request settles, then toast the outcome.
	function fixPermsBtn() {
		var b = btn('fa-wrench', 'Fix Permissions', 'btn btn-ghost', function () {
			if (b.disabled) return;
			b.disabled = true;
			var ic = b.querySelector('i');
			if (ic) ic.className = 'fa fa-spinner fa-spin';
			App.api('/system/api.php?action=fixPermission', {
				method: 'POST',
				headers: { 'X-Requested-With': 'XMLHttpRequest' }
			}).then(function (res) {
				if (res.status === 200 && res.body && res.body.result) {
					App.toast('Permissions fixed', 'ok');
				} else {
					App.toast('Fix permissions failed: ' +
						((res.body && (res.body.message || res.body.error)) || 'HTTP ' + res.status), 'error');
				}
			}).catch(function () {
				App.toast('Fix permissions request failed', 'error');
			}).then(function () {
				b.disabled = false;
				if (ic) ic.className = 'fa fa-wrench';
			});
		});
		b.title = 'Fix filesystem permissions on images and labs (runs unl_wrapper fixpermissions)';
		return b;
	}

	/* ======================================================================
	   CATALOG (ishare2 remote download) — unchanged from original
	   ====================================================================== */
	function render(view) {
		stopAll();
		var head = el('div', 'view-head vh-ruled');
		var left = el('div');
		left.style.cssText = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap';
		left.appendChild(viewTitle('Images', 'fa-hdd-o'));
		var chip = el('span', 'vh-chip'); chip.id = 'img-count'; chip.style.display = 'none';
		chip.appendChild(el('i', 'fa fa-hdd-o'));
		chip.appendChild(el('span', 'n', '0'));
		chip.appendChild(document.createTextNode('images'));
		left.appendChild(chip);
		head.appendChild(left);
		var hr = el('div', 'toolbar');
		hr.appendChild(btn('fa-refresh', 'Refresh', 'btn btn-ghost', load));
		hr.appendChild(viewToggle());
		hr.appendChild(el('span', 'spacer'));
		hr.appendChild(fixPermsBtn());
		hr.appendChild(btn('fa-folder-open', 'Manage Local Images', 'btn btn-primary', openManageModal));
		head.appendChild(hr);
		view.appendChild(head);

		sel = {};
		var card = el('div', 'card');
		var bar = el('div', 'toolbar'); bar.style.marginBottom = '12px';
		var search = el('input', 'input'); search.type = 'search'; search.id = 'img-search'; search.placeholder = 'Search images…'; search.style.maxWidth = '320px';
		search.addEventListener('input', function () { renderList(search.value.trim().toLowerCase()); });
		bar.appendChild(search);
		bar.appendChild(typeFilterUI());
		bar.appendChild(installedToggle());
		bar.appendChild(el('span', 'spacer'));
		var info = el('span', 'muted'); info.id = 'img-info';
		bar.appendChild(info);
		card.appendChild(bar);
		var bulk = el('div'); bulk.id = 'img-bulk';   // bulk action bar (empty unless selection)
		card.appendChild(bulk);
		var list = el('div'); list.id = 'img-list';
		list.appendChild(el('p', 'muted', 'Loading catalog…'));
		card.appendChild(list);
		view.appendChild(card);
		load();
	}

	function load() {
		var list = document.getElementById('img-list');
		App.api('/ishare2/api.php?action=catalog').then(function (res) {
			if (res.status !== 200) { if (list) { list.innerHTML = ''; list.appendChild(el('p', 'muted', (res.body && res.body.error) || 'Catalog unavailable (needs server internet on first fetch).')); } return; }
			var b = res.body || {};
			catalog = [].concat((b.qemu || []).map(function (x) { x.type = 'qemu'; return x; }),
				(b.iol || []).map(function (x) { x.type = 'iol'; return x; }));
			catalog.sort(function (a, b2) { return (a.name || '').localeCompare(b2.name || ''); });
			meta = { updated: b.updated, stale: b.stale };
			var chip = document.getElementById('img-count');
			if (chip && catalog.length) {
				chip.style.display = '';
				chip.querySelector('.n').textContent = String(catalog.length);
				chip.lastChild.textContent = catalog.length === 1 ? 'image' : 'images';
			}
			renderList('');
		}).catch(function () { if (list) { list.innerHTML = ''; list.appendChild(el('p', 'muted', 'Catalog request failed.')); } });
	}

	function curFilter() { var s = document.getElementById('img-search'); return s ? s.value.trim().toLowerCase() : ''; }

	function renderList(filter) {
		var list = document.getElementById('img-list'); if (!list) return;
		list.innerHTML = '';
		var rows = catalog.filter(function (it) {
			if (typeFilter !== 'all' && it.type !== typeFilter) return false;
			if (installedOnly && !it.installed) return false;
			return !filter || (it.name || '').toLowerCase().indexOf(filter) >= 0;
		});
		// Live filtered-count so the active filters/search are legible at a glance.
		var info = document.getElementById('img-info');
		if (info) info.textContent = catalog.length ? ('showing ' + rows.length + ' of ' + catalog.length) : '';
		if (!rows.length) { list.appendChild(el('p', 'muted', 'No matching images.')); refreshBulk(); return; }
		if (mode === 'grid') {
			var grid = el('div', 'tile-cards');
			rows.forEach(function (it) { grid.appendChild(imgTile(it)); });
			list.appendChild(grid);
		} else {
			var cl = el('div', 'checklist');
			var body = el('div', 'checklist-body'); body.style.maxHeight = '60vh';
			rows.forEach(function (it) { body.appendChild(imgRow(it)); });
			cl.appendChild(body);
			list.appendChild(cl);
		}
		refreshBulk();
	}

	function installedToggle() {
		var lab = el('label');
		lab.style.cssText = 'display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-size:13px;color:var(--pnq-text-muted);white-space:nowrap;';
		var cb = el('input'); cb.type = 'checkbox'; cb.checked = installedOnly;
		cb.addEventListener('change', function () {
			installedOnly = cb.checked;
			localStorage.setItem('pnq-images-installed', cb.checked ? '1' : '0');
			renderList(curFilter());
		});
		lab.appendChild(cb); lab.appendChild(document.createTextNode('Installed only'));
		return lab;
	}

	/* ---- bulk selection + batch get/delete (mirrors the Labs bulk bar) ------ */
	function refreshBulk() {
		var host = document.getElementById('img-bulk'); if (!host) return;
		host.innerHTML = '';
		var items = Object.keys(sel).map(function (k) { return sel[k]; });
		if (!items.length) return;
		var inst  = items.filter(function (it) { return it.installed; });
		var avail = items.filter(function (it) { return !it.installed; });
		var bar = el('div', 'bulkbar');
		bar.appendChild(el('span', 'count', items.length + ' selected'));
		bar.appendChild(el('span', 'spacer'));
		if (avail.length) bar.appendChild(btn('fa-download', 'Get ' + avail.length, 'btn btn-sm', function () { bulkRun(avail, 'get'); }));
		if (inst.length)  bar.appendChild(btn('fa-trash-o', 'Delete ' + inst.length, 'btn btn-sm btn-danger', function () { bulkDelete(inst); }));
		bar.appendChild(btn('fa-times', 'Clear', 'btn btn-sm btn-ghost', function () { sel = {}; renderList(curFilter()); }));
		host.appendChild(bar);
	}

	function bulkDelete(items) {
		App.confirm('Delete ' + items.length + ' selected image' + (items.length > 1 ? 's' : '') + ' from this server? This cannot be undone.',
			{ danger: true, okLabel: 'Delete ' + items.length }).then(function (yes) { if (yes) bulkRun(items, 'delete'); });
	}

	// Sequential — each catalog get/delete is its own polled job; running them
	// one at a time keeps the master from being swamped (same shape as the
	// Running Labs "destroy all" runner).
	function bulkRun(items, kind) {
		var actionWord = kind === 'delete' ? 'Deleting' : 'Downloading';
		var doneWord   = kind === 'delete' ? 'deleted' : 'downloaded';
		sel = {}; refreshBulk();
		var panel = el('div', 'import-progress');
		var head = el('div', 'import-progress-title');
		head.appendChild(el('i', 'fa ' + (kind === 'delete' ? 'fa-trash-o' : 'fa-download')));
		head.appendChild(document.createTextNode(' ' + actionWord + ' ' + items.length + ' image' + (items.length > 1 ? 's' : '') + '…'));
		var bar = el('div', 'progress'); var fill = el('div', 'progress-bar'); bar.appendChild(fill);
		var label = el('div', 'import-progress-label muted', 'Starting…');
		panel.appendChild(head); panel.appendChild(bar); panel.appendChild(label);
		document.body.appendChild(panel);
		var i = 0, good = 0, results = [];
		function step() {
			if (i >= items.length) {
				load();
				var bad = results.filter(function (r) { return !r.ok; });
				if (bad.length) {
					// Failures persist: replace the progress panel with the
					// per-item report so the error text outlives the 3.6s toast.
					panel.remove();
					App.batchReport(bad.length + ' of ' + items.length + ' image' + (items.length === 1 ? '' : 's') + ' could not be ' + doneWord, results);
					return;
				}
				fill.style.width = '100%';
				fill.className = 'progress-bar done';
				label.textContent = good + ' of ' + items.length + ' ' + doneWord;
				App.toast(good + ' image' + (good === 1 ? '' : 's') + ' ' + doneWord, 'ok');
				setTimeout(function () { panel.remove(); }, 1800);
				return;
			}
			var it = items[i];
			label.textContent = actionWord + ' "' + it.name + '" (' + (i + 1) + '/' + items.length + ')…';
			fill.style.width = Math.round(i / items.length * 100) + '%';
			startJob(it, kind).then(function () { good++; results.push({ name: it.name, ok: true }); i++; step(); })
				.catch(function (e) { results.push({ name: it.name, ok: false, error: (e && e.message) || 'failed' }); i++; step(); });
		}
		step();
	}

	function startJob(it, kind) {
		var action = kind === 'delete' ? 'delete' : 'download';
		return App.api('/ishare2/api.php?action=' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: it.type, id: it.id }) })
			.then(function (res) {
				if (res.status !== 200 || !res.body || !res.body.job) throw new Error((res.body && res.body.error) || 'failed to start');
				return waitJob(res.body.job);
			});
	}
	function waitJob(job) {
		return new Promise(function (resolve, reject) {
			var poller = App.poll(function () {
				return App.api('/ishare2/api.php?action=status&job=' + encodeURIComponent(job)).then(function (res) {
					if (res.status !== 200) throw new Error('image job status request failed');
					var j = res.body || {};
					if (j.state === 'done') { poller.stop(); resolve(); }
					else if (j.state === 'error') { poller.stop(); reject(new Error(j.msg || 'failed')); }
				});
			}, { interval: 1500, maxInterval: 30000 });
			poller.start(true);
		});
	}

	function viewToggle() {
		var wrap = el('div', 'view-toggle');
		[['list', 'fa-list', 'List view'], ['grid', 'fa-th-large', 'Card view']].forEach(function (p) {
			var b = el('button'); b.type = 'button'; b.title = p[2];
			if (mode === p[0]) b.className = 'active';
			b.appendChild(el('i', 'fa ' + p[1]));
			b.addEventListener('click', function () {
				if (mode === p[0]) return;
				mode = p[0]; localStorage.setItem('pnq-images-view', p[0]);
				wrap.querySelectorAll('button').forEach(function (x) { x.className = ''; }); b.className = 'active';
				var s = document.getElementById('img-search');
				renderList(s ? s.value.trim().toLowerCase() : '');
			});
			wrap.appendChild(b);
		});
		return wrap;
	}

	function typeFilterUI() {
		var wrap = el('div', 'tabs');
		[['all', 'All'], ['qemu', 'QEMU'], ['iol', 'IOL']].forEach(function (p) {
			var b = el('button', 'tab' + (typeFilter === p[0] ? ' active' : '')); b.type = 'button'; b.textContent = p[1];
			b.addEventListener('click', function () {
				if (typeFilter === p[0]) return;
				typeFilter = p[0]; localStorage.setItem('pnq-images-type', p[0]);
				wrap.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); }); b.classList.add('active');
				var s = document.getElementById('img-search');
				renderList(s ? s.value.trim().toLowerCase() : '');
			});
			wrap.appendChild(b);
		});
		return wrap;
	}

	function imgTile(it) {
		var t = el('div', 'tile');
		var top = el('div', 'tile-top');
		top.appendChild(el('span', 'badge', it.type.toUpperCase()));
		if (it.size) top.appendChild(el('span', 'ci-meta', it.size));
		t.appendChild(top);
		var ic = el('div', 'tile-icon'); ic.appendChild(el('i', 'fa ' + (it.type === 'iol' ? 'fa-microchip' : 'fa-hdd-o'))); t.appendChild(ic);
		t.appendChild(el('div', 'tile-name', it.name));
		var foot = el('div', 'tile-foot');
		var prog = el('span', 'img-prog'); prog.style.cssText = 'flex:1 1 auto; display:none;';
		var pbar = el('div', 'progress'); pbar.style.margin = '0'; var pfill = el('div', 'progress-bar'); pbar.appendChild(pfill); prog.appendChild(pbar);
		if (it.installed) {
			foot.appendChild(el('span', 'badge badge-ok', 'installed'));
			foot.appendChild(btn('fa-trash-o', '', 'btn btn-sm btn-danger', function () { delCatalog(it, prog, pfill, foot); }));
		} else {
			foot.appendChild(el('span'));
			foot.appendChild(btn('fa-download', 'Get', 'btn btn-sm btn-primary', function () { download(it, prog, pfill, foot); }));
		}
		foot.appendChild(prog);
		t.appendChild(foot);
		return t;
	}

	function imgRow(it) {
		var row = el('div', 'checklist-item');
		var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!sel[selKey(it)];
		cb.style.flex = 'none';
		cb.addEventListener('change', function () {
			if (cb.checked) sel[selKey(it)] = it; else delete sel[selKey(it)];
			refreshBulk();
		});
		row.appendChild(cb);
		row.appendChild(el('span', 'badge', it.type.toUpperCase()));
		var name = el('span', 'ci-name', it.name);
		row.appendChild(name);
		if (it.size) row.appendChild(el('span', 'ci-meta', it.size));
		var actions = el('span'); actions.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:120px;justify-content:flex-end;';
		var prog = el('span', 'img-prog'); prog.style.cssText = 'width:90px;display:none;';
		var pbar = el('div', 'progress'); pbar.style.margin = '0'; var pfill = el('div', 'progress-bar'); pbar.appendChild(pfill); prog.appendChild(pbar);
		if (it.installed) {
			actions.appendChild(el('span', 'badge badge-ok', 'installed'));
			actions.appendChild(btn('fa-trash-o', '', 'btn btn-sm btn-danger', function () { delCatalog(it, prog, pfill, actions); }));
		} else {
			actions.appendChild(btn('fa-download', 'Get', 'btn btn-sm btn-primary', function () { download(it, prog, pfill, actions); }));
		}
		actions.appendChild(prog);
		row.appendChild(actions);
		return row;
	}

	function download(it, prog, pfill, actions) {
		actions.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
		prog.style.display = '';
		App.api('/ishare2/api.php?action=download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: it.type, id: it.id }) })
			.then(function (res) {
				if (res.status !== 200 || !res.body || !res.body.job) { App.toast((res.body && res.body.error) || 'Download failed to start', 'error'); prog.style.display = 'none'; actions.querySelectorAll('button').forEach(function (b) { b.disabled = false; }); return; }
				pollJob(res.body.job, pfill, it.name, 'Downloaded');
			});
	}
	function delCatalog(it, prog, pfill, actions) {
		App.confirm('Delete image "' + it.name + '" from this server?', { danger: true, okLabel: 'Delete' }).then(function (yes) {
			if (!yes) return;
			actions.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
			prog.style.display = '';
			App.api('/ishare2/api.php?action=delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: it.type, id: it.id }) })
				.then(function (res) {
					if (res.status !== 200 || !res.body || !res.body.job) { App.toast((res.body && res.body.error) || 'Delete failed', 'error'); prog.style.display = 'none'; return; }
					pollJob(res.body.job, pfill, it.name, 'Deleted');
				});
		});
	}

	function pollJob(job, pfill, name, doneWord) {
		if (timers[job]) timers[job].stop();
		var watcher = App.poll(function () {
			return App.api('/ishare2/api.php?action=status&job=' + encodeURIComponent(job)).then(function (res) {
				if (res.status !== 200) throw new Error('image job status request failed');
				var j = res.body || {};
				pfill.style.width = (j.pct || 0) + '%';
				if (j.state === 'done') { pfill.className = 'progress-bar done'; pfill.style.width = '100%'; watcher.stop(); if (timers[job] === watcher) delete timers[job]; App.toast(doneWord + ' ' + name, 'ok'); load(); }
				else if (j.state === 'error') { pfill.className = 'progress-bar err'; watcher.stop(); if (timers[job] === watcher) delete timers[job]; App.toast((j.msg || 'Failed') + ': ' + name, 'error'); }
			});
		}, { interval: 1500, maxInterval: 30000 });
		timers[job] = watcher;
		watcher.start(true);
	}

	/* ======================================================================
	   LOCAL IMAGE MANAGER — Manage Modal (P1) + Chunked Upload (P2/P3)
	   ====================================================================== */

	var CHUNK_SIZE = 4 * 1024 * 1024;  // 4 MB — matches PHP side

	/* ---- open the manage modal --------------------------------------------- */
	function openManageModal() {
		var wrap = el('div');
		wrap.style.minHeight = '400px';

		// Tabs: Manage | Upload
		var tabBar = el('div', 'tabs'); tabBar.style.marginBottom = '16px';
		var tabManage = el('button', 'tab active'); tabManage.type = 'button'; tabManage.textContent = 'Manage';
		var tabUpload = el('button', 'tab'); tabUpload.type = 'button'; tabUpload.textContent = 'Upload';
		tabBar.appendChild(tabManage); tabBar.appendChild(tabUpload);
		wrap.appendChild(tabBar);

		var paneManage = el('div'); paneManage.id = 'imgmgr-manage-pane';
		var paneUpload = el('div'); paneUpload.id = 'imgmgr-upload-pane'; paneUpload.style.display = 'none';
		wrap.appendChild(paneManage);
		wrap.appendChild(paneUpload);

		tabManage.addEventListener('click', function () {
			tabManage.classList.add('active'); tabUpload.classList.remove('active');
			paneManage.style.display = ''; paneUpload.style.display = 'none';
		});
		tabUpload.addEventListener('click', function () {
			tabUpload.classList.add('active'); tabManage.classList.remove('active');
			paneUpload.style.display = ''; paneManage.style.display = 'none';
			renderUploadPane(paneUpload);
		});

		App.modal({ title: 'Local Image Manager', body: wrap, wide: true, dismissable: true });
		renderManagePane(paneManage);
	}

	/* ---- MANAGE PANE ------------------------------------------------------- */
	function renderManagePane(pane) {
		pane.innerHTML = '';
		pane.appendChild(el('p', 'muted', 'Loading…'));

		mgApi('?action=list').then(function (res) {
			if (res.status !== 200) {
				pane.innerHTML = '';
				pane.appendChild(el('p', 'muted', (res.body && res.body.error) || 'Failed to load image list.'));
				return;
			}
			var d = res.body || {};
			pane.innerHTML = '';

			// ---- Toolbar ----
			var toolbar = el('div', 'toolbar'); toolbar.style.marginBottom = '12px';
			toolbar.appendChild(btn('fa-refresh', 'Refresh', 'btn btn-ghost btn-sm', function () { renderManagePane(pane); }));
			toolbar.appendChild(btn('fa-folder-plus', 'New QEMU Folder', 'btn btn-ghost btn-sm', function () { doNewFolder(pane); }));
			pane.appendChild(toolbar);

			var scroll = el('div'); scroll.style.cssText = 'max-height:60vh;overflow-y:auto;';

			// ---- QEMU section ----
			var qemu = d.qemu || [];
			scroll.appendChild(sectionHeader('QEMU Images', 'fa-hdd-o', qemu.length + ' folder(s)'));
			if (qemu.length === 0) {
				scroll.appendChild(el('p', 'muted', 'No QEMU images installed.'));
			} else {
				var qtable = el('div', 'checklist');
				qemu.forEach(function (entry) {
					// Folder row (collapsible)
					var folderRow = el('div', 'checklist-item');
					folderRow.style.cursor = 'pointer'; folderRow.style.fontWeight = '600';
					var chevron = el('i', 'fa fa-chevron-down');
					chevron.style.cssText = 'width:14px;transition:transform .2s;';
					folderRow.appendChild(chevron);
					folderRow.appendChild(el('i', 'fa fa-folder-open'));
					folderRow.appendChild(document.createTextNode(' ' + entry.dir));
					var metaSpan = el('span', 'ci-meta', entry.human || '');
					metaSpan.style.marginLeft = 'auto';
					folderRow.appendChild(metaSpan);

					// Folder actions
					var fa = el('span'); fa.style.cssText = 'display:flex;gap:6px;margin-left:8px;';
					(function (dir) {
						fa.appendChild(btn('fa-download', '', 'btn btn-sm btn-ghost', function (e) {
							e.stopPropagation();
							window.location.href = '/images-manage/api.php?action=download_folder&type=qemu&dir=' + encodeURIComponent(dir);
						}));
						fa.appendChild(btn('fa-pencil', '', 'btn btn-sm btn-ghost', function (e) {
							e.stopPropagation();
							doRename('qemu', dir, true, pane);
						}));
						fa.appendChild(btn('fa-trash-o', '', 'btn btn-sm btn-danger', function (e) {
							e.stopPropagation();
							doDelete('qemu', dir, '"' + dir + '" (entire folder)', pane);
						}));
					}(entry.dir));
					folderRow.appendChild(fa);
					qtable.appendChild(folderRow);

					// File sub-rows
					var fileWrap = el('div'); fileWrap.style.cssText = 'padding-left:24px;';
					var files = entry.files || [];
					if (files.length === 0) {
						fileWrap.appendChild(el('div', 'muted', '(empty)'));
					} else {
						files.forEach(function (f) {
							var frow = el('div', 'checklist-item');
							frow.appendChild(el('i', 'fa fa-file'));
							frow.appendChild(document.createTextNode(' ' + f.name));
							var fmeta = el('span', 'ci-meta', f.human || '');
							fmeta.style.marginLeft = 'auto';
							frow.appendChild(fmeta);
							var af = el('span'); af.style.cssText = 'display:flex;gap:6px;margin-left:8px;';
							(function (dir, fname) {
								af.appendChild(btn('fa-download', '', 'btn btn-sm btn-ghost', function () {
									window.location.href = '/images-manage/api.php?action=download_file&type=qemu&path=' +
										encodeURIComponent(dir + '/' + fname);
								}));
								af.appendChild(btn('fa-pencil', '', 'btn btn-sm btn-ghost', function () {
									doRename('qemu', dir + '/' + fname, false, pane);
								}));
								af.appendChild(btn('fa-trash-o', '', 'btn btn-sm btn-danger', function () {
									doDelete('qemu', dir + '/' + fname, '"' + fname + '"', pane);
								}));
							}(entry.dir, f.name));
							frow.appendChild(af);
							fileWrap.appendChild(frow);
						});
					}
					// Toggle collapse
					var expanded = true;
					folderRow.addEventListener('click', function () {
						expanded = !expanded;
						fileWrap.style.display = expanded ? '' : 'none';
						chevron.style.transform = expanded ? '' : 'rotate(-90deg)';
					});
					qtable.appendChild(fileWrap);
				});
				scroll.appendChild(qtable);
			}

			// ---- IOL section ----
			var iol = d.iol || [];
			scroll.appendChild(sectionHeader('IOL Binaries', 'fa-microchip', iol.length + ' file(s)'));
			if (iol.length === 0) {
				scroll.appendChild(el('p', 'muted', 'No IOL binaries installed.'));
			} else {
				var itable = el('div', 'checklist');
				iol.forEach(function (f) {
					var row = el('div', 'checklist-item');
					row.appendChild(el('i', 'fa fa-microchip'));
					row.appendChild(document.createTextNode(' ' + f.name));
					var fmeta = el('span', 'ci-meta', f.human || '');
					fmeta.style.marginLeft = 'auto';
					row.appendChild(fmeta);
					var af = el('span'); af.style.cssText = 'display:flex;gap:6px;margin-left:8px;';
					(function (fname) {
						af.appendChild(btn('fa-download', '', 'btn btn-sm btn-ghost', function () {
							window.location.href = '/images-manage/api.php?action=download_file&type=iol&path=' + encodeURIComponent(fname);
						}));
						af.appendChild(btn('fa-pencil', '', 'btn btn-sm btn-ghost', function () {
							doRename('iol', fname, false, pane);
						}));
						af.appendChild(btn('fa-trash-o', '', 'btn btn-sm btn-danger', function () {
							doDelete('iol', fname, '"' + fname + '"', pane);
						}));
					}(f.name));
					row.appendChild(af);
					itable.appendChild(row);
				});
				scroll.appendChild(itable);
			}

			// ---- Dynamips section ----
			var dyn = d.dynamips || [];
			scroll.appendChild(sectionHeader('Dynamips IOS', 'fa-microchip', dyn.length + ' file(s)'));
			if (dyn.length === 0) {
				scroll.appendChild(el('p', 'muted', 'No Dynamips images installed.'));
			} else {
				var dtable = el('div', 'checklist');
				dyn.forEach(function (f) {
					var row = el('div', 'checklist-item');
					row.appendChild(el('i', 'fa fa-file'));
					row.appendChild(document.createTextNode(' ' + f.name));
					var fmeta = el('span', 'ci-meta', f.human || '');
					fmeta.style.marginLeft = 'auto';
					row.appendChild(fmeta);
					var af = el('span'); af.style.cssText = 'display:flex;gap:6px;margin-left:8px;';
					(function (fname) {
						af.appendChild(btn('fa-download', '', 'btn btn-sm btn-ghost', function () {
							window.location.href = '/images-manage/api.php?action=download_file&type=dynamips&path=' + encodeURIComponent(fname);
						}));
						af.appendChild(btn('fa-pencil', '', 'btn btn-sm btn-ghost', function () {
							doRename('dynamips', fname, false, pane);
						}));
						af.appendChild(btn('fa-trash-o', '', 'btn btn-sm btn-danger', function () {
							doDelete('dynamips', fname, '"' + fname + '"', pane);
						}));
					}(f.name));
					row.appendChild(af);
					dtable.appendChild(row);
				});
				scroll.appendChild(dtable);
			}

			pane.appendChild(scroll);
		}).catch(function () {
			pane.innerHTML = '';
			pane.appendChild(el('p', 'muted', 'Request failed.'));
		});
	}

	function sectionHeader(title, icon, metaText) {
		var h = el('div');
		h.style.cssText = 'display:flex;align-items:center;gap:8px;margin:14px 0 6px;border-bottom:1px solid var(--pnq-border);padding-bottom:4px;font-weight:600;';
		h.appendChild(el('i', 'fa ' + icon));
		h.appendChild(document.createTextNode(title));
		var m = el('span', 'muted'); m.style.marginLeft = 'auto'; m.style.fontWeight = 'normal'; m.textContent = metaText;
		h.appendChild(m);
		return h;
	}

	function doNewFolder(pane) {
		App.prompt({ title: 'Create QEMU Image Folder', okLabel: 'Create', fields: [
			{ name: 'name', label: 'Folder name (e.g. vios-adventerprisek9-m)', placeholder: 'vios-adventerprisek9-m', required: true }
		]}).then(function (vals) {
			if (!vals || !(vals.name || '').trim()) return;
			mgPost('?action=mkdir', { type: 'qemu', name: vals.name.trim() })
				.then(function (res) {
					if (res.status === 200 && res.body && res.body.ok) {
						App.toast('Created: ' + (res.body.dir || vals.name.trim()), 'ok');
						renderManagePane(pane);
					} else {
						App.toast((res.body && res.body.error) || 'Create failed', 'error');
					}
				});
		});
	}

	function doRename(type, path, isDir, pane) {
		var base = path.split('/').pop();
		App.prompt({ title: 'Rename', okLabel: 'Rename', fields: [
			{ name: 'newname', label: 'New name', value: base, required: true }
		]}).then(function (vals) {
			if (!vals || !(vals.newname || '').trim()) return;
			mgPost('?action=rename', { type: type, path: path, newname: vals.newname.trim() })
				.then(function (res) {
					if (res.status === 200 && res.body && res.body.ok) {
						App.toast('Renamed to ' + vals.newname.trim(), 'ok');
						renderManagePane(pane);
					} else {
						App.toast((res.body && res.body.error) || 'Rename failed', 'error');
					}
				});
		});
	}

	function doDelete(type, path, label, pane) {
		App.confirm('Delete ' + label + '? This cannot be undone.', { danger: true, okLabel: 'Delete' }).then(function (yes) {
			if (!yes) return;
			mgPost('?action=delete', { type: type, path: path })
				.then(function (res) {
					if (res.status === 200 && res.body && res.body.ok) {
						App.toast('Deleted ' + label, 'ok');
						renderManagePane(pane);
					} else {
						App.toast((res.body && res.body.error) || 'Delete failed', 'error');
					}
				});
		});
	}

	/* ======================================================================
	   UPLOAD PANE — P2: chunked single-file upload; P3: folder/multi-file
	   ====================================================================== */

	function renderUploadPane(pane) {
		if (pane.dataset.rendered) return;   // already built
		pane.dataset.rendered = '1';
		pane.innerHTML = '';

		// ---- Destination picker ----
		var destRow = el('div');
		destRow.style.cssText = 'display:flex;align-items:flex-end;gap:12px;margin-bottom:16px;flex-wrap:wrap;';
		var typeWrap = el('div', 'field'); typeWrap.style.minWidth = '130px';
		typeWrap.appendChild(el('label', null, 'Image type'));
		var typeSelect = el('select', 'input');
		[['qemu', 'QEMU (.qcow2/.img/.vmdk/.iso)'], ['iol', 'IOL (.bin)'], ['dynamips', 'Dynamips (.image/.bin)']].forEach(function (o) {
			var opt = el('option', null, o[1]); opt.value = o[0]; typeSelect.appendChild(opt);
		});
		typeWrap.appendChild(typeSelect);
		destRow.appendChild(typeWrap);

		var dirWrap = el('div', 'field'); dirWrap.style.minWidth = '200px';
		dirWrap.appendChild(el('label', null, 'QEMU folder (required for QEMU)'));
		var dirSelect = el('select', 'input'); dirSelect.id = 'up-dir-select';
		dirWrap.appendChild(dirSelect);
		destRow.appendChild(dirWrap);

		pane.appendChild(destRow);

		function refreshDirSelect() {
			var type = typeSelect.value;
			dirWrap.style.display = (type === 'qemu') ? '' : 'none';
			if (type !== 'qemu') return;
			dirSelect.innerHTML = '';
			var loadOpt = el('option', null, 'Loading…'); loadOpt.value = ''; dirSelect.appendChild(loadOpt);
			mgApi('?action=list').then(function (res) {
				dirSelect.innerHTML = '';
				var opt0 = el('option', null, '— select folder —'); opt0.value = ''; dirSelect.appendChild(opt0);
				var dirs = (res.body && res.body.qemu) || [];
				dirs.forEach(function (d) {
					var opt = el('option', null, d.dir); opt.value = d.dir; dirSelect.appendChild(opt);
				});
			});
		}
		typeSelect.addEventListener('change', refreshDirSelect);
		refreshDirSelect();

		// ---- Drop zone ----
		var dropZone = el('div');
		dropZone.style.cssText = 'border:2px dashed var(--pnq-border);border-radius:8px;padding:32px;text-align:center;cursor:pointer;margin-bottom:16px;transition:background .2s;';
		var dzIcon = el('i', 'fa fa-cloud-upload');
		dzIcon.style.cssText = 'font-size:2rem;color:var(--pnq-text-muted);display:block;margin-bottom:8px;';
		dropZone.appendChild(dzIcon);
		dropZone.appendChild(el('p', 'muted', 'Drag & drop files or a folder here'));
		dropZone.appendChild(el('p', 'muted', '— or —'));

		var browseRow = el('div'); browseRow.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:8px;';

		// Hidden file inputs
		var fileInput = el('input'); fileInput.type = 'file'; fileInput.multiple = true;
		fileInput.style.display = 'none'; fileInput.accept = '.qcow2,.img,.vmdk,.iso,.bin,.image';
		var folderInput = el('input'); folderInput.type = 'file'; folderInput.multiple = true;
		try { folderInput.webkitdirectory = true; } catch (e) {}
		folderInput.style.display = 'none';

		browseRow.appendChild(btn('fa-file', 'Browse Files', 'btn btn-ghost btn-sm', function () { fileInput.click(); }));
		browseRow.appendChild(btn('fa-folder-open', 'Browse Folder', 'btn btn-ghost btn-sm', function () { folderInput.click(); }));
		dropZone.appendChild(browseRow);

		pane.appendChild(fileInput);
		pane.appendChild(folderInput);
		pane.appendChild(dropZone);

		// ---- Upload queue display ----
		var queueDiv = el('div'); queueDiv.id = 'up-queue';
		pane.appendChild(queueDiv);

		// ---- Drag-and-drop handlers ----
		dropZone.addEventListener('dragover', function (e) { e.preventDefault(); dropZone.style.background = 'var(--pnq-hover-veil)'; });
		dropZone.addEventListener('dragleave', function () { dropZone.style.background = ''; });
		dropZone.addEventListener('drop', function (e) {
			e.preventDefault(); dropZone.style.background = '';
			var items = e.dataTransfer && e.dataTransfer.items;
			if (items && items.length) {
				var entries = [];
				for (var i = 0; i < items.length; i++) {
					if (items[i].webkitGetAsEntry) {
						var entry = items[i].webkitGetAsEntry();
						if (entry) entries.push(entry);
					}
				}
				if (entries.length) {
					collectEntries(entries, '', function (files) {
						enqueueFiles(files, typeSelect.value, dirSelect.value, queueDiv);
					});
					return;
				}
			}
			if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
				var plain = [];
				for (var j = 0; j < e.dataTransfer.files.length; j++) {
					plain.push({ file: e.dataTransfer.files[j], rel: e.dataTransfer.files[j].name });
				}
				enqueueFiles(plain, typeSelect.value, dirSelect.value, queueDiv);
			}
		});

		fileInput.addEventListener('change', function () {
			var files = [];
			for (var i = 0; i < fileInput.files.length; i++) {
				files.push({ file: fileInput.files[i], rel: fileInput.files[i].name });
			}
			fileInput.value = '';
			enqueueFiles(files, typeSelect.value, dirSelect.value, queueDiv);
		});
		folderInput.addEventListener('change', function () {
			var files = [];
			for (var i = 0; i < folderInput.files.length; i++) {
				var f = folderInput.files[i];
				var rel = f.webkitRelativePath || f.name;
				files.push({ file: f, rel: rel });
			}
			folderInput.value = '';
			enqueueFiles(files, typeSelect.value, dirSelect.value, queueDiv);
		});
	}

	/* ---- Collect FileSystemEntry tree (drag-drop folders) ---- */
	function collectEntries(entries, prefix, cb) {
		var results = [], pending = entries.length;
		if (!pending) { cb(results); return; }
		entries.forEach(function (entry) {
			if (entry.isFile) {
				entry.file(function (f) {
					results.push({ file: f, rel: (prefix ? prefix + '/' : '') + f.name });
					if (--pending === 0) cb(results);
				}, function () { if (--pending === 0) cb(results); });
			} else if (entry.isDirectory) {
				var reader = entry.createReader();
				var all = [];
				(function readAll() {
					reader.readEntries(function (batch) {
						if (!batch.length) {
							collectEntries(all, (prefix ? prefix + '/' : '') + entry.name, function (sub) {
								results = results.concat(sub);
								if (--pending === 0) cb(results);
							});
							return;
						}
						all = all.concat(Array.prototype.slice.call(batch));
						readAll();
					}, function () { if (--pending === 0) cb(results); });
				}());
			} else {
				if (--pending === 0) cb(results);
			}
		});
	}

	/* ---- Upload queue ---- */
	var uploadQueue = [];
	var uploading = false;

	function enqueueFiles(files, type, dir, queueDiv) {
		if (!type) { App.toast('Select an image type first', 'error'); return; }

		var warned = false;
		files.forEach(function (f) {
			// Folder upload: the top-level path segment IS the qemu dir (import a whole image
			// folder, auto-created server-side). Flat file upload: use the folder picked in the
			// dropdown. The picker is only required for flat qemu file uploads.
			var slash = f.rel.indexOf('/');
			var effDir = (type === 'qemu' && slash >= 0) ? f.rel.slice(0, slash) : dir;
			if (type === 'qemu' && !effDir) {
				if (!warned) {
					App.toast('Select a QEMU folder first (or create one in the Manage tab), or drag a whole image folder to import it', 'error');
					warned = true;
				}
				return;
			}
			var ext = (f.file.name.split('.').pop() || '').toLowerCase();
			var ok = false;
			if (type === 'qemu'     && ['qcow2','img','vmdk','iso'].indexOf(ext) >= 0) ok = true;
			if (type === 'iol'      && ext === 'bin')                            ok = true;
			if (type === 'dynamips' && ['image','bin'].indexOf(ext) >= 0)        ok = true;
			if (!ok) {
				App.toast('Skipped ' + f.file.name + ' (wrong extension for ' + type + ')', 'error');
				return;
			}
			var chunks = Math.max(1, Math.ceil(f.file.size / CHUNK_SIZE));
			var item = { file: f.file, rel: f.rel, type: type, dir: effDir, chunks: chunks,
				token: null, state: 'queued', _rowId: null };
			uploadQueue.push(item);
			queueDiv.appendChild(buildQueueRow(item));
		});

		if (!uploading) processQueue();
	}

	function buildQueueRow(item) {
		var rid = 'uprow-' + Date.now() + '-' + Math.random().toString(36).slice(2);
		item._rowId = rid;
		var row = el('div', 'checklist-item'); row.id = rid;
		row.style.cssText = 'flex-direction:column;align-items:stretch;padding:8px;';
		var top = el('div'); top.style.cssText = 'display:flex;align-items:center;gap:8px;';
		top.appendChild(el('i', 'fa fa-file'));
		top.appendChild(el('span', null, item.rel));
		var fmeta = el('span', 'muted'); fmeta.style.marginLeft = 'auto'; fmeta.textContent = humanSize(item.file.size);
		top.appendChild(fmeta);
		var badge = el('span', 'badge'); badge.id = rid + '-status'; badge.textContent = 'Queued';
		top.appendChild(badge);
		row.appendChild(top);
		var pbar = el('div', 'progress'); pbar.style.marginTop = '6px';
		var pfill = el('div', 'progress-bar'); pfill.id = rid + '-fill'; pfill.style.width = '0%';
		pbar.appendChild(pfill); row.appendChild(pbar);
		return row;
	}

	function setRowState(item, state, pct) {
		var badge = document.getElementById(item._rowId + '-status');
		var fill  = document.getElementById(item._rowId + '-fill');
		if (badge) {
			badge.textContent = state;
			badge.className = 'badge' + (state === 'Done' ? ' badge-ok' : state === 'Error' ? ' badge-error' : '');
		}
		if (fill && pct != null) fill.style.width = pct + '%';
	}

	function humanSize(b) {
		if (b < 1024)       return b + ' B';
		if (b < 1048576)    return (Math.round(b / 1024 * 10) / 10) + ' KB';
		if (b < 1073741824) return (Math.round(b / 1048576 * 10) / 10) + ' MB';
		return (Math.round(b / 1073741824 * 100) / 100) + ' GB';
	}

	function processQueue() {
		var next = null;
		for (var i = 0; i < uploadQueue.length; i++) {
			if (uploadQueue[i].state === 'queued') { next = uploadQueue[i]; break; }
		}
		if (!next) { uploading = false; return; }
		uploading = true;
		next.state = 'uploading';
		setRowState(next, 'Uploading', 0);

		var body = { type: next.type, filename: next.file.name, size: next.file.size, chunks: next.chunks };
		if (next.type === 'qemu') body.dir = next.dir;

		mgPost('?action=upload_init', body).then(function (res) {
			if (res.status !== 200 || !res.body || !res.body.token) {
				next.state = 'error'; setRowState(next, 'Error', null);
				App.toast('Upload init failed: ' + ((res.body && res.body.error) || 'unknown'), 'error');
				processQueue(); return;
			}
			next.token = res.body.token;
			uploadChunks(next, 0);
		}).catch(function () {
			next.state = 'error'; setRowState(next, 'Error', null);
			App.toast('Network error during upload init', 'error');
			processQueue();
		});
	}

	function uploadChunks(item, idx) {
		if (idx >= item.chunks) {
			// All chunks sent — finish
			mgPost('?action=upload_finish', { token: item.token }).then(function (res) {
				if (res.status === 200 && res.body && res.body.ok) {
					item.state = 'done'; setRowState(item, 'Done', 100);
					App.toast('Uploaded ' + item.file.name, 'ok');
				} else {
					item.state = 'error'; setRowState(item, 'Error', null);
					App.toast('Finish failed: ' + ((res.body && res.body.error) || 'unknown'), 'error');
				}
				processQueue();
			}).catch(function () {
				item.state = 'error'; setRowState(item, 'Error', null); processQueue();
			});
			return;
		}

		var start = idx * CHUNK_SIZE;
		var end   = Math.min(start + CHUNK_SIZE, item.file.size);
		var blob  = item.file.slice(start, end);

		App.api(
			'/images-manage/api.php?action=upload_chunk&token=' + encodeURIComponent(item.token) + '&idx=' + idx,
			{ method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob }
		).then(function (res) {
			if (res.status !== 200) {
				item.state = 'error'; setRowState(item, 'Error', null);
				App.toast('Chunk ' + idx + ' failed: ' + ((res.body && res.body.error) || ''), 'error');
				mgPost('?action=upload_cancel', { token: item.token });
				processQueue(); return;
			}
			var pct = Math.round((idx + 1) / item.chunks * 100);
			setRowState(item, 'Uploading', pct);
			uploadChunks(item, idx + 1);
		}).catch(function () {
			item.state = 'error'; setRowState(item, 'Error', null);
			mgPost('?action=upload_cancel', { token: item.token });
			processQueue();
		});
	}

	/* ---- register view ----------------------------------------------------- */
	App.register('images', { title: 'Images', icon: 'fa-hdd-o', admin: true, render: render });
})();
