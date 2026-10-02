/* forms/print.js — Phase 3 functions.js decomposition (Tier A, part 2).
 * Moved verbatim from functions.js; window shim keeps the global call
 * contract for the ~40 add-ons + golden javascript.js. CSP-clean. */

function printFormNetworkManage(c){
    var a=c.id;
    var g=c.smart;
    var j=c.vlan8021ad;
    var b=c.left;
    var e=c.top;
    var f=c.name;
    var h=c.interfaces;
    logger(1,"DEBUG: printing network manage modal");
    if (c.type == "dot1q") { return printFormDot1qSwitch(c); }
    if (c.type == "router") { return printFormRouterConfig(c); }
    if (c.type == "wireless") { return printFormWirelessCell(c); }
    var d='<form id="form-network-manage" class="form-horizontal">';
    d+='<div class="form-group"><label class="col-md-3 control-label">'+MESSAGES[92]+'</label><div class="col-md-5"><input class="form-control" disabled name="network[id]" value="'+a+'" type="text"/></div></div>';
    d+='<div class="form-group"><label class="col-md-6 control-label">Smart Bridge (Experimental)</label><div class="col-md1-2"><input type=checkbox style="margin-top: 10px;" value='+(g==1?1:0)+' name="network[smart]" '+(g==1?"checked":"")+"/></div></div>";
    d+='<div class="form-group"><label class="col-md-6 control-label">Enable 802.1ad (Experimental)</label><div class="col-md-2"><input type=checkbox style="margin-top: 10px;" value='+(j==1?1:0)+' name="network[vlan8021ad]" '+(j==1?"checked":"")+"/></div></div>";
    d+='<div class="form-group"><table style="width:80%;margin-left: auto;margin-right: auto;"><thead><tr><th>Node Id</th><th>Node Name</th><th>Interface Id</th><th>Interface Name</th><th>Vlan Id</th></tr></thead>';
    $.each(h,function(k,l){
    d+='<input type=hidden name="network[NodeId_'+k+']" value="'+l.NodeId+'"/>';
    d+='<input type=hidden name="network[NodeName_'+k+']" value="'+l.NodeName+'"/>';
    d+='<input type=hidden name="network[IfId_'+k+']" value="'+l.IfId+'"/>';
    d+='<input type=hidden name="network[IfName_'+k+']" value="'+l.IfName+'"/>';
    d+="<tr><td>"+l.NodeId+"</td><td>"+l.NodeName+"</td><td>"+l.IfId+"</td><td>"+l.IfName+'</td><td><input type=text class="pnq-numeric-input" name="network[Vlan_'+k+']" size=5 value="'+l.VlanId+'" ></td></tr>'
    });
    d+='<input type=hidden name="network[count]" value="'+h.length+'" />';
    d+="</table>";
    d+='<div class="form-group"><div class="col-md-5 col-md-offset-3"><button type="submit" class="btn btn-success">'+MESSAGES[47]+'</button> <button type="button" class="btn" data-dismiss="modal">'+MESSAGES[18]+"</button></div></div></form>";
    addModal(f,d,"","second-win");
    $(".selectpicker").selectpicker();$(".autofocus").focus()
}

// dot1q switch config dialog: per-port access/trunk + allowed-VLAN list + native VLAN.
// Ports appear on-demand (one per connected interface). Reuses the network/manage
// PUT endpoint (smart=1) — applyVlan() branches on the dot1q network type.
function printFormDot1qSwitch(c){
    var a=c.id;
    var f=c.name || ("Network "+a);
    var h=c.interfaces || [];
    logger(1,"DEBUG: printing dot1q switch config modal");
    var vset={};
    var d='<form id="form-network-manage" class="form-horizontal" data-dot1q="1">';
    d+='<input type="hidden" name="network[id]" value="'+a+'"/>';
    d+='<input type="hidden" name="network[smart]" value="1"/>';
    d+='<input type="hidden" name="network[vlan8021ad]" value="0"/>';
    d+='<p class="dot1q-intro">802.1Q switch — a Linux bridge with <code>vlan_filtering</code>. Set each connected port as <b>access</b> (single VLAN) or <b>trunk</b> (allowed list + native VLAN). Changes apply live to running nodes.</p>';
    if (h.length == 0){
        d+='<div class="alert alert-info" role="alert" style="margin:0 0 4px;">No ports yet — connect a node interface to this switch, then reopen this dialog.</div>';
    } else {
        d+='<table class="dot1q-ports"><thead><tr>'+
           '<th class="dot1q-col-port">'+lang("Port")+'</th>'+
           '<th class="dot1q-col-mode">'+lang("Mode")+'</th>'+
           '<th class="dot1q-col-vlan">'+lang("Access / Native VLAN")+'</th>'+
           '<th class="dot1q-col-allowed">'+lang("Allowed VLANs (trunk)")+'</th>'+
           '</tr></thead><tbody>';
        $.each(h,function(k,l){
            var mode=(l.VlanMode=="trunk")?"trunk":"access";
            var vid=(l.VlanId!==undefined && l.VlanId!=="")?l.VlanId:1;
            var allowed=(l.Vlans!==undefined)?l.Vlans:"";
            vset[vid]=1;
            d+='<input type="hidden" name="network[NodeId_'+k+']" value="'+l.NodeId+'"/>';
            d+='<input type="hidden" name="network[NodeName_'+k+']" value="'+l.NodeName+'"/>';
            d+='<input type="hidden" name="network[IfId_'+k+']" value="'+l.IfId+'"/>';
            d+='<input type="hidden" name="network[IfName_'+k+']" value="'+l.IfName+'"/>';
            d+='<tr data-row="'+k+'">';
            d+='<td class="dot1q-port-cell"><i class="glyphicon glyphicon-link"></i> '+l.NodeName+' &mdash; '+l.IfName+'</td>';
            d+='<td><select class="selectpicker show-tick form-control pnq-dot1q-mode" data-row="'+k+'" data-style="selectpicker-button" data-width="100%" name="network[Mode_'+k+']">'+
               '<option value="access"'+(mode=="access"?" selected":"")+'>access</option>'+
               '<option value="trunk"'+(mode=="trunk"?" selected":"")+'>trunk</option></select></td>';
            d+='<td><input type="text" class="form-control pnq-numeric-input" name="network[Vlan_'+k+']" value="'+vid+'"/></td>';
            d+='<td><input type="text" class="form-control pnq-dot1q-allowed" data-row="'+k+'" name="network[Vlans_'+k+']" placeholder="10,20,30-39 (blank = all)" value="'+allowed+'"'+(mode=="trunk"?"":" disabled")+'/></td>';
            d+='</tr>';
        });
        d+='</tbody></table>';
        d+='<input type="hidden" name="network[count]" value="'+h.length+'"/>';
        d+='<p class="dot1q-vlans-used"><span class="dot1q-vlans-used-label">'+lang("VLANs in use")+':</span> '+Object.keys(vset).sort(function(x,y){return x-y;}).join(", ")+'</p>';
    }
    d+='<div class="form-group" style="margin-top:8px;"><div class="col-md-6 col-md-offset-4"><button type="submit" class="btn btn-success">'+MESSAGES[47]+'</button> <button type="button" class="btn" data-dismiss="modal">'+MESSAGES[18]+'</button></div></div></form>';
    addModal(f,d,"","second-win");
    $(".selectpicker").selectpicker();
    $(".autofocus").focus();
}

// Wireless cell config dialog (P4): an SSID + its L2 segment. The SSID is the cell's
// NAME; security set here is pushed to the AP(s) cabled to this cell via the node-edit
// API (apiEditLabNode) — no separate persistence. Also lists the stations currently on
// this SSID (from pnq-wifi.php). Per-client traffic + live apply are tracked follow-ups.
// One WLAN block in the wireless-cell controller (kept as a function so the
// "Add SSID" button can append identical markup). CSP-safe: no inline handlers
// — the dialog wires change/click via delegation. Native <select> (bootstrap-
// select renders dark on the glass skin). Conditional rows (PSK / RADIUS / LAN)
// start shown/hidden to match the WLAN's own security + mode.
function wlanCardHtml(w){
    w=w||{};
    var sec=w.security||'open', mode=w.mode||'bridge';
    var psk=(typeof w.psk==='string')?w.psk:'pnetlab123';
    function opt(v,t,cur){ return '<option value="'+v+'"'+(cur===v?' selected':'')+'>'+t+'</option>'; }
    var lbl='display:block;font-size:11px;color:#3c708a;margin:0 0 2px;font-weight:600;';
    function fld(label,inner){ return '<div style="flex:0 0 auto;">'+(label?'<label style="'+lbl+'">'+label+'</label>':'')+inner+'</div>'; }
    var h='<div class="pnq-wlan-card" style="border:1px solid rgba(60,112,138,0.25);border-radius:8px;padding:10px 12px;margin:0 0 10px;">';
    // Primary row: every core setting on ONE line.
    h+='<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;">';
    h+=fld('SSID','<input type="text" class="form-control pnq-wlan-ssid" value="'+(w.ssid||'')+'" placeholder="e.g. Corp" style="width:170px;"/>');
    h+=fld('VLAN','<input type="number" min="1" max="4094" class="form-control pnq-wlan-vlan" value="'+(w.vlan||10)+'" style="width:80px;"/>');
    h+=fld('Security','<select class="form-control pnq-wlan-sec" style="width:150px;">'+
       opt('open','Open',sec)+opt('wpa2-psk','WPA2-PSK',sec)+opt('wpa3-sae','WPA3-SAE',sec)+opt('wpa-eap','WPA-EAP (RADIUS)',sec)+'</select>');
    h+=fld('AP data path','<select class="form-control pnq-wlan-mode" style="width:150px;">'+
       opt('bridge','Bridge',mode)+opt('routed','Routed (NAT)',mode)+'</select>');
    h+='<div style="flex:0 0 auto;"><button type="button" class="btn btn-danger btn-sm pnq-wlan-del" title="Remove this SSID" style="margin-bottom:1px;"><i class="glyphicon glyphicon-trash"></i></button></div>';
    h+='</div>';
    // Conditional row: PSK / RADIUS / routed-CIDR appear only when relevant.
    h+='<div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-top:8px;">';
    h+='<div class="pnq-wlan-psk-row" style="flex:0 0 auto;'+((sec==='wpa2-psk'||sec==='wpa3-sae')?'':'display:none;')+'"><label style="'+lbl+'">Passphrase</label><input type="text" class="form-control pnq-wlan-psk" value="'+psk+'" style="width:240px;"/></div>';
    h+='<div class="pnq-wlan-eap-row" style="display:flex;gap:12px;'+(sec==='wpa-eap'?'':'display:none;')+'">'+
       '<div style="flex:0 0 auto;"><label style="'+lbl+'">RADIUS server(s)</label><input type="text" class="form-control pnq-wlan-radius" value="'+(w.radius_server||'')+'" placeholder="10.0.0.5 or 10.0.0.5,10.0.0.6" title="One IP, or comma-separated for primary + failover" style="width:220px;"/></div>'+
       '<div style="flex:0 0 auto;"><label style="'+lbl+'">RADIUS secret</label><input type="text" class="form-control pnq-wlan-secret" value="'+(w.radius_secret||'pnetlab-radius')+'" style="width:160px;"/></div></div>';
    h+='<div class="pnq-wlan-lan-row" style="flex:0 0 auto;'+(mode==='routed'?'':'display:none;')+'"><label style="'+lbl+'">AP gateway / CIDR</label><input type="text" class="form-control pnq-wlan-lan" value="'+(w.lan_cidr||'192.168.10.1/24')+'" style="width:200px;"/></div>';
    h+='</div>';
    h+='</div>';
    return h;
}

// Wireless cell = a WLAN controller (P5 VLAN-trunk multi-SSID). One cell hosts
// one OR MANY SSIDs, each pinned to its own VLAN + security. The cell is a
// vlan_filtering bridge (the dot1q-switch plumbing), so it doubles as the
// VLAN-aware switch: an AP cabled in carries every SSID's VLAN over a single
// TRUNK (hostapd multi-BSS, one BSS per SSID -> a VLAN sub-interface of the
// trunk); wired lab nodes (router/DHCP/RADIUS) attach on per-VLAN ACCESS ports.
// The untagged/native VLAN = AP management. The WLAN list persists broker-side
// (wifi_cell_apply/get) and the AP bakes it into hostapd at start.
function printFormWirelessCell(c){
    var a=c.id;
    var f=c.name || ("Cell "+a);
    var cfg=c.WifiCellCfg || {};
    var wlans=(cfg.wlans && cfg.wlans.length)?cfg.wlans:[{ssid:f,vlan:10,security:'open',mode:'bridge'}];
    var mgmt=cfg.mgmt_vlan||1;
    logger(1,"DEBUG: printing wireless cell controller modal");
    var hd='clear:both;font-weight:600;color:#3c708a;margin:8px 0 8px;border-bottom:1px solid rgba(60,112,138,0.25);padding-bottom:4px;';
    var d='<form id="pnq-wifi-cell" data-id="'+a+'" class="form-horizontal">';
    d+='<p style="margin:0 0 12px;">Wireless cell <b>'+f+'</b> — a WLAN controller. Add one or more SSIDs, each on its own VLAN. The AP cabled to this cell broadcasts every SSID (hostapd multi-BSS) and carries them over a single trunk; wired nodes attach on per-VLAN access ports. The untagged/native VLAN is AP management.</p>';
    d+='<div style="'+hd+'">SSIDs (WLANs)</div>';
    d+='<div id="pnq-wlan-list">';
    $.each(wlans,function(k,w){ d+=wlanCardHtml(w); });
    d+='</div>';
    d+='<div style="margin:0 0 12px;"><button type="button" class="btn btn-sm pnq-wlan-add" style="background:#3c708a;border:1px solid #2f5b70;color:#fff;font-weight:600;"><i class="glyphicon glyphicon-plus"></i> Add SSID</button></div>';
    d+='<div style="'+hd+'">Trunk</div>';
    d+='<div class="form-group"><label class="col-md-3 control-label">Management VLAN</label><div class="col-md-3"><input type="number" min="1" max="4094" class="form-control" id="pnq-wifi-mgmt" value="'+mgmt+'"/></div><div class="col-md-6" style="padding-top:7px;font-size:12px;opacity:.7;">native/untagged on the AP trunk</div></div>';
    d+='<div style="'+hd+'">Connected clients</div>';
    d+='<div id="pnq-wifi-cell-clients" style="margin:0 0 6px 12px;"><span style="opacity:.6">Loading…</span></div>';
    d+='<div class="pnq-wifi-err alert alert-danger" style="display:none;"></div>';
    d+='<div class="form-group" style="margin-top:8px;"><div class="col-md-8 col-md-offset-3">'+
       '<button type="button" class="btn btn-success" id="pnq-wifi-cell-save">'+MESSAGES[47]+'</button> '+
       '<button type="button" class="btn" data-dismiss="modal">'+MESSAGES[18]+'</button>'+
       '<span id="pnq-wifi-cell-msg" style="margin-left:10px;font-size:12px;"></span></div></div>';
    d+='</form>';
    addModal(f,d,"","second-win pnq-net-glass");
    // Scope EVERYTHING to THIS modal's form instance. addModal appends a new modal
    // each open and Bootstrap doesn't remove closed ones, so #ids can be duplicated
    // across stale hidden modals — a global $('#id') would bind/read the wrong one
    // (this silently broke Save). $form = the newest form; all reads use $form.find.
    $('#pnq-wifi-cell').last().closest('.modal-dialog').css({'width':'880px','max-width':'96%'});
    // ALL handlers use DOCUMENT delegation scoped to the clicked element's own form
    // (#pnq-wifi-cell). This is the pattern the working "Add SSID" used, and it is
    // immune to addModal's duplicate-id stale modals (a direct .find().on() bind hit
    // the wrong/stale instance, which is why Save silently did nothing). Namespaced
    // .off()+.on() so reopening the dialog never stacks duplicate handlers.
    $(document).off('.pnqwcell')
      .on('change.pnqwcell','#pnq-wifi-cell .pnq-wlan-sec',function(){
        var v=$(this).val(), card=$(this).closest('.pnq-wlan-card');
        card.find('.pnq-wlan-psk-row').css('display',(v==='wpa2-psk'||v==='wpa3-sae')?'block':'none');
        card.find('.pnq-wlan-eap-row').css('display',v==='wpa-eap'?'flex':'none');
      })
      .on('change.pnqwcell','#pnq-wifi-cell .pnq-wlan-mode',function(){
        $(this).closest('.pnq-wlan-card').find('.pnq-wlan-lan-row').toggle($(this).val()==='routed');
      })
      .on('click.pnqwcell','#pnq-wifi-cell .pnq-wlan-del',function(){
        var $form=$(this).closest('#pnq-wifi-cell');
        if($form.find('.pnq-wlan-card').length<=1){
            $form.find('.pnq-wifi-err').text('A cell must keep at least one SSID.').show(); return;
        }
        $(this).closest('.pnq-wlan-card').remove();
      })
      .on('click.pnqwcell','#pnq-wifi-cell .pnq-wlan-add',function(){
        var $form=$(this).closest('#pnq-wifi-cell');
        $form.find('#pnq-wlan-list').append(wlanCardHtml({ssid:'',vlan:wlanNextVlan($form),security:'open',mode:'bridge'}));
      })
      .on('click.pnqwcell','#pnq-wifi-cell-save',function(){
        var $form=$(this).closest('#pnq-wifi-cell');
        var $msg=$form.find('#pnq-wifi-cell-msg'), $err=$form.find('.pnq-wifi-err');
        var err=validateWifiCell($form);
        if(err){ $err.text(err).show(); return; }
        $err.hide();
        var body={id:parseInt($form.attr('data-id'),10), wifi:{mgmt_vlan:parseInt($form.find('#pnq-wifi-mgmt').val(),10)||1, wlans:collectWifiCellWlans($form)}};
        $msg.css('color','#888').text('Saving…');
        // Mirror the proven dot1q/router submit: PUT the JSON string with jQuery's
        // default content-type + dataType json.
        $.ajax({cache:false,type:'PUT',url:'/api/labs/session/network/manage',dataType:'json',data:JSON.stringify(body)})
         .done(function(res){
            if(res && res.status==='success'){ $msg.css('color','#27ae60').text('Saved — (re)start the AP cabled to this cell to apply.'); }
            else { $msg.css('color','#c0392b').text((res&&res.message)?res.message:'Save failed.'); }
         })
         .fail(function(xhr){ var m=(xhr&&xhr.responseJSON&&xhr.responseJSON.message)?xhr.responseJSON.message:'Save failed.'; $msg.css('color','#c0392b').text(m); });
      });
    // Stations on any of this cell's SSIDs (from the Wi-Fi Painter data source).
    var $form0=$('#pnq-wifi-cell').last();
    $.ajax({url:'/pnq-wifi.php',dataType:'json'}).done(function(res){
        var rows='', nodes=(res&&res.nodes)?res.nodes:[];
        var ssids={}; $form0.find('.pnq-wlan-ssid').each(function(){ var s=$(this).val(); if(s) ssids[s]=1; });
        nodes.forEach(function(n){
            if(n.role==='sta' && ssids[n.ssid]){
                rows+='<div><i class="glyphicon glyphicon-phone"></i> '+n.name+
                      ' <span style="opacity:.55">on '+n.ssid+' ('+(n.status==2||n.status==3?'running':'stopped')+')</span></div>';
            }
        });
        $form0.find('#pnq-wifi-cell-clients').html(rows||'<span style="opacity:.6">No stations on this cell yet — set a station’s SSID to one of the above (Connect a station in the Wi-Fi Painter).</span>');
    }).fail(function(){ $form0.find('#pnq-wifi-cell-clients').html('<span style="opacity:.6">(could not load clients)</span>'); });
}
// Suggest the next free VLAN id for a new WLAN card (max existing + 10, floor 10).
function wlanNextVlan($scope){
    var mx=0; ($scope||$(document)).find('.pnq-wlan-vlan').each(function(){ var v=parseInt($(this).val(),10); if(v>mx) mx=v; });
    return mx?mx+10:10;
}
// Read every WLAN card into the cfg array the broker validates. Scoped to the
// dialog's own form so stale duplicate-id modals never leak into the payload.
function collectWifiCellWlans($scope){
    var out=[];
    ($scope||$(document)).find('.pnq-wlan-card').each(function(){
        var $c=$(this), sec=$c.find('.pnq-wlan-sec').val();
        var w={ssid:($c.find('.pnq-wlan-ssid').val()||'').trim(), vlan:parseInt($c.find('.pnq-wlan-vlan').val(),10),
                security:sec, mode:$c.find('.pnq-wlan-mode').val()};
        if(sec==='wpa2-psk'||sec==='wpa3-sae') w.psk=$c.find('.pnq-wlan-psk').val();
        if(sec==='wpa-eap'){ w.radius_server=($c.find('.pnq-wlan-radius').val()||'').trim(); w.radius_secret=$c.find('.pnq-wlan-secret').val(); }
        if(w.mode==='routed') w.lan_cidr=($c.find('.pnq-wlan-lan').val()||'').trim();
        out.push(w);
    });
    return out;
}
// Client-side validation mirroring the broker's _wificell_normalize (broker is
// authoritative; this gives a friendly message before the round-trip).
function validateWifiCell($scope){
    var wl=collectWifiCellWlans($scope), ssids={}, vlans={};
    for(var i=0;i<wl.length;i++){
        var w=wl[i], n=i+1;
        if(!/^[A-Za-z0-9 _.-]{1,32}$/.test(w.ssid)) return 'SSID '+n+': use 1–32 chars (letters, digits, space, _ . -).';
        if(!(w.vlan>=1&&w.vlan<=4094)) return 'SSID "'+w.ssid+'": VLAN must be 1–4094.';
        if(ssids[w.ssid]) return 'Duplicate SSID "'+w.ssid+'".';
        if(vlans[w.vlan]) return 'Duplicate VLAN '+w.vlan+'.';
        ssids[w.ssid]=1; vlans[w.vlan]=1;
        if((w.security==='wpa2-psk'||w.security==='wpa3-sae') && !(w.psk&&w.psk.length>=8&&w.psk.length<=63))
            return 'SSID "'+w.ssid+'": passphrase must be 8–63 characters.';
        if(w.security==='wpa-eap' && w.radius_server){
            var badRadius=w.radius_server.split(',').map(function(s){return s.trim();})
                .filter(function(s){return s!=='';}).some(function(s){return !rtrIsIPv4(s);});
            if(badRadius) return 'SSID "'+w.ssid+'": RADIUS server must be one or more IPv4 addresses (comma-separated), or blank.';
        }
        if(w.mode==='routed' && !rtrIsCIDR(w.lan_cidr))
            return 'SSID "'+w.ssid+'": AP gateway must be an IPv4 address with a mask, e.g. 192.168.10.1/24.';
    }
    return '';
}

// soft-router config dialog: a host-side Linux-netns L3 gateway (NAT + DHCP +
// static routes). Downlink = this segment's gateway; uplink = host internet
// egress or another lab network. Reuses the network/manage PUT endpoint
// (api.php branches on the 'router' type -> broker router_apply). All inputs
// are validated client-side here and authoritatively in the broker.
function printFormRouterConfig(c){
    var a=c.id;
    var f=c.name || ("Network "+a);
    var cfg=c.RouterCfg || {};
    logger(1,"DEBUG: printing router config modal");
    var up=(cfg.uplink=="host"||cfg.uplink=="net")?cfg.uplink:"none";
    var dhcpOn=(cfg.dhcp==1||cfg.dhcp=="1");
    var natOn=(cfg.nat==1||cfg.nat=="1");
    // uplink-network options (any other network on the canvas)
    var upnetopts='';
    if (window.networks){
        $.each(window.networks,function(nid,nv){
            if (nid==a) return;
            var nm=(nv && nv.name)?nv.name:("net"+nid);
            upnetopts+='<option value="'+nid+'"'+((""+cfg.uplink_net_id===""+nid)?" selected":"")+'>'+nm+'</option>';
        });
    }
    var d='<form id="form-network-manage" class="form-horizontal" data-router="1">';
    d+='<input type="hidden" name="network[id]" value="'+a+'"/>';
    d+='<input type="hidden" name="network[is_router]" value="1"/>';
    d+='<p class="rtr-intro">Soft router — a Linux network-namespace L3 gateway running on the host. Set the downlink gateway for connected nodes, an optional uplink (host internet or another network), NAT, DHCP and static routes. Changes apply live; configure after the lab is started.</p>';

    // --- Downlink ---
    d+='<div class="rtr-section-title">Downlink (LAN)</div>';
    d+='<div class="form-group"><label class="col-md-4 control-label">Gateway IP / CIDR</label><div class="col-md-6"><input type="text" class="form-control pnq-rtr-cidr" name="network[gw_cidr]" placeholder="10.10.10.1/24" value="'+(cfg.gw_cidr||"")+'"/><span class="rtr-help">The router\'s address on this segment, e.g. <code>10.10.10.1/24</code>.</span></div></div>';

    // --- DHCP ---
    d+='<div class="form-group"><label class="col-md-4 control-label">DHCP server</label><div class="col-md-6"><label class="rtr-checkbox"><input type="checkbox" class="pnq-rtr-dhcp" name="network[dhcp]" value="1"'+(dhcpOn?" checked":"")+'/> Serve addresses to downlink nodes</label></div></div>';
    d+='<div class="pnq-rtr-dhcp-rows"'+(dhcpOn?"":' style="display:none;"')+'>';
    d+='<div class="form-group"><label class="col-md-4 control-label">Pool start</label><div class="col-md-6"><input type="text" class="form-control pnq-rtr-ip" name="network[dhcp_start]" placeholder="10.10.10.50" value="'+(cfg.dhcp_start||"")+'"/></div></div>';
    d+='<div class="form-group"><label class="col-md-4 control-label">Pool end</label><div class="col-md-6"><input type="text" class="form-control pnq-rtr-ip" name="network[dhcp_end]" placeholder="10.10.10.150" value="'+(cfg.dhcp_end||"")+'"/></div></div>';
    d+='<div class="form-group"><label class="col-md-4 control-label">DNS (optional)</label><div class="col-md-6"><input type="text" class="form-control pnq-rtr-ip-opt" name="network[dhcp_dns]" placeholder="defaults to the gateway" value="'+(cfg.dhcp_dns||"")+'"/></div></div>';
    d+='</div>';

    // --- Uplink ---
    d+='<div class="rtr-section-title">Uplink (WAN)</div>';
    d+='<div class="form-group"><label class="col-md-4 control-label">Uplink</label><div class="col-md-6"><select class="selectpicker show-tick form-control pnq-rtr-uplink" data-style="selectpicker-button" data-width="100%" name="network[uplink]">'+
       '<option value="none"'+(up=="none"?" selected":"")+'>None (routing only)</option>'+
       '<option value="host"'+(up=="host"?" selected":"")+'>Host (internet)</option>'+
       '<option value="net"'+(up=="net"?" selected":"")+'>Another network</option></select></div></div>';
    d+='<div class="pnq-rtr-uplink-net"'+(up=="net"?"":' style="display:none;"')+'>';
    d+='<div class="form-group"><label class="col-md-4 control-label">Uplink network</label><div class="col-md-6"><select class="selectpicker show-tick form-control" data-style="selectpicker-button" data-width="100%" name="network[uplink_net_id]">'+upnetopts+'</select></div></div>';
    d+='<div class="form-group"><label class="col-md-4 control-label">Uplink IP / CIDR</label><div class="col-md-6"><input type="text" class="form-control pnq-rtr-cidr" name="network[uplink_cidr]" placeholder="192.168.0.2/24" value="'+(cfg.uplink_cidr||"")+'"/></div></div>';
    d+='<div class="form-group"><label class="col-md-4 control-label">Uplink gateway (optional)</label><div class="col-md-6"><input type="text" class="form-control pnq-rtr-ip-opt" name="network[uplink_gw]" placeholder="192.168.0.1" value="'+(cfg.uplink_gw||"")+'"/></div></div>';
    d+='</div>';
    d+='<div class="form-group"><label class="col-md-4 control-label">NAT</label><div class="col-md-6"><label class="rtr-checkbox"><input type="checkbox" class="pnq-rtr-nat" name="network[nat]" value="1"'+(natOn?" checked":"")+'/> Masquerade downlink traffic out the uplink</label></div></div>';

    // --- Static routes ---
    d+='<div class="rtr-section-title">Static routes</div>';
    d+='<table class="rtr-routes"><thead><tr><th class="rtr-col-dst">Destination (CIDR or "default")</th><th class="rtr-col-gw">Via gateway</th><th class="rtr-col-x"></th></tr></thead><tbody class="pnq-rtr-routes-body">';
    var routes=(cfg.routes && cfg.routes.length)?cfg.routes:[];
    $.each(routes,function(k,r){
        d+=rtrRouteRowHtml(r.dst||"", r.gw||"");
    });
    d+='</tbody></table>';
    d+='<div class="rtr-routes-add"><button type="button" class="btn btn-default btn-sm pnq-rtr-route-add"><i class="glyphicon glyphicon-plus"></i> Add route</button></div>';

    d+='<div class="rtr-error alert alert-danger pnq-rtr-error" style="display:none;"></div>';
    d+='<div class="form-group" style="margin-top:8px;"><div class="col-md-6 col-md-offset-4"><button type="submit" class="btn btn-success">'+MESSAGES[47]+'</button> <button type="button" class="btn" data-dismiss="modal">'+MESSAGES[18]+'</button></div></div></form>';
    addModal(f,d,"","second-win");
    $(".selectpicker").selectpicker();
    $(".autofocus").focus();
}

// One static-route row (kept as a function so the "Add route" button can
// append identical markup). CSP-safe: no inline handlers.
function rtrRouteRowHtml(dst, gw){
    return '<tr class="pnq-rtr-route-row">'+
        '<td><input type="text" class="form-control pnq-rtr-route-dst" placeholder="0.0.0.0/0 or 192.168.5.0/24" value="'+(dst||"")+'"/></td>'+
        '<td><input type="text" class="form-control pnq-rtr-route-gw" placeholder="10.10.10.254" value="'+(gw||"")+'"/></td>'+
        '<td class="rtr-col-x"><button type="button" class="btn btn-default btn-sm pnq-rtr-route-del"><i class="glyphicon glyphicon-remove"></i></button></td>'+
        '</tr>';
}

// --- soft-router client-side syntax validation (broker re-validates) -------
function rtrIsIPv4(s){
    var m=(""+s).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    for (var i=1;i<=4;i++){ if (parseInt(m[i],10)>255) return false; }
    return true;
}
function rtrIsCIDR(s){
    var p=(""+s).split('/');
    if (p.length!=2) return false;
    if (!rtrIsIPv4(p[0])) return false;
    var n=parseInt(p[1],10);
    return (""+n===p[1] && n>=0 && n<=32);
}
// Returns an error message string, or '' when the config is well-formed.
function validateRouterCfg(rtr){
    if (!rtrIsCIDR(rtr.gw_cidr))
        return 'Downlink gateway must be an IPv4 address with a mask, e.g. 10.10.10.1/24.';
    if (rtr.dhcp){
        if (!rtrIsIPv4(rtr.dhcp_start) || !rtrIsIPv4(rtr.dhcp_end))
            return 'DHCP pool start and end must be valid IPv4 addresses.';
        if (rtr.dhcp_dns && !rtrIsIPv4(rtr.dhcp_dns))
            return 'DHCP DNS must be a valid IPv4 address (or left blank).';
    }
    if (rtr.uplink=='net'){
        if (!rtr.uplink_net_id)
            return 'Select an uplink network.';
        if (!rtrIsCIDR(rtr.uplink_cidr))
            return 'Uplink IP must be an IPv4 address with a mask, e.g. 192.168.0.2/24.';
        if (rtr.uplink_gw && !rtrIsIPv4(rtr.uplink_gw))
            return 'Uplink gateway must be a valid IPv4 address (or left blank).';
    }
    for (var i=0;i<rtr.routes.length;i++){
        var r=rtr.routes[i];
        var okDst=(r.dst=='default'||r.dst=='0.0.0.0/0'||rtrIsCIDR(r.dst));
        if (!okDst)
            return 'Route '+(i+1)+': destination must be a CIDR (e.g. 192.168.5.0/24) or "default".';
        if (!rtrIsIPv4(r.gw))
            return 'Route '+(i+1)+': gateway must be a valid IPv4 address.';
    }
    return '';
}
// Update node data from node list
function printContextMenu(title, body, e) {

    var x = e.clientX;
    var y = e.clientY;
    var pageX = x
    var pageY = y

    $("#context-menu").remove()
    var titleLine = '';
    titleLine = '<li role="presentation" class="dropdown-header">' + lang(title) + '</li>'

    var menu = $(`<div id="context-menu" class="collapse clearfix dropdown">
                    <ul class="dropdown-menu">${titleLine + body}</ul>
                </div>`);

    $('body').append(menu);
    
    var screenW = $('#body').width()
    var screenH = $('#body').height()

    var width = Number(menu.width());
    var height = Number(menu.height());

    if (pageX + width > screenW) pageX = screenW - width;
    if (pageY + height > screenH) pageY = screenH - height;

    menu.css({
        left: pageX + 'px',
        top: pageY + 'px',
        position: 'absolute'
    });

    // Make the menu movable by its header. The link "edit" menu (Type/Stub/
    // Color/Style/…) opens a Style dropdown below it; when the menu lands near
    // the bottom edge the dropdown is clipped, and a fixed menu made it
    // impossible to reach. Dragging the header brings it into view. Form
    // controls don't start a drag (handle is the header only).
    if ($.fn.draggable) {
        menu.draggable({ handle: '.dropdown-header' });
        menu.find('.dropdown-header').css('cursor', 'move')
            .attr('title', lang('Drag to move'));
    }


}

// Folder form
function printFormFolder(action, values) {
    var name = (values['name'] != null) ? values['name'] : '';
    var path = (values['path'] != null) ? values['path'] : '';
    var original = (path == '/') ? '/' + name : path + '/' + name;
    var submit = (action == 'add') ? lang('Add') : lang('Rename');
    var title = (action == 'add') ? lang('Add a new folder') : lang("Rename current folder");
    if (original == '/' && action == 'rename') {
        addModalError(lang("Cannot rename root folder"));
    } else {
        var html = '<form id="form-folder-' + action + '" class="form-horizontal form-folder-' + action + '"><div class="form-group"><label class="col-md-3 control-label">' + lang('Path') + '</label><div class="col-md-5"><input class="form-control" name="folder[path]" value="' + path + '" disabled type="text"/></div></div><div class="form-group"><label class="col-md-3 control-label">' + lang('Name') + '</label><div class="col-md-5"><input class="form-control autofocus" name="folder[name]" value="' + name + '" type="text"/></div></div><div class="form-group"><div class="col-md-5 col-md-offset-3"><input class="form-control" name="folder[original]" value="' + original + '" type="hidden"/><button type="submit" class="btn btn-success">' + submit + '</button> <button type="button" class="btn btn-flat" data-dismiss="modal">' + lang('Cancel') + '</button></div></div></form>';
        console.log('DEBUG: popping up the folder-' + action + ' form.');
        addModal(title, html, '');
        validateFolder();
    }
}

// Network Form
function printFormNetwork(action, values) {

    var zoom = (action == "add") ? getZoomLab() / 100 : 1;
    var id = (values == null || values['id'] == null) ? '' : values['id'];
    var left = (values == null || values['left'] == null) ? null : Math.trunc(values['left'] / zoom);
    var top = (values == null || values['top'] == null) ? null : Math.trunc(values['top'] / zoom);
    var name = (values == null || values['name'] == null) ? 'Net'  : values['name'];
    var type = (values == null || values['type'] == null) ? 'bridge' || 'nat0' : values['type'];
    var icon = (values == null || values['icon'] == null) ? '' : values['icon'];
    var size = (values == null || values['size'] == null) ? '' : values['size'];

    // Only fall back to a type-derived default when the network has no saved
    // icon (e.g. on 'add'). On 'edit' keep the user's chosen icon — this block
    // previously ran unconditionally and reset the picker to the type default,
    // so a custom network icon reverted every time the Edit modal reopened.
    if (icon == '') {
        if (type == 'nat0') {
            icon = 'global.png';
        } else if (type == 'wireless') {
            icon = 'Wireless LAN Controller.png';
        } else if (type == 'dot1q') {
            icon = 'EVE-NG-Switch-Blue.png';
        } else if (type == 'router') {
            icon = 'Router.png';
        } else {
            icon = 'cloud.png';
        }
    }

    var title = (action == 'add') ? lang("Add a new network") : lang("Edit network");

    $.when(getNetworkTypes()).done(function (network_types) {
        // Read privileges and set specific actions/elements
        var html = `<form id="form-network-${action}" class="form-horizontal">`;
        if (action == 'add') {
            // If action == add -> print the nework count input
            html += '<div class="form-group"><label class="col-md-3 control-label">' + lang("Number of networks to add") + '</label><div class="col-md-5"><input class="form-control" name="network[count]" value="1" type="number" min="1" max="50"/></div></div>';
            html += '<input class="form-control" name="network[visibility]" type="hidden" value="1"/>';
        } else {
            // If action == edit -> print the network ID
            html += '<div class="form-group"><label class="col-md-3 control-label">' + lang("ID") + '</label><div class="col-md-5"><input class="form-control" disabled name="network[id]" value="' + id + '" type="text"/></div></div>';
        }

        html += `<div class="form-group">
                    <label class="col-md-3 control-label">${lang("Name/Prefix")}</label>
                    <div class="col-md-5">
                        <input class="form-control autofocus" name="network[name]" value="${name}" type="text"/>
                    </div>
                </div>
                <div class="form-group">
                    <label class="col-md-3 control-label">${lang("Type")}</label>
                    <div class="col-md-5">
                        <select ${action == 'add'? '' : 'disabled'} class="selectpicker show-tick form-control pnq-networktype" name="network[type]" data-live-search="true" data-style="selectpicker-button">`;

                          $.each(network_types, function (key, value) {
                                // Print all network types
                                if (!value.startsWith('pnet') && !value.startsWith('ovs') && !value.startsWith('nat0') ) {
                                    if (value == 'dot1q') { value = 'Switch (dot1q)'; }
                                    if (value == 'router') { value = 'Router (NAT)'; }
                                    if (value == 'wireless') { value = 'Wireless cell (Wi-Fi)'; }
                                    var type_selected = (key == type) ? 'selected ' : '';
                                    html += '<option ' + type_selected + 'value="' + key + '">' + value + '</option>';
                                }
                            });
                            $.each(network_types, function (key, value) {
                                // Print all network types
                                if (value.startsWith('nat0')) {
                                    value = value.replace('nat0', 'NAT')
                                    // Custom Management Port for eth0
    
                                    var type_selected = (key == type) ? 'selected ' : '';
                                    html += '<option ' + type_selected + 'value="' + key + '">' + value + '</option>';
                                }
                            });
                            $.each(network_types, function (key, value) {
                                // Print all network types
                                if (value.startsWith('pnet')) {
                                    value = value.replace('pnet', 'Cloud')
                                    // Custom Management Port for eth0
                                    if (value.startsWith('Cloud0')) {
                                        value = value.replace('Cloud0', 'Management(Cloud0)')
                                    }
                                    var type_selected = (key == type) ? 'selected ' : '';
                                    html += '<option ' + type_selected + 'value="' + key + '">' + value + '</option>';
                                }
                            });

                html += `</select>
                    </div>
                    </div>

                    <div class="form-group">
                        <label class="col-md-3 control-label">${lang("Left")}</label>
                        <div class="col-md-5">
                        <input class="form-control" name="network[left]" value="${left}" type="text"/>
                        </div>
                    </div>

                    <div class="form-group">
                        <label class="col-md-3 control-label">${lang("Top")}</label>
                        <div class="col-md-5">
                            <input class="form-control" name="network[top]" value="${top}" type="text"/>
                        </div>
                    </div>

                    <div class="form-group">
                        <label class="col-md-3 control-label">${lang("Size")} (px)</label>
                        <div class="col-md-5">
                            <input class="form-control" min=0 name="network[size]" value="${size}" type="number"/>
                        </div>
                    </div>

                    <div class="form-group">
                        <label class=" col-md-3 control-label">${lang('Icon')}</label>
                        <div class="col-md-5">
                            <div class="selectpicker box_flex button input action-networkicon" data-size="5">
                                <img id="networkimage_preview" src='/images/icons/${icon}' height=15 width=15 style="margin-right:20px"/> <span id='networkicon_name'>${icon}</span>
                            </div>
                            <input id="networkimage" class="form-control" type="text" style="display:none" value="${icon}" name="network[icon]"/>
                        </div>
                    </div>

                    <div class="form-group">
                        <div class="col-md-5 col-md-offset-3">
                            <button type="submit" class="btn btn-success">${lang("Save")}</button> 
                            <button type="button" class="btn" data-dismiss="modal">${lang('Cancel')}</button>
                        </div>
                    </div>

            </form>
        </form>`;

        // Show the form (pnq-net-glass = Apple-glass white skin, see enhance css)
        addModal(title, html, '', 'second-win pnq-net-glass');
        $('.selectpicker').selectpicker();
        $('.autofocus').focus();
    });
}

function showTemplate(ev) {
    if (ev.currentTarget.checked) {
        $('#form-node-add .disabled').css('display', 'block');
    } else {
        $('#form-node-add .disabled').css('display', 'none');
    }
}



// Map picture
function printNodesMap(values, cb) {
    var title = values['name'] + ': ' + lang("startup-config");
    var html = '<div class="col-md-12">' + values.body + '</div><div class="text-right">' + values.footer + '</div>';
    $('#config-data').html(html);
    cb && cb();
}

//save lab handler
function saveConfig(form) {
    var form_data = form2Array('config');
    var url = '/api/labs/session/configs/edit';
    var type = 'POST';
    App.loading(false)
    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: form_data,
        success: function (data) {
            App.loading(false);
            if (data['status'] == 'success') {
                console.log('DEBUG: config saved.');
                // Close the modal
                $('body').children('.modal').attr('skipRedraw', true);
                if (form) {
                    //$('body').children('.modal').modal('hide');
                    addMessage(data['status'], lang(data['message']));
                }
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                addModal('ERROR', '<p>' + data['message'] + '</p>', '<button type="button" class="btn btn-flat" data-dismiss="modal">' + lang('Close') + '</button>');
            }
        },
        error: function (data) {
            App.loading(false);
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addModal('ERROR', '<p>' + message + '</p>', '<button type="button" class="btn btn-flat" data-dismiss="modal">' + lang('Close') + '</button>');
        }
    });
    return false;  // Stop to avoid POST
}

// Node interfaces
function printFormNodeInterfaces(values) {
    var disabled = values['node_status'] == 2 ? ' disabled="disabled" ' : "";
    $.when(getLabLinks()).done(function (links) {
        var html = '<form id="form-node-connect" class="form-horizontal">';
        html += '<input name="node_id" value="' + values['node_id'] + '" type="hidden"/>';
        if (values['sort'] == 'iol') {
            // IOL nodes need to reorder interfaces
            // i = x/y with x = i % 16 and y = (i - x) / 16
            var iol_interfc = {};
            $.each(values['ethernet'], function (interfc_id, interfc) {
                var x = interfc_id % 16;
                var y = (interfc_id - x) / 16;
                iol_interfc[4 * x + y] = '<div class="form-group"><label class="col-md-3 control-label">' + interfc['name'] + '</label><div class="col-md-5"><select ' + disabled + ' class="selectpicker form-control" name="interfc[' + interfc_id + ']" data-live-search="true" data-style="selectpicker-button"><option value="">' + lang('Disconnected') + '</option>';
                $.each(links['ethernet'], function (link_id, link) {
                    var link_selected = (interfc['network_id'] == link_id) ? 'selected ' : '';
                    iol_interfc[4 * x + y] += '<option ' + link_selected + 'value="' + link_id + '">' + link + '</option>';
                });
                iol_interfc[4 * x + y] += '</select></div></div>';
            });
            $.each(iol_interfc, function (key, value) {
                html += value;
            });
        } else {
            $.each(values['ethernet'], function (interfc_id, interfc) {
                html += '<div class="form-group"><label class="col-md-3 control-label">' + interfc['name'] + '</label><div class="col-md-5"><select ' + disabled + ' class="selectpicker form-control" name="interfc[' + interfc_id + ']" data-live-search="true" data-style="selectpicker-button"><option value="">' + lang('Disconnected') + '</option>';
                $.each(links['ethernet'], function (link_id, link) {
                    var link_selected = (interfc['network_id'] == link_id) ? 'selected ' : '';
                    html += '<option ' + link_selected + 'value="' + link_id + '">' + link + '</option>';
                });
                html += '</select></div></div>';
            });
        }
        if (values['sort'] == 'iol') {
            // IOL nodes need to reorder interfaces
            // i = x/y with x = i % 16 and y = (i - x) / 16
            var iol_interfc = {};
            $.each(values['serial'], function (interfc_id, interfc) {
                var x = interfc_id % 16;
                var y = (interfc_id - x) / 16;
                iol_interfc[4 * x + y] = '<div class="form-group"><label class="col-md-3 control-label">' + interfc['name'] + '</label><div class="col-md-5"><select ' + disabled + ' class="selectpicker form-control" name="interfc[' + interfc_id + ']" data-live-search="true" data-style="selectpicker-button"><option value="">' + lang('Disconnected') + '</option>';
                $.each(links['serial'], function (node_id, serial_link) {
                    if (values['node_id'] != node_id) {
                        $.each(serial_link, function (link_id, link) {
                            var link_selected = (interfc['remote_id'] + ':' + interfc['remote_if'] == node_id + ':' + link_id) ? 'selected ' : '';
                            iol_interfc[4 * x + y] += '<option ' + link_selected + 'value="' + node_id + ':' + link_id + '">' + link + '</option>';
                        });
                    }
                });
                iol_interfc[4 * x + y] += '</select></div></div>';
            });
            $.each(iol_interfc, function (key, value) {
                html += value;
            });
        } else {
            $.each(values['serial'], function (interfc_id, interfc) {
                html += '<div class="form-group"><label class="col-md-3 control-label">' + interfc['name'] + '</label><div class="col-md-5"><select ' + disabled + ' class="selectpicker form-control" name="interfc[' + interfc_id + ']" data-live-search="true" data-style="selectpicker-button"><option value="">' + lang('Disconnected') + '</option>';
                $.each(links['serial'], function (node_id, serial_link) {
                    if (values['node_id'] != node_id) {
                        $.each(serial_link, function (link_id, link) {
                            var link_selected = '';
                            html += '<option ' + link_selected + 'value="' + link_id + '">' + link + '</option>';
                        });
                    }
                });
                html += '</select></div></div>';
            });
        }

        html += '<div class="form-group"><div class="col-md-5 col-md-offset-3"><button ' + disabled + ' type="submit" class="btn btn-success">' + lang("Save") + '</button> <button type="button" class="btn" data-dismiss="modal">' + lang('Cancel') + '</button></div></div></form>';

        addModal(values['node_name'] + ': ' + MESSAGES[116], html, '', 'second-win');
        $('.selectpicker').selectpicker();
    }).fail(function (message) {
        // Cannot get data
        addModalError(message);
    });
}

// Display picture in form
function updateFreeSelect(e, ui) {
    if ($('.node_frame.ui-selected, node_frame.ui-selecting, .network_frame.ui-selected,.network_ui-selecting, .customShape.ui-selected, .customShape.ui-selecting').length > 0) {
        $('#lab-viewport').addClass('freeSelectMode')
    }
    window.freeSelectedNodes = []
    if (LOCK == 0) {
        $.when(lab_topology.setDraggable($('.node_frame, .network_frame, .customShape'), false)).done(function () {
            $.when(lab_topology.clearDragSelection()).done(function () {
                lab_topology.setDraggable($('.node_frame.ui-selected, node_frame.ui-selecting, .network_frame.ui-selected,.network_ui-selecting, .customShape.ui-selected, .customShape.ui-selecting'), true)
                lab_topology.addToDragSelection($('.node_frame.ui-selected, node_frame.ui-selecting, .network_frame.ui-selected,.network_ui-selecting, .customShape.ui-selected, .customShape.ui-selecting'))
            });

        });
    } else {
        $('.customShape.ui-selected, .customShape.ui-selecting').removeClass('ui-selecting').removeClass('ui-selected')
    }
    $('.free-selected').removeClass('free-selected')
    $('.node_frame.ui-selected, node_frame.ui-selecting').addClass('free-selected')
    $('.node_frame.ui-selected, .node_frame.ui-selecting').each(function () {
        window.freeSelectedNodes.push({ name: $(this).data("name"), path: $(this).data("path"), type: 'node' });

    });
}




//=================

// Display lab status
function gimMenu(){
    var gim = localStorage.getItem('left_menu_gim');
    if(gim == 0 || gim == null){
        localStorage.setItem('left_menu_gim', 1);
        $('body').addClass('fixed');
    }else{
        localStorage.setItem('left_menu_gim', 0);
        $('body').removeClass('fixed');
    }
}


/*******************************************************************************
 * Custom Shape Functions
 * *****************************************************************************/
// Get All Text Objects

/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  printFormNetworkManage, printFormDot1qSwitch, wlanCardHtml, printFormWirelessCell, wlanNextVlan, collectWifiCellWlans, validateWifiCell, printFormRouterConfig, rtrRouteRowHtml, rtrIsIPv4, rtrIsCIDR, validateRouterCfg, printContextMenu, printFormFolder, printFormNetwork, showTemplate, printNodesMap, saveConfig, printFormNodeInterfaces, updateFreeSelect, gimMenu,
});
