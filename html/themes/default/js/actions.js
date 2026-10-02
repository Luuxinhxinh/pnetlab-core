// vim: syntax=javascript tabstop=4 softtabstop=0 noexpandtab laststatus=1 ruler

/**
 * html/themes/default/js/actions.js
 *
 * Actions for HTML elements
 *
 * @author Andrea Dainese <andrea.dainese@gmail.com>
 * @copyright 2014-2016 Andrea Dainese
 * @license BSD-3-Clause https://github.com/dainok/unetlab/blob/master/LICENSE
 * @link http://www.unetlab.com/
 * @version 20160719
 */

var KEY_CODES = {
    "tab": 9,
    "enter": 13,
    "shift": 16,
    "ctrl": 17,
    "alt": 18,
    "escape": 27
};

// Attach files
$('body').on('change', 'input[type=file]', function (e) {
    ATTACHMENTS = e.target.files;
});

// Add the selected filename to the proper input box
$('body').on('change', 'input[name="import[file]"]', function (e) {
    $('input[name="import[local]"]').val($(this).val());
});

// Choose node config upload file
$('body').on('change', 'input[name="upload[file]"]', function (e) {
    $('input[name="upload[path]"]').val($(this).val());
});

// Click on empty canvas background clears selection (mirrors the Escape path).
// Guards:
//   1. target must BE the viewport/canvas (not a node, network, shape, overlay,
//      connector svg, or rubber-band element)
//   2. the trailing click a rubber-band (lasso) drag fires on mouseup must NOT
//      deselect what the lasso just selected. Class-based detection is racy —
//      lab.js clears its selecting state in its own directly-bound mouseup,
//      before any delegated handler sees it — so we detect the drag
//      geometrically: if the pointer travelled more than a few px between
//      mousedown and click, it was a drag, not a deselect click.
(function () {
    var _downX = null, _downY = null;
    var DRAG_PX = 4;
    document.addEventListener('mousedown', function (e) {
        _downX = e.clientX; _downY = e.clientY;
    }, true);
    $('#lab-viewport').on('click', function (e) {
        var t = e.target;
        if (t !== this) return;   // click landed on a child element, not the canvas
        // A lasso/pan drag ends with a click whose pointer moved — leave it alone.
        if (_downX !== null &&
            (Math.abs(e.clientX - _downX) > DRAG_PX ||
             Math.abs(e.clientY - _downY) > DRAG_PX)) return;
        // Belt-and-suspenders: skip if a rubber-band is still actively present
        if ($('.ui-selecting').length || $('#mouse_frame').length) return;
        $('.free-selected').removeClass('free-selected');
        $('.ui-selected').removeClass('ui-selected');
        $('.ui-selecting').removeClass('ui-selecting');
        $('#lab-viewport').removeClass('freeSelectMode');
        if (typeof lab_topology !== 'undefined' && lab_topology.clearDragSelection) {
            lab_topology.clearDragSelection();
        }
        window.freeSelectedNodes = [];
    });
}());

// On escape remove mouse_frame
$(document).on('keydown', 'body', function (e) {
    var $labViewport = $("#lab-viewport")
        , isFreeSelectMode = $labViewport.hasClass("freeSelectMode")
        , isEditCustomShape = $labViewport.has(".edit-custom-shape-form").length > 0
        , isEditText = $labViewport.has(".edit-custom-text-form").length > 0
        , isEditcustomText = $labViewport.has(".editable").length > 0
        ;

    if (KEY_CODES.escape == e.which) {
        $('.lab-viewport-click-catcher').unbind('click');
        $('#mouse_frame').remove();
        $('#lab-viewport').removeClass('lab-viewport-click-catcher').data("prevent-contextmenu", false);
        $('#context-menu').remove();
        $('.free-selected').removeClass('free-selected')
        $('.ui-selected').removeClass('ui-selected')
        $('.ui-selecting').removeClass('ui-selecting')
        $("#lab-viewport").removeClass('freeSelectMode')
        lab_topology.clearDragSelection();
        if (LOCK == 0) {
            lab_topology.setDraggable($('.node_frame, .network_frame, .customShape'), true)
        }
    }
    if (isEditCustomShape && KEY_CODES.escape == e.which) {
        $(".edit-custom-shape-form button.cancelForm").click(); // it will handle all the stuff
    }
    if (isEditText && KEY_CODES.escape == e.which) {
        $(".edit-custom-text-form button.cancelForm").click();  // it will handle all the stuff
    }
    if (isEditcustomText && KEY_CODES.escape == e.which) {
        $("p").blur()
        $("p").focusout()
    }
});

//Add picture MAP
$('body').on('click', '.follower-wrapper', function (e) {
    var img_width_original = +$(".follower-wrapper img").attr('width-val')
    var img_height_original = +$(".follower-wrapper img").attr('height-val')
    var data_x = $("#follower").data("data_x");
    var data_y = $("#follower").data("data_y");
    var img_width_resized = $(".follower-wrapper img").width()
    var img_height_resized = $(".follower-wrapper img").height()

    var k = 1;
    if ($('.follower-wrapper img').hasClass('picture-img-autosozed')) {
        k = img_width_original / img_width_resized;
    }

    var y = (parseInt((data_y).toFixed(0)) * k).toFixed(0);
    var x = (parseInt((data_x).toFixed(0)) * k).toFixed(0);
    var current_href = ""
    if ($("#map_nodeid option:selected").val().match(/CUSTOM/)) {
        $('form textarea.custommap').val($('form textarea.custommap').val() + "<area shape='circle' alt='img' coords='" + x + "," + y + (",30' href='telnet://{{IP}}:{{NODE" + $("#map_nodeid option:selected").val() + "}}'>\n").replace(/telnet.*NODECUSTOM}}/, "proto://CUSTOM_IP:CUSTOM_PORT"));
    } else {
        $('form textarea.map').val($('form textarea.map').val() + "<area shape='circle' alt='img' coords='" + x + "," + y + (",30' href='telnet://{{IP}}:{{NODE" + $("#map_nodeid option:selected").val() + "}}'>\n").replace(/telnet.*NODECUSTOM}}/, "proto://CUSTOM_IP:CUSTOM_PORT"));
    }
    var htmlsvg = "";
    htmlsvg = '<div class="map_mark" id="' + x + "," + y + "," + 30 + '" style="position:absolute;top:' + (y - 30) + 'px;left:' + (x - 30) + 'px;width:60px;height:60px;"><svg width="60" height="60"><g><ellipse cx="30" cy="30" rx="28" ry="28" stroke="#000000" stroke-width="2" fill="#ffffff"></ellipse><text x="50%" y="50%" text-anchor="middle" alignment-baseline="central" stroke="#000000" stroke-width="0px" dy=".2em" font-size="12" >' + ("NODE" + $("#map_nodeid option:selected").val()).replace(/NODE.*CUSTOM.*/, "CUSTOM") + '</text></g></svg></div>'
    $(".follower-wrapper").append(htmlsvg)
});


//<div class="map_mark" id="'+area.coords+'"
// context menu on picture edit
$(document).on('contextmenu', '.follower-wrapper', function (e) {
    // Prevent default context menu on viewport
    e.stopPropagation();
    e.preventDefault();
    var body = '';
    body += `<li><a class="action-showfull-picture" href="javascript:void(0)">${lang('Set original size')}</a></li>`;
    body += `<li><a class="action-autosize" href="javascript:void(0)">${lang('Set autosize')}</a></li>`;
    //printContextMenu('Picture size', body, e);
})

$(document).on('click', '.action-showfull-picture', function () {
    $('#context-menu').remove();
    FOLLOW_WRAPPER_IMG_STATE = 'full'
    $('.follower-wrapper img').removeClass('picture-img-autosozed')
    $('#lab_picture img').removeClass('picture-img-autosozed')
})

$(document).on('click', '.action-autosize', function () {
    $('#context-menu').remove();
    FOLLOW_WRAPPER_IMG_STATE = 'resized'
    $('.follower-wrapper img').addClass('picture-img-autosozed')
    $('#lab_picture img').addClass('picture-img-autosozed')
})

// Accept privacy
$(document).on('click', '#privacy', function () {
    $.cookie('privacy', 'true', {
        expires: 90,
        path: '/'
    });
    if ($.cookie('privacy') == 'true') {
        window.location.reload();
    }
});

// Select folders, labs or users
$(document).on('click', 'a.folder, a.lab, tr.user', function (e) {
    console.log('DEBUG: selected "' + $(this).attr('data-path') + '".');
    if ($(this).hasClass('selected')) {
        // Already selected -> unselect it
        $(this).removeClass('selected');
    } else {
        // Selected it
        $(this).addClass('selected');
    }
});

// Remove modal on close
$(document).on('hidden.bs.modal', '.modal', function (e) {
    $(this).remove();
    if (window.topoChange) {
        App.topology.printTopology();
        window.topoChange = false;
    }
    if ($('body').children('.modal.fade.in')) {
        $('body').children('.modal.fade.in').focus();
        $('body').children('.modal.fade.in').css("overflow-y", "auto");
    }

});

// Set autofocus on show modal
$(document).on('shown.bs.modal', '.modal', function () {
    $('.autofocus').focus();
});

// After node/network move
function ObjectStartDrag() {
    window.objectClick = true;
    setTimeout(function () { window.objectClick = false }, 200);
}

function ObjectPosUpdate(event, cb){
    if(App.topology.isClick) return;
    if(window.updatePosTimeout) clearTimeout(window.updatePosTimeout);
    var moveObjects = $('.ui-selected');
    window.updatePosTimeout = setTimeout(function(){
        App.topology.ObjectPosUpdateExec(event, moveObjects).then(function(res){
            if(cb) cb();
        })
    }, 300)
}


// Close all context menu
$(document).on('mousedown', '*', function (e) {

    if (!$(e.target).is('#context-menu, #context-menu *')) {
        // If click outside context menu, remove the menu
        e.stopPropagation();
        $('#context-menu').remove();
    }
});

// Open context menu block
$(document).on('click', '.menu-collapse, .menu-collapse i', function (e) {
    e.preventDefault();  // Prevent default behaviour
    var item_class = $(this).attr('data-path');
    $('.' + item_class).slideToggle('fast');
});

// Open context menu block
$(document).on('click', '.menu-appear, .menu-appear i', function (e) {
    e.preventDefault();  // Prevent default behaviour
    var windowWidth = $(window).width();
    var windowHeight = $(window).height();
    var contextMenuClickX = $("#lab-viewport").data('contextMenuClickXY').x
    var contextMenuClickY = $("#lab-viewport").data('contextMenuClickXY').y
    if (windowWidth - 320 <= contextMenuClickX) {
        $('#capture-menu').css('left', -150)
    } else {
        $('#capture-menu').css('right', -150)
    }
    $('#capture-menu li a').toggle('fast')
    $('#capture-menu').toggle({
        duration: 10,
        progress: function () {
            // console.log('arguments',arguments)
            // console.log("height, fix", $('#capture-menu').height(), windowHeight - contextMenuClickY - 145)
            if (contextMenuClickY > windowHeight - 300) {
                if ($('#capture-menu').height() > contextMenuClickY + 145) {
                    $('#capture-menu').css({
                        'height': contextMenuClickY - 145,
                        'overflow': 'hidden',
                        'overflow-y': 'scroll'
                    })
                }
                $('#capture-menu').css('bottom', '114px')
            } else {
                if ($('#capture-menu').height() > (windowHeight - contextMenuClickY - 145)) {
                    $('#capture-menu').css({
                        'height': windowHeight - contextMenuClickY - 145,
                        'top': '136px',
                        'overflow': 'hidden',
                        'overflow-y': 'scroll'
                    })
                }
            }
        },
        complete: function () {

            if (!contextMenuClickY > windowHeight - 300 && $('#capture-menu').height() > (windowHeight - contextMenuClickY - 145)) {
                $('#capture-menu').css({
                    'height': windowHeight - contextMenuClickY - 145,
                    'top': '136px',
                    'overflow': 'hidden',
                    'overflow-y': 'scroll'
                })
                console.log('hei2', windowHeight - contextMenuClickY - 145)
            }

        }
    })
    if ($('.menu-appear > i').hasClass('glyphicon-chevron-left')) {
        $('.menu-appear > i').addClass('glyphicon-chevron-right').removeClass('glyphicon-chevron-left')
    } else {
        $('.menu-appear > i').addClass('glyphicon-chevron-left').removeClass('glyphicon-chevron-right')
    }
});
// Open context menu block
$(document).on('click', '.menu-stop-appear, .menu-stop-appear i', function (e) {
    e.preventDefault();  // Prevent default behaviour
    var windowWidth = $(window).width();
    var windowHeight = $(window).height();
    var contextMenuClickX = $("#lab-viewport").data('contextMenuClickXY').x
    var contextMenuClickY = $("#lab-viewport").data('contextMenuClickXY').y
    if (windowWidth - 320 <= contextMenuClickX) {
        $('#stop-menu').css('right', -150)
    } else {
        $('#stop-menu').css('left', -150)
    }
    $('#stop-menu li a').toggle('fast')
    $('#stop-menu').toggle({
        duration: 10,
        progress: function () {
            // console.log('arguments',arguments)
            // console.log("height, fix", $('#capture-menu').height(), windowHeight - contextMenuClickY - 145)
            if (contextMenuClickY > windowHeight - 300) {
                if ($('#stop-menu').height() > contextMenuClickY + 145) {
                    $('#stop-menu').css({
                        'height': contextMenuClickY - 145,
                        'overflow': 'hidden',
                        'overflow-y': 'scroll'
                    })
                }
                $('#stop-menu').css('bottom', '114px')
            } else {
                if ($('#stop-menu').height() > (windowHeight - contextMenuClickY - 145)) {
                    $('#stop-menu').css({
                        'height': windowHeight - contextMenuClickY - 145,
                        'top': '136px',
                        'overflow': 'hidden',
                        'overflow-y': 'scroll'
                    })
                }
            }
        },
        complete: function () {

            if (!contextMenuClickY > windowHeight - 300 && $('#stop-menu').height() > (windowHeight - contextMenuClickY - 145)) {
                $('#stop-menu').css({
                    'height': windowHeight - contextMenuClickY - 145,
                    'top': '136px',
                    'overflow': 'hidden',
                    'overflow-y': 'scroll'
                })
                console.log('hei2', windowHeight - contextMenuClickY - 145)
            }

        }
    })
    if ($('.menu-stop-appear > i').hasClass('glyphicon-chevron-left')) {
        $('.menu-stop-appear > i').addClass('glyphicon-chevron-right').removeClass('glyphicon-chevron-left')
    } else {
        $('.menu-stop-appear > i').addClass('glyphicon-chevron-left').removeClass('glyphicon-chevron-right')
    }
});
// canvas-flow amputation (b2 Wave 3): the classic #lab-viewport is retired; the
// lab page is marked by #pnq-lab-page. The flow island re-dispatches an empty-pane
// right-click here (with pageX/pageY set to FLOW coords) to open this same "Add a
// new object" menu. Delegate + contextClickXY store both move to the new marker.
$(document).on('contextmenu', '#pnq-lab-page', function (e) {
    // Prevent default context menu on viewport
    e.stopPropagation();
    e.preventDefault();

    $("#pnq-lab-page").data('contextClickXY', { 'x': e.pageX, 'y': e.pageY })

    console.log(1, 'DEBUG: action = opencontextmenu');

    if ($(this).hasClass("freeSelectMode")) {
        // prevent 'contextmenu' on non Free Selected Elements

        return;
    }

    if ($(this).data("prevent-contextmenu")) {
        // prevent code execution

        return;
    }

    if (window.connContext == 1) {
        window.connContext = 0
        if (LOCK == 1) return;
        body = '';
        // b2: window.connToDel is set by legacy jsPlumb link-menu code that no
        // longer runs (the island owns the edge menu). Guard the read so a stray
        // path can't throw "Cannot read 'id' of undefined".
        if (!window.connToDel || window.connToDel.id == null) return;
        if (window.connToDel.id.search('line') == -1) { /** EVE_STORE */
            body += `<li><a class="action-connectedit" href="javascript:void(0)"><i class="glyphicon glyphicon-edit"></i> ${lang('Edit')}</a></li>`;
            if (App.topology.links[window.connToDel.id] && App.topology.links[window.connToDel.id].source.type == 'ethernet'){
                // Legacy "Quality" (stock 4-field store modal) removed — superseded by
                // "Advanced WAN (netem)" (pnetlab-netem-advanced.js), the single netem editor.
                // Protocol Inspector (pnetlab-protocol-inspector.js) — per-link
                // packet ladder. Carries the two endpoint node ids; the inspector
                // maps them to the network_id and opens its modal.
                (function () {
                    var _lk = App.topology.links[window.connToDel.id];
                    if (_lk && _lk.source && _lk.source.node && _lk.dest && _lk.dest.node) {
                        var _s = _lk.source.node.get('id'), _d = _lk.dest.node.get('id');
                        body += `<li><a class="action-protoinspect" data-src="${_s}" data-dst="${_d}" href="javascript:void(0)"><i class="fa fa-exchange"></i> ${lang('Protocol Inspector')}</a></li>`;
                        // BGP best-path waterfall (pnetlab-bgp-waterfall.js) — runs
                        // `show ip bgp` on a chosen endpoint and walks the tiebreakers.
                        body += `<li><a class="action-bgppath" data-src="${_s}" data-dst="${_d}" href="javascript:void(0)"><i class="fa fa-sitemap"></i> ${lang('BGP Best-Path Finder')}</a></li>`;
                        // The OSPF SPF Tree / BGP Best-Path Map / EIGRP Successor Map
                        // canvas overlays moved out of this link menu into the
                        // Protocol Painter left-pane launcher (pnetlab-protocol-painter.js),
                        // which lets you choose both the protocol AND an explicit root
                        // node — not just one of this link's two endpoints.
                    }
                })();
                if(e.target.classList.contains('node_interface')){
                    var pos = e.target.getAttribute('position');
                    if(pos == 'src'){
                        var nodeId = App.topology.links[window.connToDel.id].source.node.get('id');
                        var ifId = App.topology.links[window.connToDel.id].source.interface.get('id');
                        var isSuspend = App.topology.links[window.connToDel.id].source.interface.get('suspend');
                    }else if(pos == 'dst'){
                        if(App.topology.links[window.connToDel.id].dest){
                            var nodeId = App.topology.links[window.connToDel.id].dest.node.get('id');
                            var ifId = App.topology.links[window.connToDel.id].dest.interface.get('id');
                            var isSuspend = App.topology.links[window.connToDel.id].dest.interface.get('suspend');
                        }
                    }else{
                        var nodeId = null;
                        var ifId = null;
                    }

                    if(nodeId !== null && ifId !== null){
                        if(isSuspend == '1'){
                            body += `<li><a class="action-linksuspend" data-node="${nodeId}" data-if="${ifId}" data-status="0" href="javascript:void(0)"><i class="fa fa-play"></i> ${lang('Resume')}</a></li>`;
                            body += `<li><a class="action-linksuspend" data-node="${nodeId}" data-if="${ifId}" data-status="0" data-twoway="1" href="javascript:void(0)"><i class="fa fa-play"></i> ${lang('Resume Full link')}</a></li>`;

                        }else{
                            body += `<li><a class="action-linksuspend" data-node="${nodeId}" data-if="${ifId}" data-status="1" href="javascript:void(0)"><i class="fa fa-pause"></i> ${lang('Suspend')}</a></li>`;
                            body += `<li><a class="action-linksuspend" data-node="${nodeId}" data-if="${ifId}" data-status="1" data-twoway="1" href="javascript:void(0)"><i class="fa fa-pause"></i> ${lang('Suspend Full link')}</a></li>`;

                        }
                        
                    }
                }
            }
        if (LOCK == 1) return;

            body += `<li><a class="action-conndelete" href="javascript:void(0)"><i class="glyphicon glyphicon-trash"></i> ${lang('Delete')}</a></li>`;
        } else {
            body += `<li><a class="action-lineedit" href="javascript:void(0)"><i class="glyphicon glyphicon-edit"></i> ${lang('Edit')}</a></li>`;
            body += `<li><a class="action-linedelete" href="javascript:void(0)"><i class="glyphicon glyphicon-trash"></i> ${lang('Delete')}</a></li>`;
        }

        printContextMenu(lang('Connection'), body, e);
        return;
    }

    if (LOCK == 0) {
        var body = '';
        body += `<li><a class="action-nodeplace" href="javascript:void(0)"><i class="fa fa-arrows" style="
                        margin-right: 7px;
                        border: solid thin;
                        border-radius: 50%;
                        padding: 2px;
                        font-size: 10px;">
                    </i>${lang('Node')}</a></li>`;
        body += `<li><a class="action-networkplace" href="javascript:void(0)"><i class="glyphicon glyphicon-transfer"></i> ${lang("Network")}</a></li>`;
        body += `<li><a class="action-textadd" href="javascript:void(0)"><i class="glyphicon glyphicon-font"></i> ${lang("Text")}</a></li>`;
        body += `<li><a class="action-lineadd" href="javascript:void(0)"><i class="glyphicon glyphicon-pencil"></i> ${lang("Line")}</a></li>`;
        body += '<li role="separator" class="divider"></li>'
        body += '<li><a class="action-undoposition" href="javascript:void(0)"><i class="fa fa-undo"></i> ' + lang("Undo Position") + '</a></li>';
        body += '<li><a class="action-redoposition" href="javascript:void(0)"><i class="fa fa-repeat"></i> ' + lang("Redo Position") + '</a></li>';
        printContextMenu(lang("Add a new object"), body, e);
    }
});

// Manage context menu
$(document).on('contextmenu', '.context-menu', function (e) {
    App.topology.createContextMenu(e);
});

// remove context menu after click on capture interface
$(document).on('click', '.action-nodecapture', function () {
    $("#context-menu").remove();
})

// Window resize
$(window).resize(function () {
    if ($('#lab-viewport').length) {
        // Keep the viewport covering the window so the right-click menu works everywhere
        if (typeof fitLabViewport === 'function') fitLabViewport();
        // Update topology on window resize
        lab_topology.repaintEverything();
        // Update picture map on window resize
        $('map').imageMapResize();
    }
});

// disable submit button if count addition nodes more than 50
$(document).on('change input', 'input[name="node[count]"]', function (e) {
    var count = $(this).val()
    console.log('val', count)
    if (count > 50) {
        $("#form-node-add button[type='submit']").attr('disabled', true)
    } else {
        $("#form-node-add button[type='submit']").attr('disabled', false)
    }
})

// plug show/hide event

$(document).on('mouseenter', '.node_frame, .network_frame', function (e) {
    console.log('mouseenter')
    if (LOCK == 0) {
        $(this).find('.tag').removeClass("hidden");
        $(this).css('z-index', 10000);
    }else{
        $(this).find('.quickset').removeClass("hidden");
        $(this).css('z-index', 10000);
    }
    
});

$(document).on('mouseover', '.ep', function (e) {
    //lab_topology.setDraggable ( this , false )
});

$(document).on('mouseleave', '.node_frame, .network_frame', function (e) {
    $(this).find('.tag').addClass("hidden");
    $(this).css('z-index', '');
    //lab_topology.setDraggable ( this , true )
});
/***************************************************************************
 * Actions links
 **************************************************************************/

// startup-config menu
$(document).on('click', '.action-configsget', function (e) {
    console.log('DEBUG: action = configsget');
    $.when(getNodeConfigs(null)).done(function (configs) {
        // The Startup Configs modal list was showing a generic broken-image glyph
        // instead of each node's real icon. apiGetLabConfigs() (api_configs.php)
        // does supply an 'icon' field, but — like every other engine-native lane
        // touched by the canvas-flow amputation — it can be empty/stale for a
        // given node. window.nodes is the proven-reliable client-side source (it
        // already backs the List of Nodes modal / node table rows, see
        // printListNodes + createNodeListRow in functions/status/render.js), so
        // prefer it here too, normalized through the same pnqIconBase() helper
        // (handles both a bare filename and a full "/images/icons/…" path).
        // Falls back to whatever apiGetLabConfigs returned, then to '' (a missing/
        // 404 icon is handled gracefully by the delegated error handler below —
        // no broken-image box).
        $.each(configs, function (key, config) {
            var topoIcon = (window.nodes && window.nodes[key]) ? window.nodes[key]['icon'] : null;
            config['icon'] = pnqIconBase(topoIcon != null ? topoIcon : config['icon']);
        });
        addModalWide(lang('Startup Configurations'), pnqEjs('/themes/default/ejs/action_configsget.ejs').render({ configs: configs }), '', 'pnq-startup-configs', function () {
            pnqRenderStartupConfigEmpty($('.modal.pnq-startup-configs #config-data').last());
        });
    }).fail(function (message) {
        addModalError(message);
    });
});

// Startup Configs modal: hide a node icon <img> instead of showing the
// browser's broken-image glyph if the resolved icon file 404s (empty icon,
// stale template name, etc). CSP forbids an inline onerror="…" attribute, so
// this is a delegated, capturing-phase handler (the 'error' event on <img>
// does not bubble, only capture) scoped to the config-list icons.
document.addEventListener('error', function (e) {
    var img = e.target;
    if (img && img.tagName === 'IMG' && img.closest('.config-list')) {
        img.style.visibility = 'hidden';
    }
}, true);

// canvas-flow amputation (b2 Wave 3): the store React lab.js — which owned the
// per-node ".action-configget" handler that filled the Startup Configs modal's
// right pane (#config-data) with an editable startup-config — is gone, so
// clicking a node in that modal did nothing (the pane stayed blank). Restore it
// with the engine's own config lanes (both already exist, verified on the gate):
//   READ : GET  /api/labs/session/configs?id=<node>  → data.data (the cfg text)
//   WRITE: POST /api/labs/session/configs/edit  {config[id], config[data]}
// Editable via a plain <textarea> (the golden #nodeconfig id) with an optional
// Ace toggle (#toggle_editor + initEditor/initTextarea from ebs/functions.js,
// still loaded). Save syncs Ace→textarea then reuses saveConfig(true).
function pnqRenderStartupConfigEmpty($pane) {
    if (!$pane || !$pane.length) return;
    var $empty = $('<div>', { 'class': 'pnq-config-empty', 'role': 'status' });
    $('<i>', { 'class': 'fa fa-file-text-o', 'aria-hidden': 'true' }).appendTo($empty);
    $('<span>').text(lang('Select a node to view its startup configuration.')).appendTo($empty);
    $pane.empty().append($empty);
}

$(document).on('click', '.action-configget', function (e) {
    e.preventDefault();
    var self = $(this);
    var id = self.attr('data-path');
    console.log('DEBUG: action = configget (' + id + ')');
    var $pane = self.closest('.modal').find('#config-data').first();
    if (self.hasClass('active')) {
        self.removeClass('active selected');
        pnqRenderStartupConfigEmpty($pane);
        return;
    }
    $('.config-list a.action-configget').removeClass('active selected');
    self.addClass('active selected');
    pnqRenderStartupConfigEmpty($pane);
    $.when(getNodeConfigs(id)).done(function (cfg) {
        cfg = cfg || {};
        var name = (cfg['name'] != null) ? cfg['name'] : ('Node ' + id);
        var data = (cfg['data'] != null) ? cfg['data'] : '';
        // Build the editor panel. #nodeconfig / #editor / #toggle_editor mirror the
        // golden form_node_configs.ejs ids so ebs/functions.js initEditor/initTextarea
        // + ebs/actions.js #toggle_editor handler work unchanged. Values are escaped
        // (config text is untrusted) — the textarea gets it via .val() below, and the
        // title via text().
        var html =
            // Header row: node title on the left, the ACE-editor toggle on the
            // right, vertically centred in a flex bar so the switch never floats
            // over/into the title underline (a plain pull-right did).
            '<div class="config-editor-head" style="display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:8px 18px;margin:0 0 10px">' +
                '<h4 class="config-node-title" style="margin:0"></h4>' +
                // Text label OUTSIDE the switch (the checkbox-switch component only
                // expects the input + slider inside its label; earlier the span was
                // nested and the slider painted over it).
                '<span style="display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:12px">' +
                    '<span>Ace Editor</span>' +
                    '<label class="checkbox-switch switch-align" title="Enable ACE Editor" style="margin:0">' +
                        '<input type="checkbox" name="toggle_editor" id="toggle_editor"/>' +
                        '<div class="checkbox-slider-off"></div>' +
                    '</label>' +
                '</span>' +
            '</div>' +
            '<form id="form-node-config" class="form-horizontal">' +
                '<input name="config[id]" value="' + id + '" type="hidden"/>' +
                '<div class="form-group"><div class="col-md-12">' +
                    '<div id="editor" name="config[editor_data]" style="display:none"></div>' +
                    '<textarea class="form-control autofocus" id="nodeconfig" name="config[data]" rows="24" spellcheck="false" style="font-family:monospace;white-space:pre;overflow-wrap:normal;overflow-x:auto"></textarea>' +
                '</div></div>' +
                '<div class="form-group"><div class="col-md-12">' +
                    '<button type="submit" class="btn btn-success pnq-button pnq-button--primary">' + lang('Save') + '</button> ' +
                    '<button type="button" class="btn pnq-button pnq-button--secondary pnq-config-revert">' + lang('Reload') + '</button>' +
                '</div></div>' +
            '</form>';
        $('#config-data').html(html);
        $('#config-data .config-node-title').text(name + ' — ' + lang('startup-config'));
        // Set the raw text safely (never via innerHTML).
        $('#nodeconfig').val(data);
        // Keep the last-loaded value for the Reload button.
        $('#form-node-config').data('orig', data);
    }).fail(function (message) {
        self.removeClass('active selected');
        pnqRenderStartupConfigEmpty($pane);
        addModalError(message);
    });
});

// Save the per-node startup-config (Startup Configs modal right pane). Scoped to
// the modal's #form-node-config so it never collides with other config forms.
$(document).on('submit', '#form-node-config', function (e) {
    e.preventDefault();
    // If Ace is active, its buffer is the source of truth — sync it into the
    // textarea (name=config[data]) before form2Array('config') reads it.
    if (window.ace && $('#editor').is(':visible')) {
        try { $('#nodeconfig').val(ace.edit('editor').getValue()); } catch (err) {}
    }
    saveConfig(true);
    return false;
});

// Reload discards unsaved edits back to the last-loaded config text.
$(document).on('click', '.pnq-config-revert', function (e) {
    e.preventDefault();
    var orig = $('#form-node-config').data('orig');
    if (orig == null) orig = '';
    $('#nodeconfig').val(orig);
    if (window.ace && $('#editor').is(':visible')) {
        try { ace.edit('editor').setValue(orig, 1); } catch (err) {}
    }
});

// canvas-flow amputation (b2 Wave 3): the store React lab.js also owned the
// Startup Configs modal's TOGGLE lanes — the per-node "boot from exported"
// switch (.change_config_status) and the "Change All" master switch
// (#checkbox-slider-master). Gone with lab.js, the only surviving listener was
// the cosmetic slider-swap in ebs/actions.js, so flipping either switch moved
// pixels but persisted nothing. Restore both on the engine's own lane:
// setNodeBoot(id, 0|1) → POST /api/labs/session/nodes/edit {id, config} — the
// same call the Setup Nodes "Set nodes startup-cfg to exported/none" bulk
// actions ride (functions/nodes/mutate.js).

// Roll a checkbox-switch back WITHOUT firing 'change' (a .trigger would
// re-enter the persist handler); mirrors the cosmetic swap in ebs/actions.js.
function pnqConfigSwitchSet(cb, checked) {
    cb.prop('checked', checked);
    cb.siblings('div[class*="checkbox-slider"]')
        .toggleClass('checkbox-slider-on', checked)
        .toggleClass('checkbox-slider-off', !checked);
}

// Per-node startup-config switch: persist, then keep the row's ⚡ marker and
// tooltips truthful. On failure roll the switch back and surface the message.
$(document).on('change', '.change_config_status', function () {
    var cb = $(this);
    var id = cb.attr('data-path');
    var name = cb.attr('data-name') || ('Node ' + id);
    var on = cb.is(':checked');
    console.log('DEBUG: action = change_config_status (' + id + ' -> ' + (on ? 1 : 0) + ')');
    $.when(setNodeBoot(id, on ? 1 : 0)).done(function () {
        cb.closest('.absolute-right').find('.align-flash')
            .html(on ? '<i class="glyphicon glyphicon-flash tg-flash"></i>' : '&nbsp;&nbsp;&nbsp;');
        cb.closest('li').find('a.action-configget')
            .attr('title', on ? MESSAGES[121] : MESSAGES[122]);
        addMessage('success', name + ': ' + (on ? MESSAGES[143] : MESSAGES[144]));
    }).fail(function (message) {
        pnqConfigSwitchSet(cb, !on);
        addMessage('danger', name + ': ' + message);
    });
});

// "Change All" master switch: propagate to every per-node switch that differs.
// .trigger('change') runs both the cosmetic slider-swap (ebs/actions.js) and
// the persist handler above — one API call per node that actually changes.
$(document).on('change', '#checkbox-slider-master', function () {
    var on = $(this).is(':checked');
    console.log('DEBUG: action = configs change-all (' + (on ? 1 : 0) + ')');
    $('.config-list input.change_config_status').each(function () {
        var cb = $(this);
        if (cb.is(':checked') !== on) cb.prop('checked', on).trigger('change');
    });
});

// Change opacity
$(document).on('click', '.action-changeopacity', function (e) {
    if ($(this).data("transparent")) {
        $('.modal-content').fadeTo("fast", 1);
        $(this).data("transparent", false);
    } else {
        $('.modal-content').fadeTo("fast", 0.3);
        $(this).data("transparent", true);
    }
});


$(document).on("click",".action-networkmanage",function(a){
    $("#context-menu").remove();
    logger(1,"DEBUG: action = action-networkmanage");
    var b=$(this).attr("data-path");
    $.when(getNetworks(b)).done(function(c){
        c.id=b;
        printFormNetworkManage(c)
    }).fail(function(c){addModalError(c)})})

// Edit/print lab network
$(document).on('click', '.action-networkedit', function (e) {

    $('#context-menu').remove();
    console.log('DEBUG: action = action-networkedit');
    var id = $(this).attr('data-path');
    // b2 amputation: window.networks was populated by lab.js (gone) — reading
    // window.networks[id] threw (undefined) so Network right-click → Edit did
    // nothing, and even the island-fed map is thin (no type/visibility). Fetch the
    // FULL record from the engine for EVERY type (the same getNetworks lane the
    // dot1q/router/wireless branch already used) so the edit form prefills the real
    // name/type/visibility and a save can never silently change the network type.
    $.when(getNetworks(id)).done(function (c) {
        c = c || {};
        c.id = id;
        var t = c['type'];
        // dot1q switches, soft-routers and wireless cells edit through their own dialogs.
        if (t == 'dot1q' || t == 'router' || t == 'wireless') {
            printFormNetworkManage(c);
        } else {
            printFormNetwork('edit', c);
        }
    }).fail(function (m) { addModalError(m); });

});

// Edit/print lab network
$(document).on('click', '.action-networkdeatach', function (e) {

    $('#context-menu').remove();
    console.log('DEBUG: action = action-networkdeatach');
    var node_id = $(this).attr('node-id');
    var interface_id = $(this).attr('interface-id');

    $.when(setNodeInterface(node_id, '', interface_id))
        .done(function (values) {

            window.location.reload();
        }).fail(function (message) {
            addModalError(message);
        });
});

// Print lab networks
$(document).on('click', '.action-networksget', function (e) {
    console.log('DEBUG: action = networksget');
    $.when(getNetworks(null)).done(function (networks) {
        printListNetworks(networks);
    }).fail(function (message) {
        addModalError(message);
    });


});



$(document).on('click', '.action-conndelete', function (e) {
    var id = window.connToDel.id
    window.connContext = 0
    if (id.search('iface') != -1) { // serial or network
        node = id.replace('iface:node', '').replace(/:.*/, '')
        iface = id.replace(/.*:/, '')
        $.when(setNodeInterface(node, '', iface)).done(function () {
            
        }).fail(function (message) {
            addModalError(message);
        });
    } else { // network P2P
        network_id = id.replace('network_id:', '')
        $.when(deleteNetwork(network_id)).done(function (values) {
            App.topology.printTopology()
        }).fail(function (message) {
            addModalError(message);
        });
    }
    $('#context-menu').remove();
});

$(document).on('contextmenu', '.map_mark', function (e) {
    //alert (this.id)
    e.preventDefault();
    e.stopPropagation();
    var body = ''
    body += '<li><a class="action-mapdelete"  id="' + this.id + '" href="javascript:void(0)"><i class="glyphicon glyphicon-trash"></i> ' + lang('Delete') + '</a></li>';
    printContextMenu(lang('Map'), body, e);
});

$(document).on('click', '.action-mapdelete', function (e) {
    id = this.id.replace(/,/g, "\\,")
    $('#context-menu').remove();
    $('#' + id).remove();
    var mapoldval = $('form :input[name="picture[map]"]').val()
    var custommapoldval = $('form :input[name="picture[custommap]"]').val()
    var regex = new RegExp(".*" + id + ".*>\n")
    var mapnewval = mapoldval.replace(regex, '')
    var custommapnewval = custommapoldval.replace(regex, '')
    $('form :input[name="picture[map]"]').val(mapnewval)
    $('form :input[name="picture[custommap]"]').val(custommapnewval)
});





// Delete lab node

$(document).on('click', '.action-nodedelete, .action-nodedelete-group', function (e) {
    if ($(this).hasClass('disabled')) return;
    var id = $(this).attr('data-path')
    // <form id="form-picture-delete" data-path="' + picture_id + '" class="form-horizontal form-picture" novalidate="novalidate">

    var textQuestion = ""
    if ($(this).hasClass('action-nodedelete')) {
        textQuestion = lang("del_node_alert");
    } else {
        textQuestion = lang("del_select_nodes_alert");
    }

    var body = '<div class="form-group">' +
        '<div class="question">' + textQuestion + '</div>' +
        '<div style="text-align:center">' +
        '<button id="deteleNode" class="btn btn-success" data-path="' + id + '" data-dismiss="modal">' + lang('Yes') + '</button>' +
        '<button type="button" class="btn" data-dismiss="modal">' + lang('Cancel') + '</button>' +
        '</div>' +
        '</div>'
    var title = "Warning"
    addWaring(title, body, "", "make-red make-small");
    $('#context-menu').remove();

    $('#deteleNode').on('click', function () {

        console.log('DEBUG: action = action-nodedelete');
        var node_id = $(this).attr('data-path')
            , isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode")
            ;

        if (isFreeSelectMode) {
            // F-LOCK: filter out locked nodes from group delete, toast them
            var skippedDel = [];
            var toDelete = window.freeSelectedNodes.filter(function (n) {
                if (window.nodes && window.nodes[n.path] && window.nodes[n.path].lock == 1) {
                    skippedDel.push(window.nodes[n.path].name || ('Node ' + n.path));
                    return false;
                }
                return true;
            });
            if (skippedDel.length) {
                addMessage('warning', (lang('node_locked_skip') || 'Skipped (locked): ') + skippedDel.join(', '));
            }
            if (!toDelete.length) return;
            window.freeSelectedNodes = toDelete.sort(function (a, b) {
                return a.path < b.path ? -1 : 1;
            });
            recursionNodeDelete(window.freeSelectedNodes);
        }
        else {
            // F-LOCK: block delete on a locked node
            if (window.nodes && window.nodes[node_id] && window.nodes[node_id].lock == 1) {
                addMessage('warning', (window.nodes[node_id].name || ('Node ' + node_id)) + ': ' + (lang('node_is_locked') || 'node is locked'));
                return;
            }
            $.when(deleteNode(node_id)).done(function (values) {
                $('.node' + node_id).remove();
                if ($('input[data-path=' + node_id + '][name="node[type]"]')) {
                    $('input[data-path=' + node_id + '][name="node[type]"]').parent().remove()
                }
            }).fail(function (message) {
                // Surface "node is locked" errors that come back from the server
                if (typeof message === 'string' && message.toLowerCase().indexOf('node is locked') !== -1) {
                    addMessage('warning', message);
                } else {
                    addModalError(message);
                }
            });
        }

    })
});


function recursionNodeDelete(restOfList) {
    var node = restOfList.pop();

    if (!node) {
        // All selected nodes deleted. Force a full page reload so the right-click
        // context menu and selection state are cleanly reset (freeSelectMode is
        // still active in the DOM after the last delete, which blocks contextmenu).
        location.reload();
        return 1;
    }

    console.log("Deleting... ", node.path);
    $.when(deleteNode(node.path)).then(function (values) {
        $('.node' + node.path).remove();
        recursionNodeDelete(restOfList);
    }).fail(function (message) {
        addModalError(message);
        recursionNodeDelete(restOfList);
    });
}

// Edit/print node interfaces
$(document).on('click', '.action-nodeinterfaces', function (e) {
    console.log('DEBUG: action = action-nodeinterfaces');
    var id = $(this).attr('data-path');
    var name = $(this).attr('data-name');
    var status = $(this).attr('data-status');
    $.when(getNodeInterfaces(id)).done(function (values) {
        values['node_id'] = id;
        values['node_name'] = name;
        values['node_status'] = status;
        printFormNodeInterfaces(values)
    }).fail(function (message) {
        addModalError(message);
    });
    $('#context-menu').remove();
});

// Deatach network lab node


$(document).on('click', '.action-nodeedit', function (e) {
    console.log('DEBUG: action = action-nodeedit');
    var disabled = $(this).hasClass('disabled')
    if (disabled) return;
    var fromNodeList = $(this).hasClass('control')
    var id = $(this).attr('data-path');
    editFormNode(id)
    //printFormNode('edit', values, fromNodeList)
    $('#context-menu').remove();
});


// Print lab nodes
$(document).on('click', '.action-nodesget', function (e) {
    console.log('DEBUG: action = nodesget');
    printListNodes(window.nodes);
});

// Lab close
$(document).on('click', '.action-labclose', function (e) {
    console.log('DEBUG: action = labclose');
    $.when(closeLab()).done(function () {
        newUIreturn();
    }).fail(function (message) {
        addModalError(message);
    });
});
// Lab destroy — confirm first, and warn clearly when nodes are still running
// (destroy force-stops + wipes ALL nodes and frees the session). The old handler
// fired immediately with no prompt, so a mis-click tore down a running lab.
$(document).on('click', '.action-labdestroy', function (e) {
    var running = 0, total = 0;
    if (window.nodes) {
        for (var k in window.nodes) {
            if (!window.nodes.hasOwnProperty(k)) continue;
            total++;
            if ((window.nodes[k].status | 0) === 2) running++;
        }
    }
    var msg = running > 0
        ? '<b>' + running + '</b> node' + (running === 1 ? ' is' : 's are') +
          ' still running. Destroying the lab will <b>force-stop and wipe all ' +
          total + ' node' + (total === 1 ? '' : 's') + '</b> and free the session.'
        : 'This will wipe all nodes and free the lab session.';
    var body = '<div class="form-group"><div class="question">' + msg +
        '<br><br>This cannot be undone. Continue?</div>' +
        '<div style="text-align:center;margin-top:12px">' +
        '<button id="confirmDestroyLab" class="btn btn-danger" data-dismiss="modal">' +
        lang('Destroy Lab') + '</button> ' +
        '<button type="button" class="btn" data-dismiss="modal">' + lang('Cancel') + '</button>' +
        '</div></div>';
    addWaring(lang('Destroy Lab') + '?', body, '', 'make-red make-small');
    $('#context-menu').remove();
    $('#confirmDestroyLab').off('click').on('click', function () {
        if (typeof addMessage === 'function') addMessage('info', 'Destroying lab session…');
        // Fade the loader in now (destroy is confirmed → newUIreturn navigates to "/").
        // The pre-emptive loader on the .action-labdestroy CLICK was removed
        // (pnetlab-node-form.js) so a Cancel no longer strands the loader; show it here
        // only once the user actually commits to the destroy.
        if (typeof window.__pnqLoaderShow === 'function') window.__pnqLoaderShow();
        $.when(destroyLab()).done(function () {
            newUIreturn();
        }).fail(function (message) {
            // Destroy failed — hide the loader so the error is visible, not a stuck splash.
            try { $('#loading-lab').hide(); } catch (e) {}
            addModalError(message);
        });
    });
});

// List all labs
$(document).on('click', '.action-lablist', function (e) {
    bodyAddClass('folders');
    console.log('DEBUG: action = lablist');

    if ($('#list-folders').length > 0) {
        // Already on lab_list view -> open /
        printPageLabList('/');
    } else {
        printPageLabList(FOLDER);
    }

});


// Action menu
$(document).on('click', '.action-moreactions', function (e) {
    console.log('DEBUG: action = moreactions');
    var body = '';
    body += '<li><a class="action-nodesstart" href="javascript:void(0)"><i class="glyphicon glyphicon-play"></i> ' + lang("Start all nodes") + '</a></li>';
    body += '<li><a class="action-nodesstop" href="javascript:void(0)"><i class="glyphicon glyphicon-stop"></i> ' + lang("Stop all nodes") + '</a></li>';
    body += `<li class="action-nodesget-li"><a class="action-nodesget" href="javascript:void(0)">
                <i class="fa fa-arrows" style="
                    margin-right: 7px;
                    border: solid thin;
                    border-radius: 50%;
                    padding: 2px;
                    font-size: 10px;">
                </i><span>${lang('Config Nodes')}</span></a>
            </li>`
    body += '<li><a class="action-nodeswipe" href="javascript:void(0)"><i class="glyphicon glyphicon-erase"></i> ' + lang("Wipe all nodes") + '</a></li>';
    body += '<li><a class="action-openconsole-all" href="javascript:void(0)"><i class="glyphicon glyphicon-console"></i> ' + lang("Console To All Nodes") + '</a></li>';
    if (LOCK == 0) {
        body += '<li><a class="action-nodesexport" href="javascript:void(0)"><i class="glyphicon glyphicon-save"></i> ' + lang("Export all CFGs") + '</a></li>';
        body += '<li><a class="action-nodesbootsaved" href="javascript:void(0)"><i class="glyphicon glyphicon-flash"></i> ' + lang("Set nodes startup-cfg to exported") + '</a></li>';
        body += '<li><a class="action-nodesbootscratch" href="javascript:void(0)"><i class="glyphicon glyphicon-remove"></i> ' + lang("Set nodes startup-cfg to none") + '</a></li>';
        body += '<li><a class="action-nodesbootdelete" href="javascript:void(0)"><i class="glyphicon glyphicon-erase"></i> ' + lang("Delete all startup-cfg") + '</a></li>';
    }
    printContextMenu(lang('Setup Nodes'), body, e);
});

// Redraw topology. getTopoData() drives the island's reseed (re-fetch
// /api/labs/session/topology + re-derive the whole model) and now resolves with
// {ok:…} on the REAL completion — the island mirrors its verdict back as
// pnq:app-updatedata:done (see pnetlab-app-topology-stub.js fireReseedAwaited).
// Without feedback the button was indistinguishable from a dead one: when the
// canvas is already in sync the reseed repaints something identical. So swap the
// menu icon for a spinner + gate re-entry for the duration, then toast the
// outcome — success only when the refresh actually landed.
$(document).on('click', '.action-labtopologyrefresh', function (e) {
    var item = $(this);
    if (item.hasClass('pnq-refreshing')) return;   // one refresh in flight at a time
    var icon = item.find('i').first();
    var iconClass = icon.attr('class');
    item.addClass('pnq-refreshing').css({ opacity: 0.5, cursor: 'default' });
    icon.attr('class', 'fa fa-spinner fa-spin');
    App.topology.getTopoData().then(function (res) {
        App.topology.printTopology();
        item.removeClass('pnq-refreshing').css({ opacity: '', cursor: '' });
        icon.attr('class', iconClass);
        if (res && res.ok) {
            addMessage('success', lang('Topology refreshed'));
        } else {
            addMessage('danger', lang('Cannot refresh topology'));
        }
    });
});

// Logout
$(document).on('click', '.action-logout', function (e) {
    console.log('DEBUG: action = logout');
    $.when(logoutUser()).done(function () {
        location.href = "/";
    }).fail(function (message) {
        error_handle(message);
    });
});


// Lock lab
$(document).on('click', '.action-lock-lab', function (e) {
    console.log('DEBUG: action = lock lab');
    lockLab();

});

// Unlock lab
$(document).on('click', '.action-unlock-lab', function (e) {
    console.log('DEBUG: action = unlock lab');
    unlockLab();
});

// hotkey for lock lab
$(document).on('keyup', null, 'alt+l', function () {
    console.log('lock')
    lockLab();
})

// hotkey for unlock lab
$(document).on('keyup', null, 'alt+u', function () {
    console.log('unlock')
    unlockLab();
})



// Add object in lab_view
$(document).on('click', '.action-labobjectadd', function (e) {
    console.log('DEBUG: action = labobjectadd');
    var body = '';
    body += `<li><a class="action-nodeplace" href="javascript:void(0)"> 
                <i class="fa fa-arrows" style="
                    margin-right: 7px;
                    border: solid thin;
                    border-radius: 50%;
                    padding: 2px;
                    font-size: 10px;">
                </i>Nodes</a>
            </li>`;
    body += '<li><a class="action-networkplace" href="javascript:void(0)"><i class="glyphicon glyphicon-transfer"></i> ' + lang("Network") + '</a></li>';
    body += '<li><a class="action-textadd" href="javascript:void(0)"><i class="glyphicon glyphicon-font"></i> ' + lang("Text") + '</a></li>';
    body += '<li><a class="action-lineadd" href="javascript:void(0)"><i class="glyphicon glyphicon-pencil"></i> ' + lang("Line") + '</a></li>';
    
    printContextMenu(MESSAGES[80], body, e);
});

// Add object in lab_view
$(document).on('click', '.action-editbackground', function (e) {
    var body = '';
    body += `<li style="padding: 0px 10px"><label class="box_flex"><input type='checkbox' class="pnq-bg-toggle" data-fn="setDarkMode" ${window.lab.darkmode == 1 ? 'checked' : ''}/>&nbsp;${lang('Dark Mode')}</label></li>`;
    body += `<li style="padding: 0px 10px"><label class="box_flex"><input type='checkbox' class="pnq-bg-toggle" data-fn="set3dMode" ${window.lab.mode3d == 1 ? 'checked' : ''}/>&nbsp;${lang('3D Mode')}</label></li>`;
    body += `<li style="padding: 0px 10px"><label class="box_flex"><input type='checkbox' class="pnq-bg-toggle" data-fn="setNoGrid" ${window.lab.nogrid == 1 ? 'checked' : ''}/>&nbsp;${lang('No Grid')}</label></li>`;
    
    printContextMenu('Background', body, e);
});

$(document).on('click', '.action-configobjects', function (e) {
    var body = '';
    body += `<li class="action-nodesget-li"><a class="action-nodesget" href="javascript:void(0)">
                <i class="fa fa-arrows" style="
                    margin-right: 7px;
                    border: solid thin;
                    border-radius: 50%;
                    padding: 2px;
                    font-size: 10px;">
                </i><span class="lab-sidebar-title">${lang('Nodes')}</span></a>
            </li>`;

    body += `<li>
                <a class="action-networksget" href="javascript:void(0)">
                <i class="glyphicon glyphicon-transfer" style="margin-right:7px"></i><span class="lab-sidebar-title">${lang('Networks')}</span></a>
            </li>`;
    printContextMenu(lang('Config Objects'), body, e);
});

// Add network
$(document).on('click', '.action-networkadd', function (e) {
    console.log('DEBUG: action = networkadd');
    printFormNetwork('add', null);
});

// Background menu toggles (Dark/3D/No Grid): originally these called
// window.setDarkMode/set3dMode/setNoGrid, globals assigned by the react lab.js
// bundle. lab.js (+ jsPlumb) was removed in the canvas-flow amputation
// (46e3a5f, "island is the only canvas"), so those globals have not existed
// for a long time — `fn` was always undefined and the click was a silent
// no-op: it never updated window.lab.{darkmode,mode3d,nogrid} in memory NOR
// persisted them server-side (the stock save was axios POST
// .../background/edit, fired from inside setDarkMode/etc.). That's the
// concrete regression behind "dark mode isn't remembered on lab reopen": the
// per-lab darkmode flag (__lab.php::setBackground(), stored as the .unl XML
// darkmode attribute and returned as window.lab.darkmode on every lab load)
// could never be changed again once lab.js was gone, so it stayed frozen at
// whatever value a lab was created with.
// Fix: own the whole read-modify-persist cycle here instead of delegating to
// the vanished globals. CSP forbids inline onChange attrs, hence the
// delegated handler.
$(document).on('change', '.pnq-bg-toggle', function (e) {
    var ck = function (f) {
        return $('.pnq-bg-toggle[data-fn="' + f + '"]').prop('checked') ? 1 : 0;
    };
    var darkmode = ck('setDarkMode'), mode3d = ck('set3dMode'), nogrid = ck('setNoGrid');
    // Reflect immediately in memory so any other code reading window.lab.* this
    // tick (and a same-tick pnqApplyBgPref() re-entry) sees the live values.
    if (window.lab) {
        window.lab.darkmode = darkmode;
        window.lab.mode3d = mode3d;
        window.lab.nogrid = nogrid;
    }
    // Persist server-side, per lab (stock behaviour: __lab.php::setBackground()
    // via POST /api/labs/session/background/edit) so the choice survives a lab
    // reopen — including from a different browser/session, not just this one.
    $.ajax({
        type: 'POST',
        url: '/api/labs/session/background/edit',
        contentType: 'application/json',
        data: JSON.stringify({ darkmode: darkmode, mode3d: mode3d, nogrid: nogrid })
    });
    // Mirror into the cross-lab localStorage preference (prefs.js) so a NEW lab
    // (which has no darkmode of its own yet) inherits the same choice, and so
    // the preference is available instantly on the next lab load even before
    // the session/info round-trip completes.
    if (typeof pnqBgPrefSet === 'function') {
        pnqBgPrefSet(darkmode, mode3d, nogrid);
    }
});

// Link suspend/resume + undo/redo position (data-* carried by the menu items;
// CSP forbids inline onclick attributes, so these bind like the other action-*)
$(document).on('click', '.action-linksuspend', function (e) {
    e.preventDefault();
    var t = $(this);
    var fn = t.data('twoway') ? updateSuspendStatustwo_way : updateSuspendStatus;
    fn(t.data('node'), t.data('if'), String(t.data('status')));
});
$(document).on('click', '.action-undoposition', function (e) {
    e.preventDefault();
    App.topology.undoPosition();
});
$(document).on('click', '.action-redoposition', function (e) {
    e.preventDefault();
    App.topology.redoPosition();
});

// Place an object
$(document).on('click', '.action-nodeplace, .action-networkplace, .action-customshapeadd, .action-textadd', function (e) {
    var target = $(this)
        , object
        , frame = ''
        ;

    
    $('#context-menu').remove();

    if (target.hasClass('action-nodeplace')) {
        object = 'node';
    } else if (target.hasClass('action-networkplace')) {
        object = 'network';
    } else if (target.hasClass('action-customshapeadd')) {
        object = 'shape';
    } else if (target.hasClass('action-textadd')) {
        object = 'text';
        return;
    } else {
        return false;
    }

    $("#pnq-lab-page").data("prevent-contextmenu", false);
    var values = {};
    if ($("#pnq-lab-page").data('contextClickXY')) {
        values['left'] = $("#pnq-lab-page").data('contextClickXY').x - 30;
        values['top'] = $("#pnq-lab-page").data('contextClickXY').y;
    } else {
        values['left'] = 0;
        values['top'] = 0;
    }
    if (object == 'node') {
        addFormNode(values);
        e.stopPropagation();
        // printFormNode('add', values);
    } else if (object == 'network') {
        printFormNetwork('add', values);
    }
    $('#mouse_frame').remove();

    $('#mouse_frame').remove();
    $('.lab-viewport-click-catcher').off();

});

$(document).on('click', '.action-halign-group', function (e) {
    $('#context-menu').remove();
    var id = $(this).attr('data-path');
    console.log('test');
    var zoom = getZoomLab() / 100;
    var height = Math.round($('#' + id).outerHeight(true) / 2)
    var hpos = Math.round($('#' + id).position().top / zoom) + height;
    
    $('.ui-selected').each(function (id, node) {
        height = Math.round($('#' + node.id).outerHeight(true) / 2)
        $('#' + node.id).css({ top: hpos - height });
    });
    ObjectPosUpdate(e, function(){App.topology.printTopology()});
});

$(document).on('click', '.action-valign-group', function (e) {
    $('#context-menu').remove();
    var id = $(this).attr('data-path');
    var zoom = getZoomLab() / 100;
    var width = Math.round($('#' + id).outerWidth(true) / 2);
    var vpos = Math.round($('#' + id).position().left / zoom) + width;
   
    $('.ui-selected').each(function (id, node) {
        width = Math.round($('#' + node.id).outerWidth(true) / 2)
        $('#' + node.id).css({ left: vpos - width });
        window.lab_topology.revalidate($('#' + node.id));
        console.log('DEBUG: action valign pos = ' + vpos);
    });
    ObjectPosUpdate(e, function(){App.topology.printTopology()});
});


$(document).on('click', '.action-calign-group', function (e) {
    $('#context-menu').remove();
    var id = $(this).attr('data-path');
    var zoom = getZoomLab() / 100;
    var selected = $('.ui-selected');

    var width = Math.round($('#' + id).outerWidth(true) / 2);
    var vpos1 = Math.round($('#' + id).position().left / zoom) + width;
    var height = Math.round($('#' + id).outerHeight(true) / 2)
    var hpos1 = Math.round($('#' + id).position().top / zoom) + height;

    var D = 0;
    selected.each(function (id, node) {
        var vpos2 = Math.round($(node).position().left / zoom) + width;
        var hpos2 = Math.round($(node).position().top / zoom) + height;
        var newD = Math.sqrt(Math.pow(vpos2-vpos1, 2) + Math.pow(hpos2 - hpos1, 2));
        if(newD > D){
            D = newD;
        }
    })
    console.log(D);
    if (D == 0) return;
    var R = D/2;
    var nbo = selected.length;

    var angle = Math.round(360 / nbo)
    var step = 0;
    console.log('DEBUG: action angle = ' + angle)
    
    selected.each(function (id, node) {
        var width = Math.round($('#' + node.id).outerWidth(true) / 2);
        var height = Math.round($('#' + node.id).outerHeight(true) / 2);
        step += 1;
        radius = angle * step * Math.PI / 180;
        x = Math.round(hpos1 - Math.sin(radius) * R) - height
        y = Math.round(vpos1 - Math.cos(radius) * R) - width
        
        $('#' + node.id).css({ top: x });
        $('#' + node.id).css({ left: y });

        console.log('DEBUG: action calign  nose ' + node.id + ' ang = ' + (angle * step));
        
    });

    ObjectPosUpdate(e, function(){App.topology.printTopology()});
});


$(document).on('click', '.action-autoalign-group', function (e) {
    $('#context-menu').remove();
    var zoom = getZoomLab() / 100;
    vpos = undefined;
    window.moveCount = 0;
    step = 25;
    $('.node_frame.ui-selected, .network_frame.ui-selected').each(function(id, node){
        width = Math.round($('#' + node.id).outerWidth(true) / 2)
        height = Math.round($('#' + node.id).outerHeight(true) / 2)
        logger(1, "node: " + node.id + "width: " + width + ", height: " + height);
        vpos = Math.round($('#' + node.id).position().left / zoom) + width;
        hpos = Math.round($('#' + node.id).position().top / zoom) + height;
        modx = ((hpos % (step * 2)) < (step)) ? (hpos % (step * 2)) : (hpos % (step * 2)) - (step * 2)
        mody = ((vpos % (step * 2)) < (step)) ? (vpos % (step * 2)) : (vpos % (step * 2)) - (step * 2)
        x = hpos - modx - height
        y = vpos - mody - width
        $('#' + node.id).css({ top: x });
        $('#' + node.id).css({ left: y });
        window.lab_topology.revalidate($('#' + node.id));
        e.el = node;
    })
    ObjectPosUpdate(e, function(){App.topology.printTopology()});
})


$(document).on('click', '.action-openconsole-all, .action-openconsole-group', function (e) {
    $('#context-menu').remove();
    var target = $(this);
    var isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode")

    if (!isFreeSelectMode) {
        var nodes = window.nodes
        var pending = 0;
        $.each(nodes, function (node_id, node) {
            if (node['status'] > 1) {
                setTimeout(function () {

                    if(window.chrome){
                        nodehtmlconsoledown(e, '_blank');
                    }else{
                        nodehtmlconsoledown(e, '_self');
                    }
                   
                    console.log($(".nodehtmlconsole[nid="+node_id+"]"));
                    $(".nodehtmlconsole[nid="+node_id+"]").click();
                }, (pending * 500))
                pending++;
            }
        })

    } else {
        var pending = 0;
        freeSelectedNodes.forEach(function (node) {
            $("#lab-viewport").removeClass("freeSelectMode");
            if ($('#node' + node.path).attr('data-status') > 1) {
                setTimeout(function () {
                    if(window.chrome){
                        nodehtmlconsoledown(e, '_blank');
                    }else{
                        nodehtmlconsoledown(e, '_self');
                    }
                    $(".nodehtmlconsole[nid="+node.path+"]").click();
                }, (pending * 500))
                pending++;
            }
            $("#lab-viewport").addClass("freeSelectMode");
        })
    }
});


// Add picture
// UNREACHABLE since 2026-08-05: the "Picture" entries that carried this class
// were removed from both add-object menus (owner decision -- the lab-layout
// picture upload never worked end to end; see the note in CanvasFlow.svelte).
// The delegate and displayPictureForm are left in place deliberately: deleting
// them widens the change for no gain, and keeping them makes restoring the
// feature a one-line menu edit if the deferred Logical Topology plan is ever
// picked up. Nothing renders this class, so it cannot fire.
$(document).on('click', '.action-pictureadd', function (e) {
    console.log('DEBUG: action = pictureadd');
    $('#context-menu').remove();
    displayPictureForm();


    $("#form-picture-add").find('input:eq(0)').delay(500).queue(function () {
        $(this).focus();
        $(this).dequeue();
    });
    //printFormPicture('add', null);
});

// Attach files
var attachments;
$('body').on('change', 'input[type=file]', function (e) {
    attachments = e.target.files;
});

// Add picture form
$('body').on('submit', '#form-picture-add', function (e) {
    // lab_file = getCurrentLab//getParameter('filename');
    var lab_file = $('#pnq-lab-page').attr('data-path');
    var form_data = new FormData();
    var picture_name = $('form :input[name^="picture[name]"]').val();
    // Setting options
    $('form :input[name^="picture["]').each(function (id, object) {
        form_data.append($(this).attr('name').substr(8, $(this).attr('name').length - 9), $(this).val());
    });

    // Add attachments
    $.each(attachments, function (key, value) {
        form_data.append(key, value);
    });

    // Get action URL
    var url = '/api/labs/session/pictures/add';
    $.ajax({
        cache: false,

        type: 'POST',
        url: encodeURI(url),
        contentType: false, // Set content type to false as jQuery will tell the server its a query string request
        processData: false, // Don't process the files
        dataType: 'json',
        data: form_data,
        success: function (data) {
            if (data['status'] == 'success') {
                addMessage('SUCCESS', 'Picture "' + picture_name + '" added.');
                // Picture added -> reopen this page (not reload, or will be posted twice)
                // window.location.href = '/lab_edit.php' + window.location.search;
                $('.action-picturesget-li').removeClass('hidden')
            } else {
                // Fetching failed
                addMessage('DANGER', data['status']);
            }
        },
        error: function (data) {
            addMessage('DANGER', getJsonMessage(data['responseText']));
        }
    });

    // Hide and delete the modal (or will be posted twice)
    $('body').children('.modal').modal('hide');

    // Stop or form will follow the action link
    return false;
});

// Edit picture
$(document).on('click', '.action-pictureedit', function (e) {
    console.log('DEBUG: action = pictureedit');
    $('#context-menu').remove();
    var picture_id = $(this).attr('data-path');
    $.when(getPictures(picture_id)).done(function (picture) {
        picture['id'] = picture_id;
        printFormPicture('edit', picture);
    }).fail(function (message) {
        addModalError(message);
    });
});

// Get picture
$(document).on('click', '.action-pictureget', function (e) {
    console.log('DEBUG: action = pictureget');
    $(".action-pictureget").removeClass("selected");
    $(this).addClass("selected");
    $('#context-menu').remove();
    var picture_id = $(this).attr('data-path');
    printPictureInForm(picture_id);

});

//Show circle under cursor
$(document).on('mousemove', '.follower-wrapper', function (e) {
    var offset = $('.follower-wrapper img').offset()
        , limitY = $('.follower-wrapper img').height()
        , limitX = $('.follower-wrapper img').width()
        , mouseX = Math.min(e.pageX - offset.left, limitX)
        , mouseY = Math.min(e.pageY - offset.top, limitY);

    if (mouseX < 0) mouseX = 0;
    if (mouseY < 0) mouseY = 0;

    $('#follower').css({ left: mouseX, top: mouseY });
    $("#follower").data("data_x", mouseX);
    $("#follower").data("data_y", mouseY);
});

$(document).on('click', '#follower', function (e) {
    e.preventDefault();
    e.folowerPosition = {
        left: parseFloat($("#follower").css("left")) - 30,
        top: parseFloat($("#follower").css("top")) + 30
    };
});

// Get pictures list
$(document).on('click', '.action-picturesget', function (e) {
    console.log('DEBUG: action = picturesget');
    $.when(getPictures()).done(function (pictures) {
        if (!$.isEmptyObject(pictures)) {
            var body = '<div class="col-md-1 col-md-offset-10" id="picslider"></div><div class="col-md-1 col-md-offset-11"></div><div class="row"><div class="picture-list col-md-3 col-lg-2"><ul class="map">';
            $.each(pictures, function (key, picture) {
                var title = picture['name'] || "pic name";
                body += '<li>';
                if (LOCK != 1) {
                    body += '<a class="delete-picture" style="margin-right: 5px;" href="javascript:void(0)" data-path="' + key + '"><i class="glyphicon glyphicon-trash" title="' + lang("Delete") + '"></i> ';
                    body += '<a class="action-pictureedit" href="javascript:void(0)" data-path="' + key + '"><i class="glyphicon glyphicon-edit" title="' + lang("Edit") + '"></i> ';
                }
                body += '<a class="action-pictureget" data-path="' + key + '" href="javascript:void(0)" title="' + title + '">&nbsp;&nbsp;' + picture['name'].split(' ')[0] + '</a>';
                body += '</a></li>';
            });
            body += '</ul></div><div id="config-data" class="col-md-9 col-lg-10"></div></div>';
            addModalWide(lang("Pictures"), body, '', "modal-ultra-wide");
            $('#picslider').slider({ value: 100, min: 10, max: 200, step: 10, slide: zoompic })
        } else {
            addMessage('info', lang("No pictures in this lab"));
        }
    }).fail(function (message) {
        addModalError(message);
    });
});

// Get picture list old
$(document).on('click', '.action-picturesget-stop', function (e) {
    console.log('DEBUG: action = picturesget');
    $.when(getPictures()).done(function (pictures) {
        if (!$.isEmptyObject(pictures)) {
            var body = '';
            $.each(pictures, function (key, picture) {
                body += '<li><a class="action-pictureget" data-path="' + key + '" href="javascript:void(0)" title="' + picture['name'] + '"><i class="glyphicon glyphicon-picture"></i> ' + picture['name'] + '</a></li>';
            });
            printContextMenu(lang("Pictures"), body, e);
        } else {
            addMessage('info', lang("No pictures in this lab"));
        }
    }).fail(function (message) {
        addModalError(message);
    });
});

//Detele picture
$(document).on('click', '.delete-picture', function (ev) {
    ev.stopPropagation();  // Prevent default behaviour
    ev.preventDefault();  // Prevent default behaviour
    var id = $(this).attr('data-path');
    console.log('this', $(this))
    var body = '<div class="form-group">' +
        '<div class="question">' + lang("del_picture_alert") + '</div>' +
        '<div style="text-align:center">' +
        '<button id="formPictureDelete" class="btn btn-success"  data-path="' + id + '" data-dismiss="modal">' + lang('Yes') + '</button>' +
        '<button type="button" class="btn" data-dismiss="modal">' + lang('Cancel') + '</button>' +
        '</div>' +
        '</div>'
    var title = "Warning"
    addWaring(title, body, "", "make-red make-small");
    $('#formPictureDelete').on('click', function (e) {
        var picture_id = $(this).attr('data-path');
        var picture_name = $('li a[data-path="' + picture_id + '"]').attr("title");
        $.when(deletePicture(picture_id)).done(function () {
            $('.modal.make-red').modal('hide')
            addMessage('SUCCESS', 'Picture "' + picture_name + '" deleted.');
            $('li a[data-path="' + picture_id + '"]').parent().remove();
            $("#config-data").html("");
            $.when(getPictures()).done(function (pic) {
                if (Object.keys(pic) < 1) {
                    $('.action-picturesget-li').addClass('hidden');
                }
            });
        }).fail(function (message) {
            $('.modal.make-red').modal('hide')
            addModalError(message);
        });
        // Hide and delete the modal (or will be posted twice)
        $('body').children('.modal.second-win').modal('hide');

        // Stop or form will follow the action link
        return false;
    });

});

// Clone selected labs
$(document).on('click', '.action-selectedclone', function (e) {
    if ($('.selected').length > 0) {
        console.log('DEBUG: action = selectedclone');
        $('.selected').each(function (id, object) {
            form_data = {};
            form_data['name'] = 'Copy of ' + $(this).text().slice(0, -4);
            form_data['source'] = $(this).attr('data-path');
            $.when(cloneLab(form_data)).done(function () {
                // Lab cloned -> reload the folder
                printPageLabList($('#list-folders').attr('data-path'));
            }).fail(function (message) {
                // Error on clone
                addModalError(message);
            });
        });
    }
});

// Delete selected folders and labs
$(document).on('click', '.action-selecteddelete', function (ev) {
    var id = $(this).attr('data-path');
    var self = $(this);
    var body = '<div class="form-group">' +
        '<div class="question">' + lang("del_select_nodes_alert") + '</div>' +
        '<div style="text-align:center">' +
        '<button id="selectedDelete" class="btn btn-success"  data-path="' + id + '" data-dismiss="modal">' + lang('Yes') + '</button>' +
        '<button type="button" class="btn" data-dismiss="modal">' + lang('Cancel') + '</button>' +
        '</div>' +
        '</div>'
    var title = lang("Warning");
    addWaring(title, body, "", "make-red make-small");
    $('#selectedDelete').on('click', function deleteSelected(e) {
        if ($('.selected').length > 0) {
            console.log('DEBUG: action = selecteddelete');

            $('.selected').each(function (id, object) {
                var path = self.attr('data-path');
                if (self.hasClass('folder')) {
                    $.when(deleteFolder(path)).done(function () {
                        // Folder deleted
                        $('.folder[data-path="' + path + '"]').fadeOut(300, function () {
                            self.remove();
                        });
                    }).fail(function (message) {
                        // Cannot delete folder
                        addModalError(message);
                    });
                } else if (self.hasClass('lab')) {
                    $.when(deleteLab(path)).done(function () {
                        // Lab deleted
                        $('.lab[data-path="' + path + '"]').fadeOut(300, function () {
                            self.remove();
                        });
                    }).fail(function (message) {
                        // Cannot delete lab
                        addModalError(message);
                    });
                } else if (self.hasClass('user')) {
                    $.when(deleteUser(path)).done(function () {
                        // User deleted
                        $('.user[data-path="' + path + '"]').fadeOut(300, function () {
                            self.remove();
                        });
                    }).fail(function (message) {
                        // Cannot delete user
                        addModalError(message);
                    });
                } else {
                    // Invalid object
                    console.log('DEBUG: cannot delete, invalid object.');
                    return;
                }
            });
        }
    })
})

// Export selected folders and labs
$(document).on('click', '.action-selectedexport', function (e) {
    if ($('.selected').length > 0) {
        console.log('DEBUG: action = selectedexport');
        var form_data = {};
        var i = 0;
        form_data['path'] = $('#list-folders').attr('data-path')
        $('.selected').each(function (id, object) {
            form_data[i] = $(this).attr('data-path');
            i++;
        });
        $.when(exportObjects(form_data)).done(function (url) {
            // Export done
            window.location = url;
        }).fail(function (message) {
            // Cannot export objects
            addModalError(message);
        });
    }
});

// Delete all startup-config
$(document).on('click', '.action-nodesbootdelete, .action-nodesbootdelete-group', function (ev) {
    $('#context-menu').remove();
    var self = $(this);

    var textQuestion = lang("del_all_startup_cfg");
    if (self.hasClass('action-nodesbootdelete-group')) {
        textQuestion = lang("del_all_selected_startup_cfg");
    }
    var body = '<div class="form-group">' +
        '<div class="question">' + textQuestion + '</div>' +
        '<div style="text-align:center">' +
        '<button id="nodesbootdelete" class="btn btn-success"  data-dismiss="modal">' + lang("Yes") + '</button>' +
        '<button type="button" class="btn" data-dismiss="modal">' + lang('Cancel') + '</button>' +
        '</div>' +
        '</div>'
    var title = "Warning"
    addWaring(title, body, "", "make-red make-small");
    $('#nodesbootdelete').on('click', function (e) {
        var isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode")
            ;
        if (isFreeSelectMode) {
            var nodeLenght = window.freeSelectedNodes.length;
            $.each(window.freeSelectedNodes, function (i, node) {
                var form_data = {};
                form_data['id'] = node.path;
                form_data['data'] = '';
                var url = '/api/labs/session/configs/edit';
                var type = 'POST';
                $.when($.ajax({
                    cache: false,

                    type: type,
                    url: encodeURI(url),
                    dataType: 'json',
                    data: form_data
                })).done(function (message) {
                    // Config deleted
                    nodeLenght--;
                    if (nodeLenght < 1) {
                        addMessage('success', MESSAGES[160])
                    }
                    ;
                }).fail(function (message) {
                    // Cannot delete config
                    nodeLenght--;
                    if (nodeLenght < 1) {
                        addMessage('danger', node.name + ': ' + message);
                    }
                    ;
                });
            });
        } else {
            var nodes = window.nodes;
            var nodeLenght = Object.keys(nodes).length;
            $.each(nodes, function (key, values) {
                var form_data = {};
                form_data['id'] = key;
                form_data['data'] = '';
                var url = '/api/labs/session/configs/edit';
                var type = 'POST';
                $.when($.ajax({
                    cache: false,

                    type: type,
                    url: encodeURI(url),
                    dataType: 'json',
                    data: form_data
                })).done(function (message) {
                    // Config deleted
                    nodeLenght--;
                    if (nodeLenght < 1) {
                        addMessage('success', MESSAGES[142])
                    }
                    ;
                }).fail(function (message) {
                    // Cannot delete config
                    nodeLenght--;
                    if (nodeLenght < 1) {
                        addMessage('danger', values['name'] + ': ' + message);
                    }
                    ;
                });
            });

        }
    });
})

// Configure nodes to boot from scratch
$(document).on('click', '.action-nodesbootscratch, .action-nodesbootscratch-group', function (e) {
    $('#context-menu').remove();

    var isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode")
        ;

    if (isFreeSelectMode) {
        $.each(window.freeSelectedNodes, function (i, node) {
            $.when(setNodeBoot(node.path, 0)).done(function () {
                addMessage('success', node.name + ': ' + MESSAGES[144]);
            }).fail(function (message) {
                // Cannot configure
                addMessage('danger', node.name + ': ' + message);
            });
        });
    }
    else {
        var nodes = window.nodes;
        $.each(nodes, function (key, values) {
            $.when(setNodeBoot(key, 0)).done(function () {
                // Node configured -> print a small green message
                addMessage('success', values['name'] + ': ' + MESSAGES[144])
            }).fail(function (message) {
                // Cannot start
                addMessage('danger', values['name'] + ': ' + message);
            });
        });

    }
});

// Configure nodes to boot from startup-config
$(document).on('click', '.action-nodesbootsaved, .action-nodesbootsaved-group', function (e) {
    $('#context-menu').remove();

    var isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode")
        ;

    if (isFreeSelectMode) {
        $.each(window.freeSelectedNodes, function (i, node) {
            $.when(setNodeBoot(node.path, 1)).done(function () {
                addMessage('success', node.name + ': ' + MESSAGES[143]);
            }).fail(function (message) {
                // Cannot configure
                addMessage('danger', node.name + ': ' + message);
            });
        });
    }
    else {
        var nodes = window.nodes;
        $.each(nodes, function (key, values) {
            $.when(setNodeBoot(key, 1)).done(function () {
                // Node configured -> print a small green message
                addMessage('success', values['name'] + ': ' + MESSAGES[143])
            }).fail(function (message) {
                // Cannot configure
                addMessage('danger', values['name'] + ': ' + message);
            });
        });

    }
});

// Export a config
$(document).on('click', '.action-nodeexport, .action-nodesexport, .action-nodeexport-group', function (e) {
    $('#context-menu').remove();

    var node_id
        , isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode")
        , exportAll = false
        , nodesLength
        ;

    if ($(this).hasClass('action-nodeexport')) {
        console.log('DEBUG: action = nodeexport');
        node_id = $(this).attr('data-path');
    } else {
        console.log('DEBUG: action = nodesexport');
        exportAll = true;
    }

    var nodes = window.nodes;
    if (isFreeSelectMode) {
        nodesLenght = window.freeSelectedNodes.length;
        addMessage('info', lang('Export Selected') + ':' + lang('Starting'));
        $.when(recursive_cfg_export(window.freeSelectedNodes, nodesLenght)).done(function () {
        }).fail(function (message) {
            addMessage('danger', lang('Export Selected') + ':' + lang('Error'));
        });
    }
    else if (node_id) {
        addMessage('info', nodes[node_id]['name'] + ': ' + MESSAGES[138]);
        $.when(cfg_export(node_id)).done(function () {
            // Node exported -> print a small green message
            setNodeBoot(node_id, '1');
            addMessage('success', nodes[node_id]['name'] + ': ' + MESSAGES[79])
        }).fail(function (message) {
            // Cannot export
            addMessage('danger', nodes[node_id]['name'] + ': ' + message);
        });
    } else if (exportAll) {
        /*
         * Parallel call for each node
         */
        nodesLenght = Object.keys(nodes).length;
        addMessage('info', lang('Export all') + ': ' + lang('Starting'));
        $.when(recursive_cfg_export(nodes, nodesLenght)).done(function () {
        }).fail(function (message) {
            addMessage('danger', lang('Export all') + ': ' + lang('Error'));
        });
    }

});

// Start a node

$(document).on('click', '.action-nodestart', function (e) {
    $('#context-menu').remove();
    var node_id = $(this).attr('data-path');
    if (node_id != null) start(node_id);
})

// Staggered start pool: 2 concurrent workers, each waits 800 ms before
// firing the next start. Prevents CPU/RAM spikes when booting many VMs.
// Stops/shutdowns fire all at once — signalling is cheap, no spawn cost.
var START_CONCURRENCY = 2;
var START_STAGGER_MS  = 800;

function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function staggeredPoolRun(thunks) {
    var idx = 0;
    async function worker() {
        while (idx < thunks.length) {
            var i = idx++;
            if (i > 0) await delay(START_STAGGER_MS);
            await Promise.resolve(thunks[i]());
        }
    }
    var workers = [];
    var limit = Math.min(START_CONCURRENCY, thunks.length);
    for (var w = 0; w < limit; w++) workers.push(worker());
    await Promise.all(workers);
}

// Wipe pool: wipes are disk-heavy (each resets the node's overlay) so we run
// them concurrently with a cap rather than one-at-a-time (the old `await` loop
// was painfully slow on big labs) — but not all-at-once, to avoid an I/O storm.
// No stagger: unlike a boot, a wipe has no sustained CPU ramp to spread out.
var WIPE_CONCURRENCY = 4;

async function poolRun(thunks, limit) {
    var idx = 0;
    async function worker() {
        while (idx < thunks.length) {
            var i = idx++;
            await Promise.resolve(thunks[i]());
        }
    }
    var workers = [];
    var n = Math.min(limit, thunks.length);
    for (var w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);
}

$(document).on('click', '.action-nodesstart', async function (e) {
    $('#context-menu').remove();
    var nodes = window.nodes;
    await staggeredPoolRun(Object.keys(nodes).map(function(id) { return function() { return start(id); }; }));
})

// selectedNodeIds(): collect selected node ids robustly for group actions.
// Prefers window.freeSelectedNodes (rubber-band lasso path, each entry has .path).
// Falls back to .node_frame.ui-selected elements (Ctrl-click jsPlumb path)
// whose id format is "node<id>" and data-path attribute holds the numeric id.
function selectedNodeIds() {
    if (window.freeSelectedNodes && window.freeSelectedNodes.length) {
        return window.freeSelectedNodes.map(function (n) { return n.path; });
    }
    var ids = [];
    $('.node_frame.ui-selected').each(function () {
        // data-path is set by updateFreeSelect; fall back to stripping "node" prefix from id.
        var id = $(this).data('path') || $(this).attr('data-path') ||
                 (this.id || '').replace(/^node/, '');
        if (id !== '' && id != null) ids.push(String(id));
    });
    return ids;
}

$(document).on('click', '.action-nodestart-group', async function (e) {
    $('#context-menu').remove();
    var ids = selectedNodeIds();
    if (ids.length) {
        await staggeredPoolRun(ids.map(function(id) { return function() { return start(id); }; }));
    }
})
// Stop a node

$(document).on('click', '.action-nodestop', function (e) {
    $('#context-menu').remove();
    var node_id = $(this).attr('data-path');
    var selIds = selectedNodeIds();
    // F-STOP: when multiple nodes are selected and the right-clicked id is among
    // them, stop the whole selection (mirrors the start-group / wipe-group pattern).
    if (selIds.length > 1 && node_id != null && selIds.indexOf(String(node_id)) !== -1) {
        var skipped = [];
        selIds.forEach(function (id) {
            if (window.nodes && window.nodes[id] && window.nodes[id].lock == 1) {
                skipped.push((window.nodes[id].name || ('Node ' + id)));
            } else {
                stop(id);
            }
        });
        if (skipped.length) {
            addMessage('warning', lang('node_locked_skip') || ('Skipped (locked): ' + skipped.join(', ')));
        }
    } else {
        // Single-node path — guard lock before calling the API
        if (node_id != null) {
            if (window.nodes && window.nodes[node_id] && window.nodes[node_id].lock == 1) {
                addMessage('warning', (window.nodes[node_id].name || ('Node ' + node_id)) + ': ' + (lang('node_is_locked') || 'node is locked'));
                return;
            }
            stop(node_id);
        }
    }
})


$(document).on('click', '.action-nodesstop', function (e) {
    $('#context-menu').remove();
    var nodes = window.nodes;
    Object.keys(nodes).forEach(function(id) { stop(id); });
})

$(document).on('click', '.action-nodestop-group', function (e) {
    $('#context-menu').remove();
    var ids = selectedNodeIds();
    ids.forEach(function(id) { stop(id); });
})

// F-STOP (robust): in the multi-select context menu, "Stop" is nested in a
// collapsible submenu whose item is a SINGLE-node .action-nodestop icon button
// (an <i>, not an <a>); the minified lab.js binds its own click that stops just
// that one node and stops propagation, so the delegated handlers above never see
// it (that's why Start/Wipe "Selected" work but Stop didn't). Intercept in the
// CAPTURE phase — before lab.js's bubble handler — and, when a real multi-
// selection is active, stop EVERY selected node and block the single-node stop.
// Single selection falls through untouched. Mirrors the capture-phase pattern in
// pnetlab-node-duplicate.js.
document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('.action-nodestop');
    if (!t) return;
    var ids = (typeof selectedNodeIds === 'function') ? selectedNodeIds() : [];
    if (!ids || ids.length < 2) return;            // single node → let normal handler run
    e.preventDefault();
    e.stopImmediatePropagation();
    var cm = document.getElementById('context-menu'); if (cm) cm.remove();
    var skipped = [];
    ids.forEach(function (id) {
        if (window.nodes && window.nodes[id] && window.nodes[id].lock == 1) {
            skipped.push(window.nodes[id].name || ('Node ' + id));
        } else if (typeof stop === 'function') {
            stop(id);
        }
    });
    if (skipped.length) {
        try { addMessage('warning', (typeof lang === 'function' && lang('node_locked_skip')) || ('Skipped (locked): ' + skipped.join(', '))); } catch (_) {}
    }
}, true);

// Shutdown a node

$(document).on('click', '.action-nodeshutdown', function (e) {
    $('#context-menu').remove();
    var node_id = $(this).attr('data-path');
    if (node_id != null) shutdown(node_id);
})


$(document).on('click', '.action-nodesshutdown', function (e) {
    $('#context-menu').remove();
    var nodes = window.nodes;
    Object.keys(nodes).forEach(function(id) { shutdown(id); });
})

$(document).on('click', '.action-nodeshutdown-group', function (e) {
    $('#context-menu').remove();
    var isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode");
    if (isFreeSelectMode) {
        window.freeSelectedNodes.forEach(function(node) { shutdown(node.path); });
    }
})
// isolate a node

$(document).on('click', '.action-nodeisolate', function (e) {
    $('#context-menu').remove();
    var node_id = $(this).attr('data-path');
    if (node_id != null) isolate(node_id);


})


$(document).on('click', '.action-nodesisolate', async function (e) {
    $('#context-menu').remove();
    var nodes = window.nodes;
    for (let node_id in nodes) {
        await isolate(node_id)
    }
})

$(document).on('click', '.action-nodeisolate-group', async function (e) {
    $('#context-menu').remove();
    var isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode");
    if (isFreeSelectMode) {
        for (let i in window.freeSelectedNodes) {
            var node = window.freeSelectedNodes[i];
            await isolate(node.path);
        }
    }
})
// hibernate a node

$(document).on('click', '.action-nodehibernate', function (e) {
    $('#context-menu').remove();
    var node_id = $(this).attr('data-path');
    if (node_id != null) hibernate(node_id);
    

})


$(document).on('click', '.action-nodeshibernate', async function (e) {
    $('#context-menu').remove();
    var nodes = window.nodes;
    for (let node_id in nodes) {
        await hibernate(node_id)
    }
})

$(document).on('click', '.action-nodehibernate-group', async function (e) {
    $('#context-menu').remove();
    var isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode");
    if (isFreeSelectMode) {
        for (let i in window.freeSelectedNodes) {
            var node = window.freeSelectedNodes[i];
            await hibernate(node.path);
        }
    }
})
// freeze a node

$(document).on('click', '.action-nodeFreeze', function (e) {
    $('#context-menu').remove();
    var node_id = $(this).attr('data-path');
    if (node_id != null) freeze(node_id);
    

})


$(document).on('click', '.action-nodesFreeze', async function (e) {
    $('#context-menu').remove();
    var nodes = window.nodes;
    for (let node_id in nodes) {
        await freeze(node_id)
    }
})

$(document).on('click', '.action-nodeFreeze-group', async function (e) {
    $('#context-menu').remove();
    var isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode");
    if (isFreeSelectMode) {
        for (let i in window.freeSelectedNodes) {
            var node = window.freeSelectedNodes[i];
            await freeze(node.path);
        }
    }
})


// Wipe a node

$(document).on('click', '.action-nodewipe', function (e) {
    $('#context-menu').remove();
    var body = '<div class="form-group">' +
        '<div class="question">' + lang("wipe_node_alert") + '</div>' +
            '<div style="text-align:center">' +
            '<button id="node_wipe" class="btn btn-success"  data-dismiss="modal">' + lang("Yes") + '</button>' +
            '<button type="button" class="btn" data-dismiss="modal">' + lang("Cancel") + '</button>' +
            '</div>' +
            '</div>'
    addWaring(lang("Warning"), body, "", "make-red make-small");
    var node_id = $(this).attr('data-path');

    $('#node_wipe').on('click', function (ev) {
        if (node_id != null) {
            // F-LOCK: block wipe on a locked node
            if (window.nodes && window.nodes[node_id] && window.nodes[node_id].lock == 1) {
                addMessage('warning', (window.nodes[node_id].name || ('Node ' + node_id)) + ': ' + (lang('node_is_locked') || 'node is locked'));
                return;
            }
            wipe(node_id);
        }
    })
})

$(document).on('click', '.action-nodeswipe', function (e) {
    $('#context-menu').remove();
    var body = '<div class="form-group">' +
        '<div class="question">' + lang("wipe_all_node_alert") + '</div>' +
            '<div style="text-align:center">' +
            '<button id="node_wipe" class="btn btn-success"  data-dismiss="modal">' + lang("Yes") + '</button>' +
            '<button type="button" class="btn" data-dismiss="modal">' + lang("Cancel") + '</button>' +
            '</div>' +
            '</div>'
    addWaring(lang("Warning"), body, "", "make-red make-small");

    $('#node_wipe').on('click', function (ev) {
        var nodes = window.nodes;
        poolRun(Object.keys(nodes).map(function (id) { return function () { return wipe(id); }; }), WIPE_CONCURRENCY);
    })
})

$(document).on('click', '.action-nodewipe-group', function (e) {
    $('#context-menu').remove();
    var body = '<div class="form-group">' +
        '<div class="question">' + lang("wipe_select_node_alert") + '</div>' +
            '<div style="text-align:center">' +
            '<button id="node_wipe" class="btn btn-success"  data-dismiss="modal">' + lang("Yes") + '</button>' +
            '<button type="button" class="btn" data-dismiss="modal">' + lang("Cancel") + '</button>' +
            '</div>' +
            '</div>'
    addWaring(lang("Warning"), body, "", "make-red make-small");

    $('#node_wipe').on('click', function (ev) {
        var ids = selectedNodeIds();
        if (ids.length) {
            poolRun(ids.map(function (id) { return function () { return wipe(id); }; }), WIPE_CONCURRENCY);
        }
    })
})

// Lock a node — POSTs to /api/labs/session/nodes/lock, then refreshes topology.
// lockNode() is defined here (not in lifecycle.js) because J1 owns only actions.js.
function lockNode(node_id) {
    var url = '/api/labs/session/nodes/lock';
    var nodeName = (window.nodes && window.nodes[node_id] && window.nodes[node_id].name) || ('Node ' + node_id);
    return $.ajax({
        cache: false,
        type: 'POST',
        url: encodeURI(url),
        dataType: 'json',
        data: { id: node_id },
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: node ' + node_id + ' locked.');
                addMessage('success', nodeName + ': ' + (lang('locked') || 'locked'));
                // Refresh topology so the lock badge (J2) and window.nodes update.
                if (App && App.topology && typeof App.topology.getTopoData === 'function') {
                    App.topology.getTopoData().then(function () {
                        App.topology.printTopology();
                    });
                }
            } else {
                // Surface "node is locked" errors clearly
                var msg = data['message'] || '';
                if (msg.toLowerCase().indexOf('node is locked') !== -1) {
                    addMessage('warning', nodeName + ': ' + msg);
                } else {
                    addMessage('danger', nodeName + ': ' + msg);
                }
            }
        },
        error: function (data) {
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error on POST ' + url + ': ' + message);
            if (message && message.toLowerCase().indexOf('node is locked') !== -1) {
                addMessage('warning', nodeName + ': ' + message);
            } else {
                addMessage('danger', nodeName + ': ' + message);
            }
        }
    });
}

// Lock node handle
$(document).on('click', '.action-nodelock', function (e) {
    $('#context-menu').remove();
    var node_id = $(this).attr('data-path');
    if (node_id != null) lockNode(node_id);
})

// Unlock node handle
$(document).on('click', '.action-nodeunlock', function (e) {
    $('#context-menu').remove();
    var node_id = $(this).attr('data-path');
    if (node_id != null) unlockNode(node_id);

})


// Add/Edit user handlers REMOVED (store-decomm cleanup): '.action-useradd' /
// '.action-useredit' markup is never rendered by the live UI (only the orphaned
// layout.ejs template referenced it), printFormUser() was never defined anywhere,
// and getUsers() hit the nonexistent store-era GET /api/users/<pod>. User
// management lives in the /main/ dashboard Users view (/users/api.php).

// Load user management page
$(document).on('click', '.action-update', function (e) {
    console.log('DEBUG: action = update');
    addMessage('info', MESSAGES[133], true);
    $.when(update()).done(function (message) {
        // Got user
        addMessage('success', message, true);
    }).fail(function (message) {
        // Cannot get user
        addMessage('alert', message, true);
    });
});

// Load user management page
$(document).on('click', '.action-usermgmt', function (e) {
    bodyAddClass('users');
    console.log('DEBUG: action = usermgmt');
    printUserManagement();
});



/***************************************************************************
 * Submit
 **************************************************************************/

// Submit folder form
$(document).on('submit', '#form-folder-add, #form-folder-rename', function (e) {
    e.preventDefault();  // Prevent default behaviour
    var form_data = form2Array('folder');

    if ($(this).attr('id') == 'form-folder-add') {
        console.log('DEBUG: posting form-folder-add form.');
        var url = '/api/folders/add';
        var type = 'POST';
        var data = { path: form_data['path'], name: form_data['name'] };
    } else {
        console.log('DEBUG: posting form-folder-rename form.');
        var url = '/api/folders/edit'
        var type = 'POST';
        var data = {
            path: form_data['original'],
            new_path: (form_data['path'] == '/') ? '/' + form_data['name'] : form_data['path'] + '/' + form_data['name']
        }
    }
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: folder "' + form_data['name'] + '" added.');
                // Close the modal
                $(e.target).parents('.modal').attr('skipRedraw', true);
                $(e.target).parents('.modal').modal('hide');
                // Reload the folder list
                printPageLabList(form_data['path']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                addModal('ERROR', '<p>' + data['message'] + '</p>', '<button type="button" class="btn btn-primary" data-dismiss="modal">' + lang("Close") + '</button>');
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addModal('ERROR', '<p>' + message + '</p>', '<button type="button" class="btn btn-primary" data-dismiss="modal">' + lang("Close") + '</button>');
        }
    });
    return false;  // Stop to avoid POST
});

// Submit import form
$(document).on('submit', '#form-import', function (e) {
    e.preventDefault();  // Prevent default behaviour
    var form_data = new FormData();
    var form_name = 'import';
    var url = '/api/import';
    var type = 'POST';
    // Setting options: cannot use form2Array() because not using JSON to send data
    $('form :input[name^="' + form_name + '["]').each(function (id, object) {
        // INPUT name is in the form of "form_name[value]", get value only
        form_data.append($(this).attr('name').substr(form_name.length + 1, $(this).attr('name').length - form_name.length - 2), $(this).val());
    });
    // Add attachments
    $.each(ATTACHMENTS, function (key, value) {
        form_data.append(key, value);
    });
    $.ajax({
        cache: false,
        timeout: LONGTIMEOUT,
        type: type,
        url: encodeURI(url),
        contentType: false, // Set content type to false as jQuery will tell the server its a query string request
        processData: false, // Don't process the files
        dataType: 'json',
        data: form_data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: labs imported.');
                // Close the modal
                $(e.target).parents('.modal').attr('skipRedraw', true);
                $(e.target).parents('.modal').modal('hide');
                // Reload the folder list
                printPageLabList($('#list-folders').attr('data-path'));
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                addModal('ERROR', '<p>' + data['message'] + '</p>', '<button type="button" class="btn btn-primary" data-dismiss="modal">' + lang('Close') + '</button>');
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addModal('ERROR', '<p>' + message + '</p>', '<button type="button" class="btn btn-primary" data-dismiss="modal">' + lang('Close') + '</button>');
        }
    });
    return false;  // Stop to avoid POST
});

$(document).on('submit', '#form-network-manage', function (e) {
     e.preventDefault();  // Prevent default behaviour
     var promises = [];
     var lab_filename = $('#pnq-lab-page').attr('data-path');
     var form_data = form2Array('network');
     console.log ( JSON.stringify(form_data) )
     console.log ( form_data['count'] )
     //create correct data
     var manage_data = {} ;
     manage_data['id'] = form_data['id']
     manage_data['smart'] = form_data['smart']
     manage_data['vlan8021ad'] = form_data['vlan8021ad']
     manage_data['port'] = {} ;
     for ( i = 0 ; i < form_data['count']; i++ ) {
         manage_data['port'][i] = {}
         manage_data['port'][i]['NodeId'] = form_data['NodeId_' + i]
         manage_data['port'][i]['NodeName'] = form_data['NodeName_' + i]
         manage_data['port'][i]['IfId'] = form_data['IfId_' + i]
         manage_data['port'][i]['IfName'] = form_data['IfName_' + i]
         manage_data['port'][i]['Vlan'] = form_data['Vlan_' + i]
         // dot1q switch ports: per-port mode + trunk allowed-VLAN list
         if (form_data['Mode_' + i] !== undefined) {
             manage_data['port'][i]['mode'] = form_data['Mode_' + i]
             manage_data['port'][i]['vlans'] = get(form_data['Vlans_' + i], '')
         }
     }
     // soft-router: collect the gateway/uplink/NAT/DHCP/static-routes payload
     // and validate it client-side before the PUT (broker re-validates).
     if (form_data['is_router'] == '1') {
         var rtr = {
             gw_cidr: get(form_data['gw_cidr'], ''),
             nat: (form_data['nat'] == '1') ? 1 : 0,
             uplink: get(form_data['uplink'], 'none'),
             dhcp: (form_data['dhcp'] == '1') ? 1 : 0,
             routes: []
         };
         if (rtr.uplink == 'net') {
             rtr.uplink_net_id = get(form_data['uplink_net_id'], '');
             rtr.uplink_cidr = get(form_data['uplink_cidr'], '');
             rtr.uplink_gw = get(form_data['uplink_gw'], '');
         }
         if (rtr.dhcp) {
             rtr.dhcp_start = get(form_data['dhcp_start'], '');
             rtr.dhcp_end = get(form_data['dhcp_end'], '');
             rtr.dhcp_dns = get(form_data['dhcp_dns'], '');
         }
         $('#form-network-manage .pnq-rtr-route-row').each(function () {
             var dst = ($(this).find('.pnq-rtr-route-dst').val() || '').trim();
             var gw = ($(this).find('.pnq-rtr-route-gw').val() || '').trim();
             if (dst !== '' || gw !== '') { rtr.routes.push({ dst: dst, gw: gw }); }
         });
         var err = validateRouterCfg(rtr);
         if (err) {
             var $e = $('#form-network-manage .pnq-rtr-error');
             $e.text(err).show();
             return false;  // keep the dialog open
         }
         manage_data['rtr'] = rtr;
     }
    console.log ( JSON.stringify(manage_data) )
    logger(1, 'DEBUG: posting form-network-add form.');
        var url = '/api/labs/session/network/manage';
        var type = 'PUT';
        var request = $.ajax({
            cache: false,
            timeout: TIMEOUT,
            type: type,
            url: encodeURI(url),
            dataType: 'json',
            data: JSON.stringify(manage_data),
            success: function (data) {
        if (data['status'] == 'success') {
            //TODO

        } else {
            //TODO
        }
        },
            error: function (data) {
            //TODO
        }
    });
    promises.push(request);

    $.when.apply(null, promises).done(function () {
        
        App.topology.printTopology();
        window.topoChange = false;
       
        $('body').children('.modal').attr('skipRedraw', true);
        $('body').children('.modal.second-win').modal('hide');
        $('body').children('.modal.fade.in').focus();
    });
    
    return false;  // Stop to avoid POST
});
// Submit network form
$(document).on('submit', '#form-network-add, #form-network-edit', function (e) {
    e.preventDefault();  // Prevent default behaviour
    var form_data = form2Array('network');
    var promises = [];
    if ($(this).attr('id') == 'form-network-add') {
        console.log('DEBUG: posting form-network-add form.');
        var url = '/api/labs/session/networks/add';
        var type = 'POST';
    } else {
        console.log('DEBUG: posting form-network-edit form.');
        var url = '/api/labs/session/networks/edit';
        var type = 'POST';
    }

    if ($(this).attr('id') == 'form-network-add') {
        // If adding need to manage multiple add
        if (form_data['count'] > 1) {
            form_data['postfix'] = 1;
        } else {
            form_data['postfix'] = 0;
        }
    } else {
        // If editing need to post once
        form_data['count'] = 1;
        form_data['postfix'] = 0;
    }

    // Multi-add: the engine has NO server-side 'postfix' support (the flag is
    // ignored), so count>1 used to post N networks all carrying the same name.
    // Number them client-side (EVE semantics: Name/Prefix + running number)
    // and fan them out 60px apart from the click point.
    var nwBaseName = form_data['name'];
    var nwBaseLeft = Number(form_data['left']);
    var nwCount = Math.max(1, Math.min(50, parseInt(form_data['count'], 10) || 1));
    form_data['count'] = nwCount;
    for (var i = 0; i < nwCount; i++) {
        form_data['left'] = nwBaseLeft + i * 60;
        if (nwCount > 1) form_data['name'] = nwBaseName + (i + 1);
        //form_data['top'] = resolveZoom(form_data['top'], 'top');
        App.loading(true);
        var request = $.ajax({
            cache: false,
            type: type,
            url: encodeURI(url),
            dataType: 'json',
            data: form_data,
            success: function (data) {
                App.loading(false)
                if (data['status'] == 'success') {
                    console.log('DEBUG: network "' + form_data['name'] + '" saved.');
                    App.topology.updateData(data['update'])
                    addMessage(data['status'], lang(data['message'], data['data']));
                } else {
                    // Application error
                    console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                    addModal('ERROR', '<p>' + data['message'] + '</p>', '<button type="button" class="btn btn-primary" data-dismiss="modal">' + lang('Close') + '</button>');
                }
            },
            error: function (data) {
                // Server error
                App.loading(false)
                var message = getJsonMessage(data['responseText']);
                console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
                console.log('DEBUG: ' + message);
                addModal('ERROR', '<p>' + message + '</p>', '<button type="button" class="btn btn-primary" data-dismiss="modal">' + lang('Close') + '</button>');
            }
        });
        promises.push(request);
    }

    $.when.apply(null, promises).done(function () {
        
        App.topology.printTopology();
        window.topoChange = false;
       
        $('body').children('.modal').attr('skipRedraw', true);
        $('body').children('.modal.second-win').modal('hide');
        $('body').children('.modal.fade.in').focus();
    });
    
    return false;  // Stop to avoid POST
});

// Submit node interfaces form
$(document).on('submit', '#form-node-connect', function (e) {
    e.preventDefault();  // Prevent default behaviour
    var form_data = form2Array('interfc');
    var node_id = $('form :input[name="node_id"]').val();
    var url = '/api/labs/session/interfaces/edit';
    var type = 'POST';
    var data = {
        node_id: node_id,
        data: form_data,
    }
    App.loading(true)
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            App.loading(false)
            if (data['status'] == 'success') {
                console.log('DEBUG: node "' + node_id + '" saved.');
                // Close the modal
                $('body').children('.modal').attr('skipRedraw', true);
                $('body').children('.modal.second-win').modal('hide');
                $('body').children('.modal.fade.in').focus();
                addMessage(data['status'], lang(data['message'], data['data']));
                App.topology.updateData(data['update']);
                App.topology.printTopology();
            } else {
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                addModal('ERROR', '<p>' + data['message'] + '</p>', '<button type="button" class="btn btn-primary" data-dismiss="modal">' + lang('Close') + '</button>');
            }
        },
        error: function (data) {
            App.loading(false)
            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            addModal('ERROR', '<p>' + message + '</p>', '<button type="button" class="btn btn-primary" data-dismiss="modal">' + lang('Close') + '</button>');
        }
    });
});


// Edit picture form
$('body').on('submit', '#form-picture-edit', function (e) {
    e.preventDefault();  // Prevent default behaviour
    var picture_id = $(this).attr('data-path');
    var missed_id = []
    var regex = /{{(NODE([0-9]*))}}/g;
    var temp;
    var str = $('form :input[name="picture[map]"]').val()
    var nodes = window.nodes;
    while (temp = regex.exec(str)) {
        if (temp[2] && !nodes.hasOwnProperty(temp[2])) missed_id.push(temp[2])
    }

    if (missed_id.length > 0) {
        var body = '<div class="form-group">'
        if (missed_id.length > 1) {
            body += '<div class="question">' + lang('Nodes IDs does not exist') + ': ' + missed_id.join(', ') + '</div>' +
                '<div class="question">' + lang('Please change it to the correct value') + '</div>'
        } else {
            body += '<div class="question">:' + lang('Node ID does not exist') + ' ' + missed_id[0] + '</div>' +
                '<div class="question">' + lang('Please change it to the correct value') + '</div>'
        }
        body += '<div style="text-align:center">' +
            '<button class="btn" data-dismiss="modal">' + lang('Continue edit picture') + '</button>' +
            // '<button type="button" class="btn" data-dismiss="modal">Cancel</button>' +
            '</div>' +
            '</div>'
        var title = lang("Warning")
        addWaring(title, body, "", "make-red make-small");
    } else {
        submitPictureEdit(picture_id)
    }

    // return false;
    // Setting options
});

function submitPictureEdit(picture_id) {
    var lab_file = $('#pnq-lab-page').attr('data-path');
    var form_data = {};

    $('form :input[name^="picture["]').each(function (id, object) {
        // Standard options
        var field_name = $(this).attr('name').replace(/^picture\[([a-z]+)\]$/, '$1');
        form_data[field_name] = $(this).val();
    });
    form_data['map'] = form_data['map'] + form_data['custommap']
    form_data['custommap'] = ''
    form_data['id'] = picture_id;
    // Get action URL
    var url = '/api/labs/session/pictures/edit';
    $.ajax({
        cache: false,

        type: 'POST',
        url: encodeURI(url),
        dataType: 'json',
        data: form_data,
        success: function (data) {
            if (data['status'] == 'success') {
                // Fetching ok
                addMessage('SUCCESS', lang('picture_save', { name: form_data['name'] }))
                printPictureInForm(picture_id);
                $('ul.map a.action-pictureget[data-path="' + picture_id + '"]').attr('title', form_data['name']);
                $('ul.map a.action-pictureget[data-path="' + picture_id + '"]').text(form_data['name'].split(" ")[0]);
                $('body').children('.modal.second-win').modal('hide');
                // Picture saved  -> reopen this page (not reload, or will be posted twice)
                // window.location.href = '/lab_edit.php' + window.location.search;
            } else {
                // Fetching failed
                addMessage('DANGER', data['status']);
            }
        },
        error: function (data) {
            addMessage('DANGER', getJsonMessage(data['responseText']));
        }
    });

    // Hide and delete the modal (or will be posted twice)
    $('#form_frame > div').modal('hide');

    // Stop or form will follow the action link
    return false;
}

// Edit picture form
$('body').on('submit', '#form-picture-delete', function (ev) {

})



$('body').on('click', '.action-textobjectduplicate', function (e) {
    console.log('DEBUG: action = action-textobjectduplicate');
    var id = $(this).attr('data-path')
        , $selected_shape
        , $duplicated_shape
        , new_id
        , textObjectsLength
        , shape_border_width
        , form_data = {}
        , new_data_html;

    $selected_shape = $("#customShape" + id + " svg").children();
    shape_border_width = $("#customShape" + id + " svg").children().attr('stroke-width');

    function getSizeObj(obj) {
        var size = 0, key;
        for (key in obj) {
            if (obj.hasOwnProperty(key)) size++;
        }
        return size;
    }

    if ($("#customShape" + id).length) {
        $selected_shape = $("#customShape" + id);
        $selected_shape.resizable("destroy");
        //$selected_shape.draggable("destroy");
        //lab_topology.setDraggable($selected_shape, false);
        $duplicated_shape = $selected_shape.clone();

        $selected_shape
            .resizable({
                autoHide: true,
                resize: function (event, ui) {
                    textObjectResize(event, ui, { "shape_border_width": shape_border_width });
                },
                stop: textObjectDragStop
            });

        getTextObjects().done(function (textObjects) {

            textObjectsLength = getSizeObj(textObjects);

            for (var i = 1; i <= textObjectsLength; i++) {
                if (textObjects['' + i + ''] == undefined) {
                    new_id = i;
                    break
                }
                if (textObjectsLength == i) {
                    new_id = i + 1;
                }
            }

            $duplicated_shape.css('top', parseInt($selected_shape.css('top')) + parseInt($selected_shape.css('width')) / 2);
            $duplicated_shape.css('left', parseInt($selected_shape.css('left')) + parseInt($selected_shape.css('height')) / 2);
            $duplicated_shape.attr("id", "customShape" + new_id);
            $duplicated_shape.attr("data-path", new_id);

            new_data_html = $duplicated_shape[0].outerHTML;
            form_data['data'] = new_data_html;
            form_data['name'] = textObjects[id]["name"];
            form_data['type'] = textObjects[id]["type"];

            createTextObject(form_data).done(function () {
                addMessage('SUCCESS', 'Lab has been saved (60023).');
            }).fail(function (message) {
                addMessage('DANGER', getJsonMessage(message));
            })
        }).fail(function (message) {
            addMessage('DANGER', getJsonMessage(message));
        });
    } else if ($("#customText" + id).length) {
        $selected_shape = $("#customText" + id);
        //$selected_shape.resizable("destroy");
        //lab_topology.setDraggable($selected_shape, false);
        $duplicated_shape = $selected_shape.clone();
        // $selected_shape
        // .resizable({
        //     autoHide: true,
        //     resize: function (event, ui) {
        //         textObjectResize(event, ui, {"shape_border_width": shape_border_width});
        //     },
        //     stop: textObjectDragStop
        // });

        getTextObjects().done(function (textObjects) {

            textObjectsLength = getSizeObj(textObjects);

            for (var i = 1; i <= textObjectsLength; i++) {
                if (textObjects['' + i + ''] == undefined) {
                    new_id = i;
                    break
                }
                if (textObjectsLength == i) {
                    new_id = i + 1;
                }
            }

            $duplicated_shape.css('top', parseInt($selected_shape.css('top')) + parseInt($selected_shape.css('width')) / 2);
            $duplicated_shape.css('left', parseInt($selected_shape.css('left')) + parseInt($selected_shape.css('height')) / 2);
            $duplicated_shape.attr("id", "customText" + new_id);
            $duplicated_shape.attr("data-path", new_id);

            new_data_html = $duplicated_shape[0].outerHTML;
            form_data['data'] = new_data_html;
            form_data['name'] = 'txt ' + new_id;
            form_data['type'] = textObjects[id]["type"];

            createTextObject(form_data).done(function () {
                addMessage('SUCCESS', lang('Lab has been saved'));
            }).fail(function (message) {
                addMessage('DANGER', getJsonMessage(message));
            })
        }).fail(function (message) {
            addMessage('DANGER', getJsonMessage(message));
        });
    }
    $('#context-menu').remove();
});

$('body').on('click', '.action-textobjecttoback', function (e) {
    console.log('DEBUG: action = action-textobjecttoback');
    var id = $(this).attr('data-path')
        , old_z_index
        , shape_border_width
        , new_data
        , $selected_shape = '';

    shape_border_width = $("#customShape" + id + " svg").children().attr('stroke-width');

    if ($("#customShape" + id).length) {
        $selected_shape = $("#customShape" + id);
        old_z_index = $selected_shape.css('z-index');
        $selected_shape.css('z-index', parseInt(old_z_index) - 1);
        $selected_shape.resizable("destroy");
        new_data = document.getElementById("customShape" + id).outerHTML;
        $selected_shape.resizable({
            autoHide: true,
            resize: function (event, ui) {
                textObjectResize(event, ui, { "shape_border_width": shape_border_width });
            },
            stop: textObjectDragStop
        });

    } else if ($("#customText" + id).length) {
        $selected_shape = $("#customText" + id);
        old_z_index = $selected_shape.css('z-index');
        $selected_shape.css('z-index', parseInt(old_z_index) - 1);
        new_data = document.getElementById("customText" + id).outerHTML;
    }

    editTextObject(id, { data: new_data }).done(function () {

    }).fail(function () {
        addMessage('DANGER', getJsonMessage(message));
    });
    $('#context-menu').remove();
});

$('body').on('click', '.action-textobjecttofront', function (e) {
    console.log('DEBUG: action = action-textobjecttofront');
    var id = $(this).attr('data-path')
        , old_z_index
        , shape_border_width
        , new_data
        , $selected_shape = '';

    shape_border_width = $("#customShape" + id + " svg").children().attr('stroke-width');
    if ($("#customShape" + id).length) {
        $selected_shape = $("#customShape" + id);
        old_z_index = $selected_shape.css('z-index');
        $selected_shape.css('z-index', parseInt(old_z_index) + 1);
        $selected_shape.resizable("destroy");
        new_data = document.getElementById("customShape" + id).outerHTML;
        $('#context-menu').remove();
        $selected_shape.resizable({
            autoHide: true,
            resize: function (event, ui) {
                textObjectResize(event, ui, { "shape_border_width": shape_border_width });
            },
            stop: textObjectDragStop
        });
    } else if ($("#customText" + id).length) {
        $selected_shape = $("#customText" + id);
        old_z_index = $selected_shape.css('z-index');
        $selected_shape.css('z-index', parseInt(old_z_index) + 1);
        new_data = document.getElementById("customText" + id).outerHTML;
        $('#context-menu').remove();
    }
    editTextObject(id, { data: new_data }).done(function () {

    }).fail(function () {
        addMessage('DANGER', getJsonMessage(message));
    });
    $('#context-menu').remove();
});

$('body').on('click', '.action-textobjectedit', function (e) {
    console.log('DEBUG: action = action-textobjectedit');
    var id = $(this).attr('data-path');

    if ($("#customShape" + id).length) {
        printFormEditCustomShape(id);
    } else if ($("#customText" + id).length) {
        printFormEditText(id);
    }
    $('#context-menu').remove();
});



//===================================================================

$(document).on('click', '.action-textobjectdelete', function (e) {
   
    const id = $(this).attr('data-path')
    const isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode")
    // <form id="form-picture-delete" data-path="' + picture_id + '" class="form-horizontal form-picture" novalidate="novalidate">

    var textQuestion = ""
    if (!isFreeSelectMode) {
        textQuestion = lang("Do you want to delete Text?");
    } else {
        textQuestion = lang("Do you want to delete selected Texts?");
    }

    var body = '<div class="form-group">' +
        '<div class="question">' + textQuestion + '</div>' +
        '<div style="text-align:center">' +
        '<button id="deleteText" class="btn btn-success" data-path="' + id + '" data-dismiss="modal">' + lang('Yes') + '</button>' +
        '<button type="button" class="btn" data-dismiss="modal">' + lang('Cancel') + '</button>' +
        '</div>' +
        '</div>'
    var title = "Warning"
    addWaring(title, body, "", "make-red make-small");
    $('#context-menu').remove();
    $('#deleteText').on('click', async function () {

        console.log('DEBUG: action = action-textobjectdelete');

        if (isFreeSelectMode) {
           var selected = $(".ui-selected");
           for (let i=0; i<selected.length; i++){
               if(selected[i].classList.contains('customText')){
                   await deleteTextObject(selected[i].getAttribute('data-path'))
               }
           }
           App.topology.printTopology();
        }
        else {
            await deleteTextObject(id).then(function(){
                App.topology.printTopology();
            })
        }

    })
});


$(document).on('click', '.action-networkdelete', function (e) {
   
    const id = $(this).attr('data-path')
    const isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode")
    // <form id="form-picture-delete" data-path="' + picture_id + '" class="form-horizontal form-picture" novalidate="novalidate">

    var textQuestion = ""
    if (!isFreeSelectMode) {
        textQuestion = lang("Do you want to delete Network?");
    } else {
        textQuestion = lang("Do you want to delete selected Network?");
    }

    var body = '<div class="form-group">' +
        '<div class="question">' + textQuestion + '</div>' +
        '<div style="text-align:center">' +
        '<button id="deleteNetwork" class="btn btn-success" data-path="' + id + '" data-dismiss="modal">' + lang('Yes') + '</button>' +
        '<button type="button" class="btn" data-dismiss="modal">' + lang('Cancel') + '</button>' +
        '</div>' +
        '</div>'
    var title = "Warning"
    addWaring(title, body, "", "make-red make-small");
    $('#context-menu').remove();
    $('#deleteNetwork').on('click', async function () {

        console.log('DEBUG: action = action-textobjectdelete');

        if (isFreeSelectMode) {
           var selected = $(".ui-selected");
           for (let i=0; i<selected.length; i++){
               if(selected[i].classList.contains('network')){
                   await deleteNetwork(selected[i].getAttribute('data-path'))
               }
           }
           App.topology.printTopology();
        }
        else {
            await deleteNetwork(id).then(function(){
                App.topology.printTopology();
            })
        }

    })
});


$('body').on('contextmenu', '.edit-custom-shape-form, .edit-custom-text-form, #context-menu', function (e) {
    e.preventDefault();
    e.stopPropagation();
});


function getCharacterOffsetWithin(range, node) {
    var treeWalker = document.createTreeWalker(
        node,
        NodeFilter.SHOW_TEXT,
        function (node) {
            var nodeRange = document.createRange();
            nodeRange.selectNodeContents(node);
            return nodeRange.compareBoundaryPoints(Range.END_TO_END, range) < 1 ?
                NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
        false
    );

    var charCount = 0;
    while (treeWalker.nextNode()) {
        charCount += treeWalker.currentNode.length;
    }
    if (range.startContainer.nodeType == 3) {
        charCount += range.startOffset;
    }
    return charCount;
}



/*******************************************************************************
 * Free Select
 * ****************************************************************************/
window.freeSelectedNodes = [];
$(document).on("click", ".action-freeselect", function (event) {
    var self = this
        , isFreeSelectMode = $(self).hasClass("active")
        ;

    if (isFreeSelectMode) {
        // TODO: disable Free Select Mode
        $(".node_frame").removeClass("free-selected");
    }
    else {
        // TODO: activate Free Select Mode

    }

    window.freeSelectedNodes = [];
    $(self).toggleClass("active", !isFreeSelectMode);
    $("#lab-viewport").toggleClass("freeSelectMode", !isFreeSelectMode);

});

$(document).on("click", "#lab-viewport.freeSelectMode .onode_frame", function (event) {
    event.preventDefault();
    event.stopPropagation();

    var self = this
        , isFreeSelected = $(self).hasClass("free-selected")
        , name = $(self).data("name")
        , path = $(self).data("path")
        ;

    if (isFreeSelected) {   // already present window.freeSelectedNodes = [];
        window.freeSelectedNodes = window.freeSelectedNodes.filter(function (node) {
            return node.name !== name && node.path !== path;
        });
    }
    else {                  // add to window.freeSelectedNodes = [];
        window.freeSelectedNodes.push({
            name: name
            , path: path
        });
    }

    $(self).toggleClass("free-selected", !isFreeSelected);
});

// '.user-settings' handler REMOVED (store-decomm cleanup) — same dead lane as
// '.action-useredit' above: unreachable markup, undefined printFormUser(),
// nonexistent /api/users/ route.


// Load logs page
$(document).on('click', '.action-logs', function (e) {
    console.log('DEBUG: action = logs');
    printLogs('access.txt', 10, "");
    bodyAddClass('logs');
});

/*******************************************************************************
 * Node link
 * ****************************************************************************/


$(document).on('click', 'a.interfaces.serial', function (e) {
    e.preventDefault();
})

$(document).on('click', '#lab-viewport', function (e) {
    var context = 0
    {
        try { if (e.target.className.search('action-') != -1) context = 1 } catch (ex) { }
    }
    if (!e.metaKey && !e.ctrlKey && $(this).hasClass('freeSelectMode') && window.dragstop != 1 && context == 0) {
        $('.free-selected').removeClass('free-selected')
        $('.ui-selected').removeClass('ui-selected')
        $('.ui-selecting').removeClass('ui-selecting')
        $('#lab-viewport').removeClass('freeSelectMode')
        lab_topology.clearDragSelection()
        if (LOCK == 0) {
            lab_topology.setDraggable($('.node_frame, .network_frame, .customShape'), true)
        }
    }
    if ($('.ui-selected').length < 1) $('#lab-viewport').removeClass('freeSelectMode')

    //if ( !$(this).parent().hasClass('customText') && !$(this).hasClass('customText')) { $('p').blur() ; $('p').focusout() ;}
    if ($(e.target).is('p.editable') == false) { $('p').blur(); $('p').focusout(); }
    window.dragstop = 0
    //lab_topology.repaintEverything()
});


$(document).on('click', '.customShape', function (e) {
    var node = $(this)
    var isFreeSelectMode = $("#lab-viewport").hasClass("freeSelectMode")
    if (e.metaKey || e.ctrlKey) {
        node.toggleClass('ui-selected')
        updateFreeSelect(e, node)
        e.preventDefault();
    } else {
        if (!node.hasClass('ui-selecting') && !node.hasClass('ui-selected') && isFreeSelectMode) {
            $('.free-selected').removeClass('free-selected')
            $('.ui-selected').removeClass('ui-selected')
            $('.ui-selecting').removeClass('ui-selecting')
            $('#lab-viewport').removeClass('freeSelectMode')
            lab_topology.clearDragSelection()
            if (LOCK == 0) {
                lab_topology.setDraggable($('.node_frame, .network_frame, .customShape'), true)
            }
            e.preventDefault();
            e.stopPropagation();
        }
    }
});

$(document).on('mousedown', '.network_frame, .node_frame, .customShape', function (e) {
    
    if (e.which == 1) {
        $('.select-move').removeClass('select-move')
        lab_topology.clearDragSelection()
    }
});

//show context menu when node is off
$(document).on('click', '.node.node_frame', function (e) {
    console.log('node frame click');
    var node = $(this);
    var status = parseInt(node.attr('data-status'));
    var $labViewport = $("#lab-viewport")
        , isFreeSelectMode = $labViewport.hasClass("freeSelectMode")


    if (e.metaKey || e.ctrlKey) {
        node.toggleClass('ui-selected')
        updateFreeSelect(e, node)
        e.preventDefault();
        return;
    }

    if (isFreeSelectMode) {
        e.preventDefault();
        return true;
    }

    if (node.hasClass('dragstopped') && node.removeClass('dragstopped')) {
        e.preventDefault();
        return true;
    }

    if (!status) {
        e.preventDefault();
        return false;
    }

})

$(document).on('submit', '#addConn', function (e) {

    e.preventDefault();  // Prevent default behaviour

    var form_data = form2Array('addConn');
    //alert ( JSON.stringify( form_data) )

    if (form_data['srcNodeType'] == 'net' && form_data['dstNodeType'] == 'net') {
        addModalError(lang('networks_connect_alert'))
        return
    }

    if ((!form_data['srcConn'] && form_data['srcNodeType'] != 'net') || (!form_data['dstConn'] && form_data['dstNodeType'] != 'net')) {
        addModalError(lang('Interface is exhausted'))
        return
    }

    var srcType = (((form_data['srcConn'] + '').search("serial") != -1) ? 'serial' : 'ethernet')
    var dstType = (((form_data['dstConn'] + '').search("serial") != -1) ? 'serial' : 'ethernet')
    // Get src dst type information and check compatibility
    if (srcType != dstType) {
        addModalError(lang('serial_ethernet_connect_alert'))
        return
    }

    //prevent user connect to eth0 of docker
    if (window.nodes) {
        var srcNode = window.nodes[form_data['srcNodeId']];
        var destNode = window.nodes[form_data['dstNodeId']];
        var result = true;
        if (form_data['srcNodeType'] == 'node' && srcNode && srcNode['template'] == 'docker') {
            if (form_data['srcConn'].split(',')[0] == '0') {
                result = false;
            }
        }
        if (form_data['dstNodeType'] == 'node' && destNode && destNode['template'] == 'docker') {
            if (form_data['dstConn'].split(',')[0] == '0') {
                result = false;
            }
        }
        if (!result) {
            addModalError(lang('docker_eth0_connect_alert'));
            return;
        }
    }


    // nonet - nono - netnet
    if (form_data['srcNodeType'] == 'node' && form_data['dstNodeType'] == 'node') {
        if (srcType == 'serial') {
            /// create link S2S between nodes
            //alert ( ' Need to build S2S between Node' + form_data['srcNodeId'] + ' ' + form_data['srcConn'].replace(',serial','') +' and Node' + form_data['dstNodeId'] + ' ' + form_data['dstConn'].replace(',serial','') )
            var node1 = form_data['srcNodeId']
            var iface1 = form_data['srcConn'].replace(',serial', '')
            var node2 = form_data['dstNodeId']
            var iface2 = form_data['dstConn'].replace(',serial', '')
            $.when(setNodeInterface(node1, node2 + ':' + iface2, iface1)).done(function () {
                $(e.target).parents('.modal').attr('skipRedraw', true);
                $(e.target).parents('.modal').modal('hide');
            });
        } else {
            var bridgename = $('#node' + form_data['srcNodeId']).attr('data-name') + 'iface_' + form_data['srcConn'].replace(',ethernet', '')
            var offset = $('#node' + form_data['srcNodeId']).offset()
            var node1 = form_data['srcNodeId']
            var iface1 = form_data['srcConn'].replace(',ethernet', '')
            var node2 = form_data['dstNodeId']
            var iface2 = form_data['dstConn'].replace(',ethernet', '')

            $.when(createNetworkP2P(bridgename, node1, iface1, node2, iface2)).then(function (res) {
                $(e.target).parents('.modal').attr('skipRedraw', true);
                $(e.target).parents('.modal').modal('hide');
            })

            

        }

    } else {
        if (form_data['srcNodeType'] == 'node') {
            var node = form_data['srcNodeId']
            var iface = form_data['srcConn'].replace(',ethernet', '')
            var bridge = form_data['dstNodeId']
        } else {
            var node = form_data['dstNodeId']
            var iface = form_data['dstConn'].replace(',ethernet', '')
            var bridge = form_data['srcNodeId']
        }
        $.when(setNodeInterface(node, bridge, iface)).done(function () {
            $(e.target).parents('.modal').attr('skipRedraw', true);
            $(e.target).parents('.modal').modal('hide');
            console.log('test')
        });
    }

});


/**
 *
 * @returns {*}
 */
function detachNodeLink() {

    if (window.conn || window.startNode) {
        var source = $('#inner').attr('data-source');
        $('#inner').remove();
        $('.link_selected').removeClass('link_selected');
        $('.startNode').removeClass('startNode');
        lab_topology.detach(window.conn);
        delete window.startNode;
        delete window.conn;
    }


}

// CPULIMIT Toggle

$(document).on('change', '#ToggleCPULIMIT', function (e) {
    if (e.currentTarget.id == 'ToggleCPULIMIT') {
        var status = $('#ToggleCPULIMIT').prop('checked');
        if (status != window.cpulimit) setCpuLimit(status);
    }
});

// UKSM Toggle

$(document).on('change', '#ToggleUKSM', function (e) {
    if (e.currentTarget.id == 'ToggleUKSM') {
        var status = $('#ToggleUKSM').prop('checked')
        if (status != window.uksm) setUksm(status);
    }
});

// KSM Toggle

$(document).on('change', '#ToggleKSM', function (e) {
    if (e.currentTarget.id == 'ToggleKSM') {
        var status = $('#ToggleKSM').prop('checked')
        if (status != window.ksm) setKsm(status);
    }
});

// uploaa a simple node config
// Import labs
$(document).on('click', '.action-upload-node-config', function (e) {
    console.log('DEBUG: action = import');
    printFormUploadNodeConfig($('#list-folders').attr('data-path'));
});

$(document).on('submit', '#form-upload-node-config', function (e) {
    e.preventDefault();
    var node_config = $('input[name="upload[file]"]')[0].files[0];
    console.log(node_config);
    var reader = new FileReader();
    reader.onload = function () {
        var text = reader.result;
        $('#nodeconfig').val(text);
    };
    reader.readAsText(node_config);
    $('.upload-modal').modal('hide');
});

// Generic Toggle Checknox
$(document).on('click', 'input[type=checkbox]', function (e) {
    if (e.currentTarget.value == 0) {
        e.currentTarget.value = 1;
    } else {
        e.currentTarget.value = 0;
    }
});

$(document).on('click', '.configured-nodes-checkbox', function (e) {
    var id = $(this).attr('data-path')
    setNodeData(id);
});

/* Menu button controller — hover-intent so the left pane doesn't flicker.
   The hover trigger (#lab-sizebar-button) is a CHILD of #lab-sidebar, so opening
   the pane moves the trigger and the canvas slides under it. With an immediate
   mouseleave->collapse, any transient leave during the 0.2s expand transition
   snaps the pane shut, which can re-trigger -> visible flicker, "won't open".
   Fix: defer the collapse ~250ms and cancel it on any re-entry. A brief leave
   (sub-pixel gap, the moving trigger, the transition) is absorbed; an intentional
   leave (cursor parked off the pane for 250ms) still closes it cleanly. */
var labSidebarCloseTimer = null;
function labSidebarOpen(){
    if(labSidebarCloseTimer){ clearTimeout(labSidebarCloseTimer); labSidebarCloseTimer = null; }
    addClass(document.body, 'leftmenu');
}
function labSidebarClose(){
    if(labSidebarCloseTimer){ clearTimeout(labSidebarCloseTimer); labSidebarCloseTimer = null; }
    rmClass(document.body, 'leftmenu');
}

$(document).on('click', '#lab-sizebar-button', function(e){
    var labSidebar = document.getElementById('lab-sidebar');
    if(labSidebar.clientWidth > 80){
        labSidebarClose();
    }else{
        labSidebarOpen();
    }
})

$(document).on('mouseenter', '#lab-sizebar-button, #lab-sidebar', function(e){
    e.stopPropagation();
    labSidebarOpen();
})

$(document).on('mouseleave', '#lab-sidebar', function(e){
    if(labSidebarCloseTimer) clearTimeout(labSidebarCloseTimer);
    labSidebarCloseTimer = setTimeout(labSidebarClose, 250);
})
/*********************************/

/** Modal show up when click on */
$(document).on('click', '.modal.click', function(e){
    if(e.currentTarget.classList.contains('active')) return;
    $('.modal.click').removeClass('active');
    e.currentTarget.classList.add('active');
})
