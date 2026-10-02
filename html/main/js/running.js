/* ============================================================================
   PNetLab dashboard — Running Labs view
   Lists OPEN lab sessions and lets the authenticated owner Open / Stop all
   nodes / Destroy each. Administrators receive the all-users list and retain
   the Destroy ALL operation — restoring what the legacy Store main page offered.
   List and card views (toggle persisted in localStorage), like the Labs view.

   List source (read-only, polled every 5s):
     GET  /status/api.php?action=sessions
          → {data:[{session,name,path,owner,pod,can_manage,nodes_total,nodes_running,hosts:[..]}]}
   Actions reuse the EXISTING engine routes (already admin/owner-gated +
   cluster-aware — they stop/wipe on whichever host actually runs each node):
     POST /api/labs/session/factory/join       {lab_session}  → then /legacy/topology
     POST /api/labs/session/factory/stopNodes   {lab_session}
     POST /api/labs/session/factory/destroy     {lab_session}
   CSP-safe: external file (script-src 'self'), no inline handlers / eval.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var poller = null;
	var busy = false;                 // suppress the poll redraw while an action runs
	var lastRows = [];                // last fetched list (so a view toggle redraws instantly)
	var view = localStorage.getItem('pnq-running-view') || 'list';

	function post(url, obj) {
		return App.api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj || {}) });
	}
	function ok(res) { var b = res.body || {}; return res.status === 200 && (b.status === 'success' || b.code === 200); }
	function actErr(res) { return App.errMsg(res.body) || 'Operation failed.'; }
	function hostLabel(h) { return h === 0 ? 'master' : 'sat' + h; }
	// Joined users may open a shared session, but only its owner/admin may
	// stop or destroy it. The API is authoritative; this keeps destructive
	// controls out of the UI instead of offering actions the backend denies.
	function canManage(r) { return r && r.can_manage !== false; }

	/* ---- ui atoms (same look as the Labs/System views) -------------------- */
	function viewTitle(text, icon) {
		var t = el('div', 'view-title');
		t.appendChild(el('i', 'fa ' + icon));
		t.appendChild(document.createTextNode(' ' + text));
		return t;
	}
	function btn(icon, label, cls, onClick) {
		var b = el('button', cls); b.type = 'button';
		b.appendChild(el('i', 'fa ' + icon));
		if (label) b.appendChild(document.createTextNode(' ' + label));
		b.addEventListener('click', onClick);
		return b;
	}
	function act(icon, title, onClick, kind) {
		var b = el('button', 'btn btn-sm btn-icon' + (kind ? ' btn-' + kind : ' btn-ghost'));
		b.type = 'button'; b.title = title;
		b.appendChild(el('i', 'fa ' + icon));
		b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
		return b;
	}
	// Bottom-bar action button for the card view (always visible, evenly sized).
	function cardAct(icon, title, cls, onClick) {
		var b = el('button', 'rl-act ' + cls); b.type = 'button'; b.title = title;
		b.appendChild(el('i', 'fa ' + icon));
		b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
		return b;
	}
	function viewToggle() {
		var wrap = el('div', 'view-toggle');
		[['list', 'fa-list', 'List view'], ['grid', 'fa-th-large', 'Card view']].forEach(function (p) {
			var b = el('button'); b.type = 'button'; b.title = p[2];
			if (view === p[0]) b.className = 'active';
			b.appendChild(el('i', 'fa ' + p[1]));
			b.addEventListener('click', function () {
				if (view === p[0]) return;
				view = p[0]; localStorage.setItem('pnq-running-view', p[0]);
				wrap.querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
				b.classList.add('active');
				draw(lastRows);
			});
			wrap.appendChild(b);
		});
		return wrap;
	}

	/* ---- render + poll ----------------------------------------------------- */
	// A running lab reads as alive: a green pill with a pulsing status dot.
	function runBadge(running) {
		var rb = el('span', 'rl-run-badge');
		rb.appendChild(el('span', 'rl-pulse'));
		rb.appendChild(document.createTextNode(running + ' running'));
		return rb;
	}
	// Live-count chip in the view-head (updated on every draw).
	function updateChip(rows) {
		var chip = document.getElementById('rl-livecount');
		if (!chip) return;
		var live = rows.filter(function (r) { return (r.nodes_running || 0) > 0; }).length;
		chip.className = 'rl-livecount' + (live ? '' : ' is-idle');
		chip.innerHTML = '';
		chip.appendChild(el('span', 'rl-pulse'));
		var lbl = el('span');
		if (live) {
			lbl.appendChild(el('span', 'n', String(live)));
			lbl.appendChild(document.createTextNode(' running'));
		} else {
			lbl.textContent = rows.length ? 'None running' : 'No open labs';
		}
		chip.appendChild(lbl);
	}

	function render(viewEl) {
		stopPolling();
		var head = el('div', 'view-head vh-ruled');
		var left = el('div');
		left.style.cssText = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap';
		left.appendChild(viewTitle('Running Labs', 'fa-play-circle'));
		var chip = el('span', 'rl-livecount is-idle'); chip.id = 'rl-livecount';
		chip.appendChild(el('span', 'rl-pulse'));
		chip.appendChild(el('span', null, 'Loading…'));
		left.appendChild(chip);
		head.appendChild(left);
		var actions = el('div', 'rl-head-actions');
		actions.style.display = 'flex';
		actions.style.gap = '8px';
		actions.style.alignItems = 'center';
		actions.appendChild(btn('fa-refresh', 'Refresh', 'btn btn-ghost', function () { load().catch(function () {}); }));
		actions.appendChild(viewToggle());
		var dall = btn('fa-bomb', 'Destroy all', 'btn btn-danger', destroyAll);
		dall.id = 'rl-destroy-all'; dall.disabled = true;
		// The endpoint scopes the list for regular users, but this is a
		// destructive aggregate action. Keep it administrator-only in the UI as
		// well as enforcing ownership on each per-lab engine route.
		if (App.isAdmin) actions.appendChild(dall);
		head.appendChild(actions);
		viewEl.appendChild(head);

		var card = el('div', 'card'); card.id = 'rl-shell'; card.style.padding = '0';
		var body = el('div'); body.id = 'rl-body';
		var loadingP = el('p', 'muted', 'Loading…'); loadingP.style.padding = '16px';
		body.appendChild(loadingP);
		card.appendChild(body);
		viewEl.appendChild(card);

		startPolling();
	}

	function startPolling() {
		stopPolling();
		poller = App.poll(function () { return busy ? Promise.resolve() : load(); }, { interval: 5000, maxInterval: 60000 });
		poller.start(true);
	}
	function stopPolling() { if (poller) { poller.stop(); poller = null; } }

	function load() {
		if (!document.getElementById('rl-body')) { stopPolling(); return; }   // view left
		return App.api('/status/api.php?action=sessions').then(function (res) {
			if (res.status !== 200) throw new Error('running labs request failed');
			if (!document.getElementById('rl-body')) return;
			lastRows = (res.body && res.body.data) || [];
			draw(lastRows);
		});
	}
	function refresh() { load().catch(function () { /* transient; next poll retries */ }); }

	// Card view drops the surrounding card chrome (cards carry their own); list
	// view keeps the single bordered table card.
	function draw(rows) {
		var body = document.getElementById('rl-body'), shell = document.getElementById('rl-shell');
		if (!body) return;
		var dall = document.getElementById('rl-destroy-all');
		if (dall) dall.disabled = !rows.length;
		updateChip(rows);
		body.innerHTML = '';
		if (!rows.length) {
			if (shell) { shell.style.padding = '0'; shell.style.background = ''; shell.style.border = ''; shell.style.boxShadow = ''; }
			body.appendChild(emptyState());
			return;
		}
		if (view === 'grid') {
			if (shell) { shell.style.padding = '0'; shell.style.background = 'transparent'; shell.style.border = 'none'; shell.style.boxShadow = 'none'; }
			body.appendChild(buildCards(rows));
		} else {
			if (shell) { shell.style.padding = '0'; shell.style.background = ''; shell.style.border = ''; shell.style.boxShadow = ''; }
			body.appendChild(buildTable(rows));
		}
	}

	function emptyState() {
		var e = el('div', 'empty');
		e.appendChild(el('i', 'fa fa-play-circle'));
		e.appendChild(el('div', null, 'No open lab sessions.'));
		var sub = el('div', 'muted'); sub.style.marginTop = '8px';
		sub.textContent = 'A lab appears here once it is opened in the topology editor.';
		e.appendChild(sub);
		return e;
	}

	/* ---- list (table) view ------------------------------------------------- */
	function buildTable(rows) {
		var t = el('table', 'fm-table');
		var thead = el('thead'); var hr = el('tr');
		['Lab', 'Owner', 'Nodes', 'Where', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
		thead.appendChild(hr); t.appendChild(thead);
		var tb = el('tbody');
		rows.forEach(function (r) { tb.appendChild(rowFor(r)); });
		t.appendChild(tb);
		return t;
	}

	function rowFor(r) {
		var tr = el('tr');

		var tdN = el('td');
		var nm = el('span', 'fm-name');
		nm.appendChild(el('i', 'fa fa-flask'));
		nm.appendChild(document.createTextNode(' ' + r.name));
		nm.title = 'Open in topology editor';
		App.clickable(nm, function () { openLab(r); });
		tdN.appendChild(nm);
		tr.appendChild(tdN);

		tr.appendChild(el('td', null, r.owner || ('pod ' + r.pod)));

		var tdNodes = el('td');
		var running = r.nodes_running || 0, total = r.nodes_total || 0;
		tdNodes.appendChild(running > 0 ? runBadge(running) : el('span', 'badge badge-off', 'stopped'));
		if (total) {
			var subN = el('span', 'muted'); subN.style.marginLeft = '8px';
			subN.textContent = running + ' / ' + total + ' nodes';
			tdNodes.appendChild(subN);
		}
		tr.appendChild(tdNodes);

		tr.appendChild(hostCell(r.hosts));

		var tdA = el('td', 'fm-actions');
		tdA.appendChild(act('fa-external-link', 'Open', function () { openLab(r); }, 'accent'));
		if (canManage(r)) {
			tdA.appendChild(act('fa-stop', 'Stop all nodes', function () { stopLab(r); }, 'ghost'));
			tdA.appendChild(act('fa-trash-o', 'Destroy', function () { destroyLab(r); }, 'danger'));
		}
		tr.appendChild(tdA);
		return tr;
	}

	function hostCell(hosts) {
		var td = el('td');
		hosts = hosts || [];
		if (!hosts.length) td.appendChild(el('span', 'muted', '—'));
		else hosts.forEach(function (h) { var hb = el('span', 'badge'); hb.style.marginRight = '4px'; hb.textContent = hostLabel(h); td.appendChild(hb); });
		return td;
	}

	/* ---- card (grid) view -------------------------------------------------- */
	function buildCards(rows) {
		var grid = el('div', 'cards');
		rows.forEach(function (r) { grid.appendChild(cardFor(r)); });
		return grid;
	}

	function cardFor(r) {
		var running = r.nodes_running || 0, total = r.nodes_total || 0;
		var card = el('div', 'lab-card rl-card' + (running > 0 ? ' is-live' : ''));

		var body = el('div', 'rl-card-body' + (running > 0 ? ' is-running' : ''));
		body.title = 'Open in topology editor';
		body.appendChild(el('i', 'fa ' + (running > 0 ? 'fa-play-circle' : 'fa-flask')));
		body.appendChild(running > 0 ? runBadge(running) : el('span', 'badge badge-off', 'stopped'));
		body.title = 'Open in topology editor';
		App.clickable(body, function () { openLab(r); });
		card.appendChild(body);

		var meta = el('div', 'card-meta');
		var nm = el('span', 'nm', r.name); nm.title = 'Open in topology editor';
		App.clickable(nm, function () { openLab(r); });
		meta.appendChild(nm);
		card.appendChild(meta);

		var sub = el('div', 'card-sub');
		sub.appendChild(document.createTextNode((r.owner || ('pod ' + r.pod)) + (total ? (' · ' + running + ' / ' + total + ' nodes') : '') + ' '));
		(r.hosts || []).forEach(function (h) { var hb = el('span', 'badge'); hb.style.marginLeft = '4px'; hb.textContent = hostLabel(h); sub.appendChild(hb); });
		card.appendChild(sub);

		var bar = el('div', 'rl-card-actions');
		bar.appendChild(cardAct('fa-external-link', 'Open', 'rl-act-open', function () { openLab(r); }));
		if (canManage(r)) {
			bar.appendChild(cardAct('fa-stop', 'Stop all nodes', 'rl-act-stop', function () { stopLab(r); }));
			bar.appendChild(cardAct('fa-trash-o', 'Destroy', 'rl-act-destroy', function () { destroyLab(r); }));
		}
		card.appendChild(bar);
		return card;
	}

	/* ---- per-lab actions --------------------------------------------------- */
	function openLab(r) {
		App.loading(true);
		post('/api/labs/session/factory/join', { lab_session: r.session }).then(function (res) {
			App.loading(false);
			if (ok(res)) window.location.href = '/legacy/topology';
			else App.toast(actErr(res), 'error');
		}).catch(function () { App.loading(false); });
	}

	function stopLab(r) {
		App.confirm('Stop all nodes in "' + r.name + '"? The session stays open and nodes can be started again.', { okLabel: 'Stop all' })
			.then(function (yes) {
				if (!yes) return;
				busy = true; App.loading(true);
				post('/api/labs/session/factory/stopNodes', { lab_session: r.session }).then(function (res) {
					busy = false; App.loading(false);
					if (ok(res)) { App.toast('Stopped all nodes in "' + r.name + '"', 'ok'); refresh(); }
					else App.toast(actErr(res), 'error');
				}).catch(function () { busy = false; App.loading(false); });
			});
	}

	function destroyLab(r) {
		App.confirm('Destroy "' + r.name + '"? This stops & wipes every node and closes the session.', { danger: true, okLabel: 'Destroy' })
			.then(function (yes) {
				if (!yes) return;
				busy = true; App.loading(true);
				post('/api/labs/session/factory/destroy', { lab_session: r.session }).then(function (res) {
					busy = false; App.loading(false);
					if (ok(res)) { App.toast('Destroyed "' + r.name + '"', 'ok'); refresh(); }
					else App.toast(actErr(res), 'error');
				}).catch(function () { busy = false; App.loading(false); });
			});
	}

	/* ---- destroy all ------------------------------------------------------- */
	function destroyAll() {
		if (!App.isAdmin) return;
		App.api('/status/api.php?action=sessions').then(function (res) {
			var rows = (res.body && res.body.data) || [];
			if (!rows.length) { App.toast('No open lab sessions.', 'info'); return; }
			var nodes = rows.reduce(function (a, r) { return a + (r.nodes_running || 0); }, 0);
			App.confirm('This destroys ALL ' + rows.length + ' open lab session' + (rows.length > 1 ? 's' : '') +
				(nodes ? ' (' + nodes + ' running node' + (nodes > 1 ? 's' : '') + ')' : '') +
				'. Every node is stopped & wiped and all sessions are closed. This cannot be undone.',
				{ danger: true, okLabel: 'Destroy all', requireType: 'DESTROY', title: 'Destroy all running labs' })
				.then(function (yes) { if (yes) runDestroyAll(rows); });
		});
	}

	// Sequential — a destroy stops+wipes every node and runs cluster cleanup,
	// so firing them all at once could swamp the master / satellites.
	function runDestroyAll(rows) {
		busy = true;
		stopPolling();
		var panel = el('div', 'import-progress');
		var head = el('div', 'import-progress-title');
		head.appendChild(el('i', 'fa fa-bomb'));
		head.appendChild(document.createTextNode(' Destroying ' + rows.length + ' lab session' + (rows.length > 1 ? 's' : '') + '…'));
		var bar = el('div', 'progress'); var fill = el('div', 'progress-bar'); bar.appendChild(fill);
		var label = el('div', 'import-progress-label muted', 'Starting…');
		panel.appendChild(head); panel.appendChild(bar); panel.appendChild(label);
		document.body.appendChild(panel);

		var i = 0, good = 0, results = [];
		function step() {
			if (i >= rows.length) {
				busy = false; startPolling();
				var bad = results.filter(function (r) { return !r.ok; });
				if (bad.length) {
					// Failures persist: swap the progress panel for the per-item
					// report so the admin can read which sessions survived and why
					// (the old toast gave 3.6 seconds to catch it).
					panel.remove();
					App.batchReport(bad.length + ' of ' + rows.length + ' session' + (rows.length === 1 ? '' : 's') + ' could not be destroyed', results);
					return;
				}
				fill.style.width = '100%';
				fill.className = 'progress-bar done';
				label.textContent = good + ' of ' + rows.length + ' destroyed';
				App.toast(good + ' lab session' + (good === 1 ? '' : 's') + ' destroyed', 'ok');
				setTimeout(function () { panel.remove(); }, 1800);
				return;
			}
			var r = rows[i];
			label.textContent = 'Destroying "' + r.name + '" (' + (i + 1) + '/' + rows.length + ')…';
			fill.style.width = Math.round(i / rows.length * 100) + '%';
			post('/api/labs/session/factory/destroy', { lab_session: r.session }).then(function (res) {
				if (ok(res)) good++;
				results.push({ name: r.name, ok: ok(res), error: ok(res) ? null : actErr(res) });
				i++; step();
			}).catch(function () { results.push({ name: r.name, ok: false, error: 'request failed' }); i++; step(); });
		}
		step();
	}

	/* ---- register (API scopes non-admins to their own pod) ----------------- */
	App.register('running', { title: 'Running Labs', icon: 'fa-play-circle', render: render });
})();
