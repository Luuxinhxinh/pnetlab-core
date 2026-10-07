/* ============================================================================
   PNetLab Engine-Native Login Controller & Interactive 3D Canvas
   FE2 Specification:
   1. Constellation 3D Particle Canvas with mouse interaction
   2. Modal open/close mechanisms (CTA, top button, Escape, overlay, close icon)
   3. Settings popover (5 Themes, i18n English/Vietnamese, Particle config)
   4. Single SVG Eye Password Toggle
   5. Preserves existing auth API, branding, and version detection
   ============================================================================ */

(function () {
	'use strict';

	/* ==========================================================================
	   1. Internationalization (i18n) Dictionary
	   ========================================================================== */
	var translations = {
		en: {
			settings_title: "Appearance & Grid",
			label_theme: "Color Theme",
			label_language: "Language",
			label_particle_toggle: "3D Particle Grid",
			label_particle_color: "Particle Glow Color",
			label_particle_speed: "Motion Speed",
			opt_color_theme: "Match Theme (Auto)",
			opt_speed_relaxed: "Relaxed (Slow)",
			opt_speed_normal: "Normal",
			opt_speed_dynamic: "Dynamic (Fast)",
			btn_signin: "Sign In",
			hero_desc: "Enterprise Network Simulation & Topology Emulation Platform",
			cta_button: "Sign In to Workbench",
			footnote: "Offline appliance access • Powered by PNetLab Next-Gen Engine",
			modal_title: "Welcome Back",
			modal_subtitle: "Enter credentials to unlock your workbench",
			label_username: "Username",
			ph_username: "admin",
			label_password: "Password",
			ph_password: "••••••••",
			btn_forgot_pwd: "Forgot password?",
			label_console: "Console Preference",
			opt_console_native: "Default Native Console",
			opt_console_html5: "HTML5 Web Console",
			label_remember_user: "Remember Username",
			default_creds: "Default account:",
			label_forgot_id: "Username or email",
			ph_forgot_id: "admin or user@domain.com",
			btn_send_reset: "Send reset link",
			btn_return_login: "← Return to sign in",
			err_fill_creds: "Enter your username and password.",
			err_fail: "Invalid credentials.",
			err_unreachable: "Cannot reach the server. Check that the appliance is running.",
			err_forgot_fill: "Enter your username or email address.",
			msg_forgot_success: "A password reset link has been dispatched to your email."
		},
		vi: {
			settings_title: "Giao diện & Hiệu ứng",
			label_theme: "Màu chủ đạo (Theme)",
			label_language: "Ngôn ngữ",
			label_particle_toggle: "Lưới hạt 3D (Constellation)",
			label_particle_color: "Màu sáng hạt",
			label_particle_speed: "Tốc độ di chuyển",
			opt_color_theme: "Đồng bộ theo Theme",
			opt_speed_relaxed: "Chậm rãi (Relaxed)",
			opt_speed_normal: "Bình thường (Normal)",
			opt_speed_dynamic: "Nhanh (Dynamic)",
			btn_signin: "Đăng nhập",
			hero_desc: "Nền tảng mô phỏng mạng viễn thông & cấu hình topo thế hệ mới",
			cta_button: "Đăng nhập vào Workbench",
			footnote: "Truy cập thiết bị ngoại tuyến • Phát triển bởi PNetLab Next-Gen Engine",
			modal_title: "Chào mừng trở lại",
			modal_subtitle: "Nhập tài khoản để truy cập không gian làm việc",
			label_username: "Tên đăng nhập",
			ph_username: "admin",
			label_password: "Mật khẩu",
			ph_password: "••••••••",
			btn_forgot_pwd: "Quên mật khẩu?",
			label_console: "Chế độ Console",
			opt_console_native: "Console mặc định (Native)",
			opt_console_html5: "Console trình duyệt (HTML5)",
			label_remember_user: "Ghi nhớ tên đăng nhập",
			default_creds: "Tài khoản mặc định:",
			label_forgot_id: "Tên đăng nhập hoặc Email",
			ph_forgot_id: "admin hoặc email@domain.com",
			btn_send_reset: "Gửi liên kết khôi phục",
			btn_return_login: "← Quay lại đăng nhập",
			err_fill_creds: "Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.",
			err_fail: "Tài khoản hoặc mật khẩu không chính xác.",
			err_unreachable: "Không thể kết nối máy chủ. Vui lòng kiểm tra dịch vụ PNetLab.",
			err_forgot_fill: "Vui lòng nhập tên đăng nhập hoặc email.",
			msg_forgot_success: "Liên kết khôi phục mật khẩu đã được gửi đến email của bạn."
		}
	};

	var currentLang = localStorage.getItem('pnq_login_lang') || 'en';
	var currentTheme = localStorage.getItem('pnq_login_theme') || 'dreamy-violet';
	var particleEnabled = localStorage.getItem('pnq_particle_enabled') !== 'false';
	var particleColorMode = localStorage.getItem('pnq_particle_color') || 'theme';
	var particleSpeed = parseFloat(localStorage.getItem('pnq_particle_speed')) || 1.0;

	function applyTranslations(lang) {
		currentLang = lang;
		localStorage.setItem('pnq_login_lang', lang);
		var dict = translations[lang] || translations.en;

		document.querySelectorAll('[data-i18n]').forEach(function (el) {
			var key = el.getAttribute('data-i18n');
			if (dict[key]) {
				el.textContent = dict[key];
			}
		});

		document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
			var key = el.getAttribute('data-i18n-ph');
			if (dict[key]) {
				el.setAttribute('placeholder', dict[key]);
			}
		});

		var langSelect = document.getElementById('lang-select');
		if (langSelect && langSelect.value !== lang) {
			langSelect.value = lang;
		}
	}

	function applyTheme(theme) {
		currentTheme = theme;
		localStorage.setItem('pnq_login_theme', theme);
		if (theme === 'dreamy-violet') {
			document.documentElement.removeAttribute('data-theme');
		} else {
			document.documentElement.setAttribute('data-theme', theme);
		}
		var themeSelect = document.getElementById('theme-select');
		if (themeSelect && themeSelect.value !== theme) {
			themeSelect.value = theme;
		}
	}

	/* ==========================================================================
	   2. 3D Constellation Particle Canvas
	   ========================================================================== */
	var canvas = document.getElementById('particle-canvas');
	var ctx = canvas ? canvas.getContext('2d') : null;
	var particles = [];
	var animFrameId = null;
	var mouse = { x: null, y: null, radius: 150 };

	function getActiveParticleColor() {
		if (particleColorMode !== 'theme') {
			return particleColorMode;
		}
		var style = getComputedStyle(document.documentElement);
		var color = style.getPropertyValue('--pnq-particle-default').trim();
		return color || '#a855f7';
	}

	function resizeCanvas() {
		if (!canvas) return;
		canvas.width = window.innerWidth;
		canvas.height = window.innerHeight;
	}

	function initParticles() {
		if (!canvas) return;
		particles = [];
		var count = Math.floor((canvas.width * canvas.height) / 9000);
		if (count < 45) count = 45;
		if (count > 160) count = 160;

		for (var i = 0; i < count; i++) {
			particles.push({
				x: Math.random() * canvas.width,
				y: Math.random() * canvas.height,
				vx: (Math.random() - 0.5) * 0.8 * particleSpeed,
				vy: (Math.random() - 0.5) * 0.8 * particleSpeed,
				size: Math.random() * 2 + 1,
				baseVx: (Math.random() - 0.5) * 0.8,
				baseVy: (Math.random() - 0.5) * 0.8
			});
		}
	}

	function renderParticles() {
		if (!ctx || !canvas || !particleEnabled) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		var color = getActiveParticleColor();
		var len = particles.length;

		for (var i = 0; i < len; i++) {
			var p = particles[i];
			p.x += p.baseVx * particleSpeed;
			p.y += p.baseVy * particleSpeed;

			if (p.x < 0) p.x = canvas.width;
			if (p.x > canvas.width) p.x = 0;
			if (p.y < 0) p.y = canvas.height;
			if (p.y > canvas.height) p.y = 0;

			// Mouse repel/magnet interaction
			if (mouse.x !== null && mouse.y !== null) {
				var dx = mouse.x - p.x;
				var dy = mouse.y - p.y;
				var dist = Math.sqrt(dx * dx + dy * dy);
				if (dist < mouse.radius) {
					var force = (mouse.radius - dist) / mouse.radius;
					p.x -= (dx / dist) * force * 3;
					p.y -= (dy / dist) * force * 3;
				}
			}

			// Draw particle
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
			ctx.fillStyle = color;
			ctx.shadowColor = color;
			ctx.shadowBlur = 8;
			ctx.fill();

			// Connect nearby particles (constellation grid)
			for (var j = i + 1; j < len; j++) {
				var p2 = particles[j];
				var cdx = p.x - p2.x;
				var cdy = p.y - p2.y;
				var cdist = Math.sqrt(cdx * cdx + cdy * cdy);
				if (cdist < 130) {
					var alpha = (1 - cdist / 130) * 0.28;
					ctx.beginPath();
					ctx.moveTo(p.x, p.y);
					ctx.lineTo(p2.x, p2.y);
					ctx.strokeStyle = color;
					ctx.globalAlpha = alpha;
					ctx.shadowBlur = 0;
					ctx.stroke();
					ctx.globalAlpha = 1.0;
				}
			}
		}

		animFrameId = requestAnimationFrame(renderParticles);
	}

	function startParticleAnimation() {
		if (!particleEnabled) {
			if (animFrameId) cancelAnimationFrame(animFrameId);
			if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
			return;
		}
		if (animFrameId) cancelAnimationFrame(animFrameId);
		renderParticles();
	}

	window.addEventListener('resize', function () {
		resizeCanvas();
		initParticles();
	});

	window.addEventListener('mousemove', function (e) {
		mouse.x = e.clientX;
		mouse.y = e.clientY;
	});

	window.addEventListener('mouseleave', function () {
		mouse.x = null;
		mouse.y = null;
	});

	/* ==========================================================================
	   3. Modal Control (Open, Close, Escape, Click-Outside)
	   ========================================================================== */
	var modalOverlay = document.getElementById('login-modal-overlay');
	var modalCloseBtn = document.getElementById('modal-close-btn');
	var ctaSignInBtn = document.getElementById('cta-signin-btn');
	var topSignInBtn = document.getElementById('top-signin-btn');
	var userEl = document.getElementById('username');
	var passEl = document.getElementById('password');

	function openLoginModal() {
		if (!modalOverlay) return;
		modalOverlay.hidden = false;
		if (userEl) {
			// Auto focus
			setTimeout(function () {
				userEl.focus();
				if (userEl.value) {
					if (passEl) passEl.focus();
				}
			}, 80);
		}
	}

	function closeLoginModal() {
		if (!modalOverlay) return;
		modalOverlay.hidden = true;
	}

	if (ctaSignInBtn) ctaSignInBtn.addEventListener('click', openLoginModal);
	if (topSignInBtn) topSignInBtn.addEventListener('click', openLoginModal);
	if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeLoginModal);

	if (modalOverlay) {
		modalOverlay.addEventListener('click', function (e) {
			if (e.target === modalOverlay) {
				closeLoginModal();
			}
		});
	}

	/* ==========================================================================
	   4. Settings Popover Menu
	   ========================================================================== */
	var settingsBtn = document.getElementById('settings-toggle-btn');
	var settingsPopover = document.getElementById('settings-popover');
	var themeSelect = document.getElementById('theme-select');
	var langSelect = document.getElementById('lang-select');
	var particleToggle = document.getElementById('particle-toggle');
	var particleColorSelect = document.getElementById('particle-color-select');
	var particleSpeedSelect = document.getElementById('particle-speed-select');

	if (settingsBtn && settingsPopover) {
		settingsBtn.addEventListener('click', function (e) {
			e.stopPropagation();
			var isHidden = settingsPopover.hidden;
			settingsPopover.hidden = !isHidden;
			settingsBtn.classList.toggle('is-active', !isHidden);
		});

		document.addEventListener('click', function (e) {
			if (!settingsPopover.hidden && !settingsPopover.contains(e.target) && e.target !== settingsBtn) {
				settingsPopover.hidden = true;
				settingsBtn.classList.remove('is-active');
			}
		});
	}

	if (themeSelect) {
		themeSelect.addEventListener('change', function () {
			applyTheme(this.value);
		});
	}

	if (langSelect) {
		langSelect.addEventListener('change', function () {
			applyTranslations(this.value);
		});
	}

	if (particleToggle) {
		particleToggle.checked = particleEnabled;
		particleToggle.addEventListener('change', function () {
			particleEnabled = this.checked;
			localStorage.setItem('pnq_particle_enabled', particleEnabled ? 'true' : 'false');
			startParticleAnimation();
		});
	}

	if (particleColorSelect) {
		particleColorSelect.value = particleColorMode;
		particleColorSelect.addEventListener('change', function () {
			particleColorMode = this.value;
			localStorage.setItem('pnq_particle_color', particleColorMode);
		});
	}

	if (particleSpeedSelect) {
		particleSpeedSelect.value = String(particleSpeed);
		particleSpeedSelect.addEventListener('change', function () {
			particleSpeed = parseFloat(this.value) || 1.0;
			localStorage.setItem('pnq_particle_speed', particleSpeed);
			initParticles();
		});
	}

	/* ==========================================================================
	   5. Eye Toggle: Single SVG with Dynamic Slash Line
	   ========================================================================== */
	var passwordToggleBtn = document.getElementById('password-toggle-btn');
	if (passwordToggleBtn && passEl) {
		passwordToggleBtn.addEventListener('click', function () {
			var isPassword = passEl.type === 'password';
			if (isPassword) {
				passEl.type = 'text';
				passwordToggleBtn.classList.add('is-revealed');
				passwordToggleBtn.setAttribute('title', 'Hide password');
			} else {
				passEl.type = 'password';
				passwordToggleBtn.classList.remove('is-revealed');
				passwordToggleBtn.setAttribute('title', 'Show password');
			}
		});
	}

	/* ==========================================================================
	   6. Authentication Form Handling
	   ========================================================================== */
	var form = document.getElementById('login-form');
	var consolePrefEl = document.getElementById('console-pref');
	var rememberUserEl = document.getElementById('remember-user');
	var alertEl = document.getElementById('alert');
	var submitEl = document.getElementById('submit');
	var versionValueEl = document.getElementById('version-value');

	// Restore remembered username
	var savedUsername = localStorage.getItem('pnq_remembered_user');
	if (savedUsername && userEl) {
		userEl.value = savedUsername;
		if (rememberUserEl) rememberUserEl.checked = true;
	}

	function redirectTarget() {
		var link = '';
		try {
			link = new URLSearchParams(window.location.search).get('link') || '';
		} catch (e) { link = ''; }
		if (!link) return '/main/';
		try {
			var u = new URL(link, window.location.origin);
			if (u.origin === window.location.origin) return u.pathname + u.search + u.hash;
		} catch (e) { /* fall through */ }
		return '/main/';
	}

	function showError(msg) {
		var dict = translations[currentLang] || translations.en;
		alertEl.textContent = msg || dict.err_fail;
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
		var dict = translations[currentLang] || translations.en;
		var username = (userEl.value || '').trim();
		var password = passEl.value || '';

		if (!username || !password) {
			showError(dict.err_fill_creds);
			return;
		}

		if (rememberUserEl && rememberUserEl.checked) {
			localStorage.setItem('pnq_remembered_user', username);
		} else {
			localStorage.removeItem('pnq_remembered_user');
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
			showError((res.body && res.body.message) || dict.err_fail);
			passEl.value = '';
			passEl.focus();
		}).catch(function () {
			setBusy(false);
			showError(dict.err_unreachable);
		});
	}

	if (form) form.addEventListener('submit', submit);

	/* ==========================================================================
	   7. Forgot Password Flow
	   ========================================================================== */
	var forgotForm = document.getElementById('forgot-form');
	var forgotLink = document.getElementById('forgot-link');
	var backToLoginBtn = document.getElementById('back-to-login');
	var forgotIdentifierEl = document.getElementById('forgot-identifier');
	var forgotSubmitBtn = document.getElementById('forgot-submit');
	var forgotAlertEl = document.getElementById('forgot-alert');
	var forgotSuccessEl = document.getElementById('forgot-success');

	function showForgotAlert(msg) {
		if (forgotSuccessEl) forgotSuccessEl.hidden = true;
		if (forgotAlertEl) {
			forgotAlertEl.textContent = msg || 'Could not process request.';
			forgotAlertEl.hidden = false;
		}
	}

	function showForgotSuccess(msg) {
		if (forgotAlertEl) forgotAlertEl.hidden = true;
		if (forgotSuccessEl) {
			forgotSuccessEl.textContent = msg || 'A password reset link has been sent.';
			forgotSuccessEl.hidden = false;
		}
	}

	function clearForgotAlerts() {
		if (forgotAlertEl) {
			forgotAlertEl.hidden = true;
			forgotAlertEl.textContent = '';
		}
		if (forgotSuccessEl) {
			forgotSuccessEl.hidden = true;
			forgotSuccessEl.textContent = '';
		}
	}

	function setForgotBusy(on) {
		if (forgotSubmitBtn) {
			forgotSubmitBtn.disabled = on;
			forgotSubmitBtn.classList.toggle('is-busy', on);
		}
	}

	if (forgotLink && forgotForm && form) {
		forgotLink.addEventListener('click', function () {
			clearError();
			clearForgotAlerts();
			form.hidden = true;
			forgotForm.hidden = false;
			if (userEl && userEl.value && forgotIdentifierEl) {
				forgotIdentifierEl.value = userEl.value.trim();
			}
			if (forgotIdentifierEl) forgotIdentifierEl.focus();
		});
	}

	if (backToLoginBtn && forgotForm && form) {
		backToLoginBtn.addEventListener('click', function () {
			clearError();
			clearForgotAlerts();
			forgotForm.hidden = true;
			form.hidden = false;
			if (userEl) userEl.focus();
		});
	}

	/* Keyboard Escape Handler */
	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape') {
			if (forgotForm && !forgotForm.hidden) {
				clearError();
				clearForgotAlerts();
				forgotForm.hidden = true;
				if (form) form.hidden = false;
			} else if (modalOverlay && !modalOverlay.hidden) {
				closeLoginModal();
			}
		}
	});

	if (forgotForm) {
		forgotForm.addEventListener('submit', function (e) {
			if (e) e.preventDefault();
			clearForgotAlerts();
			var dict = translations[currentLang] || translations.en;
			var identifier = (forgotIdentifierEl ? forgotIdentifierEl.value : '').trim();
			if (!identifier) {
				showForgotAlert(dict.err_forgot_fill);
				if (forgotIdentifierEl) forgotIdentifierEl.focus();
				return;
			}
			setForgotBusy(true);
			fetch('/api/password-reset/request', {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
				body: JSON.stringify({ identifier: identifier })
			}).then(function (r) {
				return r.text().then(function (txt) {
					var body = {};
					try { body = txt ? JSON.parse(txt) : {}; } catch (err) { body = {}; }
					return { status: r.status, body: body };
				});
			}).then(function (res) {
				setForgotBusy(false);
				if (res.status === 200) {
					showForgotSuccess((res.body && res.body.message) || dict.msg_forgot_success);
					if (forgotIdentifierEl) forgotIdentifierEl.value = '';
				} else {
					showForgotAlert((res.body && res.body.message) || 'Unable to process reset request.');
				}
			}).catch(function () {
				setForgotBusy(false);
				showForgotAlert(dict.err_unreachable);
			});
		});
	}

	/* ==========================================================================
	   8. Branding & System Version Load
	   ========================================================================== */
	if (window.PnqBranding) {
		window.PnqBranding.load().then(function (cfg) {
			window.PnqBranding.apply(cfg);
			document.title = (cfg.name || 'PNetLab') + ' — Sign in to Workbench';
			var hdr = document.getElementById('login-header');
			if (hdr && cfg.login_header) {
				hdr.textContent = cfg.login_header;
			}
			if (cfg.hide_default_creds) {
				var da = document.getElementById('default-account');
				if (da) da.hidden = true;
			}
		});
	}

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

	/* Initialize Everything */
	applyTheme(currentTheme);
	applyTranslations(currentLang);
	resizeCanvas();
	initParticles();
	startParticleAnimation();

})();
