/* ============================================================================
   pnq-branding-boot.js — lab-page branding bootstrap.
   The /main/ dashboard drives branding from its own shell (dashboard.js), and
   the login page from login.js. The lab page has no shell controller, so this
   tiny classic script does the same job: fetch once, paint the marked nodes,
   and cache the result on window.PNQ_BRANDING for the left-pane renderer
   (themes/default/js/functions/status/render.js), which builds its markup as a
   template literal long after this resolves.

   Classic script, sloppy-mode-safe (the lab page's legacy scripts rely on
   implicit globals; see functions-js-decomp notes). Never throws — a failed
   fetch simply leaves the stock markup already in the HTML.
   ============================================================================ */
(function () {
	if (!window.PnqBranding) return;
	// Seed a default synchronously so a renderer that runs BEFORE the fetch
	// resolves still gets a usable URL (the endpoint serves the stock logo when
	// no custom one exists, so the default URL is always correct).
	window.PNQ_BRANDING = window.PnqBranding.defaults;
	window.PnqBranding.load().then(function (cfg) {
		window.PNQ_BRANDING = cfg;
		window.PnqBranding.apply(cfg);
		// Left pane may already be painted (its logo <img> carries data-brand-logo,
		// so apply() above re-stamps it with the cache token either way).
	});
})();
