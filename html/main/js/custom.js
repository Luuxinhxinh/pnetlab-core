/* ============================================================================
   PNetLab dashboard — Customization view (admin)
   Wraps branding/api.php (admin-only writes; the two GET actions are public
   because the login page reads them before any token exists):
     GET  ?action=config       → {name,login_header,hide_default_creds,logo,token}
     POST ?action=save         {name,login_header,hide_default_creds}
     POST ?action=upload_logo  multipart file=<png|jpeg>
     POST ?action=reset        → back to stock branding
   Route #/custom, admin:true — the router's own guard (dashboard.js navigate())
   redirects a non-admin away, and the API 403s independently.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;

	// Mirrors branding/api.php — kept in sync so the UI rejects before the round trip.
	var NAME_MAX = 40, HEADER_MAX = 120, LOGO_MAX = 524288;

	var cfg = null;          // last-loaded config
	var pendingFile = null;  // chosen but not-yet-uploaded logo

	function viewTitle(t, i) { var d = el('div', 'view-title'); d.appendChild(el('i', 'fa ' + i)); d.appendChild(document.createTextNode(' ' + t)); return d; }
	function field(label, inp, hint) {
		var f = el('div', 'field');
		if (label) f.appendChild(el('label', null, label));
		f.appendChild(inp);
		if (hint) f.appendChild(el('p', 'muted', hint)).style.margin = '6px 0 0';
		return f;
	}

	function render(view) {
		view.appendChild(viewTitle('Customization', 'fa-paint-brush'));

		var card = el('div', 'card');
		card.appendChild(el('div', 'card-title', 'Branding'));
		card.appendChild(el('p', 'muted',
			'Replace the product name and logo shown on the login page, this dashboard and the lab view. ' +
			'The Version page keeps reporting the real package version so the appliance stays diagnosable.'));

		var form = el('div');
		card.appendChild(form);
		view.appendChild(card);

		App.loading(true);
		App.api('/branding/api.php?action=config').then(function (res) {
			App.loading(false);
			cfg = (res.status === 200 && res.body) ? res.body : { name: 'PNetLab', login_header: '', hide_default_creds: false, logo: false, token: '' };
			paint(form);
		}).catch(function () {
			App.loading(false);
			form.appendChild(el('p', 'muted', 'Could not load the current branding.'));
		});
	}

	function paint(form) {
		form.innerHTML = '';

		/* ---- logo ---- */
		var preview = el('img', 'brand-preview');
		preview.src = window.PnqBranding ? window.PnqBranding.logoUrl(cfg) : '/branding/api.php?action=logo';
		preview.alt = 'Current logo';
		// Inline sizing: the dashboard CSS has no preview class and this is the
		// only consumer. style-src allows 'unsafe-inline' (see enable-web-hardening.sh).
		preview.style.cssText = 'max-width:180px;max-height:80px;display:block;margin:0 0 10px;';
		form.appendChild(preview);

		var fileInp = el('input', 'input');
		fileInp.type = 'file';
		fileInp.accept = 'image/png,image/jpeg';
		fileInp.addEventListener('change', function () {
			pendingFile = fileInp.files && fileInp.files[0] ? fileInp.files[0] : null;
			if (!pendingFile) return;
			if (pendingFile.size > LOGO_MAX) {
				App.toast('The logo must be 512 KB or smaller.', 'error');
				fileInp.value = ''; pendingFile = null; return;
			}
			// Local preview before upload — object URL, no data: URI, CSP-clean.
			var u = URL.createObjectURL(pendingFile);
			preview.src = u;
			preview.addEventListener('load', function () { URL.revokeObjectURL(u); }, { once: true });
		});
		form.appendChild(field('Logo', fileInp,
			'PNG or JPEG, up to 512 KB and 4000×4000. Shown at roughly 28–150 px, so a square or wide mark works best.'));

		/* ---- name ---- */
		var nameInp = el('input', 'input');
		nameInp.type = 'text';
		nameInp.maxLength = NAME_MAX;
		nameInp.placeholder = 'PNetLab';
		nameInp.value = (cfg.name && cfg.name !== 'PNetLab') ? cfg.name : '';
		form.appendChild(field('Product name', nameInp,
			'Replaces the "PNetLab" wordmark and browser tab titles. Leave blank to use the default.'));

		/* ---- login header ---- */
		var hdrInp = el('input', 'input');
		hdrInp.type = 'text';
		hdrInp.maxLength = HEADER_MAX;
		hdrInp.placeholder = 'e.g. Training lab — authorised users only';
		hdrInp.value = cfg.login_header || '';
		form.appendChild(field('Login page header', hdrInp,
			'One line of plain text shown above the sign-in form. Visible to anyone who can reach the login page, including before sign-in.'));

		/* ---- hide default creds ---- */
		var hideWrap = el('label', 'check');
		var hideInp = el('input');
		hideInp.type = 'checkbox';
		hideInp.checked = !!cfg.hide_default_creds;
		hideWrap.appendChild(hideInp);
		hideWrap.appendChild(document.createTextNode(' Hide the "Default account: admin / pnet" line on the login page'));
		var hideField = el('div', 'field');
		hideField.appendChild(hideWrap);
		form.appendChild(hideField);

		/* ---- actions ---- */
		var foot = el('div', 'form-actions');
		foot.style.cssText = 'display:flex;gap:10px;align-items:center;margin-top:16px;';
		var save = el('button', 'btn btn-primary', 'Save');
		save.type = 'button';
		save.addEventListener('click', function () { doSave(form, nameInp, hdrInp, hideInp); });
		foot.appendChild(save);

		var reset = el('button', 'btn btn-ghost', 'Reset to defaults');
		reset.type = 'button';
		reset.addEventListener('click', function () { doReset(form); });
		foot.appendChild(reset);

		if (cfg.logo) foot.appendChild(el('span', 'muted', 'Using a custom logo'));
		form.appendChild(foot);
	}

	/* Save text fields first, then the logo if one was chosen — two calls because
	   the logo is multipart and the rest is JSON. Both must land before we repaint
	   the shell, so the topbar/name/logo update together. */
	function doSave(form, nameInp, hdrInp, hideInp) {
		App.loading(true);
		App.api('/branding/api.php?action=save', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: nameInp.value,
				login_header: hdrInp.value,
				hide_default_creds: hideInp.checked ? 1 : 0
			})
		}).then(function (res) {
			if (res.status !== 200) throw new Error(App.errMsg(res.body));
			if (!pendingFile) return null;
			var fd = new FormData();
			fd.append('file', pendingFile);
			// No Content-Type header: the browser must set the multipart boundary.
			return App.api('/branding/api.php?action=upload_logo', { method: 'POST', body: fd })
				.then(function (r) {
					if (r.status !== 200) throw new Error(App.errMsg(r.body));
					return r;
				});
		}).then(function () {
			pendingFile = null;
			App.loading(false);
			App.toast('Branding saved.', 'ok');
			return refresh(form);
		}).catch(function (e) {
			App.loading(false);
			App.toast((e && e.message) || 'Could not save the branding.', 'error');
		});
	}

	function doReset(form) {
		App.confirm('Reset the logo, product name and login header back to the PNetLab defaults?',
			{ title: 'Reset branding', okLabel: 'Reset', danger: true }).then(function (ok) {
			if (!ok) return;
			App.loading(true);
			App.api('/branding/api.php?action=reset', { method: 'POST' }).then(function (res) {
				App.loading(false);
				if (res.status !== 200) { App.toast(App.errMsg(res.body), 'error'); return; }
				pendingFile = null;
				App.toast('Branding reset to defaults.', 'ok');
				refresh(form);
			}).catch(function () { App.loading(false); App.toast('Could not reset the branding.', 'error'); });
		});
	}

	/* Re-read the config, repaint the shell chrome (topbar logo + wordmark +
	   tab title) and repaint this form — so a save is visible immediately
	   without a reload. */
	function refresh(form) {
		return App.applyBranding().then(function (c) {
			cfg = c || cfg;
			paint(form);
		});
	}

	App.register('custom', { title: 'Customization', icon: 'fa-paint-brush', admin: true, render: render });
})();
