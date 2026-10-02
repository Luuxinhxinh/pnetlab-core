/* conn/modal.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

function newConnModal(info, oe) {
    // b2: this legacy "Create link" modal reads window.topology, which lab.js
    // populated and is GONE (the stub installs App.topology, not window.topology).
    // The modal is effectively dead (the island owns link creation) — bail
    // gracefully instead of throwing "Cannot destructure ... of undefined" if any
    // stray caller reaches it.
    if (!window.topology) return;
    var { networks, nodes } = window.topology;
    linksourcestyle = '';
    linktargetstyle = '';
    $('#' + info.source.id).addClass("startNode")
    if (info.source.id.search('node') != -1) {
        var node = nodes[info.source.id.replace('node', '')];
        var interfaces = {
            ethernet: typeof node['ethernets'] == 'object' ? node['ethernets'] : {},
            serial: typeof node['serials'] == 'object' ? node['serials'] : {},
        };
        linksourcedata = node;
        linksourcetype = 'node';
        linksourcedata['interfaces'] = interfaces;
        if (linksourcedata['status'] == 0) linksourcestyle = 'grayscale'
    } else {
        linksourcedata = networks[info.source.id.replace('network', '')];
        linksourcetype = 'net';
        if ( linksourcedata['type'] == "nat0" ) 
        {
            linksourcedata['icon'] = 'global.png'
        }
        else {
            linksourcedata['icon'] = "cloud.png"
        }
    }
    if (info.target.id.search('node') != -1) {

        var node = nodes[info.target.id.replace('node', '')];
        var interfaces = {
            ethernet: typeof node['ethernets'] == 'object' ? node['ethernets'] : {},
            serial: typeof node['serials'] == 'object' ? node['serials'] : {},
        };

        linktargetdata = node;
        linktargettype = 'node';
        linktargetdata['interfaces'] = interfaces;
        if (linktargetdata['status'] == 0) linktargetstyle = 'grayscale'
    } else {
        linktargetdata = networks[info.target.id.replace('network', '')];
        linktargettype = 'net';
        if ((linktargetdata['type'] == "nat0")){

            linktargetdata['icon'] = 'global.png'
        }
        else {
                 linktargetdata['icon'] = "cloud.png"

        }
    }

    title = lang('add_connection_title', { src: linksourcedata['name'], dest: linktargetdata['name'] })
    var sourceif = linksourcedata['interfaces'];
    var targetif = linktargetdata['interfaces'];

    console.log(linksourcedata);
    console.log(linktargetdata);
    /* choose first free interface */
    if (linksourcetype == 'node') {
        console.log('DEBUG: looking interfaces... ');
        linksourcedata['selectedif'] = '';
        var tmp_interfaces = {};
        for (var key in sourceif['ethernet']) {
            console.log('DEBUG: interface id ' + key + ' named ' + sourceif['ethernet'][key]['name'] + ' ' + sourceif['ethernet'][key]['network_id'])
            tmp_interfaces[key] = sourceif['ethernet'][key]
            tmp_interfaces[key]['type'] = 'ethernet'
            if ((sourceif['ethernet'][key]['network_id'] == 0) && (linksourcedata['selectedif'] == '')) {
                linksourcedata['selectedif'] = key;
            }
        }
        for (var key in sourceif['serial']) {
            console.log('DEBUG: interface id ' + key + ' named ' + sourceif['serial'][key]['name'] + ' ' + sourceif['serial'][key]['remote_id'])
            tmp_interfaces[key] = sourceif['serial'][key]
            tmp_interfaces[key]['type'] = 'serial'
            if ((sourceif['serial'][key]['remote_id'] == 0) && (linksourcedata['selectedif'] == '')) {
                linksourcedata['selectedif'] = key;
            }
        }
        linksourcedata['interfaces'] = tmp_interfaces
    }
    if (linksourcedata['selectedif'] == '') linksourcedata['selectedif'] = 0;
    if (linktargettype == 'node') {
        console.log('DEBUG: looking interfaces... ');
        linktargetdata['selectedif'] = '';
        var tmp_interfaces = []
        for (var key in targetif['ethernet']) {
            console.log('DEBUG: interface id ' + key + ' named ' + targetif['ethernet'][key]['name'] + ' ' + targetif['ethernet'][key]['network_id'])
            tmp_interfaces[key] = targetif['ethernet'][key];
            tmp_interfaces[key]['type'] = 'ethernet'
            if ((targetif['ethernet'][key]['network_id'] == 0) && (linktargetdata['selectedif'] == '')) {
                linktargetdata['selectedif'] = key;
            }
        }
        for (var key in targetif['serial']) {
            console.log('DEBUG: interface id ' + key + ' named ' + targetif['serial'][key]['name'] + ' ' + targetif['serial'][key]['remote_id'])
            tmp_interfaces[key] = targetif['serial'][key];
            tmp_interfaces[key]['type'] = 'serial';
            if ((targetif['serial'][key]['remote_id'] == 0) && (linktargetdata['selectedif'] == '')) {
                linktargetdata['selectedif'] = key;
            }
        }
        linktargetdata['interfaces'] = tmp_interfaces
    }
    if (linktargetdata['selectedif'] == '') linktargetdata['selectedif'] = 0;
    //if ( linksourcedata['status'] == 2 || linktargetdata['status'] == 2 ) { lab_topology.detach( info.connection ) ; return }
    window.tmpconn = info.connection
    html = '<form id="addConn" class="addConn-form">' +
        '<input type="hidden" name="addConn[srcNodeId]" value="' + linksourcedata['id'] + '">' +
        '<input type="hidden" name="addConn[dstNodeId]" value="' + linktargetdata['id'] + '">' +
        '<input type="hidden" name="addConn[srcNodeType]" value="' + linksourcetype + '">' +
        '<input type="hidden" name="addConn[dstNodeType]" value="' + linktargettype + '">' +
        '<div class="row">' +
        '<div class="col-md-4">' +
        '<div style="text-align:center;" >' + linksourcedata['name'] + '</div>' +
        '<img src="' + '/images/icons/' + linksourcedata['icon'] + '" class="' + linksourcestyle + ' img-responsive" style="margin:0 auto;">' +
        '<div style="width:3px;height: ' + ((linksourcetype == 'net') ? '0' : '10') + 'px; margin: 0 auto; background-color:#444"></div>' +
        '<div style="margin: 0 auto; width:50%; text-align:center;" class="' + ((linksourcetype == 'net') ? 'hidden' : '') + '">' +
        '<text class="aLabel addConnSrc text-center" >' + ((linksourcetype == 'node' && linksourcedata['interfaces'][linksourcedata['selectedif']]) ? linksourcedata['interfaces'][linksourcedata['selectedif']]['name'] : '') + '</text>' +
        '</div>' +
        '<div style="width:3px;height:160px; margin: 0 auto; background-color:#444"></div>' +
        '<div style="margin: 0 auto; width:50%; text-align:center;" class="' + ((linktargettype == 'net') ? 'hidden' : '') + '">' +
        '<text class="aLabel addConnDst text-center" >' + ((linktargettype == 'node' && linktargetdata['interfaces'][linktargetdata['selectedif']]) ? linktargetdata['interfaces'][linktargetdata['selectedif']]['name'] : '') + '</text>' +
        '</div>' +
        '<div style="width:3px;height: ' + ((linktargettype == 'net') ? '0' : '10') + 'px; margin: 0 auto; background-color:#444"></div>' +
        '<img src="/images/icons/' + linktargetdata['icon'] + '" class="' + linktargetstyle + ' img-responsive" style="margin:0 auto;">' +
        '<div style="text-align:center;" >' + linktargetdata['name'] + '</div>' +
        ((linksourcedata['status'] == 2 || linktargetdata['status'] == 2) ? '<div style="color:red"><strong>' + lang('Note') + ':</strong> ' + lang('serial_port_unsupport_hot_plug') + '</div>' : '') + //EVE_STORE hot link
        '</div>' +
        '<div class="col-md-8">' +
        '<div class="form-group">' +
        '<label>Source ID: ' + linksourcedata['id'] + '</label>' +
        '<p style="margin:0px;"></p>' +
        '<label>Source Name: ' + linksourcedata['name'] + '</label>' +
        '<p style="">type - ' + ((linksourcetype == 'net') ? 'Network' : 'Node') + '</p>' +
        '</div>' +
        '<div class="form-group">' +
        '<div class="form-group ' + ((linksourcetype == 'net') ? 'hidden' : '') + '">' +
        '<label>Choose Interface for ' + linksourcedata['name'] + '</label>' +
        '<select name="addConn[srcConn]" class="form-control srcConn">'
    if (linksourcetype == 'node') {
        // Eth first
        var tmp_name = [];
        var reversetab = [];
        for (key in linksourcedata['interfaces']) {
            tmp_name.push(linksourcedata['interfaces'][key]['name'])
            reversetab[linksourcedata['interfaces'][key]['name']] = key
        }
        var ordered_name = tmp_name.sort(natSort)
        for (key in ordered_name) {
            okey = reversetab[ordered_name[key]];
            if (linksourcedata['interfaces'][okey]['type'] == 'ethernet') {

                var disable = false;
                var optionsText = linksourcedata['interfaces'][okey]['name'];

                if (isset(linksourcedata['interfaces'][okey]['network_id']) && networks[linksourcedata['interfaces'][okey]['network_id']]) {
                    disable = true;
                    optionsText += ` ${lang('connected to')} `
                    var links = App.topology.links;
                    for (let tkey in links) {
                        var link = links[tkey];
                        if ((link.source.node.get('id') == linksourcedata['id']) && (link.source.interface.get('name') == linksourcedata['interfaces'][okey]['name'])) {
                            
                            optionsText += link.dest.node.get('name');
                            if(link.dest.interface) optionsText += ' ' + link.dest.interface.get('name');
                        }
                        if ((link.dest.node.get('id') == linksourcedata['id']) && (link.dest.interface.get('name') == linksourcedata['interfaces'][okey]['name'])) {
                            
                            optionsText += link.source.node.get('name');
                            if(link.dest.interface) optionsText += ' ' + link.source.interface.get('name');
                        }
                    }

                };
                if (linksourcedata['type'] == 'docker' && optionsText == 'eth0') {
                    disable = true;
                    optionsText = lang('port_for_management', { port: optionsText });
                }
                if (linksourcedata['type'] == 'qemu' && optionsText == 'winbox' ){

                    disable = true;
                    optionsText = lang(' eth1 port_for_winbox', { port: optionsText });
                }
                   if (linksourcedata['type'] == 'qemu' && optionsText == 'Mgmt http' ){

                    disable = true;
                    optionsText = lang(' port_for_management http ', { port: optionsText });

                }
                 if (linksourcedata['type'] == 'qemu' && optionsText == 'Mgmt https' ){

                    disable = true;
                    optionsText = lang(' port_for_management https', { port: optionsText });

                }
                 if (linksourcedata['type'] == 'qemu' && optionsText == 'Mgmt ssh' ){

                    disable = true;
                    optionsText = lang(' port_for_management ssh', { port: optionsText });

                }
                 if (linksourcedata['type'] == 'qemu' && optionsText == 'Mgmt rdp' ){

                    disable = true;
                    optionsText = lang(' port_for_management rdp', { port: optionsText });

                }
                 if (linksourcedata['type'] == 'qemu' && optionsText == 'Mgmt rdp-tls' ){

                    disable = true;
                    optionsText = lang(' port_for_management rdp-tls', { port: optionsText });

                }

                html += `<option value="${okey},ethernet" ${disable == true ? 'disabled="true"' : ''}>${optionsText}`
            }
        }

        for (key in ordered_name) {
            okey = reversetab[ordered_name[key]];
            if (linksourcedata['interfaces'][okey]['type'] == 'serial') {
                html += '<option value="' + okey + ',serial' + '" ' + ((linksourcedata['interfaces'][okey]['remote_id'] != 0) ? 'disabled="true"' : '') + '>' + linksourcedata['interfaces'][okey]['name']
                if (linksourcedata['interfaces'][okey]['remote_id'] != 0) {
                    html += ` ${lang('connected to')} `
                    var remoteNode = nodes[linksourcedata['interfaces'][okey]['remote_id']];
                    var remoteInterf = remoteNode.serials[linksourcedata['interfaces'][okey]['remote_if']]
                    if(remoteNode && remoteInterf){
                        html += remoteNode['name']
                        html += ' ' + remoteInterf['name']
                    }
                    
                }
            }
        }
    }
    html += '</option>'
    html += '</select>' +
        '<div style="width:3px;height:30px;"></div>' +
        '</div>' +
        '</div>' +
        '<div style="width:3px;height:30px;"></div>' +
        '<div class="form-group">' +
        '<div class="form-group ' + ((linktargettype == 'net') ? 'hidden' : '') + '">' +
        '<label>Choose Interface for ' + linktargetdata['name'] + '</label>' +
        '<select name="addConn[dstConn]" class="form-control dstConn">'

    if (linktargettype == 'node') {
        // Eth first
        var tmp_name = [];
        var reversetab = [];
        for (key in linktargetdata['interfaces']) {
            tmp_name.push(linktargetdata['interfaces'][key]['name'])
            reversetab[linktargetdata['interfaces'][key]['name']] = key
        }
        var ordered_name = tmp_name.sort(natSort);
        for (key in ordered_name) {
            okey = reversetab[ordered_name[key]];
            if (linktargetdata['interfaces'][okey]['type'] == 'ethernet') {

                var disable = false;
                var optionsText = linktargetdata['interfaces'][okey]['name'];

                if (isset(linktargetdata['interfaces'][okey]['network_id']) && networks[linktargetdata['interfaces'][okey]['network_id']]) {
                    disable = true;
                    optionsText += ' connected to '
                    
                    var links = App.topology.links;
                    for (let tkey in links) {
                        var link = links[tkey];
                        if ((link.source.node.get('id') == linktargetdata['id']) && (link.source.interface.get('name') == linktargetdata['interfaces'][okey]['name'])) {
                            
                            optionsText += link.dest.node.get('name');
                            if(link.dest.interface) optionsText += ' ' + link.dest.interface.get('name');
                        }
                        if ((link.dest.node.get('id') == linktargetdata['id']) && (link.dest.interface.get('name') == linktargetdata['interfaces'][okey]['name'])) {
                            
                            optionsText += link.source.node.get('name');
                            if(link.dest.interface) optionsText += ' ' + link.source.interface.get('name');
                        }
                    }

                };

                if (linktargetdata['type'] == 'docker' && optionsText == 'eth0') {
                    disable = true;
                    optionsText = lang('port_for_management', { port: optionsText });
                }
                if (linktargetdata['type'] == 'qemu' && optionsText == 'winbox' ){

                    disable = true;
                    optionsText = lang(' eth1 port_for_winbox', { port: optionsText });
                }
                if (linktargetdata['type'] == 'qemu' && optionsText == 'Mgmt http' ){

                    disable = true;
                    optionsText = lang(' port_for_management http ', { port: optionsText });

                }
                 if (linktargetdata['type'] == 'qemu' && optionsText == 'Mgmt https' ){

                    disable = true;
                    optionsText = lang(' port_for_management https', { port: optionsText });

                }
                 if (linktargetdata['type'] == 'qemu' && optionsText == 'Mgmt ssh' ){

                    disable = true;
                    optionsText = lang(' port_for_management ssh', { port: optionsText });

                }
                 if (linktargetdata['type'] == 'qemu' && optionsText == 'Mgmt rdp' ){

                    disable = true;
                    optionsText = lang(' port_for_management rdp', { port: optionsText });

                }
                 if (linktargetdata['type'] == 'qemu' && optionsText == 'Mgmt rdp-tls' ){

                    disable = true;
                    optionsText = lang(' port_for_management rdp-tls', { port: optionsText });

                }

                html += `<option value="${okey},ethernet" ${disable == true ? 'disabled="true"' : ''}>${optionsText}`

            }
        }
        // Serial first
        for (key in ordered_name) {
            okey = reversetab[ordered_name[key]];
            if (linktargetdata['interfaces'][okey]['type'] == 'serial') {
                html += '<option value="' + okey + ',serial' + '" ' + ((linktargetdata['interfaces'][okey]['remote_id'] != 0) ? 'disabled="true"' : '') + '>' + linktargetdata['interfaces'][okey]['name']
                if (linktargetdata['interfaces'][okey]['remote_id'] != 0) {
                    html += ' ' + lang('connected to') + ' '
                    html += nodes[linktargetdata['interfaces'][okey]['remote_id']]['name']
                    html += ' ' + linktargetdata['interfaces'][okey]['remote_if_name']
                }
            }
        }
    }
    html += '</option>'
    html += '</select>' +
        '<div style="width:3px;height:30px;"></div>' +
        '</div>' +
        '</div>' +
        '<div class="form-group">' +
        '<label>' + lang('Destination ID') + ': ' + linktargetdata['id'] + '</label>' +
        '<p style="margin:0px;"></p>' +
        '<label>' + lang('Destination Name') + ': ' + linktargetdata['name'] + '</label>' +
        '<p style="text-muted">type - ' + ((linktargettype == 'net') ? lang('Network') : lang('Node')) + '</p>' +
        '</div>' +
        '</div>' +
        '<div class="col-md-8 btn-part col-md-offset-6">' +
        '<div class="form-group">' +
        '<button type="submit" class="btn btn-success addConn-form-save">' + lang("Save") + '</button>' +
        '<button type="button" class="btn cancelForm" data-dismiss="modal">' + lang('Cancel') + '</button>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '</form>'

    addModal(title, html, '');
    window.topoChange = true;

    $('body').on('change', 'select.srcConn', function (e) {
        var iname = $('select.srcConn option[value="' + $('select.srcConn').val() + '"]').text();
        $('.addConnSrc').html(iname)
    });
    $('body').on('change', 'select.dstConn', function (e) {
        var iname = $('select.dstConn option[value="' + $('select.dstConn').val() + '"]').text();
        $('.addConnDst').html(iname)
    });
}

function connContextMenu(e, ui) {
    window.connContext = 1
    window.connToDel = e
}


/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  newConnModal, connContextMenu,
});
