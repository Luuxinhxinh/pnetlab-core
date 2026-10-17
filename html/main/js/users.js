/* ============================================================================
   PNetLab dashboard — Users & Roles view (admin)
   Wraps the engine shim users/api.php (token-cookie, admin-only):
     GET  ?action=users / roles / permcatalog
     POST ?action=user_add|user_edit|user_delete
     POST ?action=role_add|role_edit|role_delete
   Two tabs: Users (CRUD local accounts) and Roles (limits + permission sets).
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var tab = 'users', roles = [], permCatalog = [];

	function viewTitle(t, i) { var d = el('div', 'view-title'); d.appendChild(el('i', 'fa ' + i)); d.appendChild(document.createTextNode(' ' + t)); return d; }
	function btn(icon, label, cls, fn) { var b = el('button', cls); b.type = 'button'; b.appendChild(el('i', 'fa ' + icon)); if (label) b.appendChild(document.createTextNode(' ' + label)); b.addEventListener('click', fn); return b; }
	function actBtn(icon, title, fn, kind) { var b = el('button', 'btn btn-sm btn-icon' + (kind ? ' btn-' + kind : ' btn-ghost')); b.type = 'button'; b.title = title; b.appendChild(el('i', 'fa ' + icon)); b.addEventListener('click', function (e) { e.stopPropagation(); fn(); }); return b; }
	function field(label, inp) { var f = el('div', 'field'); if (label) f.appendChild(el('label', null, label)); f.appendChild(inp); return f; }
	function selEl(options, value) { var s = el('select', 'input'); options.forEach(function (o) { var op = el('option', null, o.label); op.value = o.value; if (String(value) === String(o.value)) op.selected = true; s.appendChild(op); }); return s; }
	var DAYNAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
	function fmtLimits(u) {
		if (u.max_cpu == null && u.max_ram == null) return '—';
		return (u.max_cpu != null ? u.max_cpu + ' vCPU' : '∞') + ' / ' + (u.max_ram != null ? u.max_ram + ' MB' : '∞');
	}
	function fmtSchedule(u) {
		var parts = [];
		if (u.access_days) parts.push(u.access_days.split('').map(function (d) { return DAYNAMES[+d] || d; }).join(' '));
		var from = u.access_from ? u.access_from.replace('T', ' ') : '';
		var to = u.access_to ? u.access_to.replace('T', ' ') : '';
		if (from || to) parts.push((from || '…') + ' → ' + (to || '…'));
		return parts.length ? parts.join(' · ') : '—';
	}
	function pretty(p) { return p.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
	function reload() { var v = document.getElementById('view'); if (v) { v.innerHTML = ''; render(v); } }
	function ensurePerms(cb) { if (permCatalog.length) return cb(); App.api('/users/api.php?action=permcatalog').then(function (r) { permCatalog = (r.body && r.body.data) || []; cb(); }); }

	// Bounded breadth-first walk of GET /api/folders, collecting every folder
	// path under root — populates the Add/Edit User workspace field's
	// suggestions. Trimmed copy of labs.js's searchWalk() (same endpoint, same
	// caps) minus the query filter and the labs collection, since here we only
	// want a flat folder-path list, not a search result. Best-effort: on any
	// failure the datalist is just left empty, the (still free-typed) input is
	// unaffected either way.
	function walkWorkspaceFolders() {
		var MAX_VISITED = 300, MAX_DEPTH = 12, POOL = 5;
		var visited = { '/': true }, seen = {}, out = [];
		var queue = [{ path: '/', depth: 0 }];
		var visitedCount = 0, inFlight = 0;
		return new Promise(function (resolve) {
			function pump() {
				while (inFlight < POOL && queue.length && visitedCount < MAX_VISITED) visit(queue.shift());
				if (!inFlight && !queue.length) resolve(out);
			}
			function visit(cur) {
				visitedCount++; inFlight++;
				App.api('/api/folders?path=' + encodeURIComponent(cur.path)).then(function (res) {
					var okRes = res.status === 200 && res.body && res.body.status !== 'fail';
					var d = (okRes && res.body.data) || {};
					(d.folders || []).forEach(function (f) {
						if (f.name === '..' || visited[f.path]) return;
						visited[f.path] = true;
						if (!seen[f.path]) { seen[f.path] = true; out.push(f.path); }
						if (cur.depth + 1 < MAX_DEPTH) queue.push({ path: f.path, depth: cur.depth + 1 });
					});
				}).catch(function () { /* unreadable subtree — skip it */ })
					.then(function () { inFlight--; pump(); });
			}
			pump();
		});
	}

	function render(view) {
		var head = el('div', 'view-head');
		head.appendChild(viewTitle('Users & Roles', 'fa-users'));
		var tabs = el('div', 'tabs');
		[['users', 'Users'], ['roles', 'Roles'], ['extauth', 'External Auth']].forEach(function (t) {
			var b = el('button', 'tab' + (tab === t[0] ? ' active' : '')); b.type = 'button'; b.textContent = t[1];
			b.addEventListener('click', function () { if (tab !== t[0]) { tab = t[0]; reload(); } });
			tabs.appendChild(b);
		});
		head.appendChild(tabs);
		view.appendChild(head);
		var card = el('div', 'card'); card.id = 'ur-card';
		card.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(card);
		if (tab === 'users') loadUsers(card);
		else if (tab === 'roles') loadRoles(card);
		else loadExtAuth(card);
	}

	/* ---- Users tab --------------------------------------------------------- */
	function loadUsers(card) {
		App.api('/users/api.php?action=roles').then(function (r2) {
			roles = (r2.body && r2.body.data) || [];
			App.api('/users/api.php?action=users').then(function (res) {
				if (res.status !== 200) { card.innerHTML = ''; card.appendChild(el('p', 'muted', (res.body && res.body.error) || 'Failed to load users.')); return; }
				renderUsers(card, (res.body && res.body.data) || []);
			});
		});
	}

	function renderUsers(card, users) {
		card.innerHTML = '';
		var bar = el('div', 'toolbar'); bar.style.marginBottom = '12px';
		bar.appendChild(el('div', 'card-title', users.length + ' user' + (users.length === 1 ? '' : 's')));
		bar.appendChild(el('span', 'spacer'));
		bar.appendChild(btn('fa-upload', 'Import CSV', 'btn btn-ghost', function () { importCsvModal(); }));
		bar.appendChild(btn('fa-user-plus', 'Add user', 'btn btn-primary', function () { userModal(null); }));
		card.appendChild(bar);
		var t = el('table', 'fm-table'); var thead = el('thead'); var hr = el('tr');
		['Username', 'Email', 'Role', 'Auth', 'Status', 'Limits', 'Lab schedule', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
		thead.appendChild(hr); t.appendChild(thead);
		var tb = el('tbody');
		users.forEach(function (u) {
			var tr = el('tr');
			tr.appendChild(el('td', null, u.username));
			tr.appendChild(el('td', 'muted', u.email || '—'));
			var rc = el('td'); rc.appendChild(el('span', 'badge' + (u.role === '0' ? '' : ' badge-off'), u.role_name)); tr.appendChild(rc);
			tr.appendChild(el('td', (u.ext_auth ? null : 'muted'), u.ext_auth === 'radius' ? 'RADIUS' : (u.ext_auth === 'ldap' ? 'LDAP' : 'Local')));
			var sc = el('td'); sc.appendChild(el('span', 'badge ' + (u.user_status ? 'badge-ok' : 'badge-warn'), u.user_status ? 'active' : 'blocked')); tr.appendChild(sc);
			tr.appendChild(el('td', (u.role === '0' ? 'muted' : null), u.role === '0' ? '—' : fmtLimits(u)));
			tr.appendChild(el('td', (u.role === '0' ? 'muted' : null), u.role === '0' ? '—' : fmtSchedule(u)));
			var ac = el('td', 'fm-actions');
			ac.appendChild(actBtn('fa-pencil', 'Edit', function () { userModal(u); }));
			if (!u.ext_auth) ac.appendChild(actBtn('fa-key', 'Reset password', function () { resetUserPassword(u); }));
			ac.appendChild(actBtn('fa-trash-o', 'Delete', function () { delUser(u); }, 'danger'));
			tr.appendChild(ac);
			tb.appendChild(tr);
		});
		t.appendChild(tb); card.appendChild(t);
	}

	function userModal(u) {
		var roleOpts = [{ label: 'Admin', value: '0' }].concat(roles.map(function (r) { return { label: r.name, value: String(r.id) }; }));
		var form = el('div');

		var userI = null;
		if (!u) { userI = el('input', 'input'); form.appendChild(field('Username', userI)); }
		var passI = el('input', 'input'); passI.type = 'password';
		var passField = field(u ? 'New password (blank = keep)' : 'Password', passI);
		form.appendChild(passField);
		var emailI = el('input', 'input'); emailI.type = 'email'; if (u) emailI.value = u.email || '';
		form.appendChild(field('Email', emailI));

		// New LOCAL users only: generate a password server-side and email a
		// "set your password" link instead of the admin typing one in. Wired to
		// /users/api.php?action=user_add's send_welcome_email flag (Mail (SMTP)
		// page configures the server that sends it).
		var sendWelcomeCB = null;
		if (!u) {
			var welcomeRow = el('label', 'field'); welcomeRow.style.cssText = 'display:flex;flex-direction:row;align-items:center;gap:8px;cursor:pointer';
			sendWelcomeCB = el('input'); sendWelcomeCB.type = 'checkbox';
			welcomeRow.appendChild(sendWelcomeCB);
			welcomeRow.appendChild(el('span', null, 'Send a welcome email with a set-password link'));
			form.appendChild(welcomeRow);
			sendWelcomeCB.addEventListener('change', function () { passField.style.display = sendWelcomeCB.checked ? 'none' : ''; });
		}
		// When no custom role exists yet, only Admin is selectable — say so, since
		// a restricted user is meaningless without a role to scope them.
		if (!roles.length) {
			var hint = el('p', 'muted'); hint.style.margin = '0 0 8px';
			hint.textContent = 'Only Admin is available — create a role in the Roles tab to add restricted users.';
			form.appendChild(hint);
		}
		var roleS = selEl(roleOpts, u ? u.role : '0');
		var statusS = selEl([{ label: 'Active', value: '1' }, { label: 'Blocked', value: '0' }], u ? String(u.user_status) : '1');
		var grid1 = el('div', 'form-grid');
		grid1.appendChild(field('Role', roleS));
		grid1.appendChild(field('Status', statusS));
		form.appendChild(grid1);

		// Where the password is verified at login: locally (sha256 hash) or by
		// the configured RADIUS/LDAP directory (External Auth tab). The local
		// password stays stored either way — it is only used again if the admin
		// enables directory-unreachable local fallback.
		var extS = selEl([
			{ label: 'Local password', value: '' },
			{ label: 'RADIUS', value: 'radius' },
			{ label: 'LDAP / AD', value: 'ldap' }
		], (u && u.ext_auth) ? u.ext_auth : '');
		form.appendChild(field('Authentication', extS));
		// Welcome-email links are local-account only (users/api.php rejects
		// send_welcome_email for a directory-authenticated user) — keep the
		// checkbox in step so it can't be submitted in a state the server will
		// just reject.
		if (sendWelcomeCB) {
			var syncWelcomeAvailability = function () {
				var extAuthSet = extS.value !== '';
				sendWelcomeCB.disabled = extAuthSet;
				if (extAuthSet && sendWelcomeCB.checked) { sendWelcomeCB.checked = false; passField.style.display = ''; }
			};
			extS.addEventListener('change', syncWelcomeAvailability);
		}

		// Per-user workspace OVERRIDE — replaces the role's default workspace for
		// just this user (blank = use the role default). Still a free-type text
		// input (a brand-new, not-yet-created path is valid — getWorkspace()
		// auto-creates it on that user's first login), just with existing
		// folders suggested via a native <datalist> so the admin isn't guessing.
		var wsI = el('input', 'input'); wsI.type = 'text'; wsI.placeholder = '/'; if (u && u.workspace) wsI.value = u.workspace;
		var wsList = el('datalist'); wsList.id = 'pnq-workspace-folders';
		wsI.setAttribute('list', 'pnq-workspace-folders');
		form.appendChild(field('Workspace folder (blank = role default)', wsI));
		form.appendChild(wsList);
		walkWorkspaceFolders().then(function (paths) {
			paths.sort().forEach(function (p) { var o = el('option'); o.value = p; wsList.appendChild(o); });
			// The walk is async, so a click into the (still-empty-at-that-moment)
			// field before it resolves gets no suggestions — datalists don't
			// reopen on their own just because options showed up later. If the
			// user is still sitting in the empty field when data lands, nudge
			// it (blur+refocus) so the now-populated list actually opens.
			if (paths.length && document.activeElement === wsI && wsI.value === '') { wsI.blur(); wsI.focus(); }
		});

		// Per-user resource caps (enforced at node start; 0/blank = unlimited).
		var cpuI = el('input', 'input'); cpuI.type = 'number'; cpuI.min = '0'; cpuI.placeholder = 'unlimited'; if (u && u.max_cpu != null) cpuI.value = u.max_cpu;
		var ramI = el('input', 'input'); ramI.type = 'number'; ramI.min = '0'; ramI.placeholder = 'unlimited'; if (u && u.max_ram != null) ramI.value = u.max_ram;
		var grid2 = el('div', 'form-grid');
		grid2.appendChild(field('Max CPU (vCPUs)', cpuI));
		grid2.appendChild(field('Max RAM (MB)', ramI));
		form.appendChild(grid2);

		// Lab-access schedule (blank = unrestricted; admins are always exempt).
		form.appendChild(el('label', null, 'Lab-access days (none checked = any day)'));
		var dayWrap = el('div', 'perm-grid');
		var dayBoxes = {};
		var storedDays = (u && u.access_days) ? u.access_days : '';
		[['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['7', 'Sun']].forEach(function (d) {
			var lab = el('label', 'perm-item');
			var cb = el('input'); cb.type = 'checkbox'; cb.checked = storedDays.indexOf(d[0]) >= 0; dayBoxes[d[0]] = cb;
			lab.appendChild(cb); lab.appendChild(el('span', null, d[1]));
			dayWrap.appendChild(lab);
		});
		form.appendChild(dayWrap);
		var startI = el('input', 'input'); startI.type = 'datetime-local'; startI.value = (u && u.access_from) ? u.access_from : '';
		var endI = el('input', 'input'); endI.type = 'datetime-local'; endI.value = (u && u.access_to) ? u.access_to : '';
		var grid3 = el('div', 'form-grid');
		grid3.appendChild(field('Access from (date & time; blank = no start)', startI));
		grid3.appendChild(field('Access to (blank = no end)', endI));
		form.appendChild(grid3);

		var noteI = el('textarea', 'input'); noteI.rows = 2; if (u && u.note) noteI.value = u.note;
		form.appendChild(field('Note', noteI));

		var dlg = App.modal({
			title: u ? 'Edit user' : 'Add user', wide: true, body: form, dismissable: true, buttons: [
				{ label: 'Cancel', kind: 'ghost', onClick: function (c) { c(); } },
				{ label: u ? 'Save' : 'Create', kind: 'primary', onClick: function () { submit(); } }
			]
		});

		function submit() {
			var wantsWelcome = !!(sendWelcomeCB && sendWelcomeCB.checked);
			if (!u && !userI.value.trim()) { userI.classList.add('invalid'); return; }
			if (!u && !passI.value && !wantsWelcome) { passI.classList.add('invalid'); return; }
			if (wantsWelcome && !emailI.value.trim()) { emailI.classList.add('invalid'); App.toast('Email is required to send a welcome email', 'error'); return; }
			if (startI.value && endI.value && endI.value <= startI.value) { endI.classList.add('invalid'); App.toast('"Access to" must be after "Access from"', 'error'); return; }
			var days = Object.keys(dayBoxes).filter(function (d) { return dayBoxes[d].checked; }).join('');
			var payload = {
				email: emailI.value.trim(), role: roleS.value, note: noteI.value,
				ext_auth: extS.value,
				workspace: wsI.value.trim(),
				user_status: parseInt(statusS.value, 10),
				max_cpu: cpuI.value, max_ram: ramI.value, access_days: days,
				access_from: startI.value, access_to: endI.value
			};
			if (wantsWelcome) payload.send_welcome_email = true;
			else if (passI.value) payload.password = passI.value;
			var url;
			if (u) { payload.pod = u.pod; url = '/users/api.php?action=user_edit'; }
			else { payload.username = userI.value.trim(); url = '/users/api.php?action=user_add'; }
			App.loading(true);
			App.api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (res) {
				App.loading(false);
				if (res.status === 200 && res.body && res.body.ok) {
					dlg.close();
					if (!u && wantsWelcome && res.body.email_sent === false) {
						App.toast('User created, but the welcome email could not be sent (' + (res.body.email_error || 'check Mail Settings') + ')', 'error');
					} else if (!u && wantsWelcome) {
						App.toast('User created — welcome email sent', 'ok');
					} else {
						App.toast(u ? 'User updated' : 'User created', 'ok');
					}
					reload();
				}
				else App.toast((res.body && res.body.error) || 'Operation failed', 'error');
			});
		}
	}

	function importCsvModal() {
		var roleOpts = [{ label: 'Admin', value: '0' }].concat(roles.map(function (r) { return { label: r.name, value: String(r.id) }; }));
		var form = el('div');
		form.style.cssText = 'display:flex;flex-direction:column;gap:12px;';

		// Help text / Instructions
		var helpBox = el('div');
		helpBox.style.cssText = 'padding:10px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:6px;font-size:12px;line-height:1.6;';
		var helpP1 = el('p', null, 'Tải lên file CSV chứa danh sách tài khoản cần tạo. Định dạng tiêu đề cột chuẩn:');
		helpP1.style.margin = '0 0 4px';
		var codeBlock = el('code', null, 'username,password,email,role,workspace,note');
		codeBlock.style.cssText = 'display:block;padding:4px 8px;background:rgba(0,0,0,0.25);border-radius:4px;font-family:monospace;font-size:11px;color:#38bdf8;';
		helpBox.appendChild(helpP1);
		helpBox.appendChild(codeBlock);
		var helpNote = el('div', 'muted', '* Bắt buộc: username và password. Các cột email, role, workspace, note có thể để trống.');
		helpNote.style.fontSize = '11px';
		helpNote.style.marginTop = '4px';
		helpBox.appendChild(helpNote);
		form.appendChild(helpBox);

		// File selector & sample download bar
		var fileRow = el('div');
		fileRow.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;';

		var fileInp = el('input');
		fileInp.type = 'file';
		fileInp.accept = '.csv,text/csv,text/plain';
		fileInp.style.display = 'none';

		var selectFileBtn = btn('fa-folder-open-o', 'Chọn file CSV', 'btn btn-secondary', function () {
			fileInp.click();
		});

		var fileNameLabel = el('span', 'muted', 'Chưa chọn file');
		fileNameLabel.style.fontSize = '12px';

		var sampleBtn = btn('fa-download', 'Tải file CSV mẫu', 'btn btn-sm btn-ghost', function () {
			var sampleContent = 'username,password,email,role,workspace,note\nstudent01,P@ssw0rd123,student01@example.com,0,/student01,Nhom 1\nstudent02,P@ssw0rd123,student02@example.com,0,/student02,Nhom 1\nstudent03,P@ssw0rd123,student03@example.com,0,/student03,Nhom 2\n';
			var blob = new Blob([sampleContent], { type: 'text/csv;charset=utf-8;' });
			var url = URL.createObjectURL(blob);
			var a = document.createElement('a');
			a.href = url;
			a.download = 'pnetlab_users_sample.csv';
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		});

		fileRow.appendChild(selectFileBtn);
		fileRow.appendChild(sampleBtn);
		fileRow.appendChild(fileNameLabel);
		fileRow.appendChild(fileInp);
		form.appendChild(fileRow);

		// Defaults configuration
		var grid = el('div', 'form-grid');
		var defRoleS = selEl(roleOpts, roles.length ? String(roles[0].id) : '0');
		var defWsI = el('input', 'input');
		defWsI.placeholder = '/ (tùy chọn)';
		grid.appendChild(field('Role mặc định (nếu trong CSV để trống)', defRoleS));
		grid.appendChild(field('Workspace mặc định (nếu trong CSV để trống)', defWsI));
		form.appendChild(grid);

		// Status alert box (notifies about format errors or readiness)
		var statusBox = el('div');
		statusBox.style.cssText = 'display:none;padding:10px 14px;border-radius:6px;font-size:12px;line-height:1.5;';
		form.appendChild(statusBox);

		// Live preview container
		var previewCard = el('div');
		previewCard.style.cssText = 'max-height:220px;overflow-y:auto;border:1px solid rgba(255,255,255,0.08);border-radius:4px;display:none;';
		form.appendChild(previewCard);

		var parsedRows = [];
		var lastParseResult = null;
		var importBtnRef = null;

		function parseCsvText(txt) {
			if (!txt || !txt.trim()) {
				return { error: 'File CSV rỗng! Không tìm thấy dữ liệu nào trong file.', rows: [] };
			}
			var lines = txt.split(/\r\n|\r|\n/);
			var res = [];
			var headers = null;

			for (var i = 0; i < lines.length; i++) {
				var line = lines[i].trim();
				if (!line) continue;
				var cells = parseCsvLine(line);
				if (!headers) {
					var low = cells.map(function (c) { return c.trim().toLowerCase(); });
					// Header must contain username/user
					if (low.indexOf('username') !== -1 || low.indexOf('user') !== -1) {
						headers = low;
						continue;
					} else {
						return {
							error: "File CSV sai định dạng! Dòng đầu tiên (tiêu đề cột) bắt buộc phải có cột 'username' và 'password'.",
							rows: []
						};
					}
				}
				var r = {};
				for (var h = 0; h < headers.length; h++) {
					r[headers[h]] = (cells[h] !== undefined) ? cells[h].trim() : '';
				}
				res.push(r);
			}

			if (!headers) {
				return { error: "Không tìm thấy dòng tiêu đề hợp lệ trong file CSV.", rows: [] };
			}
			if (res.length === 0) {
				return { error: "File CSV có dòng tiêu đề nhưng không chứa dòng dữ liệu nào.", rows: [] };
			}

			return { error: null, rows: res, headers: headers };
		}

		function parseCsvLine(line) {
			var arr = [];
			var cur = '';
			var inQuotes = false;
			for (var i = 0; i < line.length; i++) {
				var c = line[i];
				if (c === '"') {
					if (inQuotes && line[i + 1] === '"') {
						cur += '"';
						i++;
					} else {
						inQuotes = !inQuotes;
					}
				} else if (c === ',' && !inQuotes) {
					arr.push(cur);
					cur = '';
				} else {
					cur += c;
				}
			}
			arr.push(cur);
			return arr;
		}

		function validateRow(r, seenUsernames) {
			var u = (r.username || r.user || '').trim();
			var p = (r.password || r.pass || '').trim();
			var e = (r.email || '').trim();

			if (!u) return { valid: false, error: 'Thiếu username' };
			if (!/^[a-zA-Z0-9_.-]+$/.test(u)) return { valid: false, error: 'Ký tự username không hợp lệ' };
			var lowU = u.toLowerCase();
			if (seenUsernames[lowU]) return { valid: false, error: 'Trùng username trong file' };
			seenUsernames[lowU] = true;

			if (!p) return { valid: false, error: 'Thiếu password' };
			if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
				return { valid: false, error: 'Email sai định dạng' };
			}
			return { valid: true, error: null };
		}

		function updatePreview(parseResult) {
			previewCard.innerHTML = '';
			if (!parseResult) {
				previewCard.style.display = 'none';
				statusBox.style.display = 'none';
				if (importBtnRef) importBtnRef.disabled = true;
				return;
			}

			if (parseResult.error) {
				previewCard.style.display = 'none';
				statusBox.style.display = 'block';
				statusBox.style.background = 'rgba(231,76,60,0.15)';
				statusBox.style.border = '1px solid rgba(231,76,60,0.4)';
				statusBox.style.color = '#ff6b6b';
				statusBox.innerHTML = '<i class="fa fa-times-circle"></i> <strong>Lỗi định dạng file:</strong> ' + parseResult.error;
				App.toast(parseResult.error, 'error');
				if (importBtnRef) importBtnRef.disabled = true;
				return;
			}

			var rows = parseResult.rows || [];
			var seen = {};
			var invalidCount = 0;
			var rowValidations = [];

			rows.forEach(function (r) {
				var v = validateRow(r, seen);
				rowValidations.push(v);
				if (!v.valid) invalidCount++;
			});

			previewCard.style.display = 'block';
			statusBox.style.display = 'block';

			if (invalidCount > 0) {
				statusBox.style.background = 'rgba(243,156,18,0.15)';
				statusBox.style.border = '1px solid rgba(243,156,18,0.4)';
				statusBox.style.color = '#f39c12';
				statusBox.innerHTML = '<i class="fa fa-exclamation-triangle"></i> <strong>Cảnh báo dữ liệu:</strong> Phát hiện <strong>' + invalidCount + ' / ' + rows.length + ' dòng sai định dạng</strong> (xem đánh dấu đỏ bên dưới). Các dòng lỗi sẽ không được tạo.';
				App.toast('Phát hiện ' + invalidCount + ' dòng không đúng định dạng!', 'error');
			} else {
				statusBox.style.background = 'rgba(46,204,113,0.15)';
				statusBox.style.border = '1px solid rgba(46,204,113,0.4)';
				statusBox.style.color = '#2ecc71';
				statusBox.innerHTML = '<i class="fa fa-check-circle"></i> <strong>Định dạng hoàn toàn hợp lệ:</strong> Tìm thấy ' + rows.length + ' tài khoản hợp lệ, sẵn sàng tạo.';
			}

			var pt = el('table', 'fm-table');
			pt.style.margin = '0';
			var pth = el('thead');
			var pthr = el('tr');
			['#', 'Trạng thái', 'Username', 'Password', 'Email', 'Role', 'Workspace'].forEach(function (h) {
				pthr.appendChild(el('th', null, h));
			});
			pth.appendChild(pthr);
			pt.appendChild(pth);

			var ptb = el('tbody');
			rows.forEach(function (r, idx) {
				var tr = el('tr');
				var v = rowValidations[idx];
				if (!v.valid) tr.style.backgroundColor = 'rgba(231,76,60,0.15)';

				tr.appendChild(el('td', 'muted', String(idx + 1)));

				var stTd = el('td');
				if (v.valid) {
					stTd.appendChild(el('span', 'badge badge-ok', 'Hợp lệ'));
				} else {
					var badg = el('span', 'badge badge-warn', v.error);
					badg.style.backgroundColor = '#e74c3c';
					badg.style.color = '#fff';
					stTd.appendChild(badg);
				}
				tr.appendChild(stTd);

				tr.appendChild(el('td', v.valid ? null : 'invalid', r.username || '(trống)'));
				tr.appendChild(el('td', v.valid ? 'muted' : 'invalid', r.password ? '••••••' : '(trống)'));
				tr.appendChild(el('td', 'muted', r.email || '—'));
				tr.appendChild(el('td', 'muted', r.role || defRoleS.options[defRoleS.selectedIndex].text));
				tr.appendChild(el('td', 'muted', r.workspace || (defWsI.value || '/')));
				ptb.appendChild(tr);
			});
			pt.appendChild(ptb);
			previewCard.appendChild(pt);

			if (importBtnRef) {
				importBtnRef.disabled = (rows.length === 0 || invalidCount === rows.length);
			}
		}

		fileInp.addEventListener('change', function () {
			if (!fileInp.files || !fileInp.files[0]) return;
			var f = fileInp.files[0];
			var ext = f.name.split('.').pop().toLowerCase();
			if (ext !== 'csv' && ext !== 'txt') {
				fileInp.value = '';
				fileNameLabel.textContent = 'File không hợp lệ';
				parsedRows = [];
				updatePreview({ error: 'Tập tin "' + f.name + '" không đúng định dạng! Vui lòng chọn file có đuôi .csv hoặc .txt.' });
				return;
			}

			fileNameLabel.textContent = f.name + ' (' + Math.round(f.size / 1024) + ' KB)';
			var reader = new FileReader();
			reader.onload = function (e) {
				try {
					var parseResult = parseCsvText(e.target.result || '');
					parsedRows = parseResult.rows || [];
					lastParseResult = parseResult;
					updatePreview(parseResult);
				} catch (err) {
					parsedRows = [];
					updatePreview({ error: 'Lỗi đọc file: ' + err.message });
				}
			};
			reader.readAsText(f);
		});

		defRoleS.addEventListener('change', function () {
			if (lastParseResult) updatePreview(lastParseResult);
		});
		defWsI.addEventListener('input', function () {
			if (lastParseResult) updatePreview(lastParseResult);
		});

		var dlg = App.modal({
			title: 'Import tài khoản từ file CSV', wide: true, body: form, dismissable: true, buttons: [
				{ label: 'Hủy', kind: 'ghost', onClick: function (c) { c(); } },
				{
					label: 'Tiến hành Import', kind: 'primary', onClick: function () {
						if (!parsedRows.length) {
							App.toast('Vui lòng chọn file CSV hợp lệ trước khi import', 'error');
							return;
						}
						submitImport();
					}
				}
			],
			onOpen: function (root) {
				var btns = root.querySelectorAll('.modal-foot button');
				if (btns.length >= 2) {
					importBtnRef = btns[1];
					importBtnRef.disabled = true;
				}
			}
		});

		function submitImport() {
			App.loading(true);
			var payload = {
				rows: parsedRows,
				default_role: defRoleS.value,
				default_workspace: defWsI.value.trim()
			};
			App.api('/users/api.php?action=user_import_csv', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			}).then(function (res) {
				App.loading(false);
				if (res.status === 200 && res.body && res.body.ok) {
					dlg.close();
					var b = res.body;
					if (b.imported > 0) {
						App.toast('Đã tạo thành công ' + b.imported + ' / ' + b.total + ' tài khoản.', 'ok');
					}
					if (b.failed > 0 && b.results) {
						App.batchReport('Kết quả Import CSV (' + b.imported + ' thành công, ' + b.failed + ' lỗi)', b.results);
					}
					reload();
				} else {
					var err = (res.body && res.body.error) || 'Import tài khoản thất bại';
					App.toast(err, 'error');
				}
			}).catch(function (err) {
				App.loading(false);
				App.toast('Lỗi kết nối: ' + (err.message || err), 'error');
			});
		}
	}

	// Issues a fresh reset token and emails it to the user's existing address
	// (POST /api/admin/users/:pod/password-reset — see html/api.php). Doesn't
	// touch the user's current password; it stays valid until the emailed
	// link is used. Directory-authenticated (RADIUS/LDAP) users are excluded
	// from the action-button row itself (see renderUsers above) since the
	// server rejects them with 409 anyway.
	function resetUserPassword(u) {
		if (!u.email) { App.toast('This user has no email address on file', 'error'); return; }
		App.confirm('Send a password-reset email to ' + u.username + ' <' + u.email + '>?', { okLabel: 'Send' }).then(function (yes) {
			if (!yes) return;
			App.loading(true);
			App.api('/api/admin/users/' + encodeURIComponent(u.pod) + '/password-reset', { method: 'POST' }).then(function (res) {
				App.loading(false);
				if (res.status === 200) App.toast('Password-reset email sent to ' + u.email, 'ok');
				else App.toast((res.body && res.body.message) || 'Could not send reset email', 'error');
			}).catch(function () { App.loading(false); App.toast('Could not send reset email', 'error'); });
		});
	}

	function delUser(u) {
		// State the blast radius we can actually know before asking: whether
		// this user has open lab sessions right now (same endpoint the Running
		// Labs view polls — this view is admin-only, so it's readable). Match
		// sessions by pod (the engine's user key) with owner-name as belt and
		// braces. On any failure fall back to concrete-but-uncounted copy —
		// never block the delete on the safety lookup.
		App.loading(true);
		App.api('/status/api.php?action=sessions').then(function (res) {
			App.loading(false);
			if (res.status !== 200) throw new Error('sessions');
			var mine = ((res.body && res.body.data) || []).filter(function (r) {
				return String(r.pod) === String(u.pod) || (u.username && r.owner === u.username);
			});
			var running = mine.reduce(function (a, r) { return a + (r.nodes_running || 0); }, 0);
			var body = el('div');
			body.appendChild(el('p', null, 'Delete user "' + u.username + '"? The account and its sign-in are removed permanently.')).style.margin = '0 0 8px';
			if (mine.length) {
				var warn = el('p'); warn.style.cssText = 'margin:0;color:var(--pnq-danger);font-weight:600;';
				warn.textContent = 'This user has ' + mine.length + ' open lab session' + (mine.length === 1 ? '' : 's') +
					(running ? ' with ' + running + ' node' + (running === 1 ? '' : 's') + ' running' : '') + '.';
				body.appendChild(warn);
			} else {
				body.appendChild(el('p', 'muted', 'No open lab sessions for this user right now.')).style.margin = '0';
			}
			// Live nodes = the genuinely dangerous case; gate it behind the
			// typed confirmation like the other high-blast-radius deletes.
			var opts = { danger: true, okLabel: 'Delete', title: 'Delete user' };
			if (running) opts.requireType = 'DELETE';
			return App.confirm(body, opts);
		}).catch(function () {
			App.loading(false);
			return App.confirm('Delete user "' + u.username + '"? The account and its sign-in are removed permanently.', { danger: true, okLabel: 'Delete' });
		}).then(function (yes) {
			if (!yes) return;
			App.loading(true);
			App.api('/users/api.php?action=user_delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pod: u.pod }) }).then(function (res) {
				App.loading(false);
				if (res.status === 200 && res.body && res.body.ok) { App.toast('User deleted', 'ok'); reload(); }
				else App.toast((res.body && res.body.error) || 'Could not delete', 'error');
			});
		});
	}

	/* ---- Roles tab --------------------------------------------------------- */
	function loadRoles(card) {
		ensurePerms(function () {
			App.api('/users/api.php?action=roles').then(function (res) {
				if (res.status !== 200) { card.innerHTML = ''; card.appendChild(el('p', 'muted', (res.body && res.body.error) || 'Failed to load roles.')); return; }
				renderRoles(card, (res.body && res.body.data) || [], (res.body && res.body.admin_users) || 0);
			});
		});
	}

	function renderRoles(card, list, adminUsers) {
		card.innerHTML = '';
		var bar = el('div', 'toolbar'); bar.style.marginBottom = '12px';
		bar.appendChild(el('div', 'card-title', 'Roles'));
		bar.appendChild(el('span', 'spacer'));
		bar.appendChild(btn('fa-plus', 'Add role', 'btn btn-primary', function () { roleModal(null); }));
		card.appendChild(bar);
		var t = el('table', 'fm-table'); var thead = el('thead'); var hr = el('tr');
		['Role', 'Workspace', 'CPU', 'RAM', 'Disk', 'Permissions', 'Users', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
		thead.appendChild(hr); t.appendChild(thead);
		var tb = el('tbody');
		// built-in Admin row (read-only)
		var ar = el('tr');
		var an = el('td'); an.appendChild(el('span', 'badge', 'Admin')); tb.appendChild(ar);
		ar.appendChild(an);
		ar.appendChild(el('td', 'muted', '/'));
		ar.appendChild(el('td', 'muted', '—')); ar.appendChild(el('td', 'muted', '—')); ar.appendChild(el('td', 'muted', '—'));
		ar.appendChild(el('td', 'muted', 'Full access'));
		ar.appendChild(el('td', null, String(adminUsers)));
		ar.appendChild(el('td', 'muted', 'built-in'));
		// custom roles
		list.forEach(function (r) {
			var tr = el('tr');
			tr.appendChild(el('td', null, r.name));
			tr.appendChild(el('td', 'muted', r.workspace || '/'));
			tr.appendChild(el('td', null, r.cpu != null ? r.cpu + '%' : '—'));
			tr.appendChild(el('td', null, r.ram != null ? r.ram + '%' : '—'));
			tr.appendChild(el('td', null, r.hdd != null ? r.hdd + ' GB' : '—'));
			tr.appendChild(el('td', null, (r.perms ? r.perms.length : 0) + ' / ' + permCatalog.length));
			tr.appendChild(el('td', null, String(r.users || 0)));
			var ac = el('td', 'fm-actions');
			ac.appendChild(actBtn('fa-pencil', 'Edit', function () { roleModal(r); }));
			ac.appendChild(actBtn('fa-trash-o', 'Delete', function () { delRole(r); }, 'danger'));
			tr.appendChild(ac);
			tb.appendChild(tr);
		});
		t.appendChild(tb); card.appendChild(t);
	}

	function roleModal(r) {
		ensurePerms(function () {
			var form = el('div');
			var nameI = el('input', 'input'); nameI.value = r ? r.name : '';
			var wsI = el('input', 'input'); wsI.value = r ? (r.workspace || '/') : '/';
			var cpuI = el('input', 'input'); cpuI.type = 'number'; cpuI.placeholder = 'e.g. 80'; if (r && r.cpu != null) cpuI.value = r.cpu;
			var ramI = el('input', 'input'); ramI.type = 'number'; ramI.placeholder = 'e.g. 80'; if (r && r.ram != null) ramI.value = r.ram;
			var hddI = el('input', 'input'); hddI.type = 'number'; hddI.placeholder = 'GB'; if (r && r.hdd != null) hddI.value = r.hdd;
			form.appendChild(field('Role name', nameI));
			form.appendChild(field('Default workspace', wsI));
			var grid = el('div', 'form-grid');
			grid.appendChild(field('CPU limit %', cpuI));
			grid.appendChild(field('RAM limit %', ramI));
			grid.appendChild(field('Disk limit (GB)', hddI));
			form.appendChild(grid);
			form.appendChild(el('label', null, 'Permissions'));
			var have = (r && r.perms) ? r.perms : [];
			var permWrap = el('div', 'perm-grid');
			var boxes = {};
			permCatalog.forEach(function (p) {
				var lab = el('label', 'perm-item');
				var cb = el('input'); cb.type = 'checkbox'; cb.checked = have.indexOf(p) >= 0; boxes[p] = cb;
				lab.appendChild(cb); lab.appendChild(el('span', null, pretty(p)));
				permWrap.appendChild(lab);
			});
			form.appendChild(permWrap);
			var dlg = App.modal({
				title: r ? 'Edit role' : 'Add role', wide: true, body: form, dismissable: true, buttons: [
					{ label: 'Cancel', kind: 'ghost', onClick: function (c) { c(); } },
					{ label: r ? 'Save' : 'Create', kind: 'primary', onClick: function () { submit(); } }
				]
			});
			function submit() {
				var name = nameI.value.trim();
				if (!name) { nameI.classList.add('invalid'); return; }
				var perms = Object.keys(boxes).filter(function (p) { return boxes[p].checked; });
				var payload = { name: name, workspace: wsI.value.trim() || '/', cpu: cpuI.value, ram: ramI.value, hdd: hddI.value, permissions: perms };
				var url = '/users/api.php?action=role_add';
				if (r) { payload.id = r.id; url = '/users/api.php?action=role_edit'; }
				App.loading(true);
				App.api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (res) {
					App.loading(false);
					if (res.status === 200 && res.body && res.body.ok) { dlg.close(); App.toast(r ? 'Role updated' : 'Role created', 'ok'); reload(); }
					else App.toast((res.body && res.body.error) || 'Operation failed', 'error');
				});
			}
		});
	}

	function delRole(r) {
		App.confirm('Delete role "' + r.name + '"?', { danger: true, okLabel: 'Delete' }).then(function (yes) {
			if (!yes) return;
			App.loading(true);
			App.api('/users/api.php?action=role_delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: r.id }) }).then(function (res) {
				App.loading(false);
				if (res.status === 200 && res.body && res.body.ok) { App.toast('Role deleted', 'ok'); reload(); }
				else App.toast((res.body && res.body.error) || 'Could not delete', 'error');
			});
		});
	}

	/* ---- External Auth tab --------------------------------------------------
	   Admin settings card for directory-backed logins (users flagged RADIUS/
	   LDAP in the Users tab). Wraps users/api.php?action=extauth_get|set|test,
	   which proxy the root broker; secrets are write-only (never echoed back —
	   the GET view only says whether one is stored). */
	function loadExtAuth(card) {
		App.api('/users/api.php?action=roles').then(function (r2) {
			roles = (r2.body && r2.body.data) || [];
			App.api('/users/api.php?action=extauth_get').then(function (res) {
				if (res.status !== 200 || !res.body || !res.body.data) {
					card.innerHTML = '';
					card.appendChild(el('p', 'muted', (res.body && res.body.error) || 'Failed to load external-auth settings.'));
					return;
				}
				renderExtAuth(card, res.body.data);
			});
		});
	}

	function renderExtAuth(card, cfg) {
		card.innerHTML = '';
		var form = el('div');
		var rcfg = cfg.radius || {}, lcfg = cfg.ldap || {};

		var intro = el('p', 'muted');
		intro.style.margin = '0 0 10px';
		intro.textContent = 'Users flagged RADIUS/LDAP (Users tab) are verified against the directory below at login. ' +
			'Group membership is re-evaluated at login only: removing a user from a directory group takes effect on their ' +
			'next login, not on open sessions — block the account here for immediate revocation. ' +
			'A directory group can never map to the built-in Admin role.';
		form.appendChild(intro);

		var enabledB = el('input'); enabledB.type = 'checkbox'; enabledB.checked = !!cfg.enabled;
		var enLab = el('label', 'perm-item'); enLab.appendChild(enabledB); enLab.appendChild(el('span', null, 'Enable external authentication'));
		var fallbackB = el('input'); fallbackB.type = 'checkbox'; fallbackB.checked = !!cfg.fallback_local;
		var fbLab = el('label', 'perm-item'); fbLab.appendChild(fallbackB);
		fbLab.appendChild(el('span', null, 'Fall back to the stored local password when the directory is unreachable (weakens external auth to the local hash while the directory is down; every use is logged)'));
		var topGrid = el('div', 'form-grid');
		var modeS = selEl([
			{ label: 'RADIUS only', value: 'radius' },
			{ label: 'LDAP only', value: 'ldap' },
			{ label: 'Both — RADIUS first, LDAP only if RADIUS is unreachable', value: 'both' }
		], cfg.mode || 'ldap');
		topGrid.appendChild(field('Mode', modeS));
		var defRoleS = selEl([{ label: '(keep current role)', value: '' }].concat(
			roles.map(function (r) { return { label: r.name, value: r.name }; })
		), cfg.default_role || '');
		topGrid.appendChild(field('Default role when no group matches', defRoleS));
		form.appendChild(enLab);
		form.appendChild(fbLab);
		form.appendChild(topGrid);

		// --- RADIUS ---------------------------------------------------------
		form.appendChild(el('div', 'card-title', 'RADIUS'));
		var rg1 = el('div', 'form-grid');
		var rPriH = el('input', 'input'); rPriH.value = rcfg.primary_host || ''; rPriH.placeholder = 'radius1.example.net';
		var rPriP = el('input', 'input'); rPriP.type = 'number'; rPriP.value = rcfg.primary_port || 1812;
		var rSecH = el('input', 'input'); rSecH.value = rcfg.secondary_host || ''; rSecH.placeholder = 'optional failover';
		var rSecP = el('input', 'input'); rSecP.type = 'number'; rSecP.value = rcfg.secondary_port || 1812;
		rg1.appendChild(field('Primary server', rPriH)); rg1.appendChild(field('Port', rPriP));
		rg1.appendChild(field('Secondary server', rSecH)); rg1.appendChild(field('Port', rSecP));
		form.appendChild(rg1);
		var rg2 = el('div', 'form-grid');
		var rSecret = el('input', 'input'); rSecret.type = 'password';
		rSecret.placeholder = rcfg.secret_set ? '(stored — leave blank to keep)' : 'shared secret';
		var rTimeout = el('input', 'input'); rTimeout.type = 'number'; rTimeout.min = '1'; rTimeout.max = '10'; rTimeout.value = rcfg.timeout || 3;
		var rNas = el('input', 'input'); rNas.value = rcfg.nas_identifier || 'pnetlab';
		rg2.appendChild(field('Shared secret', rSecret));
		rg2.appendChild(field('Timeout (s)', rTimeout));
		rg2.appendChild(field('NAS-Identifier', rNas));
		form.appendChild(rg2);
		form.appendChild(el('p', 'muted', 'Group values are read from Filter-Id and Class attributes of the Access-Accept. ' +
			'Requests always carry a Message-Authenticator and replies must return a valid one (spoofed replies are dropped).'));

		// --- LDAP -----------------------------------------------------------
		form.appendChild(el('div', 'card-title', 'LDAP / Active Directory'));
		var lg1 = el('div', 'form-grid');
		var lUri = el('input', 'input'); lUri.value = lcfg.uri || ''; lUri.placeholder = 'ldaps://dc1.example.net:636';
		var lTimeout = el('input', 'input'); lTimeout.type = 'number'; lTimeout.min = '1'; lTimeout.max = '30'; lTimeout.value = lcfg.timeout || 5;
		lg1.appendChild(field('Server URI (ldap:// or ldaps://)', lUri));
		lg1.appendChild(field('Timeout (s)', lTimeout));
		form.appendChild(lg1);
		var lStart = el('input'); lStart.type = 'checkbox'; lStart.checked = !!lcfg.starttls;
		var lStartLab = el('label', 'perm-item'); lStartLab.appendChild(lStart); lStartLab.appendChild(el('span', null, 'StartTLS (upgrade ldap:// to TLS)'));
		var lVerify = el('input'); lVerify.type = 'checkbox'; lVerify.checked = (lcfg.verify !== false);
		var lVerifyLab = el('label', 'perm-item'); lVerifyLab.appendChild(lVerify); lVerifyLab.appendChild(el('span', null, 'Verify the server TLS certificate (recommended)'));
		form.appendChild(lStartLab); form.appendChild(lVerifyLab);
		// persistent security-posture warning — shown whenever the saved/current
		// selection is insecure (verify off, or plaintext ldap:// without StartTLS)
		var tlsWarn = el('p');
		tlsWarn.style.cssText = 'margin:6px 0;color:var(--pnq-danger);font-weight:600;';
		function refreshTlsWarn() {
			var plain = lUri.value.indexOf('ldap://') === 0 && !lStart.checked;
			var noverify = !lVerify.checked && (lUri.value.indexOf('ldaps://') === 0 || lStart.checked);
			var msgs = [];
			if (plain && lUri.value) msgs.push('Plaintext ldap:// without StartTLS: passwords cross the network unencrypted.');
			if (noverify) msgs.push('TLS certificate verification is OFF: connections can be intercepted (man-in-the-middle).');
			tlsWarn.textContent = msgs.join(' ');
			tlsWarn.style.display = msgs.length ? '' : 'none';
		}
		['change', 'input'].forEach(function (ev) { lUri.addEventListener(ev, refreshTlsWarn); });
		lStart.addEventListener('change', refreshTlsWarn);
		lVerify.addEventListener('change', refreshTlsWarn);
		form.appendChild(tlsWarn);
		var lg2 = el('div', 'form-grid');
		var lBindDn = el('input', 'input'); lBindDn.value = lcfg.bind_dn || ''; lBindDn.placeholder = 'CN=svc-pnet,OU=Service,DC=example,DC=net';
		var lBindPw = el('input', 'input'); lBindPw.type = 'password';
		lBindPw.placeholder = lcfg.bind_pw_set ? '(stored — leave blank to keep)' : 'service bind password';
		lg2.appendChild(field('Service bind DN', lBindDn));
		lg2.appendChild(field('Service bind password', lBindPw));
		form.appendChild(lg2);
		var lg3 = el('div', 'form-grid');
		var lBaseDn = el('input', 'input'); lBaseDn.value = lcfg.base_dn || ''; lBaseDn.placeholder = 'DC=example,DC=net';
		var lUserAttr = selEl([
			{ label: 'sAMAccountName (AD)', value: 'sAMAccountName' },
			{ label: 'userPrincipalName (AD UPN)', value: 'userPrincipalName' },
			{ label: 'uid (OpenLDAP)', value: 'uid' },
			{ label: 'cn', value: 'cn' },
			{ label: 'mail', value: 'mail' }
		], lcfg.user_attr || 'sAMAccountName');
		var lGroupAttr = selEl([
			{ label: 'memberOf (on the user, AD-style)', value: 'memberOf' },
			{ label: 'member (on the group, OpenLDAP-style)', value: 'member' }
		], lcfg.group_attr || 'memberOf');
		lg3.appendChild(field('Search base DN', lBaseDn));
		lg3.appendChild(field('Username attribute', lUserAttr));
		lg3.appendChild(field('Group lookup', lGroupAttr));
		form.appendChild(lg3);

		// --- group -> role map ------------------------------------------------
		form.appendChild(el('div', 'card-title', 'Group → role mapping'));
		form.appendChild(el('p', 'muted', 'First match (lowest priority number wins) sets the user\'s role at login. ' +
			'Matching is case-insensitive against the full returned value (group DN, Filter-Id, Class) or the CN of a DN. ' +
			'The built-in Admin role is not a permitted target.'));
		var mapWrap = el('div');
		var mapRows = [];
		var roleOpts = roles.map(function (r) { return { label: r.name, value: r.name }; });
		function addMapRow(entry) {
			var row = el('div', 'form-grid'); row.style.alignItems = 'end';
			var gI = el('input', 'input'); gI.value = (entry && entry.group) || ''; gI.placeholder = 'CN=neteng,OU=Groups,DC=example,DC=net  or  neteng';
			var rS = selEl(roleOpts, (entry && entry.role) || (roleOpts.length ? roleOpts[0].value : ''));
			var pI = el('input', 'input'); pI.type = 'number'; pI.min = '0'; pI.value = (entry && entry.prio != null) ? entry.prio : 100;
			var rm = btn('fa-trash-o', '', 'btn btn-sm btn-ghost', function () {
				mapWrap.removeChild(row);
				mapRows = mapRows.filter(function (mr) { return mr.row !== row; });
			});
			row.appendChild(field('Directory group', gI));
			row.appendChild(field('Role', rS));
			row.appendChild(field('Priority', pI));
			row.appendChild(field('', rm));
			mapWrap.appendChild(row);
			mapRows.push({ row: row, g: gI, r: rS, p: pI });
		}
		(cfg.group_map || []).forEach(addMapRow);
		form.appendChild(mapWrap);
		if (!roleOpts.length) {
			form.appendChild(el('p', 'muted', 'No custom roles exist yet — create one in the Roles tab first (mappings cannot target Admin).'));
		}
		form.appendChild(btn('fa-plus', 'Add mapping', 'btn btn-ghost', function () { addMapRow(null); }));

		// --- test + save ------------------------------------------------------
		form.appendChild(el('div', 'card-title', 'Test'));
		form.appendChild(el('p', 'muted', 'Save first, then test with a real directory account (the test uses the STORED settings).'));
		var tg = el('div', 'form-grid');
		var tProto = selEl([{ label: 'RADIUS', value: 'radius' }, { label: 'LDAP', value: 'ldap' }], 'ldap');
		var tUser = el('input', 'input'); tUser.placeholder = 'directory username';
		var tPass = el('input', 'input'); tPass.type = 'password'; tPass.placeholder = 'password';
		tg.appendChild(field('Protocol', tProto));
		tg.appendChild(field('Username', tUser));
		tg.appendChild(field('Password', tPass));
		form.appendChild(tg);
		var testOut = el('p', 'muted'); testOut.style.margin = '4px 0 10px';
		form.appendChild(testOut);
		var barBtns = el('div', 'toolbar');
		barBtns.appendChild(btn('fa-flask', 'Test connection', 'btn btn-ghost', function () {
			if (!tUser.value.trim() || !tPass.value) { testOut.textContent = 'Enter a directory username and password to test.'; return; }
			App.loading(true);
			App.api('/users/api.php?action=extauth_test', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ proto: tProto.value, username: tUser.value.trim(), password: tPass.value })
			}).then(function (res) {
				App.loading(false);
				tPass.value = '';
				var d = (res.body && res.body.data) || null;
				if (res.status !== 200 || !d) { testOut.textContent = 'Test failed: ' + ((res.body && res.body.error) || 'no response'); return; }
				if (d.ok) {
					testOut.textContent = 'OK — authenticated. Groups: ' + ((d.groups && d.groups.length) ? d.groups.join(' | ') : '(none returned)');
					App.toast('Directory test OK', 'ok');
				} else {
					testOut.textContent = 'FAILED (' + (d.reason || '?') + '): ' + (d.detail || '');
					App.toast('Directory test failed', 'error');
				}
			});
		}));
		barBtns.appendChild(el('span', 'spacer'));
		barBtns.appendChild(btn('fa-check', 'Save settings', 'btn btn-primary', function () {
			var gmap = [];
			for (var i = 0; i < mapRows.length; i++) {
				var mr = mapRows[i];
				if (!mr.g.value.trim()) continue;
				if (!mr.r.value) { App.toast('Every mapping needs a role', 'error'); return; }
				gmap.push({ group: mr.g.value.trim(), role: mr.r.value, prio: parseInt(mr.p.value, 10) || 0 });
			}
			var payload = {
				enabled: enabledB.checked ? 1 : 0,
				fallback_local: fallbackB.checked ? 1 : 0,
				mode: modeS.value,
				default_role: defRoleS.value || '',
				radius: {
					primary_host: rPriH.value.trim(), primary_port: parseInt(rPriP.value, 10) || 1812,
					secondary_host: rSecH.value.trim(), secondary_port: parseInt(rSecP.value, 10) || 1812,
					timeout: parseInt(rTimeout.value, 10) || 3, nas_identifier: rNas.value.trim() || 'pnetlab'
				},
				ldap: {
					uri: lUri.value.trim(), starttls: lStart.checked ? 1 : 0, verify: lVerify.checked ? 1 : 0,
					bind_dn: lBindDn.value, base_dn: lBaseDn.value,
					user_attr: lUserAttr.value, group_attr: lGroupAttr.value,
					timeout: parseInt(lTimeout.value, 10) || 5
				},
				group_map: gmap
			};
			if (rSecret.value) payload.radius.secret = rSecret.value;
			if (lBindPw.value) payload.ldap.bind_pw = lBindPw.value;
			App.loading(true);
			App.api('/users/api.php?action=extauth_set', {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
			}).then(function (res) {
				App.loading(false);
				rSecret.value = ''; lBindPw.value = '';
				if (res.status === 200 && res.body && res.body.ok) { App.toast('External-auth settings saved', 'ok'); reload(); }
				else App.toast((res.body && res.body.error) || 'Save rejected', 'error');
			});
		}));
		form.appendChild(barBtns);

		refreshTlsWarn();
		card.appendChild(form);
	}

	App.register('users', { title: 'Users & Roles', icon: 'fa-users', admin: true, render: render });
})();
