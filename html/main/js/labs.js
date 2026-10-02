/* Route bridge only: Labs UI and state rendering are owned by the Svelte island. */
(function () {
	'use strict';
	var App = window.PnqApp;
	var destroyLabs = null;

	App.register('labs', {
		title: 'Labs', icon: 'fa-sitemap',
		render: function (view) {
			if (!window.PnqLabsWorkspace || typeof window.PnqLabsWorkspace.mount !== 'function') {
				var message = document.createElement('p');
				message.className = 'pnq-labs__boot-error';
				message.textContent = 'The Labs workspace is unavailable. Refresh the page to try again.';
				view.appendChild(message);
				return;
			}
			destroyLabs = window.PnqLabsWorkspace.mount(view);
		},
		destroy: function () {
			if (destroyLabs) destroyLabs();
			destroyLabs = null;
		}
	});
})();
