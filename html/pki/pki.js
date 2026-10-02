/* pki.js — Lab PKI single-page UI (CSP-clean: no inline handlers, no eval).
 * Talks to api.php, which relays to the broker `pki` verb. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LAB = new URLSearchParams(location.search).get('lab') || '';
  var state = { cas: [], sel: null };

  /* ---- transport ---------------------------------------------------------- */
  function api(action, params, method) {
    params = params || {};
    params.action = action;
    var opts = { credentials: 'same-origin',
                 headers: { 'X-Requested-With': 'XMLHttpRequest' } };
    if (method === 'POST' || method === undefined && action !== 'list' && action !== 'profiles') {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(params);
      return fetch('api.php', opts).then(function (r) { return r.json(); });
    }
    var qs = Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    return fetch('api.php?' + qs, opts).then(function (r) { return r.json(); });
  }

  // POST an export/crl request and trigger a file download from the blob.
  function downloadArtifact(params) {
    params.action = params.action || 'export';
    return fetch('api.php', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(params)
    }).then(function (r) {
      var ct = r.headers.get('Content-Type') || '';
      if (ct.indexOf('application/json') !== -1) {
        return r.json().then(function (j) { throw new Error(j.error || 'download failed'); });
      }
      var cd = r.headers.get('Content-Disposition') || '';
      var m = cd.match(/filename="?([^"]+)"?/);
      var fn = m ? m[1] : 'download';
      return r.blob().then(function (b) { saveBlob(b, fn); });
    }).catch(function (e) { toast(e.message || 'download failed', true); });
  }

  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function saveText(text, filename) {
    saveBlob(new Blob([text], { type: 'application/x-pem-file' }), filename);
  }

  /* ---- toast -------------------------------------------------------------- */
  var toastTimer = null;
  function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 3200);
  }

  /* ---- option population -------------------------------------------------- */
  function fillSelect(sel, items, valKey, labKey) {
    sel.innerHTML = '';
    items.forEach(function (it) {
      var o = document.createElement('option');
      o.value = valKey ? it[valKey] : it;
      o.textContent = labKey ? it[labKey] : it;
      sel.appendChild(o);
    });
  }

  function loadMeta() {
    return api('profiles', {}, 'GET').then(function (j) {
      if (!j.ok) { toast(j.error || 'cannot load profiles', true); return; }
      ['iss-profile', 'csr-profile'].forEach(function (id) {
        fillSelect($(id), j.profiles, 'id', 'label');
      });
      var KEY_LABELS = { rsa2048: 'RSA 2048', rsa4096: 'RSA 4096', ec256: 'EC P-256', ec384: 'EC P-384' };
      var keys = j.key_types.map(function (k) { return { id: k, label: KEY_LABELS[k] || k }; });
      ['ca-key', 'iss-key'].forEach(function (id) { fillSelect($(id), keys, 'id', 'label'); });
    });
  }

  /* ---- CA list / detail --------------------------------------------------- */
  function refresh(keepSel) {
    return api('list', {}, 'GET').then(function (j) {
      if (!j.ok) { toast(j.error || 'cannot list CAs', true); return; }
      state.cas = j.cas || [];
      renderCAList();
      if (keepSel && state.sel) {
        var still = state.cas.filter(function (c) { return c.ca.id === state.sel; })[0];
        if (still) { selectCA(state.sel); return; }
      }
    });
  }

  function renderCAList() {
    var box = $('ca-list');
    if (!state.cas.length) { box.innerHTML = '<div class="empty">No CAs yet.</div>'; return; }
    box.innerHTML = '';
    state.cas.forEach(function (c) {
      var div = document.createElement('div');
      div.className = 'ca-item' + (state.sel === c.ca.id ? ' sel' : '');
      div.innerHTML = '<b></b>' + (c.ca.two_tier ? '<span class="tag">2-tier</span>' : '') +
        '<div class="meta"></div>';
      div.querySelector('b').textContent = c.ca.name;
      div.querySelector('.meta').textContent =
        c.certs.length + ' cert' + (c.certs.length === 1 ? '' : 's') +
        ' · ' + (c.ca.key_type || '');
      div.addEventListener('click', function () { selectCA(c.ca.id); });
      box.appendChild(div);
    });
  }

  function selectedCA() {
    return state.cas.filter(function (c) { return c.ca.id === state.sel; })[0];
  }

  function selectCA(id) {
    state.sel = id;
    $('new-ca-card').style.display = 'none';
    $('welcome').style.display = 'none';
    $('ca-detail').style.display = '';
    renderCAList();
    var c = selectedCA();
    if (!c) return;
    $('detail-title').textContent = c.ca.name +
      (c.ca.two_tier ? '  (Root → Issuing CA)' : '  (Root CA)');
    $('detail-fp').textContent = 'Root SHA-256: ' + (c.ca.root_fp || '');
    renderCerts(c);
  }

  function renderCerts(c) {
    var tb = $('cert-rows');
    tb.innerHTML = '';
    if (!c.certs.length) { $('no-certs').style.display = ''; return; }
    $('no-certs').style.display = 'none';
    c.certs.forEach(function (ct) {
      var tr = document.createElement('tr');
      var cn = document.createElement('td'); cn.textContent = ct.cn || '(no CN)';
      var pf = document.createElement('td'); pf.textContent = ct.profile || '';
      var st = document.createElement('td');
      st.innerHTML = ct.revoked ? '<span class="pill rev">revoked</span>'
                                : '<span class="pill ok">valid</span>';
      var ac = document.createElement('td'); ac.className = 'actions';
      ac.appendChild(mkBtn('Cert', 'ghost sm', function () {
        downloadArtifact({ ca_id: c.ca.id, cert_id: ct.id, format: 'fullchain' });
      }));
      var keyBtn = mkBtn('Key', 'ghost sm', function () {
        downloadArtifact({ ca_id: c.ca.id, cert_id: ct.id, format: 'key' });
      });
      ac.appendChild(keyBtn);
      ac.appendChild(mkBtn('P12', 'ghost sm', function () {
        var pw = window.prompt('PKCS#12 passphrase (blank = none):', '');
        if (pw === null) return;
        downloadArtifact({ ca_id: c.ca.id, cert_id: ct.id, format: 'p12', p12_pass: pw });
      }));
      if (!ct.revoked) {
        ac.appendChild(mkBtn('Revoke', 'danger sm', function () {
          if (!window.confirm('Revoke ' + (ct.cn || ct.id) + '? This regenerates the CRL.')) return;
          api('revoke', { ca_id: c.ca.id, cert_id: ct.id }, 'POST').then(function (j) {
            if (j.ok) { toast('Revoked'); refresh(true); } else { toast(j.error || 'revoke failed', true); }
          });
        }));
      }
      tr.appendChild(cn); tr.appendChild(pf); tr.appendChild(st); tr.appendChild(ac);
      tb.appendChild(tr);
    });
  }

  function mkBtn(label, cls, fn) {
    var b = document.createElement('button');
    b.className = cls; b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }

  /* ---- actions ------------------------------------------------------------ */
  function createCA() {
    var name = $('ca-name').value.trim();
    if (!name) { toast('CA name required', true); return; }
    var btn = $('btn-create-ca'); btn.disabled = true;
    api('ca_create', {
      name: name, org: $('ca-org').value, ou: $('ca-ou').value,
      country: $('ca-country').value, key_type: $('ca-key').value,
      days: parseInt($('ca-days').value, 10) || 3650,
      two_tier: $('ca-twotier').value, lab: LAB
    }, 'POST').then(function (j) {
      btn.disabled = false;
      if (!j.ok) { toast(j.error || 'CA creation failed', true); return; }
      toast('Root CA created');
      $('ca-name').value = '';
      refresh().then(function () { selectCA(j.ca.id); });
    });
  }

  function issueCert() {
    var c = selectedCA(); if (!c) return;
    var cn = $('iss-cn').value.trim();
    if (!cn) { toast('Common Name required', true); return; }
    var btn = $('btn-issue'); btn.disabled = true;
    api('issue', {
      ca_id: c.ca.id, profile: $('iss-profile').value, cn: cn,
      sans: $('iss-sans').value, key_type: $('iss-key').value,
      days: parseInt($('iss-days').value, 10) || 825
    }, 'POST').then(function (j) {
      btn.disabled = false;
      if (!j.ok) { toast(j.error || 'issue failed', true); return; }
      // immediate bundle: private key + cert + CA chain
      saveText(j.key + '\n' + j.cert + j.chain, safeName(cn) + '.pem');
      toast('Issued ' + cn + ' — bundle downloaded');
      $('iss-cn').value = ''; $('iss-sans').value = '';
      refresh(true);
    });
  }

  function signCSR() {
    var c = selectedCA(); if (!c) return;
    var csr = $('csr-pem').value.trim();
    if (csr.indexOf('BEGIN CERTIFICATE REQUEST') === -1) { toast('Paste a PEM CSR', true); return; }
    var btn = $('btn-sign-csr'); btn.disabled = true;
    api('sign_csr', {
      ca_id: c.ca.id, profile: $('csr-profile').value, csr: csr,
      days: parseInt($('csr-days').value, 10) || 825
    }, 'POST').then(function (j) {
      btn.disabled = false;
      if (!j.ok) { toast(j.error || 'signing failed', true); return; }
      saveText(j.cert + j.chain, 'signed-' + (j.cert_id || 'cert') + '.pem');
      toast('CSR signed — cert + chain downloaded');
      $('csr-pem').value = '';
      refresh(true);
    });
  }

  function deleteCA() {
    var c = selectedCA(); if (!c) return;
    if (!window.confirm('Delete CA "' + c.ca.name + '" and ALL its certificates? This cannot be undone.')) return;
    api('delete_ca', { ca_id: c.ca.id }, 'POST').then(function (j) {
      if (!j.ok) { toast(j.error || 'delete failed', true); return; }
      toast('CA deleted');
      state.sel = null;
      $('ca-detail').style.display = 'none';
      $('welcome').style.display = '';
      refresh();
    });
  }

  function safeName(s) { return (s || 'cert').replace(/[^A-Za-z0-9._-]/g, '_'); }

  /* ---- wiring ------------------------------------------------------------- */
  function showNewCA() {
    $('welcome').style.display = 'none';
    $('ca-detail').style.display = 'none';
    state.sel = null; renderCAList();
    $('new-ca-card').style.display = '';
  }
  function hideNewCA() {
    $('new-ca-card').style.display = 'none';
    if (state.sel) selectCA(state.sel); else $('welcome').style.display = '';
  }

  function init() {
    if (LAB) $('lab-label').textContent = 'Lab: ' + LAB;
    $('btn-new-ca').addEventListener('click', showNewCA);
    $('btn-cancel-ca').addEventListener('click', hideNewCA);
    $('btn-create-ca').addEventListener('click', createCA);
    $('btn-issue').addEventListener('click', issueCert);
    $('btn-sign-csr').addEventListener('click', signCSR);
    $('btn-del-ca').addEventListener('click', deleteCA);
    document.querySelectorAll('[data-dl]').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = selectedCA(); if (!c) return;
        var kind = b.getAttribute('data-dl');
        if (kind === 'ca') downloadArtifact({ action: 'export', ca_id: c.ca.id, format: 'ca' });
        else if (kind === 'crl') downloadArtifact({ action: 'crl', ca_id: c.ca.id });
      });
    });
    loadMeta().then(refresh);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
