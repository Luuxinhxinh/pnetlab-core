/* ============================================================================
   PNetLab engine-native login controller.
   Posts {username,password} as JSON to POST /api/auth (api.php). That endpoint
   mints a token, writes the `token` cookie (path=/, expires time()+SESSION),
   and returns {code,status,message}. On 200 we redirect to the ?link= target
   if it is same-origin, else to /main/. CSP-safe: external file, no eval.
   ============================================================================ */
(function () {
	'use strict';

	var form = document.getElementById('login-form');
	var userEl = document.getElementById('username');
	var passEl = document.getElementById('password');
	var consolePrefEl = document.getElementById('console-pref');
	var alertEl = document.getElementById('alert');
	var submitEl = document.getElementById('submit');
	var versionValueEl = document.getElementById('version-value');

	/* Resolve where to land after a successful login. Only same-origin targets
	   are honoured (open-redirect guard); anything else falls back to /main/. */
	function redirectTarget() {
		var link = '';
		try {
			link = new URLSearchParams(window.location.search).get('link') || '';
		} catch (e) { link = ''; }
		if (!link) return '/main/';
		try {
			// Resolve relative to current origin; reject cross-origin.
			var u = new URL(link, window.location.origin);
			if (u.origin === window.location.origin) return u.pathname + u.search + u.hash;
		} catch (e) { /* fall through */ }
		return '/main/';
	}

	function showError(msg) {
		alertEl.textContent = msg || 'Sign in failed. Please try again.';
		alertEl.hidden = false;
	}
	function clearError() {
		alertEl.hidden = true;
		alertEl.textContent = '';
	}

	function setBusy(on) {
		submitEl.disabled = on;
		submitEl.classList.toggle('is-busy', on);
	}

	function submit(e) {
		if (e) e.preventDefault();
		clearError();
		var username = (userEl.value || '').trim();
		var password = passEl.value || '';
		if (!username || !password) {
			showError('Enter your username and password.');
			return;
		}
		setBusy(true);
		var consolePref = consolePrefEl ? consolePrefEl.value : 'native';
		var html5 = (consolePref === 'html5') ? 1 : 0;
		fetch('/api/auth', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username: username, password: password, html5: html5 })
		}).then(function (r) {
			return r.text().then(function (txt) {
				var body = {};
				try { body = txt ? JSON.parse(txt) : {}; } catch (err) { body = {}; }
				return { status: r.status, body: body };
			});
		}).then(function (res) {
			if (res.status === 200 && res.body && res.body.status === 'success') {
				window.location.replace(redirectTarget());
				return;
			}
			setBusy(false);
			showError((res.body && res.body.message) || 'Invalid credentials.');
			passEl.value = '';
			passEl.focus();
		}).catch(function () {
			setBusy(false);
			showError('Cannot reach the server. Check that the appliance is running.');
		});
	}

	form.addEventListener('submit', submit);

	/* Logo fallback: if the engine-side asset 404s, drop to the "PN" wordmark
	   (CSP-safe — no inline onerror handler). */
	var logoEl = document.getElementById('brand-logo');
	var markEl = document.getElementById('brand-mark');
	if (logoEl && markEl) {
		logoEl.addEventListener('error', function () {
			logoEl.hidden = true;
			markEl.hidden = false;
		});
	}

	/* Custom branding (pre-auth). /branding/api.php?action=config is deliberately
	   unauthenticated — this page paints before any token exists. PnqBranding.load
	   never rejects, so a missing/broken config just leaves the stock markup that
	   is already in the HTML. The logo <img> already points at the branding
	   endpoint, which falls back to the stock image server-side; apply() only
	   re-stamps it with the ?v= cache token. */
	if (window.PnqBranding) {
		window.PnqBranding.load().then(function (cfg) {
			/* The same public config drives branding and appearance. Confirm it here
			   as well as in pnq-theme's boot refresh so the pre-auth page cannot be
			   left on a stale local hint if the two startup requests interleave. */
			if (window.PnqTheme && cfg.theme_profile) {
				window.PnqTheme.confirm(cfg.theme_profile, 'login');
			}
			window.PnqBranding.apply(cfg);
			document.title = cfg.name + ' — Sign in';
			var hdr = document.getElementById('login-header');
			if (hdr && cfg.login_header) {
				hdr.textContent = cfg.login_header;   // textContent: never markup
				hdr.hidden = false;
			}
			if (cfg.hide_default_creds) {
				var da = document.getElementById('default-account');
				if (da) da.hidden = true;
			}
		});
	}

	/* Live version line: sourced from login/version.php, which itself proxies
	   includes/version.php (PNET_RELEASE) — the single source of truth. Never
	   hardcode the number here; fall back to a plain dash if the fetch fails
	   (e.g. DB-independent but PHP still misbehaving). */
	if (versionValueEl) {
		fetch('/login/version.php', { credentials: 'same-origin' })
			.then(function (r) { return r.json(); })
			.then(function (data) {
				versionValueEl.textContent = (data && data.version) ? data.version : '—';
			})
			.catch(function () {
				versionValueEl.textContent = '—';
			});
	}
})();
