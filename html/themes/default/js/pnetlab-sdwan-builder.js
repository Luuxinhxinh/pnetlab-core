/*
 * pnetlab-sdwan-builder.js
 *
 * "Cisco SDWAN Lab Builder" — left-panel button that opens a modal to build the
 * standard Catalyst SD-WAN topology (vManage + vBond + vSmart + N cEdge + underlay
 * networks) into the open lab, via POST /api/labs/session/sdwan/build.
 *
 * All handlers are attached via delegated jQuery / addEventListener (CSP-safe — never
 * inline onclick). Version dropdown is populated live from the installed images, so the
 * builder stays version-agnostic.
 */
(function () {
    'use strict';

    function t(s) { return (typeof lang === 'function') ? lang(s) : s; }

    function notify(type, msg) {
        if (typeof addMessage === 'function') addMessage(type, msg);
        else if (type === 'danger') alert(msg);
    }

    function modalBody() {
        return '' +
            '<form id="form-sdwan-builder" class="sdwan-form">' +
            '  <p class="sdwan-intro">' + t('Builds a standard SD-WAN topology (vManage, vBond, vSmart, cEdge) with INET/MPLS underlays into this lab.') + '</p>' +
            '  <div class="sdwan-form-row"><label class="sdwan-field-label" for="sdwan-version">' + t('Viptela version') + '</label>' +
            '    <div class="sdwan-field-control"><select class="form-control" id="sdwan-version"><option value="">' + t('loading…') + '</option></select>' +
            '      <p class="sdwan-version-help text-muted" id="sdwan-version-help" hidden>' + t('Install a Viptela image before building this topology.') + '</p></div></div>' +
            '  <div class="sdwan-form-row"><label class="sdwan-field-label" for="sdwan-vbond">' + t('vBond (Validator) count') + '</label>' +
            '    <div class="sdwan-field-control"><input class="form-control" id="sdwan-vbond" type="number" value="1" min="1" max="8"/></div></div>' +
            '  <div class="sdwan-form-row"><label class="sdwan-field-label" for="sdwan-vsmart">' + t('vSmart (Controller) count') + '</label>' +
            '    <div class="sdwan-field-control"><input class="form-control" id="sdwan-vsmart" type="number" value="1" min="1" max="12"/></div></div>' +
            '  <div class="sdwan-form-row"><label class="sdwan-field-label" for="sdwan-cedge">' + t('cEdge count') + '</label>' +
            '    <div class="sdwan-field-control"><input class="form-control" id="sdwan-cedge" type="number" value="1" min="0" max="20"/></div></div>' +
            '  <div class="sdwan-checkbox-row"><label class="sdwan-checkbox-label" for="sdwan-onboard">' +
            '    <input type="checkbox" id="sdwan-onboard"/><span>' + t('Onboard control plane after build') + '</span></label></div>' +
            // ---- onboarding fields (shown only when the checkbox is ticked) ----
            '  <div id="sdwan-onboard-fields" class="sdwan-onboard-fields" hidden>' +
            '    <hr class="sdwan-section-rule"/>' +
            '    <div class="sdwan-form-row"><label class="sdwan-field-label" for="sdwan-org">' + t('Organization name') + '</label>' +
            '      <div class="sdwan-field-control"><input class="form-control" id="sdwan-org" type="text" value="cml-sdwan-lab-tool"/></div></div>' +
            '    <div class="sdwan-form-row"><label class="sdwan-field-label" for="sdwan-admin-pass">' + t('vManage admin password') + '</label>' +
            '      <div class="sdwan-field-control"><input class="form-control" id="sdwan-admin-pass" type="password" autocomplete="new-password" placeholder="' + t('not "admin"') + '"/></div></div>' +
            '    <div class="sdwan-form-row"><label class="sdwan-field-label" for="sdwan-mgr-ip">' + t('Manager external IP') + '</label>' +
            '      <div class="sdwan-field-control"><input class="form-control" id="sdwan-mgr-ip" type="text" placeholder="192.168.10.50"/></div></div>' +
            '    <div class="sdwan-form-row"><label class="sdwan-field-label" for="sdwan-mgr-mask">' + t('Mask / prefix') + '</label>' +
            '      <div class="sdwan-field-control"><input class="form-control" id="sdwan-mgr-mask" type="text" value="/24"/></div></div>' +
            '    <div class="sdwan-form-row"><label class="sdwan-field-label" for="sdwan-mgr-gw">' + t('Gateway') + '</label>' +
            '      <div class="sdwan-field-control"><input class="form-control" id="sdwan-mgr-gw" type="text" placeholder="192.168.10.1"/></div></div>' +
            '    <div class="sdwan-form-row"><label class="sdwan-field-label" for="sdwan-serial">' + t('Serial file (.viptela, optional)') + '</label>' +
            '      <div class="sdwan-field-control"><input class="form-control" id="sdwan-serial" type="file" accept=".viptela,.txt"/></div></div>' +
            '    <p class="text-muted">' + t('The org-name + bundled Root CA + serial file must stay consistent. Defaults match the bundled certs — change the org-name only if you also supply a matching serial file.') + '</p>' +
            '  </div>' +
            '  <p class="text-muted">' + t('Note: vManage needs ~32 GB RAM. Onboarding can take 15–30 min while the control plane boots.') + '</p>' +
            '  <div id="sdwan-progress" class="sdwan-progress" hidden>' +
            '    <div id="sdwan-prog-msg">' + t('Starting…') + '</div>' +
            '    <div class="sdwan-progress-track">' +
            '      <div id="sdwan-prog-bar" class="sdwan-progress-bar"></div></div>' +
            '  </div>' +
            '</form>';
    }

    function modalFooter() {
        return '<button type="button" class="btn btn-success pnq-button pnq-button--primary" id="sdwan-build-submit" disabled>' + t('Build Topology') + '</button>' +
               '<button type="button" class="btn btn-default pnq-button pnq-button--secondary" data-dismiss="modal">' + t('Cancel') + '</button>';
    }

    function applyPanelShell() {
        var modal = document.querySelector('.modal.sdwan-glass');
        if (!modal) return;
        var content = modal.querySelector('.modal-content');
        var header = modal.querySelector('.modal-header');
        var footer = modal.querySelector('.modal-footer');
        var close = modal.querySelector('.modal-header .close');
        if (content) content.classList.add('pnq-panel');
        if (header) header.classList.add('pnq-panel__header');
        if (footer) footer.classList.add('pnq-panel__footer');
        if (close) close.classList.add('pnq-icon-button');
    }

    function setVersionState(available, message) {
        var submit = document.getElementById('sdwan-build-submit');
        var hint = document.getElementById('sdwan-version-help');
        if (submit) submit.disabled = !available;
        if (hint) {
            if (message) hint.textContent = message;
            hint.hidden = available || !message;
        }
    }

    function populateVersions() {
        setVersionState(false, '');
        $.ajax({
            cache: false, type: 'POST',
            url: '/api/labs/session/sdwan/versions',
            contentType: 'application/json', data: '{}', dataType: 'json'
        }).done(function (r) {
            var sel = document.getElementById('sdwan-version');
            if (!sel) return;
            sel.innerHTML = '';
            var vers = (r && r.data && r.data.vmanage && r.data.vmanage.versions) || [];
            if (!vers.length) {
                var o = document.createElement('option');
                o.value = ''; o.textContent = t('(no viptela images installed)');
                sel.appendChild(o);
                setVersionState(false, t('Install a Viptela image before building this topology.'));
                return;
            }
            vers.forEach(function (v) {
                var o = document.createElement('option');
                o.value = v; o.textContent = v;
                sel.appendChild(o);
            });
            setVersionState(true, '');
        }).fail(function () {
            setVersionState(false, t('Install a Viptela image before building this topology.'));
            notify('danger', t('Failed to load SD-WAN image versions.'));
        });
    }

    var pollTimer = null;

    function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }

    // Read the optional serial file as base64; calls cb(b64orEmpty).
    function readSerial(cb) {
        var el = document.getElementById('sdwan-serial');
        if (!el || !el.files || !el.files.length) { cb(''); return; }
        var fr = new FileReader();
        fr.onload = function () {
            var s = String(fr.result || '');
            var comma = s.indexOf(',');           // strip "data:...;base64,"
            cb(comma >= 0 ? s.slice(comma + 1) : '');
        };
        fr.onerror = function () { cb(''); };
        fr.readAsDataURL(el.files[0]);
    }

    function setProgress(pct, msg) {
        var box = document.getElementById('sdwan-progress');
        if (box) box.hidden = false;
        var bar = document.getElementById('sdwan-prog-bar');
        if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
        var m = document.getElementById('sdwan-prog-msg');
        if (m && msg) m.textContent = msg;
    }

    function pollStatus(job) {
        if (pollTimer) clearTimeout(pollTimer);
        $.ajax({
            cache: false, type: 'GET',
            url: '/sdwan/api.php?action=status&job=' + encodeURIComponent(job),
            dataType: 'json'
        }).done(function (s) {
            if (!s) { pollTimer = setTimeout(function () { pollStatus(job); }, 4000); return; }
            setProgress(s.pct || 0, s.msg || '');
            if (s.state === 'done') {
                notify('success', t('SD-WAN control plane onboarded.'));
                setProgress(100, s.msg || t('Done.'));
                return;
            }
            if (s.state === 'error') {
                notify('danger', t('Onboarding failed: ') + (s.msg || ''));
                return;
            }
            pollTimer = setTimeout(function () { pollStatus(job); }, 4000);
        }).fail(function () {
            pollTimer = setTimeout(function () { pollStatus(job); }, 6000);
        });
    }

    function postBuild(payload, btn) {
        $.ajax({
            cache: false, type: 'POST',
            url: '/api/labs/session/sdwan/build',
            contentType: 'application/json', data: JSON.stringify(payload), dataType: 'json'
        }).done(function (r) {
            if (r && (r.status === 'success' || r.status === 'partial')) {
                notify(r.status === 'partial' ? 'warning' : 'success', r.message || t('SD-WAN topology built.'));
                var job = r.data && r.data.job;
                if (job) {
                    // Onboarding launched: keep the modal open and show live progress.
                    if (btn) { btn.style.display = 'none'; }
                    setProgress(2, t('Onboarding started — waiting for SD-WAN Manager…'));
                    pollStatus(job);
                } else {
                    $('.modal').modal('hide');
                    setTimeout(function () { location.reload(); }, 900);
                }
            } else {
                notify('danger', (r && r.message) || t('Build failed.'));
                if (btn) { btn.disabled = false; btn.textContent = t('Build Topology'); }
            }
        }).fail(function (x) {
            var m = t('Build failed.');
            try { m = JSON.parse(x.responseText).message || m; } catch (e) {}
            notify('danger', m);
            if (btn) { btn.disabled = false; btn.textContent = t('Build Topology'); }
        });
    }

    function submitBuild() {
        var btn = document.getElementById('sdwan-build-submit');
        if (!val('sdwan-version')) {
            notify('danger', t('Install a Viptela image before building this topology.'));
            return;
        }
        var onboard = (document.getElementById('sdwan-onboard') || {}).checked;
        var payload = {
            version:   val('sdwan-version'),
            vbond:     parseInt(val('sdwan-vbond'), 10) || 1,
            vsmart:    parseInt(val('sdwan-vsmart'), 10) || 1,
            cedge:     parseInt(val('sdwan-cedge'), 10) || 0,
            autostart: '0',
            onboard:   onboard ? '1' : '0'
        };
        if (onboard) {
            var pass = val('sdwan-admin-pass');
            var mip = val('sdwan-mgr-ip'), mgw = val('sdwan-mgr-gw');
            if (!pass || pass.toLowerCase() === 'admin') {
                notify('danger', t('Enter a vManage admin password (not "admin").')); return;
            }
            if (!mip || !mgw) {
                notify('danger', t('Enter the Manager external IP and gateway.')); return;
            }
            payload.org_name = val('sdwan-org') || 'cml-sdwan-lab-tool';
            payload.admin_password = pass;
            payload.mgr_ip = mip;
            payload.mgr_mask = val('sdwan-mgr-mask') || '/24';
            payload.mgr_gw = mgw;
        }
        if (btn) { btn.disabled = true; btn.textContent = t('Building…'); }
        if (onboard) {
            readSerial(function (b64) {
                if (b64) payload.serial_b64 = b64;
                postBuild(payload, btn);
            });
        } else {
            postBuild(payload, btn);
        }
    }

    function openModal() {
        if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
        addModal(t('SDWAN Lab Builder'), modalBody(), modalFooter(), 'sdwan-glass');
        applyPanelShell();
        populateVersions();
        var submit = document.getElementById('sdwan-build-submit');
        if (submit) submit.addEventListener('click', submitBuild);
        // progressive disclosure: reveal onboarding fields only when ticked
        var ob = document.getElementById('sdwan-onboard');
        if (ob) ob.addEventListener('change', function () {
            var f = document.getElementById('sdwan-onboard-fields');
            if (f) f.hidden = !ob.checked;
        });
    }

    // This file is included WITHOUT defer and executes during body parsing — before the
    // deferred jQuery loads — so the sidebar handler MUST bind with native DOM APIs (no
    // jQuery at load time). jQuery (addModal/$.ajax) is only used inside the click handler,
    // by which time the deferred scripts have run. Mirrors pnetlab-node-duplicate.js.
    function init() {
        document.addEventListener('click', function (e) {
            var el = e.target && e.target.closest ? e.target.closest('.action-sdwan-builder') : null;
            if (el) {
                e.preventDefault();
                openModal();
            }
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
