/* ============================================================================
   PNetLab dashboard — Network view (admin)
   Edit the appliance's own network config via the engine shim status/api.php:
     GET  ?action=netcfg_get   current pnet0 mode/addr + DNS/domain
     POST ?action=netcfg_set   {mode,address,netmask,gateway,dns:[],domain,apply}
   The broker validates + backs up before writing /etc/network/interfaces and the
   systemd-resolved drop-in. Changing the management address can drop the link,
   so the apply step is opt-in and clearly warned.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;

	function viewTitle(text, icon) {
		var t = el('div', 'view-title');
		t.appendChild(el('i', 'fa ' + icon));
		t.appendChild(document.createTextNode(' ' + text));
		return t;
	}
	function field(label, inp, hint) {
		var f = el('div', 'field');
		if (label) f.appendChild(el('label', null, label));
		f.appendChild(inp);
		if (hint) f.appendChild(el('div', 'muted', hint));
		return f;
	}
	function input(id, ph) {
		var i = el('input', 'input'); i.type = 'text'; i.id = id;
		if (ph) i.placeholder = ph;
		return i;
	}
	function isIPv4(s) {
		return /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) &&
			s.split('.').every(function (o) { return +o >= 0 && +o <= 255; });
	}

	var state = { mode: 'dhcp' };

	function render(view) {
		if (!App.isAdmin) {
			view.appendChild(el('p', 'muted', 'Admin only.'));
			return;
		}
		var head = el('div', 'view-head');
		head.appendChild(viewTitle('Network', 'fa-sitemap'));
		var refresh = el('button', 'btn btn-ghost'); refresh.type = 'button';
		refresh.appendChild(el('i', 'fa fa-refresh'));
		refresh.appendChild(document.createTextNode(' Reload'));
		refresh.addEventListener('click', load);
		head.appendChild(refresh);
		view.appendChild(head);

		// warning banner (shared .alert component; was an inline-styled card)
		var warn = el('div', 'alert alert-warn');
		warn.appendChild(el('i', 'fa fa-exclamation-triangle'));
		var warnBody = el('div');
		warnBody.appendChild(el('div', 'alert-title', 'Management network'));
		warnBody.appendChild(el('div', '',
			'These settings control how this ' + App.brandName() + ' server reaches the network. ' +
			'A wrong static address or gateway can make the appliance unreachable ' +
			'until fixed from the console. The previous config is backed up before ' +
			'every change.'));
		warn.appendChild(warnBody);
		view.appendChild(warn);

		var card = el('div', 'card');
		card.appendChild(el('div', 'card-title', 'Management interface (pnet0)'));
		var body = el('div'); body.id = 'net-body';
		body.appendChild(el('p', 'muted', 'Loading…'));
		card.appendChild(body);
		view.appendChild(card);

		load();
	}

	function load() {
		var body = document.getElementById('net-body');
		if (body) { body.innerHTML = ''; body.appendChild(el('p', 'muted', 'Loading…')); }
		App.api('/status/api.php?action=netcfg_get').then(function (res) {
			var d = (res.body && res.body.data) || {};
			buildForm(d);
		}).catch(function () {
			var b = document.getElementById('net-body');
			if (b) { b.innerHTML = ''; b.appendChild(el('p', 'muted', 'Could not load network config.')); }
		});
	}

	function buildForm(d) {
		var body = document.getElementById('net-body');
		if (!body) return;
		body.innerHTML = '';
		state.mode = (d.mode === 'static') ? 'static' : 'dhcp';
		// remember the current (saved) interface config so onSave can tell whether an
		// address/mode change was made (→ needs a reboot) vs DNS-only (applies live).
		state.current = {
			mode: state.mode, address: d.address || '',
			netmask: d.netmask || '', gateway: d.gateway || ''
		};

		// mode select
		var mode = el('select', 'input'); mode.id = 'net-mode';
		[['dhcp', 'DHCP (automatic)'], ['static', 'Static (manual)']].forEach(function (o) {
			var op = el('option', null, o[1]); op.value = o[0];
			if (o[0] === state.mode) op.selected = true;
			mode.appendChild(op);
		});
		mode.addEventListener('change', function () { state.mode = mode.value; toggleStatic(); });
		body.appendChild(field('Addressing', mode));

		// static block
		var sb = el('div'); sb.id = 'net-static';
		var addr = input('net-address', '192.168.1.50'); addr.value = d.address || '';
		var mask = input('net-netmask', '255.255.255.0'); mask.value = d.netmask || '';
		var gw = input('net-gateway', '192.168.1.1'); gw.value = d.gateway || '';
		sb.appendChild(field('IP address', addr));
		sb.appendChild(field('Netmask', mask));
		sb.appendChild(field('Gateway', gw));
		body.appendChild(sb);

		// DNS + domain (apply regardless of mode)
		var dns = input('net-dns', '8.8.8.8 1.1.1.1');
		dns.value = (d.dns && d.dns.length) ? d.dns.join(' ') : '';
		body.appendChild(field('DNS servers', dns, 'Space- or comma-separated. Leave empty to use DHCP-provided DNS.'));
		var dom = input('net-domain', 'lab.example.com'); dom.value = d.domain || '';
		body.appendChild(field('Search domain', dom));

		// note: changing the IP address or mode reboots the appliance to apply (the only
		// reliable way on this box); DNS/domain edits apply live without a reboot.
		body.appendChild(el('div', 'muted',
			'Changing the IP address or addressing mode reboots the appliance to apply. ' +
			'DNS and search-domain changes apply immediately, no reboot.'));

		// save
		var saveRow = el('div'); saveRow.style.marginTop = '14px';
		var save = el('button', 'btn btn-primary'); save.type = 'button';
		save.appendChild(el('i', 'fa fa-save'));
		save.appendChild(document.createTextNode(' Save network config'));
		save.addEventListener('click', onSave);
		saveRow.appendChild(save);
		body.appendChild(saveRow);

		toggleStatic();
	}

	function toggleStatic() {
		var sb = document.getElementById('net-static');
		if (sb) sb.style.display = (state.mode === 'static') ? '' : 'none';
	}

	function val(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }

	function onSave() {
		var mode = val('net-mode');
		var payload = {
			mode: mode,
			address: val('net-address'),
			netmask: val('net-netmask'),
			gateway: val('net-gateway'),
			dns: val('net-dns').split(/[\s,]+/).filter(function (x) { return x; }),
			domain: val('net-domain'),
			apply: true   // Save always applies; an address/mode change reboots to apply
		};

		// client-side guard rails (the broker validates authoritatively)
		if (mode === 'static') {
			if (!isIPv4(payload.address)) return App.toast('Enter a valid IP address.', 'error');
			if (!isIPv4(payload.netmask)) return App.toast('Enter a valid netmask, e.g. 255.255.255.0.', 'error');
			if (!isIPv4(payload.gateway)) return App.toast('A valid gateway is required for a static address.', 'error');
		}
		for (var i = 0; i < payload.dns.length; i++) {
			if (!isIPv4(payload.dns[i])) return App.toast('DNS "' + payload.dns[i] + '" is not a valid IPv4 address.', 'error');
		}

		// Did the IP address / mode change? Only that needs a reboot to apply.
		var cur = state.current || {};
		var ifaceChanged = (mode !== cur.mode) ||
			(mode === 'static' && (payload.address !== cur.address ||
				payload.netmask !== cur.netmask || payload.gateway !== cur.gateway));

		var dest = (mode === 'static') ? 'https://' + payload.address : 'its DHCP address';
		var warn, title, okLabel;
		if (ifaceChanged) {
			title = 'Reboot to apply network change';
			okLabel = 'Save & reboot';
			warn = 'Saving will REBOOT the appliance to apply the new network settings. ' +
				'All running labs will stop and the server will be offline for about a minute, ' +
				'then come back at ' + dest + '. ' +
				(mode === 'static'
					? 'If the new address or gateway is wrong you will need console access to fix it. '
					: '') +
				'Continue?';
		} else {
			title = 'Apply DNS changes';
			okLabel = 'Apply';
			warn = 'Apply these DNS / search-domain changes now? This applies immediately — no reboot.';
		}

		App.confirm(warn, { title: title, danger: ifaceChanged, okLabel: okLabel })
			.then(function (ok) {
				if (!ok) return;
				App.loading(true);
				App.api('/status/api.php?action=netcfg_set', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload)
				}).then(function (res) {
					App.loading(false);
					if (res.status === 200 && res.body && res.body.ok) {
						var r = res.body.result || {};
						App.toast(r.rebooting
							? 'Saved — the appliance is rebooting to apply. It will be back in about ' +
							  'a minute at ' + dest + '.'
							: 'Network settings applied.', 'ok');
					} else {
						App.toast((res.body && (res.body.error || res.body.message)) || 'Save failed.', 'error');
					}
				}).catch(function () { App.loading(false); App.toast('Save request failed.', 'error'); });
			});
	}

	App.register('network', { title: 'Network', icon: 'fa-sitemap', render: render, admin: true });
})();
