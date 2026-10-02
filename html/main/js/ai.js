/* ============================================================================
   PNetLab dashboard — AI / MCP server view (admin-only, Phase P1)
   Talks to the engine shim mcp/api.php (token-cookie auth, broker-mediated):
     GET  ?action=status      service active/enabled + bind/port
     GET  ?action=health      listener reachable
     GET  ?action=settings    redacted config (tokens by name, no secrets)
     POST ?action=service     {state:bool}   enable+start / stop+disable
     POST ?action=settings    {bind,port}
     POST ?action=token_new   {name,pod}  -> plaintext token (shown once)
     POST ?action=token_del   {name}
   The MCP server exposes the lab-build tool surface to external MCP clients
   (Claude Desktop/Code, etc.) over Streamable-HTTP, authenticated with the
   bearer access-tokens minted here. Disabled by default.
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
	function kv(k, v) {
		var r = el('div', 'kv');
		r.appendChild(el('span', 'k', k));
		r.appendChild(el('span', 'v', v));
		return r;
	}
	function fmtDate(epoch) {
		if (!epoch) return '—';
		try { return new Date(epoch * 1000).toLocaleString(); } catch (e) { return String(epoch); }
	}

	function render(view) {
		var head = el('div', 'view-head');
		head.appendChild(viewTitle('AI / MCP server', 'fa-magic'));
		var refresh = el('button', 'btn btn-ghost'); refresh.type = 'button';
		refresh.appendChild(el('i', 'fa fa-refresh'));
		refresh.appendChild(document.createTextNode(' Refresh'));
		refresh.addEventListener('click', load);
		head.appendChild(refresh);
		view.appendChild(head);

		var svc = el('div', 'card'); svc.id = 'mcp-svc';
		svc.appendChild(el('div', 'card-title', 'MCP service'));
		svc.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(svc);

		var ep = el('div', 'card'); ep.id = 'mcp-endpoint';
		ep.appendChild(el('div', 'card-title', 'Endpoint'));
		ep.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(ep);

		var prov = el('div', 'card'); prov.id = 'mcp-provider';
		prov.appendChild(el('div', 'card-title', 'Provider (in-app agent)'));
		prov.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(prov);

		var roles = el('div', 'card'); roles.id = 'mcp-roles';
		roles.appendChild(el('div', 'card-title', 'Allowed roles'));
		roles.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(roles);

		var tok = el('div', 'card'); tok.id = 'mcp-tokens';
		tok.appendChild(el('div', 'card-title', 'Access tokens'));
		tok.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(tok);

		var usg = el('div', 'card'); usg.id = 'mcp-usage';
		usg.appendChild(el('div', 'card-title', 'Token usage'));
		usg.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(usg);

		load();
	}

	function load() {
		Promise.all([
			App.api('/mcp/api.php?action=status'),
			App.api('/mcp/api.php?action=settings'),
			App.api('/mcp/api.php?action=usage')
		]).then(function (r) {
			var st = (r[0].body && r[0].body.data) || {};
			var cfg = (r[1].body && r[1].body.data) || {};
			var usage = (r[2].body && r[2].body.data) || {};
			renderService(st);
			renderEndpoint(st);
			renderProvider((cfg.provider) || {}, (cfg.limits) || {});
			renderAllowedRoles((cfg.limits && cfg.limits.ai_allowed_roles) || []);
			renderTokens((cfg.mcp && cfg.mcp.tokens) || []);
			renderUsage(usage);
		}).catch(function () { App.toast('Could not load MCP status', 'error'); });
	}

	/* ---- service card: enable/disable toggle + status + health -------------- */
	function renderService(st) {
		var c = document.getElementById('mcp-svc'); if (!c) return;
		c.innerHTML = '';
		c.appendChild(el('div', 'card-title', 'MCP service'));

		var row = el('div', 'kv');
		row.appendChild(el('span', 'k', 'Server'));
		var right = el('span', 'v');
		var badge = el('span', 'badge ' + (st.active ? 'badge-ok' : 'badge-off'),
			st.active ? 'running' : (st.active_state || 'stopped'));
		right.appendChild(badge);
		var sw = el('label', 'switch'); sw.style.marginLeft = '10px';
		var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!st.active;
		sw.appendChild(cb); sw.appendChild(el('span', 'slider'));
		cb.addEventListener('change', function () {
			cb.disabled = true;
			App.loading(true);
			App.api('/mcp/api.php?action=service', {
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ state: cb.checked })
			}).then(function (res) {
				App.loading(false); cb.disabled = false;
				if (res.status === 200 && res.body && res.body.ok) {
					App.toast('MCP server ' + (cb.checked ? 'enabled' : 'disabled'), 'ok');
				} else {
					App.toast((res.body && res.body.error) || 'Could not change service state', 'error');
				}
				load();
			}).catch(function () { App.loading(false); cb.disabled = false; load(); });
		});
		right.appendChild(sw);
		row.appendChild(right);
		c.appendChild(row);

		c.appendChild(kv('Boot start', st.enabled || '—'));
		c.appendChild(kv('Bind', (st.bind || '127.0.0.1') + ':' + (st.port || 5701)));

		var actions = el('div'); actions.style.cssText = 'margin-top:10px;display:flex;gap:10px;flex-wrap:wrap';
		var health = el('button', 'btn btn-ghost'); health.type = 'button';
		health.appendChild(el('i', 'fa fa-heartbeat'));
		health.appendChild(document.createTextNode(' Health check'));
		health.addEventListener('click', function () {
			health.disabled = true;
			App.api('/mcp/api.php?action=health').then(function (res) {
				health.disabled = false;
				var d = (res.body && res.body.data) || {};
				App.toast('Listener ' + (d.listening ? 'reachable' : 'NOT reachable') +
					' · unit ' + (d.active ? 'active' : 'inactive'), d.listening ? 'ok' : 'error');
			}).catch(function () { health.disabled = false; App.toast('Health probe failed', 'error'); });
		});
		actions.appendChild(health);
		c.appendChild(actions);

		if (st.bind === '0.0.0.0') {
			var warn = el('p', 'muted'); warn.style.marginTop = '8px';
			warn.textContent = 'Bound to all interfaces — expose only behind an nginx/TLS reverse proxy. Every external request still needs a bearer access token.';
			c.appendChild(warn);
		}
	}

	/* ---- endpoint card: bind/port editor + connect URL --------------------- */
	function renderEndpoint(st) {
		var c = document.getElementById('mcp-endpoint'); if (!c) return;
		c.innerHTML = '';
		c.appendChild(el('div', 'card-title', 'Endpoint'));

		var url = 'http://' + (st.bind === '0.0.0.0' ? window.location.hostname : (st.bind || '127.0.0.1')) +
			':' + (st.port || 5701) + '/mcp';
		c.appendChild(el('p', 'muted', 'External MCP clients (Claude Desktop/Code, any MCP client) connect over Streamable-HTTP and authenticate with a bearer access token:'));
		var urlBox = el('div', 'kv'); urlBox.appendChild(el('span', 'k', 'URL'));
		var u = el('span', 'v'); u.appendChild(el('code', null, url)); urlBox.appendChild(u);
		c.appendChild(urlBox);

		var edit = el('button', 'btn btn-ghost'); edit.type = 'button';
		edit.appendChild(el('i', 'fa fa-pencil'));
		edit.appendChild(document.createTextNode(' Change bind / port'));
		edit.style.marginTop = '10px';
		edit.addEventListener('click', function () {
			App.prompt({
				title: 'MCP endpoint',
				okLabel: 'Save',
				fields: [
					{ name: 'bind', label: 'Bind address', type: 'select', value: st.bind || '127.0.0.1',
						options: [
							{ label: '127.0.0.1 (local only)', value: '127.0.0.1' },
							{ label: '0.0.0.0 (all interfaces — TLS proxy!)', value: '0.0.0.0' }
						] },
					{ name: 'port', label: 'Port', type: 'number', value: st.port || 5701, required: true }
				]
			}).then(function (vals) {
				if (!vals) return;
				App.api('/mcp/api.php?action=settings', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ bind: vals.bind, port: parseInt(vals.port, 10) })
				}).then(function (res) {
					if (res.status === 200 && res.body && res.body.ok) {
						App.toast('Endpoint saved — restart the server to apply', 'ok');
					} else {
						App.toast((res.body && res.body.error) || 'Could not save endpoint', 'error');
					}
					load();
				});
			});
		});
		c.appendChild(edit);
	}

	/* ---- provider card: the in-app agent's LLM (one appliance-wide key) ----- */
	// Named base_url presets for the OpenAI-compatible / open-weight path. The
	// agent talks OpenAI chat-completions to any of these; pick a tool-calling
	// model or the build loop can only plan, not execute.
	var LOCAL_PRESETS = [
		{ label: 'Ollama (local)', url: 'http://127.0.0.1:11434/v1' },
		{ label: 'vLLM (local)', url: 'http://127.0.0.1:8000/v1' },
		{ label: 'LM Studio (local)', url: 'http://127.0.0.1:1234/v1' }
	];
	function providerLabel(p) {
		return ({ anthropic: 'Anthropic (Claude)', openai: 'OpenAI',
			azure: 'Azure OpenAI', local: 'Open-weight / OpenAI-compatible' })[p] || p || '—';
	}

	function renderProvider(p, limits) {
		var c = document.getElementById('mcp-provider'); if (!c) return;
		limits = limits || {};
		c.innerHTML = '';
		c.appendChild(el('div', 'card-title', 'Provider (in-app agent)'));
		c.appendChild(el('p', 'muted', 'The lab-view AI Lab Builder uses this provider with one ' +
			'appliance-wide key. External MCP clients bring their own model and ignore this.'));

		var prov = p.provider || 'anthropic';
		c.appendChild(kv('Provider', providerLabel(prov)));
		c.appendChild(kv('Model', p.model || '—'));
		c.appendChild(kv('Base URL', p.base_url || (prov === 'anthropic' ? '(Anthropic default)' : '—')));
		var keyNeeded = (prov !== 'local');
		c.appendChild(kv('API key', p.api_key_set ? 'set' : (keyNeeded ? 'NOT set — required' : 'not needed (local)')));
		var cap = parseInt(limits.per_user_daily_tokens, 10) || 0;
		c.appendChild(kv('Daily token cap (per user)',
			cap ? (cap.toLocaleString() + ' tokens/day') : 'unlimited'));

		if (prov === 'local') {
			var note = el('p', 'muted'); note.style.marginTop = '6px';
			note.innerHTML = 'Open-weight path: point Base URL at any server speaking the OpenAI ' +
				'chat-completions API on your LAN (Ollama <code>:11434/v1</code>, vLLM ' +
				'<code>:8000/v1</code>, LM Studio <code>:1234/v1</code>) — fully offline, no key. ' +
				'Choose a <b>tool-calling</b> model (e.g. Qwen2.5/3-Instruct, Llama-3.1+, Mistral) ' +
				'or the agent can only plan, not build.';
			c.appendChild(note);
		}

		var actions = el('div'); actions.style.cssText = 'margin-top:10px;display:flex;gap:10px;flex-wrap:wrap';
		var cfgBtn = el('button', 'btn btn-primary'); cfgBtn.type = 'button';
		cfgBtn.appendChild(el('i', 'fa fa-sliders'));
		cfgBtn.appendChild(document.createTextNode(' Configure provider'));
		cfgBtn.addEventListener('click', function () { configureProvider(p, limits); });
		actions.appendChild(cfgBtn);

		if (p.api_key_set) {
			var clr = el('button', 'btn btn-ghost'); clr.type = 'button';
			clr.appendChild(el('i', 'fa fa-eraser'));
			clr.appendChild(document.createTextNode(' Clear key'));
			clr.addEventListener('click', function () {
				App.confirm('Clear the stored API key?', { danger: true, okLabel: 'Clear' }).then(function (yes) {
					if (!yes) return;
					saveProvider({ clear_api_key: 1 });
				});
			});
			actions.appendChild(clr);
		}
		c.appendChild(actions);
	}

	function configureProvider(p, limits) {
		limits = limits || {};
		var curCap = parseInt(limits.per_user_daily_tokens, 10) || 0;
		App.prompt({
			title: 'AI provider',
			okLabel: 'Save',
			fields: [
				{ name: 'provider', label: 'Provider', type: 'select', value: p.provider || 'anthropic',
					options: [
						{ label: 'Anthropic (Claude)', value: 'anthropic' },
						{ label: 'OpenAI', value: 'openai' },
						{ label: 'Azure OpenAI', value: 'azure' },
						{ label: 'Open-weight / OpenAI-compatible (Ollama, vLLM, LM Studio)', value: 'local' }
					] },
				{ name: 'model', label: 'Model', type: 'text', value: p.model || 'claude-opus-4-8',
					placeholder: 'claude-opus-4-8 · gpt-4o · qwen2.5:32b · llama3.1:70b' },
				{ name: 'base_url', label: 'Base URL (OpenAI-compatible / local only)', type: 'text',
					value: p.base_url || '',
					placeholder: 'Ollama http://host:11434/v1 · vLLM http://host:8000/v1 · LM Studio http://host:1234/v1' },
				{ name: 'api_key', label: 'API key (blank = keep current; not needed for local)', type: 'text',
					value: '', placeholder: p.api_key_set ? '•••••• stored' : 'sk-… / leave blank for local' },
				{ name: 'per_user_daily_tokens', label: 'Daily token cap per user (0 = unlimited)', type: 'number',
					value: String(curCap),
					placeholder: 'e.g. 200000 — one build can use 150–200k; 0 disables the cap' }
			]
		}).then(function (vals) {
			if (!vals) return;
			var args = { provider: vals.provider, model: (vals.model || '').trim(),
				base_url: (vals.base_url || '').trim() };
			if (vals.api_key && vals.api_key.trim()) args.api_key = vals.api_key.trim();
			var capRaw = (vals.per_user_daily_tokens == null) ? '' : String(vals.per_user_daily_tokens).trim();
			if (capRaw !== '') {
				var cap = parseInt(capRaw, 10);
				if (isNaN(cap) || cap < 0) { App.toast('Daily token cap must be 0 or a positive number', 'error'); return; }
				args.per_user_daily_tokens = cap;
			}
			saveProvider(args);
		});
	}

	function saveProvider(args) {
		App.loading(true);
		App.api('/mcp/api.php?action=settings', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(args)
		}).then(function (res) {
			App.loading(false);
			if (res.status === 200 && res.body && res.body.ok) {
				App.toast('Provider saved (applied on the next build — no restart needed)', 'ok');
			} else {
				App.toast((res.body && res.body.error) || 'Could not save provider', 'error');
			}
			load();
		}).catch(function () { App.loading(false); load(); });
	}

	/* ---- allowed-roles card: which roles may open the AI Lab Builder pane -- */
	// Admin (role '0') is always allowed implicitly and is never stored in the list.
	// Custom roles come from /users/api.php?action=roles → [{id, name, …}].
	// The save POSTs ai_allowed_roles (array of role-id strings) to mcp/api.php?action=settings.
	function renderAllowedRoles(allowedRoles) {
		var c = document.getElementById('mcp-roles'); if (!c) return;
		allowedRoles = allowedRoles || [];
		c.innerHTML = '';
		c.appendChild(el('div', 'card-title', 'Allowed roles'));
		c.appendChild(el('p', 'muted',
			'Which user roles may open the in-app AI Lab Builder. ' +
			'Admin is always allowed. Default (empty list) = admins only.'));

		App.api('/users/api.php?action=roles').then(function (r) {
			var roleList = (r.body && r.body.data) || [];
			c.innerHTML = '';
			c.appendChild(el('div', 'card-title', 'Allowed roles'));
			c.appendChild(el('p', 'muted',
				'Which user roles may open the in-app AI Lab Builder. ' +
				'Admin is always allowed. Default (empty list) = admins only.'));

			// Admin row — always checked, disabled (never stored in the list).
			var adminRow = el('div', 'kv'); adminRow.style.cssText = 'align-items:center;gap:8px';
			var adminLabel = el('label'); adminLabel.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:default;opacity:.6';
			var adminCb = el('input'); adminCb.type = 'checkbox'; adminCb.checked = true; adminCb.disabled = true;
			adminLabel.appendChild(adminCb);
			adminLabel.appendChild(document.createTextNode('Admin (always allowed)'));
			adminRow.appendChild(adminLabel);
			c.appendChild(adminRow);

			// One checkbox per custom role.
			var checkboxes = [];
			roleList.forEach(function (r) {
				var rid = String(r.id);
				var row = el('div', 'kv'); row.style.cssText = 'align-items:center;gap:8px';
				var lbl = el('label'); lbl.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer';
				var cb = el('input'); cb.type = 'checkbox';
				cb.value = rid;
				cb.checked = (allowedRoles.indexOf(rid) !== -1);
				lbl.appendChild(cb);
				lbl.appendChild(document.createTextNode(r.name));
				row.appendChild(lbl);
				c.appendChild(row);
				checkboxes.push(cb);
			});

			if (!roleList.length) {
				c.appendChild(el('p', 'muted', 'No custom roles defined — only admins can access the AI Lab Builder.'));
			}

			var actions = el('div'); actions.style.cssText = 'margin-top:10px;display:flex;gap:10px;flex-wrap:wrap';
			var saveBtn = el('button', 'btn btn-primary'); saveBtn.type = 'button';
			saveBtn.appendChild(el('i', 'fa fa-save'));
			saveBtn.appendChild(document.createTextNode(' Save'));
			saveBtn.addEventListener('click', function () {
				var selected = [];
				checkboxes.forEach(function (cb) {
					if (cb.checked) selected.push(cb.value);
				});
				saveBtn.disabled = true;
				App.loading(true);
				App.api('/mcp/api.php?action=settings', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ai_allowed_roles: selected })
				}).then(function (res) {
					App.loading(false);
					saveBtn.disabled = false;
					if (res.status === 200 && res.body && res.body.ok) {
						App.toast('Allowed roles saved', 'ok');
					} else {
						App.toast((res.body && res.body.error) || 'Could not save allowed roles', 'error');
					}
					load();
				}).catch(function () { App.loading(false); saveBtn.disabled = false; load(); });
			});
			actions.appendChild(saveBtn);
			c.appendChild(actions);
		}).catch(function () {
			c.innerHTML = '';
			c.appendChild(el('div', 'card-title', 'Allowed roles'));
			c.appendChild(el('p', 'muted', 'Could not load roles.'));
		});
	}

	/* ---- tokens card: list + generate (shown once) + delete ---------------- */
	/* ---- usage card: per-day AI token totals + the per-user daily cap ------- */
	function renderUsage(u) {
		var c = document.getElementById('mcp-usage'); if (!c) return;
		c.innerHTML = '';
		c.appendChild(el('div', 'card-title', 'Token usage'));

		var cap = (u && u.per_user_daily_cap) ? u.per_user_daily_cap : 0;
		c.appendChild(kv('Per-user daily cap',
			cap ? (cap.toLocaleString() + ' tokens') : 'unlimited'));
		c.appendChild(el('p', 'muted', 'Totals count NET (billed) tokens — the cached ' +
			'share of each request is not charged against the cap.'));

		var byDay = (u && u.by_day) || {};
		var days = Object.keys(byDay).sort().reverse().slice(0, 7);
		if (!days.length) {
			c.appendChild(el('p', 'muted', 'No AI build activity recorded yet.'));
			return;
		}
		c.appendChild(kv('Today (' + (u.today || '') + ')',
			((byDay[u.today] || 0)).toLocaleString() + ' tokens (all users)'));
		var hist = el('div'); hist.style.cssText = 'margin-top:8px';
		hist.appendChild(el('p', 'muted', 'Recent daily totals (all users):'));
		days.forEach(function (d) {
			hist.appendChild(kv(d, (byDay[d] || 0).toLocaleString()));
		});
		c.appendChild(hist);
	}

	function renderTokens(tokens) {
		var c = document.getElementById('mcp-tokens'); if (!c) return;
		c.innerHTML = '';
		var title = el('div', 'card-title', 'Access tokens');
		c.appendChild(title);

		if (!tokens.length) {
			c.appendChild(el('p', 'muted', 'No access tokens yet. Generate one for each external MCP client.'));
		} else {
			tokens.forEach(function (t) {
				var r = el('div', 'kv');
				r.appendChild(el('span', 'k', t.name + '  ·  pod ' + t.pod));
				var v = el('span', 'v');
				v.appendChild(el('span', 'muted', fmtDate(t.created)));
				var del = el('button', 'btn btn-ghost btn-sm'); del.type = 'button'; del.style.marginLeft = '10px';
				del.appendChild(el('i', 'fa fa-trash'));
				del.addEventListener('click', function () {
					App.confirm('Revoke access token "' + t.name + '"? Any client using it will stop working.',
						{ danger: true, okLabel: 'Revoke' }).then(function (yes) {
						if (!yes) return;
						App.api('/mcp/api.php?action=token_del', {
							method: 'POST', headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ name: t.name })
						}).then(function (res) {
							if (res.status === 200 && res.body && res.body.ok) App.toast('Token revoked', 'ok');
							else App.toast((res.body && res.body.error) || 'Could not revoke', 'error');
							load();
						});
					});
				});
				v.appendChild(del);
				r.appendChild(v);
				c.appendChild(r);
			});
		}

		var gen = el('button', 'btn btn-primary'); gen.type = 'button'; gen.style.marginTop = '10px';
		gen.appendChild(el('i', 'fa fa-plus'));
		gen.appendChild(document.createTextNode(' Generate token'));
		gen.addEventListener('click', function () {
			App.prompt({
				title: 'New access token',
				okLabel: 'Generate',
				fields: [
					{ name: 'name', label: 'Name (which client)', type: 'text', required: true, placeholder: 'e.g. Claude Desktop' },
					{ name: 'pod', label: 'Acts as pod', type: 'number', value: 0 }
				]
			}).then(function (vals) {
				if (!vals) return;
				App.api('/mcp/api.php?action=token_new', {
					method: 'POST', headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ name: vals.name, pod: parseInt(vals.pod, 10) || 0 })
				}).then(function (res) {
					if (res.status === 200 && res.body && res.body.ok && res.body.data) {
						showToken(res.body.data.token);
						load();
					} else {
						App.toast((res.body && res.body.error) || 'Could not generate token', 'error');
					}
				});
			});
		});
		c.appendChild(gen);
	}

	function showToken(token) {
		var body = el('div');
		body.appendChild(el('p', null, 'Copy this token now — it is shown only once and stored hashed:'));
		var ta = el('textarea', 'input'); ta.rows = 2; ta.readOnly = true; ta.value = token;
		ta.style.cssText = 'width:100%;font-family:monospace';
		body.appendChild(ta);
		body.appendChild(el('p', 'muted', 'Use it as the Authorization: Bearer header from your MCP client.'));
		App.modal({
			title: 'Access token', body: body, dismissable: true,
			buttons: [
				{ label: 'Copy', kind: 'ghost', onClick: function () { ta.select(); try { document.execCommand('copy'); App.toast('Copied', 'ok'); } catch (e) {} } },
				{ label: 'Done', kind: 'primary', onClick: function (c) { c(); } }
			],
			onOpen: function () { ta.focus(); ta.select(); }
		});
	}

	App.register('ai', { title: 'AI / MCP', icon: 'fa-magic', admin: true, render: render });
})();
