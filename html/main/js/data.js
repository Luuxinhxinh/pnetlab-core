/* ============================================================================
   PNetLab dashboard — Import / Export view (admin)
   Wraps the existing engine "Import Data" backend import/api.php:
     POST ?action=discover  {host,user,pass,port}  → {images[],labs[]}
     POST ?action=import    {…,images[],labs[]}     → {job}
     GET  ?action=status&job=<16hex>                → {state,pct,msg}
   Pulls QEMU images / IOL bins / labs from another PNetLab server over SSH.
   The remote server's SSH password is entered by the user into the form (their
   own credential) and posted to the local engine, exactly as the legacy tool.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var conn = null, found = { images: [], labs: [] }, jobTimer = null;

	function viewTitle(t, i) { var d = el('div', 'view-title'); d.appendChild(el('i', 'fa ' + i)); d.appendChild(document.createTextNode(' ' + t)); return d; }
	function btn(icon, label, cls, fn) { var b = el('button', cls); b.type = 'button'; b.appendChild(el('i', 'fa ' + icon)); if (label) b.appendChild(document.createTextNode(' ' + label)); b.addEventListener('click', fn); return b; }
	function field(name, label, type, val) {
		var f = el('div', 'field'); f.appendChild(el('label', null, label));
		var i = el('input', 'input'); i.type = type || 'text'; i.id = 'imp-' + name; if (val != null) i.value = val;
		f.appendChild(i); return f;
	}
	function v(name) { var e = document.getElementById('imp-' + name); return e ? e.value.trim() : ''; }
	function stopJob() { if (jobTimer) { jobTimer.stop(); jobTimer = null; } }

	function render(view) {
		stopJob();
		var head = el('div', 'view-head'); head.appendChild(viewTitle('Import Data', 'fa-exchange'));
		view.appendChild(head);

		var c = el('div', 'card');
		c.appendChild(el('div', 'card-title', 'Import from another ' + App.brandName() + ' server'));
		c.appendChild(el('p', 'muted', 'Pull QEMU images, IOL binaries and labs from an existing ' + App.brandName() + ' / EVE-NG server over SSH.'));
		var grid = el('div', 'form-grid');
		grid.appendChild(field('host', 'Host / IP', 'text'));
		grid.appendChild(field('user', 'SSH user', 'text', 'root'));
		grid.appendChild(field('pass', 'SSH password', 'password'));
		grid.appendChild(field('port', 'Port', 'text', '22'));
		c.appendChild(grid);
		var tb = el('div', 'toolbar'); tb.style.marginTop = '12px';
		tb.appendChild(btn('fa-search', 'Discover', 'btn btn-primary', discover));
		c.appendChild(tb);
		view.appendChild(c);

		var results = el('div'); results.id = 'imp-results'; view.appendChild(results);

		var note = el('div', 'card');
		note.appendChild(el('div', 'card-title', 'Export labs'));
		var p = el('p', 'muted'); p.appendChild(document.createTextNode('Export individual or multiple labs from the '));
		var link = el('a', null, 'Labs'); link.href = '#/labs'; p.appendChild(link);
		p.appendChild(document.createTextNode(' view (per-row Export, or select several and use the bulk bar).'));
		note.appendChild(p);
		view.appendChild(note);
	}

	function discover() {
		var host = v('host'), user = v('user'), pass = v('pass'), port = v('port') || '22';
		if (!host || !user || !pass) { App.toast('Host, user and password are required.', 'error'); return; }
		conn = { host: host, user: user, pass: pass, port: parseInt(port, 10) || 22 };
		App.loading(true);
		App.api('/import/api.php?action=discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(conn) })
			.then(function (res) {
				App.loading(false);
				if (res.status !== 200 || !res.body || res.body.error) { App.toast((res.body && res.body.error) || 'Discovery failed.', 'error'); return; }
				found = { images: res.body.images || [], labs: res.body.labs || [] };
				renderResults();
			}).catch(function () { App.loading(false); });
	}

	function renderResults() {
		var r = document.getElementById('imp-results'); if (!r) return;
		r.innerHTML = '';
		var c = el('div', 'card');
		c.appendChild(el('div', 'card-title', 'Found ' + found.images.length + ' image(s) and ' + found.labs.length + ' lab(s) on ' + conn.host));
		if (found.images.length) {
			c.appendChild(checklist('Images', found.images.map(function (it) {
				return { label: it.name, meta: it.type.toUpperCase() + (it.size ? ' · ' + it.size : ''), installed: it.installed, data: { type: it.type, name: it.name } };
			}), 'imgsel'));
		}
		if (found.labs.length) {
			c.appendChild(checklist('Labs', found.labs.map(function (it) {
				return { label: it.path, meta: '', installed: it.installed, data: { path: it.path } };
			}), 'labsel'));
		}
		if (!found.images.length && !found.labs.length) c.appendChild(el('p', 'muted', 'Nothing found on the remote server.'));
		var tb = el('div', 'toolbar'); tb.style.marginTop = '4px';
		tb.appendChild(btn('fa-download', 'Import selected', 'btn btn-primary', doImport));
		c.appendChild(tb);
		var prog = el('div'); prog.id = 'imp-progress'; c.appendChild(prog);
		r.appendChild(c);
	}

	function checklist(title, items, group) {
		var wrap = el('div', 'checklist');
		var head = el('div', 'checklist-head');
		head.appendChild(el('span', null, title));
		var saWrap = el('label'); saWrap.style.cssText = 'font-weight:400;text-transform:none;display:flex;align-items:center;gap:6px;cursor:pointer;';
		var sa = el('input'); sa.type = 'checkbox';
		saWrap.appendChild(sa); saWrap.appendChild(document.createTextNode('select all'));
		head.appendChild(saWrap); wrap.appendChild(head);
		var body = el('div', 'checklist-body'); var boxes = [];
		items.forEach(function (it) {
			var row = el('div', 'checklist-item');
			var cb = el('input'); cb.type = 'checkbox'; cb.className = group; cb.dataset.payload = JSON.stringify(it.data);
			boxes.push(cb); row.appendChild(cb);
			row.appendChild(el('span', 'ci-name', it.label));
			if (it.meta) row.appendChild(el('span', 'ci-meta', it.meta));
			if (it.installed) row.appendChild(el('span', 'badge badge-off', 'installed'));
			body.appendChild(row);
		});
		sa.addEventListener('change', function () { boxes.forEach(function (b) { b.checked = sa.checked; }); });
		wrap.appendChild(body);
		return wrap;
	}

	function doImport() {
		if (!conn) { App.toast('Discover a server first.', 'error'); return; }
		var imgs = Array.prototype.slice.call(document.querySelectorAll('.imgsel:checked')).map(function (cb) { return JSON.parse(cb.dataset.payload); });
		var labs = Array.prototype.slice.call(document.querySelectorAll('.labsel:checked')).map(function (cb) { return JSON.parse(cb.dataset.payload).path; });
		if (!imgs.length && !labs.length) { App.toast('Select something to import.', 'error'); return; }
		var payload = { host: conn.host, user: conn.user, pass: conn.pass, port: conn.port, images: imgs, labs: labs };
		App.api('/import/api.php?action=import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
			.then(function (res) {
				if (res.status !== 200 || !res.body || !res.body.job) { App.toast((res.body && res.body.error) || 'Import failed to start.', 'error'); return; }
				pollJob(res.body.job);
			});
	}

	function pollJob(job) {
		var prog = document.getElementById('imp-progress'); if (!prog) return;
		prog.innerHTML = '';
		var bar = el('div', 'progress'); var fill = el('div', 'progress-bar'); bar.appendChild(fill);
		var label = el('div', 'muted', 'Starting…');
		prog.appendChild(bar); prog.appendChild(label);
		stopJob();
		jobTimer = App.poll(function () {
			return App.api('/import/api.php?action=status&job=' + encodeURIComponent(job)).then(function (res) {
				if (res.status !== 200) throw new Error('import status request failed');
				var j = res.body || {};
				fill.style.width = (j.pct || 0) + '%';
				label.textContent = j.msg || j.state || '';
				if (j.state === 'done') { fill.className = 'progress-bar done'; fill.style.width = '100%'; label.textContent = 'Import complete'; stopJob(); App.toast('Import complete', 'ok'); }
				else if (j.state === 'error') { fill.className = 'progress-bar err'; label.textContent = 'Error: ' + (j.msg || ''); stopJob(); App.toast('Import failed', 'error'); }
			});
		}, { interval: 1500, maxInterval: 30000 });
		jobTimer.start(true);
	}

	App.register('data', { title: 'Import Data', icon: 'fa-exchange', admin: true, render: render });
})();
