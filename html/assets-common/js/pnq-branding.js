/* ============================================================================
   pnq-branding.js — shared client helper for GUI-configurable branding.
   Loaded by the login page, the /main/ dashboard and the lab page; each one
   paints the same three things (product name, logo, login header) from the
   PUBLIC endpoint /branding/api.php?action=config.

   Classic script, no ESM, no strict-only syntax (the engine loads it alongside
   sloppy-mode legacy code). CSP-safe: external file, textContent only, never
   innerHTML — the name and header are admin-supplied strings and must never be
   parsed as markup.
   ============================================================================ */
(function () {
	'use strict';

	var DEFAULTS = { name: 'PNetLab', login_header: '', hide_default_creds: false, theme_profile: 'dark', logo: false, token: '' };
	var pending = null;
	var lastSuccessful = null;
	var requestSequence = 0;
	var appliedSequence = 0;

	function validTheme(value) {
		return ['light', 'dark', 'ocean-teal', 'mint-teal', 'macos-26-dark'].indexOf(value) !== -1;
	}
	function sanitize(d) {
		if (!d || typeof d !== 'object') d = {};
		return {
			name: (typeof d.name === 'string' && d.name) ? d.name : DEFAULTS.name,
			login_header: (typeof d.login_header === 'string') ? d.login_header : '',
			hide_default_creds: !!d.hide_default_creds,
			theme_profile: validTheme(d.theme_profile) ? d.theme_profile : DEFAULTS.theme_profile,
			logo: !!d.logo,
			token: (typeof d.token === 'string') ? d.token : ''
		};
	}

	/* Fetch the branding config. NEVER rejects: a failed/garbled fetch resolves
	   to stock defaults, because every caller paints chrome that must render
	   even when this endpoint is unreachable. */
	function loadResult(force) {
		if (pending && !force) return pending;
		var requestId = ++requestSequence;
		var request = fetch('/branding/api.php?action=config', { credentials: 'same-origin', cache: 'no-store' })
			.then(function (r) {
				if (!r.ok) throw new Error('branding config unavailable');
				return r.json();
			})
			.then(function (d) {
				var clean = sanitize(d);
				if (requestId >= appliedSequence) {
					appliedSequence = requestId;
					lastSuccessful = clean;
				}
				return { ok: true, config: clean };
			})
			.catch(function () {
				return { ok: false, config: lastSuccessful || DEFAULTS };
			});
		var tracked = request.then(function (result) {
			if (pending === tracked) pending = null;
			return result;
		});
		pending = tracked;
		return pending;
	}
	function load(force) {
		return loadResult(force).then(function (result) { return result.config; });
	}

	/* Logo URL for a given config. The ?v= token changes only when the image
	   actually changes, so browsers keep their cache entry across reloads but
	   pick up a new logo immediately. */
	function logoUrl(cfg) {
		var t = (cfg && cfg.token) ? cfg.token : '';
		return '/branding/api.php?action=logo' + (t ? '&v=' + encodeURIComponent(t) : '');
	}

	/* Point every branded <img> at the endpoint and swap every wordmark node.
	   Selectors are opt-in (data-brand-logo / data-brand-name) so a page only
	   rebrands what it marked, and untouched markup keeps working. */
	function apply(cfg) {
		var url = logoUrl(cfg);
		document.querySelectorAll('[data-brand-logo]').forEach(function (img) {
			img.src = url;
			if (img.tagName === 'IMG') img.alt = cfg.name;
		});
		document.querySelectorAll('[data-brand-name]').forEach(function (n) {
			n.textContent = cfg.name;
		});
		document.querySelectorAll('link[rel~="icon"]').forEach(function (l) { l.href = url; });
		var tpl = document.documentElement.getAttribute('data-brand-title');
		if (tpl) document.title = tpl.replace('%s', cfg.name);
	}

	window.PnqBranding = { load: load, loadResult: loadResult, apply: apply, logoUrl: logoUrl, defaults: DEFAULTS, sanitize: sanitize };
})();
