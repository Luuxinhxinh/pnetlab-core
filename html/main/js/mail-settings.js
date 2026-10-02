/* ============================================================================
   PNetLab dashboard — Mail (SMTP) settings view (admin-only)
   Talks to the router endpoints added in html/api.php:
     GET  /api/admin/mail                    -> {data:{enabled,host,port,encryption,auth,
                                                 username,password_set,from_email,from_name,
                                                 public_url,templates:{welcome,request,test}}}
     PUT  /api/admin/mail                    body {enabled,auth,host,port,encryption,username,
                                                 from_email,from_name,public_url,password?}
     PUT  /api/admin/mail/template/(:kind)   kind = welcome|request|test, body {subject,body}
     POST /api/admin/mail/test               body {to,subject?,body?}
   "welcome" = the "set your password" link sent when a new user is created
   with "send a welcome email" checked (users.js). "request" = the default
   subject/body used by the Reset password button for an EXISTING user.
   "test" =
   the "Send a test email" fields below, saved on demand.
   Every response is wrapped {code,status,data,message} — read res.body.data
   / res.body.message via App.api()'s {status, body} shape.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var fieldId = 0;

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
	function field(label, inp) {
		var f = el('div', 'field');
		if (label) {
			if (!inp.id) inp.id = 'mail-field-' + (++fieldId);
			var lab = el('label', null, label); lab.htmlFor = inp.id; f.appendChild(lab);
		}
		f.appendChild(inp);
		return f;
	}
	var ENCRYPTION_LABELS = { none: 'None', ssl: 'SSL/TLS (implicit)', tls: 'STARTTLS' };

	function render(view) {
		var head = el('div', 'view-head');
		head.appendChild(viewTitle('Mail (SMTP)', 'fa-envelope'));
		view.appendChild(head);

		var card = el('div', 'card'); card.id = 'mail-settings-card';
		card.appendChild(el('div', 'card-title', 'SMTP settings'));
		card.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(card);

		var welcomeCard = el('div', 'card'); welcomeCard.id = 'mail-welcome-card';
		welcomeCard.appendChild(el('div', 'card-title', 'Account creation email'));
		welcomeCard.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(welcomeCard);

		var requestCard = el('div', 'card'); requestCard.id = 'mail-request-card';
		requestCard.appendChild(el('div', 'card-title', 'Request password reset email'));
		requestCard.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(requestCard);

		var testCard = el('div', 'card'); testCard.id = 'mail-test-card';
		testCard.appendChild(el('div', 'card-title', 'Send a test email'));
		testCard.appendChild(el('p', 'muted', 'Save settings first.'));
		view.appendChild(testCard);

		load();
	}

	function load() {
		App.api('/api/admin/mail').then(function (res) {
			if (res.status !== 200 || !res.body || !res.body.data) {
				showLoadError((res.body && res.body.message) || 'Could not load mail settings.');
				return;
			}
			var cfg = res.body.data;
			renderSettings(cfg);
			renderTemplate(cfg, 'welcome', 'mail-welcome-card', 'Account creation email',
				'Subject and body of the "set your password" email sent when a new user is created with "send a welcome email" checked.');
			renderTemplate(cfg, 'request', 'mail-request-card', 'Request password reset email',
				'Subject and body sent by the Reset password button for an existing user.');
			renderTest(cfg);
		}).catch(function () {
			showLoadError('Could not load mail settings. Check the appliance connection and try again.');
			App.toast('Could not load mail settings', 'error');
		});
	}

	function showLoadError(message) {
		[
			['mail-settings-card', 'SMTP settings'],
			['mail-welcome-card', 'Account creation email'],
			['mail-request-card', 'Request password reset email'],
			['mail-test-card', 'Send a test email']
		].forEach(function (item) {
			var c = document.getElementById(item[0]); if (!c) return;
			c.innerHTML = '';
			c.appendChild(el('div', 'card-title', item[1]));
			c.appendChild(el('p', 'muted', message));
		});
	}

	function renderSettings(cfg) {
		var c = document.getElementById('mail-settings-card'); if (!c) return;
		c.innerHTML = '';
		c.appendChild(el('div', 'card-title', 'SMTP settings'));

		var statusRow = el('div', 'kv'); statusRow.appendChild(el('span', 'k', 'Status'));
		var v0 = el('span', 'v');
		var sw = el('label', 'switch');
		var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!cfg.enabled;
		cb.setAttribute('aria-label', 'Enable SMTP delivery');
		sw.appendChild(cb); sw.appendChild(el('span', 'slider'));
		cb.addEventListener('change', function () { toggleEnabled(cfg, cb); });
		v0.appendChild(sw);
		statusRow.appendChild(v0);
		c.appendChild(statusRow);

		c.appendChild(kv('Host', cfg.host || '—'));
		c.appendChild(kv('Port', cfg.port || '—'));
		c.appendChild(kv('Encryption', ENCRYPTION_LABELS[cfg.encryption] || cfg.encryption || '—'));
		c.appendChild(kv('Authentication', cfg.auth ? (cfg.username || '(username not set)') : 'None'));
		if (cfg.auth) c.appendChild(kv('Password', cfg.password_set ? 'set' : 'not set'));
		c.appendChild(kv('From', (cfg.from_name ? cfg.from_name + ' ' : '') + (cfg.from_email ? '<' + cfg.from_email + '>' : '—')));
		c.appendChild(kv('Public URL', cfg.public_url || '(not set — password-reset email delivery is unavailable)'));

		var cfgBtn = el('button', 'btn btn-primary'); cfgBtn.type = 'button'; cfgBtn.style.marginTop = '10px';
		cfgBtn.appendChild(el('i', 'fa fa-sliders'));
		cfgBtn.appendChild(document.createTextNode(' Configure'));
		cfgBtn.addEventListener('click', function () { configure(cfg); });
		c.appendChild(cfgBtn);

		if (!cfg.enabled) {
			var note = el('p', 'muted'); note.style.marginTop = '8px';
			note.textContent = 'Disabled — SMTP must be enabled and configured before an account can be created with "send a welcome email" checked.';
			c.appendChild(note);
		}
	}

	// Live toggle, matches system.js's own sliders. Sends the FULL current
	// settings, not just {enabled} — PUT /api/admin/mail requires host/from_email
	// when enabled=true and would otherwise reject a bare {enabled:true} flip.
	function toggleEnabled(cfg, cb) {
		cb.disabled = true;
		App.loading(true);
		App.api('/api/admin/mail', {
			method: 'PUT', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				enabled: cb.checked, auth: !!cfg.auth, host: cfg.host || '', port: cfg.port || 587,
				encryption: cfg.encryption || 'tls', username: cfg.username || '',
				from_email: cfg.from_email || '', from_name: cfg.from_name || '', public_url: cfg.public_url || ''
			})
		}).then(function (res) {
			App.loading(false); cb.disabled = false;
			if (res.status === 200) App.toast('SMTP ' + (cb.checked ? 'enabled' : 'disabled'), 'ok');
			else { App.toast((res.body && res.body.message) || 'Could not update status', 'error'); cb.checked = !cb.checked; }
			load();
		}).catch(function () { App.loading(false); cb.disabled = false; cb.checked = !cb.checked; });
	}

	function configure(cfg) {
		App.prompt({
			title: 'SMTP settings',
			okLabel: 'Save',
			fields: [
				{ name: 'host', label: 'SMTP host', type: 'text', value: cfg.host || '', placeholder: 'smtp.example.com' },
				{ name: 'port', label: 'Port', type: 'number', value: cfg.port || 587 },
				{ name: 'encryption', label: 'Encryption', type: 'select', value: cfg.encryption || 'tls',
					options: [{ label: 'STARTTLS', value: 'tls' }, { label: 'SSL/TLS (implicit)', value: 'ssl' }, { label: 'None', value: 'none' }] },
				{ name: 'auth', label: 'Authentication', type: 'select', value: cfg.auth ? '1' : '0',
					options: [{ label: 'Username and password', value: '1' }, { label: 'None', value: '0' }] },
				{ name: 'username', label: 'Username (used only if authentication is checked)', type: 'text', value: cfg.username || '' },
				{ name: 'password', label: 'Password (blank = keep current)', type: 'password', value: '',
					placeholder: cfg.password_set ? '•••••• stored' : '' },
				{ name: 'from_email', label: 'From address', type: 'text', value: cfg.from_email || '', placeholder: 'noreply@example.com' },
				{ name: 'from_name', label: 'From name', type: 'text', value: cfg.from_name || '' },
				{ name: 'public_url', label: 'Public appliance URL (HTTPS, no path — used to build reset links)', type: 'text',
					value: cfg.public_url || '', placeholder: 'https://pnetlab.example.com' }
			]
		}).then(function (vals) {
			if (!vals) return;
			var port = parseInt(vals.port, 10);
			if (isNaN(port)) port = 587;
			var payload = {
				// Status stays whatever the card's own slider last set — never
				// part of this form, so Save here can't silently flip it.
				enabled: !!cfg.enabled, auth: vals.auth === '1', host: (vals.host || '').trim(),
				port: port, encryption: vals.encryption,
				username: (vals.username || '').trim(), from_email: (vals.from_email || '').trim(),
				from_name: (vals.from_name || '').trim(), public_url: (vals.public_url || '').trim()
			};
			if (vals.password) payload.password = vals.password;
			App.loading(true);
			App.api('/api/admin/mail', {
				method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
			}).then(function (res) {
				App.loading(false);
				if (res.status === 200) App.toast('SMTP settings saved', 'ok');
				else App.toast((res.body && res.body.message) || 'Could not save settings', 'error');
				load();
			}).catch(function () { App.loading(false); load(); });
		});
	}

	function textPreview(html, max) {
		var text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		return text.length > max ? text.slice(0, max) + '…' : text;
	}

	function previewVars() {
		return {
			username: 'johndoe',
			link: window.location.origin + '/reset-password/#token=1a2b3c4d5e6f7890abcd1234ef567890abcd1234ef567890abcd1234ef56789',
			hours: '48'
		};
	}
	function renderPlaceholders(template, vars) {
		return String(template || '')
			.split('{{username}}').join(vars.username)
			.split('{{link}}').join(vars.link)
			.split('{{hours}}').join(vars.hours);
	}

	function showPreview(subjectTpl, bodyTpl) {
		var vars = previewVars();
		var wrap = el('div');
		wrap.appendChild(el('p', 'muted', 'Rendered with sample values ({{username}} → ' + vars.username + ', {{hours}} → ' + vars.hours + '). The real email uses a genuine one-time link.'));
		var subjRow = el('div', 'kv');
		subjRow.appendChild(el('span', 'k', 'Subject'));
		var subjV = el('span', 'v'); subjV.style.fontWeight = '600';
		subjV.textContent = renderPlaceholders(subjectTpl, vars);
		subjRow.appendChild(subjV);
		wrap.appendChild(subjRow);

		// Template HTML must never enter the dashboard document. A sandboxed
		// srcdoc preview preserves basic email formatting while blocking scripts,
		// forms, navigation, and remote resources from an authored template.
		var frame = el('iframe');
		frame.title = 'Email body preview';
		frame.setAttribute('sandbox', '');
		frame.referrerPolicy = 'no-referrer';
		frame.style.cssText = 'display:block;width:100%;height:320px;margin-top:12px;border:1px solid var(--pnq-border);border-radius:8px;background:#fff';
		frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8">' +
			'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">' +
			'</head><body>' + renderPlaceholders(bodyTpl, vars) + '</body></html>';
		wrap.appendChild(frame);

		App.modal({
			title: 'Preview', body: wrap, dismissable: false,
			buttons: [{ label: 'Close', kind: 'primary', onClick: function (c) { c(); } }]
		});
	}

	function openTemplateEditor(opts) {
		var subjectI = el('input', 'input'); subjectI.type = 'text'; subjectI.value = opts.subjectValue || '';
		var bodyI = el('textarea', 'input'); bodyI.rows = 10; bodyI.value = opts.bodyValue || '';
		var form = el('div');
		form.appendChild(field('Subject', subjectI));
		form.appendChild(field('Body (HTML) — placeholders: {{username}} {{link}} {{hours}}', bodyI));

		App.modal({
			title: opts.title, body: form, dismissable: true,
			buttons: [
				{ label: 'Cancel', kind: 'ghost', onClick: function (c) { c(); } },
				{ label: 'Preview', kind: 'ghost', onClick: function () { showPreview(subjectI.value, bodyI.value); } },
				{ label: 'Save', kind: 'primary', onClick: function (c) {
					if (!subjectI.value.trim() || !bodyI.value.trim()) { App.toast('Subject and body cannot be blank', 'error'); return; }
					c();
					App.loading(true);
					App.api('/api/admin/mail/template/' + opts.kind, {
						method: 'PUT', headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ subject: subjectI.value, body: bodyI.value })
					}).then(function (res) {
						App.loading(false);
						if (res.status === 200) App.toast('Email template saved', 'ok');
						else App.toast((res.body && res.body.message) || 'Could not save template', 'error');
						load();
					}).catch(function () { App.loading(false); load(); });
				} }
			],
			onOpen: function () { subjectI.focus(); }
		});
	}

	function renderTemplate(cfg, kind, cardId, title, description) {
		var c = document.getElementById(cardId); if (!c) return;
		var tpl = (cfg.templates && cfg.templates[kind]) || {};
		c.innerHTML = '';
		c.appendChild(el('div', 'card-title', title));
		c.appendChild(el('p', 'muted', description));

		c.appendChild(kv('Subject', tpl.subject || '—'));
		var bodyRow = el('div', 'kv');
		bodyRow.appendChild(el('span', 'k', 'Body'));
		var bv = el('span', 'v'); bv.style.cssText = 'font-weight:400;text-align:right;max-width:70%';
		bv.appendChild(document.createTextNode(textPreview(tpl.body, 140)));
		bodyRow.appendChild(bv);
		c.appendChild(bodyRow);

		var editBtn = el('button', 'btn btn-primary'); editBtn.type = 'button'; editBtn.style.marginTop = '10px';
		editBtn.appendChild(el('i', 'fa fa-pencil'));
		editBtn.appendChild(document.createTextNode(' Edit'));
		editBtn.addEventListener('click', function () {
			openTemplateEditor({ title: title, kind: kind, subjectValue: tpl.subject || '', bodyValue: tpl.body || '' });
		});
		c.appendChild(editBtn);
	}

	function renderTest(cfg) {
		var c = document.getElementById('mail-test-card'); if (!c) return;
		var tpl = (cfg.templates && cfg.templates.test) || {};
		c.innerHTML = '';
		c.appendChild(el('div', 'card-title', 'Send a test email'));
		c.appendChild(el('p', 'muted', 'Sends a real message through the settings above — use this to confirm the server accepts them before relying on it for account-creation emails.'));

		var addr = el('input', 'input'); addr.type = 'email'; addr.placeholder = 'you@example.com';
		c.appendChild(field('Send to', addr));

		var subjectI = el('input', 'input'); subjectI.type = 'text';
		subjectI.value = tpl.subject || 'PNETLab SMTP test';
		c.appendChild(field('Subject', subjectI));

		var bodyI = el('textarea', 'input'); bodyI.rows = 6;
		bodyI.value = tpl.body || "<p>This is a test email from your PNETLab install's Mail Settings page.</p>";
		c.appendChild(field('Body (HTML)', bodyI));

		var sendBtn = el('button', 'btn btn-primary'); sendBtn.type = 'button';
		sendBtn.appendChild(el('i', 'fa fa-paper-plane'));
		sendBtn.appendChild(document.createTextNode(' Send test email'));
		sendBtn.addEventListener('click', function () {
			var to = addr.value.trim();
			if (!to) { addr.classList.add('invalid'); return; }
			if (!subjectI.value.trim()) { subjectI.classList.add('invalid'); return; }
			if (!bodyI.value.trim()) { bodyI.classList.add('invalid'); return; }
			sendBtn.disabled = true;
			App.loading(true);
			App.api('/api/admin/mail/test', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ to: to, subject: subjectI.value, body: bodyI.value })
			}).then(function (res) {
				App.loading(false); sendBtn.disabled = false;
				if (res.status === 200) App.toast('Test email sent to ' + to, 'ok');
				else App.toast((res.body && res.body.message) || 'Could not send test email', 'error');
			}).catch(function () { App.loading(false); sendBtn.disabled = false; App.toast('Could not send test email', 'error'); });
		});
		c.appendChild(sendBtn);

		var saveTplBtn = el('button', 'btn btn-ghost'); saveTplBtn.type = 'button'; saveTplBtn.style.marginLeft = '8px';
		saveTplBtn.appendChild(el('i', 'fa fa-floppy-o'));
		saveTplBtn.appendChild(document.createTextNode(' Save template'));
		saveTplBtn.title = 'Remember this subject/body so it preloads next time';
		saveTplBtn.addEventListener('click', function () {
			if (!subjectI.value.trim()) { subjectI.classList.add('invalid'); return; }
			if (!bodyI.value.trim()) { bodyI.classList.add('invalid'); return; }
			saveTplBtn.disabled = true;
			App.loading(true);
			App.api('/api/admin/mail/template/test', {
				method: 'PUT', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ subject: subjectI.value, body: bodyI.value })
			}).then(function (res) {
				App.loading(false); saveTplBtn.disabled = false;
				if (res.status === 200) App.toast('Test email template saved', 'ok');
				else App.toast((res.body && res.body.message) || 'Could not save template', 'error');
			}).catch(function () { App.loading(false); saveTplBtn.disabled = false; App.toast('Could not save template', 'error'); });
		});
		c.appendChild(saveTplBtn);
	}

	App.register('mail', { title: 'Mail (SMTP)', icon: 'fa-envelope', admin: true, render: render });
})();
