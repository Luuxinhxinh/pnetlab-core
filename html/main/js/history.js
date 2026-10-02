/* ============================================================================
   PNetLab dashboard — History view (admin-only)
   Historical host telemetry charts fed by the pnq-telemetryd collector via
     GET /status/api.php?action=history_sys&range=1h|6h|24h|7d|30d
   Pure-SVG polyline charts, CSP-safe: every element is built with
   document.createElementNS / createElement — no chart library, no
   innerHTML-with-markup, no inline handlers. Auto-refreshes every 30s while
   the view is on screen; shows a "collector down" empty-state when the
   daemon is not running.
   ============================================================================ */
(function () {
	'use strict';
	var App = window.PnqApp, el = App.el;
	var SVGNS = 'http://www.w3.org/2000/svg';
	var RANGES = ['1h', '6h', '24h', '7d', '30d'];
	var range = '1h';
	var poller = null;
	var resizeHandler = null, resizeDebounce = null;
	var cachedData = {};

	function svgEl(tag, attrs) {
		var e = document.createElementNS(SVGNS, tag);
		if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
		return e;
	}
	function fmtTime(ts, span) {
		var d = new Date(ts * 1000);
		function p(n) { return (n < 10 ? '0' : '') + n; }
		if (span > 172800) return (d.getMonth() + 1) + '/' + d.getDate();
		return p(d.getHours()) + ':' + p(d.getMinutes());
	}
	function fmtMb(mb) {
		if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
		return Math.round(mb) + ' MB';
	}

	/* Polyline chart: pts = [{ts, v}], ymax fixed (e.g. 100 for %) or null
	   (auto). Returns an <svg> 100% wide via viewBox. */
	function chart(pts, opts, widthPx) {
		// Render at the container's real pixel width so the 100%-wide SVG maps
		// 1:1 (viewBox width == displayed px). A fixed 720-wide viewBox stretched
		// to fill wide panels scaled the SVG non-uniformly, distorting the <text>
		// axis labels (glyphs stretched horizontally); geometry-only elements were
		// unaffected, which is why the lines looked fine but the numbers did not.
		var W = (widthPx && widthPx > 40) ? Math.round(widthPx) : 720;
		var H = 180, padL = 44, padR = 8, padT = 10, padB = 22;
		var svg = svgEl('svg', {
			viewBox: '0 0 ' + W + ' ' + H,
			preserveAspectRatio: 'none',
			'class': 'hist-chart'
		});
		svg.style.width = '100%';
		svg.style.height = '180px';
		svg.style.display = 'block';
		if (!pts.length) return svg;

		var t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
		var span = Math.max(1, t1 - t0);
		var ymax = opts.ymax;
		if (ymax == null) {
			ymax = 0;
			pts.forEach(function (p) { if (p.v > ymax) ymax = p.v; });
			ymax = ymax > 0 ? ymax * 1.15 : 1;
		}
		var iw = W - padL - padR, ih = H - padT - padB;
		function X(ts) { return padL + (span ? (ts - t0) / span : 0) * iw; }
		function Y(v) { return padT + ih - Math.max(0, Math.min(1, v / ymax)) * ih; }

		// gridlines + y labels (4 steps)
		for (var i = 0; i <= 4; i++) {
			var yv = ymax * i / 4;
			var y = Y(yv);
			svg.appendChild(svgEl('line', {
				x1: padL, y1: y, x2: W - padR, y2: y,
				stroke: 'var(--pnq-border)', 'stroke-width': '1'
			}));
			var lab = svgEl('text', {
				x: padL - 6, y: y + 4, 'text-anchor': 'end',
				'font-size': '10', fill: 'var(--pnq-text-dim, var(--pnq-text))'
			});
			lab.textContent = opts.yfmt ? opts.yfmt(yv) : Math.round(yv);
			svg.appendChild(lab);
		}
		// x labels (5 ticks)
		for (var j = 0; j <= 4; j++) {
			var ts = t0 + span * j / 4;
			var xl = svgEl('text', {
				x: X(ts), y: H - 6,
				'text-anchor': j === 0 ? 'start' : (j === 4 ? 'end' : 'middle'),
				'font-size': '10', fill: 'var(--pnq-text-dim, var(--pnq-text))'
			});
			xl.textContent = fmtTime(ts, span);
			svg.appendChild(xl);
		}

		// area fill + line
		var line = '', area = '';
		pts.forEach(function (p, idx) {
			var pt = X(p.ts).toFixed(1) + ',' + Y(p.v).toFixed(1);
			line += (idx ? ' ' : '') + pt;
		});
		area = padL + ',' + (padT + ih) + ' ' + line + ' ' +
			X(t1).toFixed(1) + ',' + (padT + ih);
		var fill = svgEl('polygon', {
			points: area, fill: opts.color || 'var(--pnq-accent, #2f81f7)',
			'fill-opacity': '0.12', stroke: 'none'
		});
		svg.appendChild(fill);
		svg.appendChild(svgEl('polyline', {
			points: line, fill: 'none',
			stroke: opts.color || 'var(--pnq-accent, #2f81f7)',
			'stroke-width': '1.6', 'vector-effect': 'non-scaling-stroke',
			'stroke-linejoin': 'round'
		}));
		return svg;
	}

	function pane(title, sub) {
		var c = el('div', 'card');
		var head = el('div', 'card-title', title);
		c.appendChild(head);
		if (sub) c.appendChild(el('p', 'muted', sub));
		var body = el('div');
		c.appendChild(body);
		return { card: c, body: body };
	}

	function emptyState(msg) {
		var d = el('div');
		d.style.cssText = 'padding:26px;text-align:center';
		d.appendChild(el('i', 'fa fa-line-chart'));
		d.appendChild(el('p', 'muted', msg));
		return d;
	}

	var panes = null;

	function render(view) {
		stopPolling();
		var head = el('div', 'view-head vh-ruled');
		var left = el('div');
		left.style.cssText = 'display:flex;align-items:center;gap:14px;flex-wrap:wrap';
		var t = el('div', 'view-title');
		t.appendChild(el('i', 'fa fa-line-chart'));
		t.appendChild(document.createTextNode(' History'));
		left.appendChild(t);
		head.appendChild(left);

		// range selector chips
		var sel = el('div');
		sel.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
		RANGES.forEach(function (r) {
			var b = el('button', 'btn btn-ghost' + (r === range ? ' is-active' : ''));
			b.type = 'button';
			b.setAttribute('data-range', r);
			b.appendChild(document.createTextNode(r));
			if (r === range) b.style.cssText = 'border-color:var(--pnq-accent,#2f81f7);color:var(--pnq-accent,#2f81f7)';
			b.addEventListener('click', function () {
				range = r;
				if (cachedData[range]) renderData(cachedData[range]);
				load().catch(function () {});
				sel.querySelectorAll('button').forEach(function (x) {
					x.style.cssText = '';
					if (x.getAttribute('data-range') === range) {
						x.style.cssText = 'border-color:var(--pnq-accent,#2f81f7);color:var(--pnq-accent,#2f81f7)';
					}
				});
			});
			sel.appendChild(b);
		});
		head.appendChild(sel);
		view.appendChild(head);

		panes = {
			cpu:  pane('CPU', 'Host CPU utilization, percent of all cores'),
			ram:  pane('Memory', null),
			disk: pane('Disk', 'Root filesystem usage'),
		};
		panes.cpu.body.appendChild(el('p', 'muted', 'Loading…'));
		view.appendChild(panes.cpu.card);
		view.appendChild(panes.ram.card);
		view.appendChild(panes.disk.card);

		startPolling();
		// re-render on resize so charts track the panel width and stay crisp
		// (debounced; uses the fetched series, so resizing never hits the API)
		resizeHandler = function () {
			if (resizeDebounce) clearTimeout(resizeDebounce);
			resizeDebounce = setTimeout(function () {
				if (panes && document.body.contains(panes.cpu.card)) {
					if (cachedData[range]) renderData(cachedData[range]);
				} else stopPolling();
			}, 180);
		};
		window.addEventListener('resize', resizeHandler);
	}
	function startPolling() {
		stopPolling();
		poller = App.poll(load, { interval: 30000, maxInterval: 120000 });
		poller.start(true);
	}
	function stopPolling() {
		if (poller) { poller.stop(); poller = null; }
		if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
		if (resizeDebounce) { clearTimeout(resizeDebounce); resizeDebounce = null; }
	}

	function renderData(d) {
		if (!panes || !document.body.contains(panes.cpu.card)) return;
			var series = d.series || [];
			['cpu', 'ram', 'disk'].forEach(function (k) {
				while (panes[k].body.firstChild) panes[k].body.removeChild(panes[k].body.firstChild);
			});
			if (d.collector === 'down' && !series.length) {
				panes.cpu.body.appendChild(emptyState(
					'Telemetry collector is not running — no history recorded. ' +
					'Start it with: systemctl enable --now pnq-telemetryd'));
				panes.ram.body.appendChild(emptyState('No data.'));
				panes.disk.body.appendChild(emptyState('No data.'));
				return;
			}
			if (!series.length) {
				panes.cpu.body.appendChild(emptyState('No samples in this range yet.'));
				panes.ram.body.appendChild(emptyState('No data.'));
				panes.disk.body.appendChild(emptyState('No data.'));
				return;
			}
			if (d.collector === 'down') {
				var warn = el('p', 'muted', 'Collector currently down — showing recorded history.');
				warn.style.cssText = 'color:var(--pnq-danger,#d9534f)';
				panes.cpu.body.appendChild(warn);
			}
			var cpuPts = series.map(function (s) { return { ts: s.ts, v: s.cpu }; });
			var ramPts = series.map(function (s) { return { ts: s.ts, v: s.ram_used }; });
			var dskPts = series.map(function (s) { return { ts: s.ts, v: s.disk_used }; });
			var last = series[series.length - 1];
			// real panel width -> charts render 1:1 so axis labels stay crisp
			var cw = panes.cpu.body.clientWidth || panes.disk.body.clientWidth || 720;

			panes.cpu.body.appendChild(chart(cpuPts, {
				ymax: 100, color: 'var(--pnq-accent, #2f81f7)',
				yfmt: function (v) { return Math.round(v) + '%'; }
			}, cw));
			var ramSub = el('p', 'muted', 'Used ' + fmtMb(last.ram_used) + ' of ' + fmtMb(last.ram_total));
			panes.ram.body.appendChild(ramSub);
			panes.ram.body.appendChild(chart(ramPts, {
				ymax: last.ram_total || null, color: '#3fb950',
				yfmt: fmtMb
			}, cw));
			var dskSub = el('p', 'muted', 'Used ' + fmtMb(last.disk_used) + ' of ' + fmtMb(last.disk_total));
			panes.disk.body.appendChild(dskSub);
			panes.disk.body.appendChild(chart(dskPts, {
				ymax: last.disk_total || null, color: '#d29922',
				yfmt: fmtMb
			}, cw));
	}

	function load() {
		if (!panes || !document.body.contains(panes.cpu.card)) { stopPolling(); return Promise.resolve(); }
		var requestedRange = range;
		return App.api('/status/api.php?action=history_sys&range=' + requestedRange).then(function (res) {
			if (res.status !== 200) throw new Error('history request failed');
			var d = (res.body && res.body.data) || {};
			cachedData[requestedRange] = d;
			if (requestedRange === range) renderData(d);
		}).catch(function (err) {
			if (requestedRange === range && panes && document.body.contains(panes.cpu.card)) {
				while (panes.cpu.body.firstChild) panes.cpu.body.removeChild(panes.cpu.body.firstChild);
				panes.cpu.body.appendChild(emptyState('Could not load history.'));
			}
			throw err;
		});
	}

	App.register('history', { title: 'History', icon: 'fa-line-chart', admin: true, render: render });
})();
