/* ============================================================================
   PNetLab dashboard — Version view
   Shows component versions from status/api.php?action=version. The data is
   fetched once at boot (App.version) for the sidebar footer and reused here.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;

	function viewTitle(t, i) { var d = el('div', 'view-title'); d.appendChild(el('i', 'fa ' + i)); d.appendChild(document.createTextNode(' ' + t)); return d; }
	function kv(k, v) { var r = el('div', 'kv'); r.appendChild(el('span', 'k', k)); r.appendChild(el('span', 'v', v || '—')); return r; }

	function render(view) {
		var head = el('div', 'view-head'); head.appendChild(viewTitle('Version', 'fa-info-circle')); view.appendChild(head);
		var card = el('div', 'card');
		var body = el('div'); body.appendChild(el('p', 'muted', 'Loading…'));
		card.appendChild(body);
		view.appendChild(card);
		if (App.version) paint(body, App.version);
		else App.api('/status/api.php?action=version').then(function (res) { App.version = (res.body && res.body.data) || {}; paint(body, App.version); });
	}

	function paint(body, d) {
		body.innerHTML = '';
		var banner = el('div', 'ver-banner');
		/* FOR ADMINS, DELIBERATELY NOT REBRANDED. This page is the box's identity
		   card: support and diagnostics need the real product + package version, so
		   a rebranded appliance still reads "PNetLab 6.8.51" for an admin.
		   Non-admins get neither — status/api.php omits release/package/kernel for
		   them (all three spell out the real product), so falling back to the
		   hardcoded "PNetLab" here would leak the very name the rebrand hides.
		   Detect by what the server sent, not by a client-side role check: the API
		   is the gate, this just renders what it was given. */
		var hasIdentity = !!(d.release || d.pnetlab);
		banner.appendChild(el('div', 'ver-big', hasIdentity
			? 'PNetLab ' + (d.release || d.pnetlab)
			: App.brandName()));
		banner.appendChild(el('div', 'muted', [d.os, d.hostname].filter(Boolean).join('  ·  ')));
		body.appendChild(banner);
		if (d.release) body.appendChild(kv('Release', d.release));
		if (d.pnetlab) body.appendChild(kv('Package', d.pnetlab));
		body.appendChild(kv('Operating system', d.os));
		/* Kernel row is admin-only (uname carries a "-pnetlab" suffix), but arch is
		   not — keep showing it on its own so non-admins still see x86_64/aarch64. */
		if (d.kernel) body.appendChild(kv('Kernel', d.kernel + (d.arch ? '  (' + d.arch + ')' : '')));
		else if (d.arch) body.appendChild(kv('Architecture', d.arch));
		body.appendChild(kv('QEMU', d.qemu));
		body.appendChild(kv('Docker', d.docker));
		body.appendChild(kv('Guacamole (guacd)', d.guacd));
		body.appendChild(kv('PHP', d.php));
		body.appendChild(kv('Hostname', d.hostname));
	}

	App.register('version', { title: 'Version', icon: 'fa-info-circle', render: render });
})();
