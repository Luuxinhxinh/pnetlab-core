/* ============================================================================
   pnq-default.js — engine-side replacement for the retired Laravel store
   /store/public/assets/js/default.js (Phase C store decommission, item C5).

   Contains the load-bearing globals that engine pages consume, copied
   faithfully from the store default.js, plus the topology auth-expiry guard:
     lang           (267 call sites / 16 files)
     get / isset    (get: 23 files; isset: get's dependency + direct use)
     output_secure  (media/text-pictures.js)
     addClass / rmClass (actions.js)
     makeId         (pnetlab-line.js, guarded)
     the delegated '.modal' click handler (keeps body scroll-lock consistent
       when a Bootstrap modal opens — tiny, and the theme is modal-heavy)

   DROPPED as dead-for-engine (0 engine consumers): HtmlEncode, HtmlDecode,
   str_limit, clean_string, active_menu, highlight, toggle_class, create_key,
   count, sleep, scroll_to, clearNumber, formatNumber, MD5 (+helpers),
   file_public, and the /store/public/admin/default/refreshToken window.onload
   poll (store-circular — the store is gone).

   Classic <script> (NOT type=module): keeps sloppy-mode implicit-global
   semantics that the legacy engine JS relies on.
   ============================================================================ */

/* ---- authentication expiry guard -----------------------------------------
   The topology shell is deliberately a static page, so Apache can still serve
   it after the token cookie expires.  API calls then return 401/412 while the
   canvas (and any feature waiting on a fetch) remains mounted.  Catch both
   fetch and XMLHttpRequest responses here, before feature code can turn an
   auth failure into an apparently stuck spinner.  The redirect is delegated
   to core/dom.js when it has loaded; the small fallback keeps this guard useful
   during early module startup as well. */
(function installAuthExpiryGuard() {
	function returnPath() {
		var l = window.location || {};
		return (l.pathname || '/') + (l.search || '');
	}
	function redirectToLogin() {
		// Let the full topology helper own the redirect when core/dom.js has
		// loaded.  It has its own idempotence flag, so do this before setting
		// that flag in the early-startup fallback below.
		if (typeof window.pnqRedirectToLogin === 'function' &&
			window.pnqRedirectToLogin !== redirectToLogin) {
			window.pnqRedirectToLogin();
			return;
		}
		if (window.__pnqLoginRedirecting) return;
		window.__pnqLoginRedirecting = true;
		if (String((window.location && window.location.pathname) || '').indexOf('/login/') === 0) return;
		var target = '/login/?link=' + encodeURIComponent(returnPath());
		if (window.location) window.location.href = target;
	}
	function authResponse(status) {
		if (status === 401 || status === 412) redirectToLogin();
	}

	window.pnqAuthExpired = redirectToLogin;

	if (typeof window.fetch === 'function' && !window.fetch.__pnqAuthExpiryGuard) {
		var nativeFetch = window.fetch;
		var guardedFetch = function () {
			return nativeFetch.apply(this, arguments).then(function (response) {
				if (response) authResponse(response.status);
				return response;
			});
		};
		guardedFetch.__pnqAuthExpiryGuard = true;
		window.fetch = guardedFetch;
	}

	if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype &&
		!XMLHttpRequest.prototype.__pnqAuthExpiryGuard) {
		var nativeSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.send = function () {
			// The prototype carries the install marker below, so use an own
			// per-instance marker here; checking the same property would see the
			// inherited prototype value and never attach the loadend listener.
			if (!Object.prototype.hasOwnProperty.call(this, '__pnqAuthExpiryBound')) {
				this.__pnqAuthExpiryBound = true;
				this.addEventListener('loadend', function () {
					authResponse(this.status);
				});
			}
			return nativeSend.apply(this, arguments);
		};
		XMLHttpRequest.prototype.__pnqAuthExpiryGuard = true;
	}
}());

function isset(obj) {
	if (typeof (obj) == 'undefined' || obj == null) {
		return false;
	}
	return true;
}

function get(obj, def) {
	if (isset(obj)) {
		return obj;
	} else {
		return def;
	}
}

function output_secure(string) {
	return string.replace('/<\/?script>?/gmi', '');
}

function addClass(element, className) {

	var classes = element.className.split(" ");
	var i = classes.indexOf(className);
	if (i < 0) {

		classes.push(className);
	}
	element.className = classes.join(" ");

}

function rmClass(element, className) {


	var classes = element.className.split(" ");
	var i = classes.indexOf(className);
	if (i >= 0) {
		classes.splice(i, 1);
	}
	element.className = classes.join(" ");

}

function makeId(min, max) {
	if (typeof max == 'undefined') max = 999;
	if (typeof min == 'undefined') min = 100;
	return Date.now() + '' + (Math.floor(Math.random() * (max - min + 1)) + min);
}

function lang(string, variables = null) {
	var translate = string;
	var data = get(LANG['data'], {});
	if (typeof (data[string]) != 'undefined') {
		translate = data[string]
	}
	if (typeof variables == 'string') variables = { data: variables };
	if (typeof variables == 'object') {
		for (let i in variables) {
			translate = translate.replace(new RegExp('\{' + i + '\}', 'g'), lang(variables[i]))
		}
	}
	return translate;
}

window.onload = function () {
	$(document).on('click', '.modal', function () {
		$('body').addClass('modal-open');
	});
};
