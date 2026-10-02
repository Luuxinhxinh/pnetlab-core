/* Appliance-wide appearance profiles. The server is authoritative; the local
 * cache is only an anti-flash hint. Lab canvas light/dark is intentionally not
 * owned here and remains in pnq.canvasflow.theme. */
(function (root) {
	'use strict';

	var CACHE_KEY = 'pnq.appearance.theme';
	var PROFILES = {
		light: { id: 'light', label: 'Light', mode: 'light', description: 'Bright neutral surfaces with a restrained teal accent.' },
		dark: { id: 'dark', label: 'Dark teal', mode: 'dark', description: 'The original dark appearance with restrained teal chrome.' },
		'ocean-teal': { id: 'ocean-teal', label: 'Nord', mode: 'dark', description: 'Neutral slate surfaces with restrained, muted-blue accents.' },
		'mint-teal': { id: 'mint-teal', label: 'Catppuccin Frappe', mode: 'dark', description: 'Soft charcoal surfaces with a calm periwinkle-blue accent.' },
		'macos-26-dark': { id: 'macos-26-dark', label: 'Dark', mode: 'dark', description: 'Graphite surfaces, luminous blue, and restrained glass chrome.' }
	};
	var current = 'dark';
	var confirmed = false;
	var readGeneration = 0;
	var writeGeneration = 0;
	var savesInFlight = 0;
	var refreshQueued = false;

	function valid(value) { return typeof value === 'string' && !!PROFILES[value]; }
	function normalize(value) { return valid(value) ? value : null; }
	function mode(value) { return PROFILES[normalize(value) || 'dark'].mode; }
	function profile(value) { return PROFILES[normalize(value) || 'dark']; }
	function cached() {
		try { return normalize(root.localStorage.getItem(CACHE_KEY)); } catch (e) { return null; }
	}
	function read() { return current; }
	function apply(value, isConfirmed) {
		var next = normalize(value) || 'dark';
		current = next;
		if (isConfirmed) {
			confirmed = true;
			try { root.localStorage.setItem(CACHE_KEY, next); } catch (e) {}
		}
		var doc = root.document;
		if (doc && doc.documentElement) {
			doc.documentElement.dataset.theme = mode(next);
			doc.documentElement.dataset.themeProfile = next;
			if (doc.body) {
				doc.body.dataset.theme = mode(next);
				doc.body.dataset.themeProfile = next;
			}
		}
		return next;
	}
	function announce(value, source) {
		var next = apply(value, true);
		try {
			root.dispatchEvent(new CustomEvent('pnq:theme-change', { detail: { profile: next, mode: mode(next), source: source || 'server' } }));
		} catch (e) {}
		return next;
	}
	function refresh(force) {
		if (!root.PnqBranding || !root.PnqBranding.loadResult) return Promise.resolve({ ok: false, profile: current });
		if (savesInFlight > 0) {
			refreshQueued = true;
			return Promise.resolve({ ok: false, profile: current });
		}
		var requestedAt = ++readGeneration;
		return root.PnqBranding.loadResult(!!force).then(function (result) {
			if (!result.ok || requestedAt !== readGeneration) return { ok: false, profile: current };
			return { ok: true, profile: announce(result.config.theme_profile, 'server') };
		});
	}
	function save(value) {
		var next = normalize(value);
		if (!next) return Promise.reject(new Error('Invalid theme profile.'));
		var writeId = ++writeGeneration;
		readGeneration += 1; // invalidate every GET that began before this write
		savesInFlight += 1;
		var request = fetch('/branding/api.php?action=save_theme', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', 'X-PNetLab-Request': 'theme-settings' },
			body: JSON.stringify({ theme_profile: next })
		}).then(function (response) {
			return response.text().then(function (text) {
				var body = {};
				try { body = text ? JSON.parse(text) : {}; } catch (e) {}
				if (!response.ok || !valid(body.theme_profile)) throw new Error(body.error || 'Could not save the appliance theme.');
				if (writeId !== writeGeneration) return current;
				return announce(body.theme_profile, 'save');
			});
		});
		return request.then(function (result) {
			savesInFlight -= 1;
			if (savesInFlight === 0 && refreshQueued) { refreshQueued = false; refresh(true); }
			return result;
		}, function (error) {
			savesInFlight -= 1;
			if (savesInFlight === 0 && refreshQueued) { refreshQueued = false; refresh(true); }
			throw error;
		});
	}
	function isConfirmed() { return confirmed; }

	root.PnqTheme = {
		key: CACHE_KEY,
		profiles: PROFILES,
		list: Object.keys(PROFILES).map(function (id) { return PROFILES[id]; }),
		valid: valid, normalize: normalize, read: read, mode: mode, profile: profile,
		apply: apply, confirm: announce, refresh: refresh, save: save, isConfirmed: isConfirmed
	};

	apply(cached() || 'dark', false);
	if (root.document && !root.document.body) {
		root.document.addEventListener('DOMContentLoaded', function () { apply(current, false); });
	}
	refresh(false);
	root.addEventListener('focus', function () { refresh(true); });
	root.addEventListener('storage', function (event) {
		if (event.key === CACHE_KEY) refresh(true);
	});
})(window);
