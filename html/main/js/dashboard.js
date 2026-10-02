/* ============================================================================
   PNetLab self-created dashboard — shell bootstrap + router
   Pure vanilla JS, no build step. CSP-safe: external file (script-src 'self'),
   no eval / no new Function, no inline handlers (delegated listeners only).
   The browser already holds the shared `token` cookie that the engine-native
   login (/login/ → POST /api/auth) set; every API call below rides it via
   credentials:'same-origin'.
   ============================================================================ */
(function () {
	'use strict';

	/* ---- theme (must run FIRST, before any paint we can influence) ----------
	   dashboard.js is a deferred external script (CSP script-src 'self' forbids an
	   inline <head> script), so a dark user still sees one frame of the light html
	   background (#f4f6f5, set statically in index.html) before this runs. Setting
	   data-theme as the very first statement keeps that flash to a single frame. */
	var Theme = window.PnqTheme;
	var THEME_PROFILES = Theme ? Theme.profiles : {
		light: { id: 'light', label: 'Light', mode: 'light', description: 'Bright surfaces with the existing light canvas.' },
		dark: { id: 'dark', label: 'Dark teal', mode: 'dark', description: 'The original dark appearance with restrained teal chrome.' },
		'ocean-teal': { id: 'ocean-teal', label: 'Nord', mode: 'dark', description: 'Neutral slate surfaces with restrained, muted-blue accents.' },
		'mint-teal': { id: 'mint-teal', label: 'Catppuccin Frappe', mode: 'dark', description: 'Soft charcoal surfaces with a calm periwinkle-blue accent.' },
		'macos-26-dark': { id: 'macos-26-dark', label: 'Dark', mode: 'dark', description: 'Graphite surfaces, luminous blue, and restrained glass chrome.' }
	};
	var currentThemeProfile = null;
	function normalizeThemeProfile(value) {
		if (Theme && Theme.normalize) return Theme.normalize(value) || 'dark';
		return THEME_PROFILES[value] ? value : 'dark';
	}
	function readThemeProfile() {
		if (Theme && Theme.read) return normalizeThemeProfile(Theme.read());
		return 'dark';
	}
	function themeMode(profile) {
		var p = THEME_PROFILES[normalizeThemeProfile(profile)] || THEME_PROFILES.dark;
		return p.mode || (p.id === 'light' ? 'light' : 'dark');
	}
	function applyTheme(profile) {
		var next = normalizeThemeProfile(profile);
		currentThemeProfile = next;
		document.documentElement.dataset.theme = themeMode(next);
		document.documentElement.dataset.themeProfile = next;
		return next;
	}
	function persistTheme(profile) {
		if (!Theme || !Theme.save) return Promise.reject(new Error('Theme service is unavailable.'));
		return Theme.save(normalizeThemeProfile(profile)).then(function (next) {
			applyTheme(next);
			document.dispatchEvent(new CustomEvent('pnq:theme-applied', { detail: { profile: next, mode: themeMode(next) } }));
			return next;
		});
	}
	applyTheme(readThemeProfile());
	window.addEventListener('pnq:theme-change', function (event) {
		var detail = event.detail || {};
		if (!detail.profile) return;
		applyTheme(detail.profile);
		document.dispatchEvent(new CustomEvent('pnq:theme-applied', { detail: detail }));
	});

	// Engine-native login (the Laravel store login is retired). Pass link=/main/
	// so a successful login returns straight to this dashboard. /login/ is a real
	// directory, so it bypasses the .htaccess store catch-all.
	var LOGIN_URL = '/login/?link=' + encodeURIComponent(window.location.origin + '/main/');

	/* ---- shared app state (read by view modules) --------------------------- */
	var App = window.PnqApp = {
		user: null,
		isAdmin: false,
		lang: {},
		branding: null,      // {name,login_header,…} from /branding/api.php; see applyBranding()
		version: null,       // {pnetlab,os,kernel,…} fetched once at boot
		routes: {},          // filled by view modules via App.register()
		currentRoute: null,
		api: api,
		poll: createPoller,
		el: el,
		h: h,
		clickable: clickable,
		toast: toast,
		batchReport: batchReport,
		t: t,
		register: register,
		modal: modal,
		confirm: confirmDialog,
		prompt: promptDialog,
		loading: loading,
		errMsg: errMsg,
		go: function (key) { location.hash = '#/' + key; },
		applyBranding: applyBranding,
		themeProfiles: THEME_PROFILES,
		getTheme: function () { return currentThemeProfile; },
		setTheme: persistTheme,
		brandName: function () { return (App.branding && App.branding.name) || 'PNetLab'; }
	};

	/* ---- branding ----------------------------------------------------------
	   Paints the custom product name / logo over the stock markup. Called at boot
	   and again after the Customization view saves, so a rebrand lands without a
	   reload. PnqBranding.load() never rejects — a failure leaves stock chrome. */
	function applyBranding(cfg) {
		if (!window.PnqBranding) return Promise.resolve(null);
		var p = cfg ? Promise.resolve({ ok: true, config: cfg }) : window.PnqBranding.loadResult();
		return p.then(function (result) {
			var c = result.config;
			App.branding = c;
			window.PnqBranding.apply(c);
			document.title = c.name;
			// The sidebar version line renders "<name> <release>"; re-stamp it
			// because the version fetch may have already painted the old name.
			renderVersionLine();
			return c;
		});
	}
	function renderVersionLine() {
		if (!App.version) return;
		var shown = App.version.release || App.version.pnetlab || '';
		document.querySelectorAll('[data-bind="version"]').forEach(function (n) { n.textContent = shown; });
	}

	/* ---- tiny fetch helper: returns {status, body} ------------------------- */
	function api(path, opts) {
		opts = opts || {};
		opts.credentials = 'same-origin';
		opts.headers = opts.headers || {};
		return fetch(path, opts).then(function (r) {
			// 401 = not authenticated; 412 = session no longer valid — the auth guard
			// (indentify::authorization) returns 412 when the token cookie no longer
			// matches users.cookie, which is exactly what a newer login elsewhere does
			// (single-session-per-user: the second login rotates users.cookie, orphaning
			// this tab's token). Treat both as "signed out" and hand the tab to the login
			// page, mirroring the lab view's error_handle (412 || 401 -> pnqRedirectToLogin).
			if (r.status === 401 || r.status === 412) { location.href = LOGIN_URL; throw new Error('unauthorized'); }
			return r.text().then(function (txt) {
				var body = {};
				try { body = txt ? JSON.parse(txt) : {}; } catch (e) { body = { _raw: txt }; }
				return { status: r.status, body: body };
			});
		});
	}

	/* ---- shared visibility-aware poller ------------------------------------
	   Dashboard status requests are cheap on the wire but not free on the
	   appliance: background-tab polling burns host CPU that should go to the
	   QEMU/IOL processes the user is watching. All repeating status/job lanes
	   use this helper so hidden tabs pause, visible tabs refresh immediately,
	   and repeated failures back off instead of keeping a sick endpoint hot. */
	function createPoller(task, opts) {
		opts = opts || {};
		var interval = opts.interval || 5000;
		var maxInterval = opts.maxInterval || 120000;
		var timer = null, stopped = true, inFlight = false, failures = 0, bound = false;

		function clearTimer() {
			if (timer) { clearTimeout(timer); timer = null; }
		}
		function delayAfterFailure() {
			return Math.min(interval * Math.pow(2, failures), maxInterval);
		}
		function schedule(delay) {
			clearTimer();
			if (stopped || document.hidden) return;
			timer = setTimeout(run, Math.max(0, delay));
		}
		function finish(ok) {
			inFlight = false;
			if (stopped || document.hidden) return;
			if (ok) failures = 0;
			else failures = Math.min(failures + 1, 8);
			schedule(ok ? interval : delayAfterFailure());
		}
		function run() {
			timer = null;
			if (stopped || document.hidden || inFlight) return;
			if (opts.guard && !opts.guard()) { stop(); return; }
			inFlight = true;
			var result;
			try { result = task(); }
			catch (e) { result = Promise.reject(e); }
			Promise.resolve(result).then(function (value) {
				if (value && typeof value.status === 'number' && value.status >= 400) {
					return Promise.reject(new Error('poll request failed'));
				}
				return value;
			}).then(function () { finish(true); }, function () { finish(false); });
		}
		function onVisibilityChange() {
			if (document.hidden) { clearTimer(); return; }
			if (!stopped && !inFlight) { failures = 0; schedule(0); }
		}
		function start(immediate) {
			stopped = false;
			if (!bound) {
				document.addEventListener('visibilitychange', onVisibilityChange);
				bound = true;
			}
			failures = 0;
			schedule(immediate === false ? interval : 0);
		}
		function stop() {
			stopped = true;
			clearTimer();
			if (bound) {
				document.removeEventListener('visibilitychange', onVisibilityChange);
				bound = false;
			}
		}
		return { start: start, stop: stop, kick: function () { if (!stopped) schedule(0); } };
	}

	/* ---- DOM helpers ------------------------------------------------------- */
	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}
	// h('div.card', {attrs}, [children|text]) — minimal hyperscript, textContent-safe
	function h(sel, attrs, children) {
		var parts = sel.split('.');
		var tag = parts.shift() || 'div';
		var e = document.createElement(tag);
		if (parts.length) e.className = parts.join(' ');
		if (attrs && typeof attrs === 'object' && !Array.isArray(attrs) && attrs.nodeType === undefined) {
			Object.keys(attrs).forEach(function (k) {
				if (k === 'text') { e.textContent = attrs[k]; }
				else if (k === 'html') { e.innerHTML = attrs[k]; }   // only ever called with our own static strings
				else if (k === 'dataset') { Object.keys(attrs[k]).forEach(function (d) { e.dataset[d] = attrs[k][d]; }); }
				else if (attrs[k] != null) { e.setAttribute(k, attrs[k]); }
			});
		} else { children = attrs; }
		appendChildren(e, children);
		return e;
	}
	// Make a non-button element (a click-<span>/<div> that's a primary action)
	// keyboard-operable: focusable + role=button + Enter/Space mirroring click,
	// so its :focus-visible ring is reachable. Additive — mouse behaviour intact.
	function clickable(node, handler) {
		node.setAttribute('role', 'button');
		if (!node.hasAttribute('tabindex')) node.tabIndex = 0;
		node.addEventListener('click', handler);
		node.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); handler(e); }
		});
		return node;
	}
	function appendChildren(e, children) {
		if (children == null) return;
		if (!Array.isArray(children)) children = [children];
		children.forEach(function (c) {
			if (c == null) return;
			if (typeof c === 'string') e.appendChild(document.createTextNode(c));
			else e.appendChild(c);
		});
	}

	/* ---- i18n passthrough (uses the lang map from /api/auth) ---------------- */
	function t(key) {
		return (App.lang && App.lang[key]) ? App.lang[key] : key;
	}

	/* ---- toast notifications ----------------------------------------------- */
	var toastHost = null;
	function toast(msg, kind) {
		if (!toastHost) {
			toastHost = el('div', 'toast-host');
			// Toasts are the ONLY channel for operation results, so the host must
			// be a live region or a screen-reader user never hears an outcome.
			// role=status implies polite, but set aria-live explicitly for older
			// AT; atomic so a toast is read whole, not as a diff.
			toastHost.setAttribute('role', 'status');
			toastHost.setAttribute('aria-live', 'polite');
			toastHost.setAttribute('aria-atomic', 'true');
			document.body.appendChild(toastHost);
		}
		var node = el('div', 'toast toast-' + (kind || 'info'));
		node.appendChild(el('i', 'fa ' + (kind === 'error' ? 'fa-exclamation-circle' : kind === 'ok' ? 'fa-check-circle' : 'fa-info-circle')));
		node.appendChild(el('span', null, msg));
		toastHost.appendChild(node);
		setTimeout(function () { node.classList.add('out'); setTimeout(function () { node.remove(); }, 250); }, 3600);
	}

	/* ---- loading overlay (ref-counted) ------------------------------------- */
	var loadEl = null, loadN = 0;
	function loading(on) {
		if (on) {
			loadN++;
			if (!loadEl) { loadEl = el('div', 'load-overlay'); loadEl.appendChild(el('div', 'boot-spin')); document.body.appendChild(loadEl); }
		} else {
			loadN = Math.max(0, loadN - 1);
			if (loadN === 0 && loadEl) { loadEl.remove(); loadEl = null; }
		}
	}

	/* ---- modal ------------------------------------------------------------- */
	// opts: { title, body:(Node|string), buttons:[{label,kind,onClick(close)}], wide, dismissable, onOpen(root,close) }
	// Accessibility contract (WCAG 2.4.3 focus order): the dialog announces
	// itself (role=dialog + aria-modal + aria-labelledby → the <h3>), keyboard
	// focus is pulled inside on open, Tab/Shift+Tab cycle within the dialog,
	// and close() hands focus back to whatever had it before the modal opened —
	// without this the page behind stays tabbable and the dialog is unreachable
	// to keyboard/AT users.
	var modalSeq = 0;   // unique ids for aria-labelledby (dialogs can stack, e.g. confirm-over-modal)
	function modal(opts) {
		opts = opts || {};
		var opener = document.activeElement;   // focus-restore target for close()
		var backdrop = el('div', 'modal-backdrop');
		var box = el('div', 'modal' + (opts.wide ? ' modal-lg' : ''));
		var titleId = 'pnq-modal-title-' + (++modalSeq);
		box.setAttribute('role', 'dialog');
		box.setAttribute('aria-modal', 'true');
		box.setAttribute('aria-labelledby', titleId);
		var head = el('div', 'modal-head');
		var hTitle = el('h3', null, opts.title || '');
		hTitle.id = titleId;
		head.appendChild(hTitle);
		var x = el('button', 'modal-close'); x.type = 'button'; x.textContent = '×';
		x.setAttribute('aria-label', 'Close'); x.title = 'Close';
		head.appendChild(x);
		box.appendChild(head);
		var body = el('div', 'modal-body');
		if (typeof opts.body === 'string') body.textContent = opts.body;
		else if (opts.body) body.appendChild(opts.body);
		box.appendChild(body);
		// What a Tab press can actually reach right now: standard focusable
		// elements minus disabled ones, minus anything hidden (display:none
		// leaves offsetParent null — e.g. the perm-group picker rows), so the
		// trap list always matches real tab order.
		function focusables() {
			var q = box.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])');
			return Array.prototype.filter.call(q, function (n) { return n.offsetParent !== null; });
		}
		// Dialogs stack (a confirm can open over a modal); only the topmost
		// backdrop may handle keys, or the lower trap would steal focus back
		// and Escape would close every layer at once.
		function isTop() {
			var all = document.querySelectorAll('.modal-backdrop');
			return all.length > 0 && all[all.length - 1] === backdrop;
		}
		function close() {
			backdrop.remove();
			document.removeEventListener('keydown', onKey);
			// Hand focus back to the opener. Views re-render rows freely, so the
			// opener may be gone from the DOM by now — body is the safe landing.
			if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
			else if (document.body) document.body.focus();
		}
		if (opts.buttons && opts.buttons.length) {
			var foot = el('div', 'modal-foot');
			opts.buttons.forEach(function (b) {
				var btn = el('button', 'btn' + (b.kind ? ' btn-' + b.kind : ''), b.label);
				btn.type = 'button';
				btn.addEventListener('click', function () { if (b.onClick) b.onClick(close); else close(); });
				foot.appendChild(btn);
			});
			box.appendChild(foot);
		}
		backdrop.appendChild(box);
		x.addEventListener('click', close);
		backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop && opts.dismissable !== false) close(); });
		function onKey(e) {
			if (!isTop()) return;
			if (e.key === 'Escape' && opts.dismissable !== false) { close(); return; }
			if (e.key !== 'Tab') return;
			var f = focusables();
			if (!f.length) { e.preventDefault(); return; }   // nothing tabbable: keep focus parked
			var idx = f.indexOf(document.activeElement);
			// Wrap at both ends; focus that escaped the dialog (idx -1, e.g. the
			// user clicked the backdrop) is recaptured to the appropriate end.
			if (e.shiftKey) {
				if (idx <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
			} else if (idx === -1 || idx === f.length - 1) {
				e.preventDefault(); f[0].focus();
			}
		}
		document.addEventListener('keydown', onKey);
		document.body.appendChild(backdrop);
		if (opts.onOpen) opts.onOpen(box, close);
		// Initial focus: onOpen handlers usually focus a field themselves; if
		// none did, land on the first focusable (the × close at minimum) so a
		// keyboard user starts inside the dialog, not on the page behind it.
		if (!box.contains(document.activeElement)) {
			var f0 = focusables();
			if (f0.length) f0[0].focus();
		}
		return { close: close, root: box, body: body };
	}

	/* ---- confirm: resolves true/false -------------------------------------- */
	// opts: { title, okLabel, cancelLabel, danger, requireType }
	// requireType (a word like 'DESTROY') gates the confirm button behind an
	// exact-match text input — for the highest blast-radius actions only.
	// `message` may be a string or a Node (blast-radius summaries build rich
	// bodies with counts + name samples); both work with and without the gate.
	function confirmDialog(message, opts) {
		opts = opts || {};
		return new Promise(function (resolve) {
			var body = message, typeInput = null;
			if (opts.requireType) {
				body = el('div');
				if (message && message.nodeType) body.appendChild(message);
				else body.appendChild(el('p', null, message)).style.marginTop = '0';
				var hint = el('p', 'muted'); hint.style.margin = '12px 0 6px';
				hint.appendChild(document.createTextNode('Type '));
				var strong = el('strong', null, opts.requireType); strong.style.color = 'var(--pnq-danger)';
				hint.appendChild(strong);
				hint.appendChild(document.createTextNode(' to confirm.'));
				body.appendChild(hint);
				typeInput = el('input', 'input'); typeInput.type = 'text';
				typeInput.setAttribute('autocomplete', 'off'); typeInput.setAttribute('autocapitalize', 'off');
				typeInput.setAttribute('aria-label', 'Type ' + opts.requireType + ' to confirm');
				body.appendChild(typeInput);
			}
			modal({
				title: opts.title || 'Confirm', body: body, dismissable: true,
				buttons: [
					{ label: opts.cancelLabel || 'Cancel', kind: 'ghost', onClick: function (c) { c(); resolve(false); } },
					{ label: opts.okLabel || 'OK', kind: opts.danger ? 'danger' : 'primary', onClick: function (c) { c(); resolve(true); } }
				],
				onOpen: function (root) {
					if (!typeInput) return;
					var okBtn = root.querySelector('.modal-foot .btn:last-child');
					if (okBtn) {
						okBtn.disabled = true;
						typeInput.addEventListener('input', function () {
							okBtn.disabled = (typeInput.value.trim() !== opts.requireType);
						});
						typeInput.addEventListener('keydown', function (e) {
							if (e.key === 'Enter' && !okBtn.disabled) { e.preventDefault(); okBtn.click(); }
						});
					}
					typeInput.focus();
				}
			});
		});
	}

	/* ---- prompt: resolves {name:value,...} or null ------------------------- */
	// opts: { title, okLabel, fields:[{name,label,value,type,placeholder,required,options}] }
	function promptDialog(opts) {
		opts = opts || {};
		var fields = opts.fields || [];
		return new Promise(function (resolve) {
			var form = el('form');
			var inputs = {};
			fields.forEach(function (f) {
				var field = el('div', 'field');
				if (f.label) field.appendChild(el('label', null, f.label));
				var inp;
				if (f.type === 'select') {
					inp = el('select', 'input');
					(f.options || []).forEach(function (o) {
						var op = el('option', null, (o.label != null ? o.label : o));
						op.value = (o.value != null ? o.value : o);
						inp.appendChild(op);
					});
				} else if (f.type === 'textarea') {
					inp = el('textarea', 'input'); inp.rows = f.rows || 3;
				} else {
					inp = el('input', 'input'); inp.type = f.type || 'text';
				}
				if (f.placeholder) inp.placeholder = f.placeholder;
				if (f.value != null) inp.value = f.value;
				inputs[f.name] = inp;
				field.appendChild(inp);
				form.appendChild(field);
			});
			var dlg = modal({
				title: opts.title || '', body: form, dismissable: true,
				buttons: [
					{ label: opts.cancelLabel || 'Cancel', kind: 'ghost', onClick: function (c) { c(); resolve(null); } },
					{ label: opts.okLabel || 'Save', kind: 'primary', onClick: function () { submit(); } }
				],
				onOpen: function () { var first = form.querySelector('input,select,textarea'); if (first) { first.focus(); if (first.select) first.select(); } }
			});
			function submit() {
				var vals = {}, ok = true;
				fields.forEach(function (f) {
					var v = inputs[f.name].value;
					inputs[f.name].classList.remove('invalid');
					if (f.required && !String(v).trim()) { ok = false; inputs[f.name].classList.add('invalid'); }
					vals[f.name] = v;
				});
				if (!ok) return;
				dlg.close(); resolve(vals);
			}
			form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
		});
	}

	/* ---- persistent batch-result report ------------------------------------ */
	// A toast is right for an all-good batch, but failures used to vanish with
	// it — 3.6 seconds is not enough to read (let alone act on) "3 could not be
	// deleted". This reuses the .import-progress panel chrome but has NO
	// self-remove timer: the user closes it manually, so the per-item error
	// text survives. Callers show it ONLY when a batch had failures.
	// results: [{name, ok, error}] — error text shown on failed rows.
	function batchReport(title, results) {
		var panel = el('div', 'import-progress batch-report');
		var head = el('div', 'import-progress-title');
		head.appendChild(el('i', 'fa fa-exclamation-circle'));
		head.appendChild(document.createTextNode(' ' + title));
		panel.appendChild(head);
		var list = el('div', 'batch-report-list');
		results.forEach(function (r) {
			var row = el('div', 'batch-report-row' + (r.ok ? '' : ' is-fail'));
			row.appendChild(el('i', 'fa ' + (r.ok ? 'fa-check-circle' : 'fa-times-circle')));
			row.appendChild(el('span', 'batch-report-name', r.name));
			row.appendChild(el('span', 'muted', r.ok ? 'succeeded' : (r.error || 'failed')));
			list.appendChild(row);
		});
		panel.appendChild(list);
		var foot = el('div', 'batch-report-foot');
		var x = el('button', 'btn btn-sm btn-ghost', 'Close'); x.type = 'button';
		x.addEventListener('click', function () { panel.remove(); });
		foot.appendChild(x);
		panel.appendChild(foot);
		document.body.appendChild(panel);
		return panel;
	}

	/* ---- map backend error codes to friendly text -------------------------- */
	var ERRORS = {
		error_lab_running: 'The lab is open — close its session in the topology editor first.',
		error_folder_running: 'The folder contains an open lab — close it first.',
		error_lab_exist: 'A lab with that name already exists here.',
		error_folder_exist: 'A folder with that name already exists here.',
		error_folder_workspace: 'This folder contains a role\'s workspace folder — change or delete that role first.'
	};
	function errMsg(body) {
		if (!body) return 'Operation failed.';
		var m = body.message || '';
		return ERRORS[m] || m || 'Operation failed.';
	}

	/* ---- view registration (each js module registers itself) --------------- */
	function register(key, def) { App.routes[key] = def; }

	/* placeholder shown for any route whose module hasn't loaded yet */
	function placeholder(view, def) {
		var card = el('div', 'card');
		card.appendChild(el('div', 'card-title', def.title));
		card.appendChild(el('p', 'muted', 'This section is on its way.'));
		view.appendChild(card);
	}

	/* ---- routing ----------------------------------------------------------- */
	function currentKey() {
		var hKey = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
		return App.routes[hKey] ? hKey : 'labs';
	}
	function navigate() {
		var key = currentKey();
		var def = App.routes[key] || { title: key, render: placeholder };
		// admin-only guard
		if (def.admin && !App.isAdmin) { App.go('labs'); return; }
		document.querySelectorAll('.nav-item[data-route]').forEach(function (a) {
			a.classList.toggle('active', a.getAttribute('data-route') === key);
		});
		var sv = document.querySelector('.sidebar-version');
		if (sv) sv.classList.toggle('active', key === 'version');
		var previous = App.routes[App.currentRoute];
		if (previous && typeof previous.destroy === 'function') {
			try { previous.destroy(); } catch (e) { /* a stale island must not block routing */ }
		}
		var view = document.getElementById('view');
		view.innerHTML = '';
		App.currentRoute = key;
		(def.render || placeholder)(view, def);
	}

	/* ---- shell wiring ------------------------------------------------------ */
	function applyUser() {
		var u = App.user || {};
		document.querySelectorAll('[data-bind="username"]').forEach(function (n) {
			n.textContent = u.username || u.email || 'user';
		});
		document.querySelectorAll('.nav-item[data-admin="1"]').forEach(function (a) {
			a.style.display = App.isAdmin ? '' : 'none';
		});
		document.querySelectorAll('.nav-group[data-nav-group]').forEach(function (group) {
			var items = group.querySelectorAll('.nav-item[data-route]');
			var visible = Array.prototype.some.call(items, function (item) { return item.style.display !== 'none'; });
			group.style.display = visible ? '' : 'none';
		});
	}
	function logout() {
		fetch('/api/auth/logout', { credentials: 'same-origin' })
			.then(function () { location.href = LOGIN_URL; })
			.catch(function () { location.href = LOGIN_URL; });
	}
	/* ---- change own password ----------------------------------------------- */
	// Any authenticated user can change their own password. POSTs to the engine
	// users module (users/api.php?action=change_password), which re-checks the
	// old hash and writes sha256(new) keyed on the caller's authenticated pod.
	function changePassword() {
		promptDialog({
			title: 'Change password', okLabel: 'Update',
			fields: [
				{ name: 'old_pass', label: 'Current password', type: 'password', required: true },
				{ name: 'new_pass', label: 'New password', type: 'password', required: true },
				{ name: 'confirm', label: 'Confirm new password', type: 'password', required: true }
			]
		}).then(function (vals) {
			if (!vals) return;
			if (vals.new_pass !== vals.confirm) { toast('New passwords do not match.', 'error'); return; }
			loading(true);
			api('/users/api.php?action=change_password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ old_pass: vals.old_pass, new_pass: vals.new_pass })
			}).then(function (res) {
				loading(false);
				if (res.status === 200 && res.body && res.body.status === 'success') {
					toast('Password changed.', 'ok');
				} else {
					toast((res.body && res.body.message) || 'Could not change the password.', 'error');
				}
			}).catch(function () { loading(false); toast('Could not change the password.', 'error'); });
		});
	}
	function bindEvents() {
		document.addEventListener('click', function (e) {
			if (e.target.closest('[data-action="logout"]')) { e.preventDefault(); logout(); return; }
			if (e.target.closest('[data-action="passwd"]')) { e.preventDefault(); changePassword(); return; }
		});
		window.addEventListener('hashchange', navigate);
	}

	/* ---- boot -------------------------------------------------------------- */
	function boot() {
		bindEvents();
		api('/api/auth').then(function (res) {
			if (res.status !== 200 || !res.body || !res.body.data) { location.href = LOGIN_URL; return; }
			App.user = res.body.data;
			var role = String(App.user.role);
			App.isAdmin = (role === '0' || role.toLowerCase() === 'admin');
			App.lang = (App.user.lang && App.user.lang.data) ? App.user.lang.data : {};
			applyUser();
			// version header (reused by the Version view via App.version)
			api('/status/api.php?action=version').then(function (r) {
				App.version = (r.body && r.body.data) || {};
				renderVersionLine();
			}).catch(function () {});
			// Branding is independent of auth (public endpoint) but painted here
			// so the shell swaps name+logo in one pass with the user data.
			applyBranding();
			document.getElementById('app').classList.remove('is-loading');
			var b = document.getElementById('boot'); if (b) b.remove();
			if (!location.hash) location.hash = '#/labs';
			navigate();
		}).catch(function () { /* 401 already redirected */ });
	}

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
	else boot();
})();
