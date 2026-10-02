/* status/render.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

/* Left-pane logo source. Custom branding (/main/#/custom) is served by
 * /branding/api.php, which falls back to the stock logo server-side — so this
 * URL is correct whether or not a custom logo exists, and works even if
 * pnq-branding.js failed to load. The ?v= token (when the config has resolved)
 * only cache-busts a CHANGED logo. */
function brandLogoUrl() {
    if (window.PnqBranding) return window.PnqBranding.logoUrl(window.PNQ_BRANDING);
    return '/branding/api.php?action=logo';
}

/* canvas-flow amputation (b2): window.nodes is now island-fed, and its `icon`
 * field carries a FULL path ("/images/icons/Switch-2D-L2-Generic-S.svg") rather
 * than the bare filename the engine API returns. The Nodes-list rows prepend
 * "/images/icons/" unconditionally, which double-prefixed the src
 * ("/images/icons//images/icons/…"→ naturalWidth 0, blank thumbnail). Normalize
 * to the bare basename so a stored value in EITHER shape resolves. */
function pnqIconBase(v) {
    if (v == null) return '';
    var s = String(v).split(/[?#]/)[0];   // drop any query/hash
    var i = s.lastIndexOf('/');
    return (i >= 0) ? s.slice(i + 1) : s;  // basename
}

function printLabStatus() {

    // Phase 2 (push-not-poll): when the lab-state WS path is live it feeds node
    // status into PNQStore in real time, so skip the per-client polling API call.
    // The interval stays armed, so polling resumes automatically if the socket
    // drops; on (re)connect the daemon resends full node.state, so no drift.
    // isLive() is heartbeat-backed (pnetlab-labstate-client.js): a socket that
    // handshook but has gone silent behind the proxy reports NOT live once its
    // ping/pong stalls, so the poll resumes as the fail-safe and LEDs/cables no
    // longer stay stale until a manual reload.
    if (window.PNQLabState && typeof PNQLabState.isLive === 'function' && PNQLabState.isLive()) return;

    // console.log('DEBUG: updating node status');
    $.when(getNodesStatus(null)).done(function (nodes) {
        if (window.PNQStore) {
            // Phase 2 complete: the poll is the FALLBACK feeder (runs only when the
            // WS path is down). Converge it on the store so the store subscriber is
            // the SOLE node-status renderer — no DOM-as-state path remains.
            var patch = {};
            $.each(nodes, function (id, st) { patch[id] = { status: st }; });
            PNQStore.apply({ nodes: patch });
        } else {
            $.each(nodes, function (node_id, node_status) {
                if(isset(App.topology.nodes[node_id])){
                    var nodeComp = App.topology.nodes[node_id].get('component', false);
                    if(nodeComp){
                        if(nodeComp.attr('data-status') == 5) return;
                        nodeComp.attr('data-status', node_status);
                        if (window.nodes && window.nodes[node_id]) window.nodes[node_id]['status'] = node_status;
                    }
                }
            });
        }
    }).fail(function (message) {
        error_handle(message)
    });
}


function createNodeListRow(struct, node) {
    var defer = $.Deferred();
    var userRight = "readonly";
    var disabledAttr = 'disabled="true"';
    var running = (node['status'] == 2);          // 2 = running → lock & grey its config
    if (LOCK == 0 && !running) {
        userRight = "";
        disabledAttr = ""
    }
    $.when(getTemplates(node['template'], false)).done(function (template) {
        
        var template = template['options'];
        var cells = [`<td style="text-align:center"><b>${node['id']}</b></td>`];

        cells = cells.concat(struct.map(function(colid){

            // CPU (vCPU count) — always render an editable input, even when unset
            // (fresh nodes / IOL come through with no cpu value, which previously
            // produced an empty, non-editable cell).
            if(colid == 'cpu'){
                return `<td><input data-pnq-update="data" data-nodeid="${node['id']}" style="width:100%; min-width:55px" class="input ${userRight}" data-path="cpu" value="${isset(node['cpu']) ? node['cpu'] : ''}" type="number" min="1" ${disabledAttr}></input></td>`;
            }

            if(!isset(node[colid])) return `<td></td>`;

            if(colid == 'port'){
                return `<td><input data-pnq-update="port" data-nodeid="${node['id']}" style="width:100%; min-width:65px" class="input ${userRight}" data-path="${colid}" value="${node[colid]}" type="number" ${disabledAttr}/></td>`
            }
            if(colid == 'port_2nd'){
                return `<td><input data-pnq-update="port2nd" data-nodeid="${node['id']}" style="width:100%; min-width:65px" class="input ${userRight}" data-path="${colid}" value="${node[colid]}" type="number" ${disabledAttr}/></td>`
            }

            // cluster_host: compare by KEY (numeric host id) not label; always enabled
            if (colid == 'cluster_host') {
                var chOpts = (template[colid] && template[colid]['options']) ? template[colid]['options'] : {0: 'Master'};
                var chCur = parseInt(node[colid], 10) || 0;
                var chHtml = `<td><select data-pnq-update="runon" data-nodeid="${node['id']}" data-prev="${chCur}" style="width:100%; min-width:80px" class="input">`;
                for (var chKey in chOpts) {
                    chHtml += `<option value="${chKey}" ${parseInt(chKey,10) === chCur ? 'selected' : ''}>${chOpts[chKey]}</option>`;
                }
                // "Auto (least loaded)" — only when satellites exist; resolved on
                // change by pnetlab-node-runon.js to the lowest-load online satellite.
                if (Object.keys(chOpts).some(function (k) { return parseInt(k, 10) > 0; })) {
                    chHtml += `<option value="auto">${lang('Auto (least loaded)')}</option>`;
                }
                chHtml += `</select></td>`;
                return chHtml;
            }

            if(!isset(template[colid])) return `<td><input style="width:100%; min-width:30px" class="input" disabled value=""></input></td>`;

            if(colid == 'icon'){
                var iconBase = pnqIconBase(node[colid]);
                return `<td><div class="input box_flex button box_line action-nodeicon" data-nodeid="${node['id']}" data-path="${colid}" style="line-height:14px" data-size="5" data-style="selectpicker-button">
                    <img id="tablenode_icon_img${node['id']}" src='/images/icons/${iconBase}' height=12 width=12 style="margin-right:20px"/><span id="tablenode_icon_name${node['id']}">${iconBase}</span>
                    <input type="text" style="display:none" value="${iconBase}"/>
                </div></td>`
            }

            // Boot Image: a node whose stored image is missing from the addons dir
            // shows "(INVALID)" in the Edit-node modal but a plain <select> here would
            // silently fall back to the first valid option, hiding the breakage. So
            // flag it: a disabled, selected "(INVALID) …" option carries the broken
            // value + the cell goes red; the valid images follow. Picking one fires
            // change -> updateNodeData (same save path as every other field), so all
            // broken images can be re-pointed in one page. (template.image.options =
            // listNodeImages() valid set, keyed name=>name.)
            if(colid == 'image'){
                var imgOpts = (template['image'] && template['image']['options']) ? template['image']['options'] : {};
                var curImg = isset(node['image']) ? node['image'] : '';
                var imgInvalid = (curImg !== '' && !Object.prototype.hasOwnProperty.call(imgOpts, curImg));
                var sel = `<td class="pnq-img-cell${imgInvalid ? ' pnq-img-invalid' : ''}"><select data-pnq-update="data" data-nodeid="${node['id']}" style="width:100%; min-width:120px${imgInvalid ? '; border:2px solid #e02424; background:#fff5f5' : ''}" class="input ${userRight}" data-path="image" ${disabledAttr}>`;
                if(imgInvalid){
                    sel += `<option value="${curImg}" selected disabled>⚠ (INVALID) ${curImg}</option>`;
                }
                if(Object.keys(imgOpts).length){
                    for(var ik in imgOpts){
                        sel += `<option value="${ik}" ${curImg === ik ? 'selected' : ''}>${imgOpts[ik]}</option>`;
                    }
                } else if(!imgInvalid){
                    sel += `<option value="" disabled selected>${lang('No images installed')}</option>`;
                }
                sel += `</select></td>`;
                return sel;
            }

            if(colid == 'left' || colid == 'top' || colid == 'size' || colid == 'delay' || colid == 'ram' || colid == 'ethernet' || colid == 'cpu' || colid == 'serial' || colid == 'nvram'){
                return `<td><input data-pnq-update="data" data-nodeid="${node['id']}" data-path="${colid}" style="width:100%; min-width:55px" class="input" value="${node[colid]}" type='number' ${disabledAttr}></input></td>`;
            }
            if( colid == 'ethernet' || colid == 'cpu' || colid == 'serial' || colid == 'nvram'){
                return `<td><input data-pnq-update="data" data-nodeid="${node['id']}" data-path="${colid}" style="width:100%; min-width:30px" class="input" value="${node[colid]}" type='number' ${disabledAttr}></input></td>`;
            }

            if(template[colid]['type'] == 'checkbox') return `<td><input data-pnq-update="data" data-nodeid="${node['id']}" style="width:100%; min-width:30px" class="input ${userRight}" data-path="${colid}" value="${node[colid]}" type="checkbox" ${disabledAttr} ${((node[colid] == 1) ? 'checked' : '')}/></td>`
            if(template[colid]['type'] == 'list' && (colid == 'config' || colid == 'console' || colid == 'console_2nd' ) ){
                var html_data = `<td><select data-pnq-update="data" data-nodeid="${node['id']}" style="width:100%; min-width:70px" class="input ${userRight}" data-path="${colid}" ${disabledAttr}>`
                var options_arr = template[colid]['options'] ? template[colid]['options'] : {};
                for(let key in options_arr){
                    html_data += `<option ${node[colid] == options_arr[key] ? 'selected' : ''} value="${key}" ${colid=='console' && `data-content="<div class='box_flex'><img src='/images/icons/${key}'></img>&nbsp;${options_arr[key]}</div>"`}>
                        ${options_arr[key]}
                    </option>`
                }
                html_data += `</select></td>`;
                return html_data;
            }
            
            if(template[colid]['type'] == 'list'){
                var html_data = `<td><select data-pnq-update="data" data-nodeid="${node['id']}" style="width:100%; min-width:100px" class="input ${userRight}" data-path="${colid}" ${disabledAttr}>`
                var options_arr = template[colid]['options'] ? template[colid]['options'] : {};
                for(let key in options_arr){
                    html_data += `<option ${node[colid] == options_arr[key] ? 'selected' : ''} value="${key}" ${colid=='icon' && `data-content="<div class='box_flex'><img src='/images/icons/${key}'></img>&nbsp;${options_arr[key]}</div>"`}>
                        ${options_arr[key]}
                    </option>`
                }
                html_data += `</select></td>`;
                return html_data;
            }
            if(template[colid]['type'] == '') template[colid]['type'] = 'text' 
            return `<td><input data-pnq-update="data" data-nodeid="${node['id']}" style="width:100%; min-width:80px" class="input ${userRight}" data-path="${colid}" value="${node[colid]}" type="${template[colid]['type']}" ${disabledAttr}/></td>`
        }))

        // live usage cells (filled by pnetlab-node-stats.js polling /pnq-nodestats.php)
        var ramMax = parseInt(node['ram'], 10) || 0;
        cells.push(`<td class="pnq-usage-cell" data-nid="${node['id']}" data-kind="cpu"><div class="pnq-usage"><div class="pnq-usage-bar"><i></i></div><span class="v">—</span></div></td>`);
        cells.push(`<td class="pnq-usage-cell" data-nid="${node['id']}" data-kind="mem" data-max="${ramMax}"><div class="pnq-usage"><div class="pnq-usage-bar"><i></i></div><span class="v">—</span></div></td>`);

        var nodeLocked = (node['lock'] == 1);
        cells.push(`<td>
        <div class="action-controls">
            <a class="action-nodestart" data-path="${node['id']}" href="javascript:void(0)" title="${lang('Start')}"><i class="glyphicon glyphicon-play"></i></a>
            <a class="action-nodestop" data-path="${node['id']}" href="javascript:void(0)" title="${lang('Stop')}"><i class="glyphicon glyphicon-stop"></i></a>
            <a class="action-nodewipe" data-path="${node['id']}" href="javascript:void(0)" title="${lang('Wipe')}"><i class="glyphicon glyphicon-erase"></i></a>
            ${nodeLocked
            ? `<a class="action-nodeunlock" data-path="${node['id']}" href="javascript:void(0)" title="${lang('Unlock node')}"><i class="glyphicon glyphicon-lock"></i></a>`
            : `<a class="action-nodelock"   data-path="${node['id']}" href="javascript:void(0)" title="${lang('Lock node')}"><i class="glyphicon glyphicon-unchecked"></i></a>`}
            ${(LOCK == 0)
            && `<a class="action-nodeexport" data-path="${node['id']}" href="javascript:void(0)" title="${lang('Export CFG')}"><i class="glyphicon glyphicon-save"></i></a>
            <a class="action-nodedelete" data-path="${node['id']}" href="javascript:void(0)" title="${lang('Delete')}"><i class="glyphicon glyphicon-trash"></i></a>
            </div>
        </td>`}`)
        defer.resolve(`<tr class="${running ? 'pnq-node-running' : ''}" data-lock="${nodeLocked ? 1 : 0}" title="${running ? lang('Node is running — stop it to edit') : ''}">${cells.join('')}</tr>`);
    }).fail(function (message1, message2) {
        if (message1 != null) {
            addModalError(message1);
        } else {
            addModalError(message2)
        }
        defer.resolve('');
    });

    return defer;
}

// Display all nodes in a table
function printListNodes(nodes) {
    // The legacy click can arrive while the island has only seeded its reduced
    // PNQStore rows. Wait for the stub's authoritative raw-node readiness edge
    // before composing cells; otherwise the row count is right but every
    // descriptive field is missing.
    var ensureReady = window.__pnqEnsureWindowNodesReady;
    if (typeof ensureReady === 'function') {
        var ready = ensureReady();
        if (ready && typeof ready.then === 'function') {
            ready.then(function (readyNodes) {
                printListNodes(readyNodes || window.nodes || nodes || {});
            });
            return;
        }
        nodes = window.nodes || nodes || {};
    }
    $('#context-menu').remove();
    App.loading(false);
    // Lean PRO-style column set for the dedicated Nodes modal: Name · Icon · Boot
    // Image · CPU · RAM (+ ID + Actions, added by the table builder). The header and
    // rows both derive from `struct`, and each field still saves on change via
    // updateNodeData(), so trimming columns here doesn't affect editing/saving.
    var struct = [
        'name',
        'icon',
        'image',
        'cpu',
        'ram',
    ];
    // Add "Run on" column when at least one node carries cluster_host (cluster active).
    var hasCluster = Object.values(nodes).some(function(n){ return 'cluster_host' in n; });
    if (hasCluster) struct.push('cluster_host');

    console.log('DEBUG: printing node list');
    
    var html_rows = [];
    var promises = [];

    var composePromise = function (key, value) {
        var defer = $.Deferred();
        $.when(createNodeListRow(struct, value)).done(function (data) {
            html_rows.push({id: key, tr: data});
            defer.resolve();
        });
        return defer;
    };

    $.each(nodes, function (key, value) {
        promises.push(composePromise(key, value));
    })

    $.when.apply($, promises).done(function () {

        var html_data = html_rows.sort(function (a, b) {
            return (Number(a.id) < Number(b.id)) ? -1 : 1;
        })

        var body = `<div class="table-responsive">
                <form id="form-node-edit-table" >
                    <table class="configured-nodes table">
                        <thead>
                            <tr>
                                <th>${lang('ID')}</th>
                                ${struct.map(function(colid){
                                    return `<th>${colid === 'cluster_host' ? lang('Run on') : lang(colid)}</th>`
                                }).join('')}
                                <th>${lang('CPU %')}</th>
                                <th>${lang('RAM Used')}</th>
                                <th>${lang('Actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${html_data.map(function(item){return item.tr}).join('')}
                        </tbody>
                    </table>
                </form>
                </div>
                `;

        addModalWide(lang('List of Nodes'), body, '<button type="button" class="btn btn-success pnq-nodes-save"><i class="glyphicon glyphicon-floppy-disk"></i> ' + lang('Save') + '</button>');
        // Invalid-image helper: if any node references a boot image missing from the
        // addons dir (flagged with .pnq-img-invalid by createNodeListRow), surface a
        // count + a "show only invalid" filter so they can all be re-pointed here.
        (function () {
            var tbl = document.querySelector('.configured-nodes');
            var invalid = tbl ? tbl.querySelectorAll('.pnq-img-invalid').length : 0;
            if (!tbl || !tbl.parentNode || !invalid) return;
            var bar = document.createElement('div');
            bar.className = 'pnq-img-fixbar';
            bar.style.cssText = 'margin:0 0 10px;padding:8px 12px;border-radius:6px;background:#fff5f5;border:1px solid #e02424;color:#a31414;display:flex;align-items:center;gap:12px;flex-wrap:wrap';
            bar.innerHTML = '<i class="fa fa-exclamation-triangle"></i>' +
                '<span><b>' + invalid + '</b> ' + lang('node(s) have an invalid boot image') +
                ' — ' + lang('pick a valid image; it saves automatically') + '.</span>' +
                '<label style="margin:0 0 0 auto;font-weight:normal;cursor:pointer;white-space:nowrap">' +
                '<input type="checkbox" id="pnq-only-invalid" style="vertical-align:middle"> ' +
                lang('Show only invalid') + '</label>';
            tbl.parentNode.insertBefore(bar, tbl);
            document.getElementById('pnq-only-invalid').addEventListener('change', function () {
                var only = this.checked;
                tbl.querySelectorAll('tbody tr').forEach(function (tr) {
                    tr.style.display = (only && !tr.querySelector('.pnq-img-invalid')) ? 'none' : '';
                });
            });
        })();
        $('.selectpicker').selectpicker();
        App.loading(false);
    })
}

// Print lab open page
function printPageLabOpen(lab) {

    var gim = localStorage.getItem('left_menu_gim');
    if(gim == 1) $('body').addClass('fixed');

    var html = `
                <div id="lab-sidebar">
                    <!-- Reopen affordance: keep #lab-sizebar-button as an invisible 20px
                         hover/click strip (the collapsed #lab-sidebar is width:0, so this
                         strip is what re-opens the pane on hover) but drop the visible
                         chevron "arrow" tab the user asked to remove. -->
                    <div id="lab-sizebar-button"></div>
                    <div id="lab-sidebar-menu">
                        <ul></ul>
                        <div style="padding:0px 7px"><hr/></div>
                        <div id="lab_members"></div>
                        <br/>
                        <div style="padding-left:11px">
                            <a class="action-logout" href="javascript:void(0)"><i class="glyphicon glyphicon-log-out" style="margin-right:7px"></i><span class="lab-sidebar-title">${lang('Logout')}</span></a>
                        </div>
                    </div>
                    <div class="logo_img">
                        <img data-brand-logo src='${brandLogoUrl()}' style="max-width:90%"></img>
                    </div>

                    <i id="gim" class="button fa fa-thumb-tack"></i>
                    
                </div>



                <!-- canvas-flow amputation (b2 Wave 3, B1): the classic jsPlumb
                     #lab-viewport is retired — the Svelte Flow island is the ONLY
                     canvas. This lightweight page-marker replaces it: the island's
                     main.js resolvePage() and addMessage's page check gate on this
                     element's EXISTENCE only (never its geometry). The island mounts
                     its own body-level container over the whole window.
                     data-path carries the lab file path (previously set on
                     #lab-viewport by lab.js) — survivor code (actions.js workbook/
                     export/add-object) reads $('#pnq-lab-page').attr('data-path'). -->
                <div id="pnq-lab-page" data-path="${lab}"></div>

                <div>
                    <div id="alert_container" style="display:none" >
                        <b>
                            <i class="fa fa-bell-o"></i> ${lang("Notifications")}&nbsp;
                            <i id="alert_container_close" class="pull-right fa fa-times" style="color: red; cursor:pointer; padding:2px"></i>
                        </b>
                        <div class="inner" style="overflow:auto; max-height:400px"></div>
                    </div>
                    <div id="notification_container"></div> 
                </div>
                
                `;

    $('#body').html(html);
    // (canvas-flow amputation: fitLabViewport() removed — there is no #lab-viewport
    //  to size; the island covers the whole window itself.)

    $('#lab-sidebar ul').append('<li class="action-labobjectadd-li"><a class="action-labobjectadd" href="javascript:void(0)" title="' + lang('Add an object') + '"><i class="glyphicon glyphicon-plus"></i><span class="lab-sidebar-title">' + lang('Add an object') + '</span></a></li>');
    $('#lab-sidebar ul').append('<li><a class="action-moreactions" href="javascript:void(0)" title="' + lang('Setup Nodes') + '"><i class="fa fa-cogs"></i><span class="lab-sidebar-title">' + lang('Setup Nodes') + '</span></a></li>');
    $('#lab-sidebar ul').append('<li><a class="action-nodesget" href="javascript:void(0)" title="' + lang('Nodes') + '"><i class="fa fa-server"></i><span class="lab-sidebar-title">' + lang('Nodes') + '</span></a></li>');
    $('#lab-sidebar ul').append('<li><a class="action-configsget"  href="javascript:void(0)" title="' + lang('Startup Configs') + '"><i class="fa fa-list-alt"></i><span class="lab-sidebar-title">' + lang('Startup Configs') + '</span></a></li>');
    $('#lab-sidebar ul').append('<li><a class="action-sdwan-builder" href="javascript:void(0)" title="' + lang('SDWAN Lab Builder') + '"><i class="fa fa-cloud"></i><span class="lab-sidebar-title">' + lang('SDWAN Lab Builder') + '</span></a></li>');
    // $('#lab-sidebar ul').append('<li><a class="action-configobjects" href="javascript:void(0)" title="' + lang('Config Objects') + '"><i class="fa fa-cubes"></i><span class="lab-sidebar-title">' + lang('Config Objects') + '</span></a></li>');
    $('#lab-sidebar ul').append('<li class="action-picturesget-li"><a class="action-picturesget" href="javascript:void(0)" title="' + lang('Pictures') + '"><i class="glyphicon glyphicon-picture"></i><span class="lab-sidebar-title">' + lang('Pictures') + '</span></a></li>');
    $('#lab-sidebar ul').append('<li><a class="action-labtopologyrefresh" href="javascript:void(0)"><i class="glyphicon glyphicon-refresh"></i><span class="lab-sidebar-title">' + lang("Refresh topology") + '</span></a></li>');
    // Lock/Unlock Lab removed from the left pane (user request) — the #action_lock_lab
    // placeholder that lab.js bound its lock button to is no longer rendered.
    $('#lab-sidebar ul').append('<div id="action-labclose"><li><a class="action-labclose" href="javascript:void(0)"><i class="glyphicon glyphicon-off"></i><span class="lab-sidebar-title">' + lang("Close Lab") + '</span></a></li></div>');
    $('#lab-sidebar ul').append('<div id="action-labdestroy"><li><a class="action-labdestroy" href="javascript:void(0)"><i class="fa fa-chain-broken"></i><span class="lab-sidebar-title">' + lang('Destroy Lab') + '</span></a></li></div>');
    $('#lab-sidebar ul').append('<div style="padding:0px 7px"><hr/></div>');
    $('#lab-sidebar ul').append('<li><a class="action-systemstatus" href="javascript:void(0)" title="' + lang("System Status") + '"><i class="fa fa-bar-chart-o"></i><span class="lab-sidebar-title">' + lang("System Status") + '</span></a></li>');
    $('#lab-sidebar ul').append('<li><a class="action-editbackground" href="javascript:void(0)" title="' + lang("Background") + '"><i class="fa fa-map-o"></i><span class="lab-sidebar-title">' + lang("Background") + '</span></a></li>');
    $('#lab-sidebar ul').append('<li><a class="lab_workbook" href="javascript:void(0)" title="' + lang("Lab Tasks") + '"><i class="fa fa-tasks"></i><span class="lab-sidebar-title">' + lang("Lab Tasks") + '</span></a></li>');
    // FIX 5 (Wave B2) — this <li> is a pure DOM anchor: pnetlab-sidebar-tools.js
    // and pnetlab-webconsole.js locate it by id to know where to insert their
    // own toggles (Quick Bar / Resource Monitor / Web Console Tab / etc.), but
    // nothing ever populates it with content (the "HTML Console" switch it once
    // held is gone). Left empty + visible it rendered as a bare ~18px gap
    // between Workbook and Quick Bar. display:none keeps it in the DOM (so the
    // anchor lookups + insertBefore/nextSibling logic in those two files keep
    // working unchanged) while removing its empty visual row.
    $('#lab-sidebar ul').append('<li id="action_change_console" style="display:none"></li>');

    // canvas-flow amputation (b2 Wave 3, B1): the store React bundle (lab.js) is no
    // longer injected — it drew the retired jsPlumb canvas and installed
    // App.topology (now the persistent stub in pnetlab-app-topology-stub.js). The
    // Svelte Flow island (islands/js/canvas-flow.*.js) fetches the topology itself
    // (api-seed) and is the sole canvas. pnqSeedNodePositions (which back-filled
    // PNQStore from lab.js's drawn canvas) is likewise gone — api-seed seeds
    // positions straight from /api/labs/session/topology.

}



/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  printLabStatus, createNodeListRow, printListNodes, printPageLabOpen,
});
