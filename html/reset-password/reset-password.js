(function () {
	'use strict';

	var checkingCard = document.getElementById('checking-card');
	var resetForm = document.getElementById('reset-form');
	var invalidCard = document.getElementById('invalid-card');
	var invalidMessage = document.getElementById('invalid-message');
	var successCard = document.getElementById('success-card');
	var accountLine = document.getElementById('account-line');
	var alertBox = document.getElementById('reset-alert');
	var submitButton = document.getElementById('reset-submit');
	var passwordInput = document.getElementById('new-password');
	var confirmInput = document.getElementById('confirm-password');

	function readToken() {
		var token = new URLSearchParams(window.location.hash.slice(1)).get('token');
		if (!token) token = new URLSearchParams(window.location.search).get('token');
		// Remove the bearer token before any subsequent navigation or same-page
		// resource request. Query-string support is retained for old links only.
		window.history.replaceState(null, document.title, window.location.pathname);
		return token || '';
	}

	function parseResponse(response) {
		return response.json().catch(function () { return {}; }).then(function (body) {
			return { status: response.status, body: body || {} };
		});
	}

	function showInvalid(message) {
		checkingCard.hidden = true;
		resetForm.hidden = true;
		invalidMessage.textContent = message || 'This link is invalid, expired, or has already been used.';
		invalidCard.hidden = false;
	}

	function showError(message) {
		alertBox.textContent = message;
		alertBox.hidden = false;
	}

	function setBusy(busy) {
		submitButton.disabled = busy;
		submitButton.classList.toggle('is-busy', busy);
	}

	if (window.PnqBranding) {
		window.PnqBranding.load().then(function (cfg) { window.PnqBranding.apply(cfg); });
	}

	var token = readToken();
	if (!/^[a-f0-9]{64}$/i.test(token)) {
		showInvalid();
		return;
	}

	fetch('/api/password-reset/check', {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
		body: JSON.stringify({ token: token })
	}).then(parseResponse).then(function (result) {
		if (result.status !== 200 || !result.body.data || !result.body.data.username) {
			showInvalid(result.body.message);
			return;
		}
		checkingCard.hidden = true;
		accountLine.textContent = 'Account: ' + result.body.data.username;
		resetForm.hidden = false;
		passwordInput.focus();
	}).catch(function () {
		showInvalid('The appliance could not validate this link. Try again shortly.');
	});

	resetForm.addEventListener('submit', function (event) {
		event.preventDefault();
		alertBox.hidden = true;
		if (passwordInput.value.length < 8) {
			showError('Use at least 8 characters for the new password.');
			passwordInput.focus();
			return;
		}
		if (passwordInput.value !== confirmInput.value) {
			showError('The passwords do not match.');
			confirmInput.focus();
			return;
		}

		setBusy(true);
		fetch('/api/password-reset/consume', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ token: token, password: passwordInput.value })
		}).then(parseResponse).then(function (result) {
			setBusy(false);
			if (result.status !== 200) {
				showError(result.body.message || 'The password could not be changed.');
				return;
			}
			passwordInput.value = '';
			confirmInput.value = '';
			token = '';
			resetForm.hidden = true;
			successCard.hidden = false;
		}).catch(function () {
			setBusy(false);
			showError('The password could not be changed. Try again shortly.');
		});
	});
})();
