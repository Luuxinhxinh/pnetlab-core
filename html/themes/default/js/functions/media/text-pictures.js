/* media/text-pictures.js — Phase 3 functions.js decomposition (Tier A).
 * Moved verbatim from functions.js; re-attached to window via the
 * transition shim so the ~40 pnetlab-* add-ons + golden javascript.js
 * keep resolving these as globals (bare-name -> window). CSP-clean. */

function getPictures(picture_id) {
    var deferred = $.Deferred();
    var url = '/api/labs/session/pictures';
    var data = picture_id != null ? { id: picture_id } : {};
    var type = 'GET';
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: got pictures(s) from lab');
                deferred.resolve(data['data']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Get lab pictures
function getPicturesMapped(picture_id) {
    var deferred = $.Deferred();

    var url = '/api/labs/session/picturesmapped';
    var type = 'GET';
    var data = picture_id != null ? { id: picture_id } : {};
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: got pictures(s) from lab.');
                deferred.resolve(data['data']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}


// Get lab topology
function deletePicture(picture_id) {
    var deferred = $.Deferred();
    var url = '/api/labs/session/pictures/delete';
    $.ajax({
        cache: false,

        type: 'POST',
        url: encodeURI(url),
        dataType: 'json',
        data: {
            id: picture_id,
        },
        success: function (data) {
            if (data['status'] == 'success') {
                // Fetching ok
                $('.picture' + picture_id).fadeOut(300, function () {
                    $(this).remove();
                });
                deferred.resolve(data);
            } else {
                // Fetching failed
                addMessage('DANGER', lang(data['status']));
                deferred.reject(data['status']);
            }
        },
        error: function (data) {
            addMessage('DANGER', lang(getJsonMessage(data['responseText'])));
            deferred.reject();
        }
    });
    return deferred.promise();
}

// Post login
function printPictureInForm(id) {
    var picture_id = id;
    var picture_url = `/api/labs/session/picturedata?id=${picture_id}`;

    //$.when(getPicturesMapped(picture_id)).done(function (picture) {
    $.when(getPictures(picture_id)).done(function (picture) {
        // var picture_map = picture['map'];
        // picture_map = picture_map.replace(/href='telnet:..{{IP}}:{{NODE([0-9]+)}}/g, function (a, b, c, d, e) {
        //     var nodehref = ''
        //     if ($("#node" + b).length > 0) nodehref = $("#node" + b).find('a')[0].href
        //     return "href='" + nodehref

        // });
        // Read privileges and set specific actions/elements
        var sizeClass = FOLLOW_WRAPPER_IMG_STATE == 'resized' ? 'picture-img-autosozed' : ''
        //var sizeClass = ""
        var body = '<div id="lab_picture">' +
            '<img class="' + sizeClass + '" usemap="#picture_map" ' +
            'src="' + picture_url + '" ' +
            'alt="' + picture['name'] + '" ' +
            'title="' + picture['name'] + '" ' +
            '/>' +
            '</div>';

        var footer = '';

        printNodesMap({ name: picture['name'], body: body, footer: footer }, function () {
            setTimeout(function () {
                $('map').imageMapResize();
            }, 500);
        });
        // Wave 1 (b2) — pictures modal pan/zoom is now plain CSS transform +
        // pointer/wheel (drag to pan, wheel to zoom), replacing the jsPlumb
        // `lab_picture` instance this modal used solely for image zoom. The
        // controller owns #lab_picture's transform; the #picslider still drives zoom
        // through it (functions/canvas/zoom.js:zoompic → pnqPicturePanZoom.setZoom).
        window.pnqPicturePanZoom = pnqMakePicturePanZoom(document.getElementById('lab_picture'));
        $('#picslider').slider("value", 100)
    }).fail(function (message) {
        addModalError(message);
    });
}

// CSS-transform pan/zoom controller for the pictures modal (Wave 1 / b2). Owns a
// single translate+scale transform on the picture container `el`; drag-to-pan
// (pointer events) and wheel-to-zoom around the cursor, plus setZoom(pct) for the
// #picslider. Self-contained, no jsPlumb. Re-created each time a picture opens; the
// previous instance's listeners live on the discarded DOM node, so no teardown is
// needed (the modal body is replaced wholesale on the next open).
function pnqMakePicturePanZoom(el) {
    if (!el) return null;
    var scale = 1, tx = 0, ty = 0;
    var MIN = 0.1, MAX = 2.0;           // matches #picslider min/max (10%..200%)
    var dragging = false, startX = 0, startY = 0, startTx = 0, startTy = 0;

    el.style.transformOrigin = '0 0';
    el.style.cursor = 'grab';
    el.style.willChange = 'transform';
    // Contain the (possibly-scaled) image inside the modal body without spilling.
    var host = el.parentNode;
    if (host && host.style) { host.style.overflow = 'hidden'; }

    function apply() {
        el.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    }
    function clampScale(s) { return Math.max(MIN, Math.min(MAX, s)); }

    // Origin O = the host container's top-left in client coords = the untransformed
    // position of el's top-left (transformOrigin is 0,0). With transform
    // `translate(t) scale(s)`, an element-local point p appears at client O + t + p*s.
    function originClient() {
        var h = el.parentNode;
        var hr = h && h.getBoundingClientRect ? h.getBoundingClientRect() : { left: 0, top: 0 };
        return { x: hr.left, y: hr.top };
    }
    // Zoom around a client-space focal point (cx,cy) so content under the cursor
    // stays put. Omit the focal point to zoom around the origin.
    // Invariant-focal solution (see derivation): t' = (F-O)(1 - s'/s) + t*(s'/s).
    function zoomTo(nextScale, cx, cy) {
        var s2 = clampScale(nextScale);
        var O = originClient();
        var Fx = (cx == null ? O.x : cx);
        var Fy = (cy == null ? O.y : cy);
        var k = s2 / scale;
        tx = (Fx - O.x) * (1 - k) + tx * k;
        ty = (Fy - O.y) * (1 - k) + ty * k;
        scale = s2;
        apply();
    }

    el.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        dragging = true;
        startX = e.clientX; startY = e.clientY; startTx = tx; startTy = ty;
        el.style.cursor = 'grabbing';
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
    });
    el.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        tx = startTx + (e.clientX - startX);
        ty = startTy + (e.clientY - startY);
        apply();
    });
    function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        el.style.cursor = 'grab';
        try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);

    el.addEventListener('wheel', function (e) {
        e.preventDefault();
        var factor = e.deltaY < 0 ? 1.1 : (1 / 1.1);
        zoomTo(scale * factor, e.clientX, e.clientY);
        // keep the slider in step with wheel zoom
        var sl = document.getElementById('picslider');
        if (sl && window.jQuery) { try { $(sl).slider('value', Math.round(scale * 100)); } catch (_) {} }
    }, { passive: false });

    apply();

    return {
        // Absolute zoom in PERCENT (slider contract), around the container centre.
        setZoom: function (pct) {
            var r = el.getBoundingClientRect();
            zoomTo(pct / 100, r.left + r.width / 2, r.top + r.height / 2);
        },
        getZoom: function () { return Math.round(scale * 100); },
        reset: function () { scale = 1; tx = 0; ty = 0; apply(); }
    };
}

// Display picture form
function displayPictureForm(picture_id) {
    var deferred = $.Deferred();
    var form = '';
    var lab_file = LAB;
    if (picture_id == null) {
        // Adding a new picture
        var title = 'Add new picture';
        var action = 'picture-add';
        var button = 'Add';
        // Header
        form += '<form id="form-' + action + '" class="form-horizontal form-picture">';
        // Name
        form += '<div class="form-group"><label class="col-md-3 control-label">' + lang('Name') + '</label><div class="col-md-5"><input type="text" class="form-control-static" name="picture[name]" value=""/></div></div>';
        // File (add only)
        form += '<div class="form-group"><label class="col-md-3 control-label">' + lang('Picture') + '</label><div class="col-md-5"><input type="file" name="picture[file]" value=""/></div></div>';
        // Footer
        form += '<div class="form-group"><div class="col-md-5 col-md-offset-3"><button type="submit" class="btn btn-success">' + button + '</button><button type="button" class="btn" data-dismiss="modal">Cancel</button></div></div></form>';
        // Add the form to the HTML page
        // $('#form_frame').html(form);

        addModal("Add picture", form, '<div></div>');

        // Show the form
        // $('#modal-' + action).modal('show');
        $('.selectpicker').selectpicker();
        validateLabPicture();
        deferred.resolve();
    } else {
        // Can be lab_edit or lab_open

        $.when(getPicture(lab_file, picture_id)).done(function (picture) {
            if (picture != null) {
                var imgUrl = "/api/labs/session/picturedata?id=" + picture_id;
                if ($(location).attr('pathname') == '/lab_edit.php') {
                    var title = 'Edit picture';
                    var action = 'picture_edit';
                    var button = 'Save';

                    picture_name = picture['name'];
                    if (typeof picture['map'] != 'undefined') {
                        picture_map = picture['map'];
                    } else {
                        picture_map = '';
                    }
                    // Header
                    form += '<div class="modal fade" id="modal-' + action + '" tabindex="-1" role="dialog"><div class="modal-dialog" style="width: 100%;"><div class="modal-content"><div class="modal-header"><button type="button" class="close" data-dismiss="modal">&times;</button><h4 class="modal-title">' + title + '</h4></div><div class="modal-body"><form id="form-' + action + '" class="form-horizontal form-picture">';
                    // Name
                    form += '<div class="form-group"><label class="col-md-3 control-label">Name</label><div class="col-md-5"><input type="text" class="form-control" name="picture[name]" value="' + picture_name + '"/></div></div>';
                    // Picure
                    form += '<img id="lab_picture" src="' + imgUrl + '">'
                    // MAP
                    form += '<div class="form-group"><label class="col-md-3 control-label">Map</label><div class="col-md-5"><textarea type="textarea" name="picture[map]">' + picture_map + '</textarea></div></div>';
                    // Footer
                    form += '<input type="hidden" name="picture[id]" value="' + picture_id + '"/>';
                    form += '<div class="form-group"><div class="col-md-5 col-md-offset-3"><button type="submit" class="btn btn-success">' + button + '</button> <button type="button" class="btn" data-dismiss="modal">Cancel</button></div></div></form></div></div></div></div>';
                    // Add the form to the HTML page
                    $('#form_frame').html(form);

                    // Show the form
                    $('#modal-' + action).modal('show');
                    $('.selectpicker').selectpicker();
                    validateLabPicture();
                    deferred.resolve();
                } else {
                    var action = 'picture_open';
                    var title = picture['name'];
                    if (typeof picture['map'] != 'undefined') {
                        picture_map = picture['map'];
                    } else {
                        picture_map = '';
                    }
                    // Header
                    form += '<div class="modal fade" id="modal-' + action + '" tabindex="-1" role="dialog"><div class="modal-dialog" style="width: 100%;"><div class="modal-content"><div class="modal-header"><button type="button" class="close" data-dismiss="modal">&times;</button><h4 class="modal-title">' + title + '</h4></div><div class="modal-body">';
                    // Picure
                    form += '<img id="lab_picture" src="' + imgUrl + '" usemap="#picture_map">';
                    // Map
                    form += '<map name="picture_map">' + translateMap(picture_map) + '</map>';
                    // Footer
                    form += '</div></div></div></div>';
                    // Add the form to the HTML page
                    $('#form_frame').html(form);

                    // Show the form
                    $('#modal-' + action).modal('show');
                    deferred.resolve();
                }
            } else {
                // Cannot get picture
                raiseMessage('DANGER', 'Cannot get picture (picture_id = ' + picture_id + ').');
                deferred.reject();
            }
        });
    }

    return deferred.promise();
}

// Add a new picture
function printFormPicture(action, values) {
    var map = (values['map'] != null) ? values['map'] : ''
        , custommap = map.replace(/.*NODE.*/g, '').replace(/^\s*[\r\n]/gm, '').replace(/\n*$/, '\n')
        , name = (values['name'] != null) ? values['name'] : ''
        , width = (values['width'] != null) ? values['width'] : ''
        , height = (values['height'] != null) ? values['height'] : ''
        , title = (action == 'add') ? MESSAGES[135] : MESSAGES[137]
        , html = '';

    map = map.match(/.*NODE.*/g)
    if (map != '' && map != null) map = map.join().replace(/>,</g, '>\n<').replace(/\n*$/, '\n');

    $("#lab_picture").empty()
    $.when(getPictures(values['id'])).done(function (picture) {
        var picture_map = values['map'];
        picture_map = picture_map.replace(/{{IP}}/g, location.hostname);
        var nodes = window.nodes;
            if (action == 'add') {
                html += '<form id="form-picture-' + action + '" class="form-horizontal form-lab-' + action + '">' +
                    '<div class="form-group">' +
                    '<label class="col-md-3 control-label">' + lang('Name') + '</label>' +
                    '<div class="col-md-5">' +
                    '<input class="form-control" autofocus name="picture[name]" value="' + name + '" type="text"/>' +
                    '</div>' +
                    '</div>' +
                    '<div class="form-group">' +
                    '<label class="col-md-3 control-label">' + MESSAGES[137] + '</label>' +
                    '<div class="col-md-5">' +
                    '<textarea class="form-control" name="picture[map]">' + map + '</textarea></div>' +
                    '</div>' +
                    '</div>' +
                    '<div class="form-group">' +
                    '<div class="col-md-5 col-md-offset-3">' +
                    '<button type="submit" class="btn btn-success">' + lang("Save") + '</button>' +
                    '<button type="button" class="btn" data-dismiss="modal">' + lang('Cancel') + '</button>' +
                    '</div>' +
                    '</div>' +
                    '</form>';
            } else {
                //var sizeClass = FOLLOW_WRAPPER_IMG_STATE == 'resized' ? 'picture-img-autosozed' : ''
                var sizeClass = 'resized'
                html += '<form id="form-picture-' + action + '" class="form-horizontal form-lab-' + action + '" data-path=' + values['id'] + '>' +
                    '<div class="follower-wrapper">' +
                    '<img class="' + sizeClass + '" src="/api/labs/session/picturedata?id=' + values['id'] + '" alt="' + values['name'] + '" width-val="' + values['width'] + '" height-val="' + values['height'] + '"/>' +
                    '<div id="follower">' +
                    '<map name="picture_map">' + picture_map + '</map>' +
                    '</div>' +
                    '</div>' +
                    '<div class="form-group">' +
                    '<label class="col-md-3 control-label">' + lang('Name') + '</label>' +
                    '<div class="col-md-5">' +
                    '<input class="form-control" autofocus name="picture[name]" value="' + name + '" type="text"/>' +
                    '</div>' +
                    '</div>' +
                    '<div class="form-group">' +
                    '<label class="col-md-3 control-label">' + lang("Nodes") + '</label>' +
                    '<div class="col-md-5">' +
                    '<select class="form-control" id="map_nodeid">';
                $.each(nodes, function (key, value) {
                    html += '<option value="' + key + '">' + value.name + ', NODE ' + key + '</option>';
                });
                html += '<option value="CUSTOM"> CUSTOM , NODE outside lab</option>';
                html += '</select>' +
                    '</div>' +
                    '</div>' +
                    '<div class="form-group">' +
                    '<label class="col-md-3 control-label">' + lang('Image MAP') + '</label>' +
                    '<div class="col-md-5">' +
                    '<textarea class="form-control map hidden" name="picture[map]">' + map + '</textarea>' +
                    '<textarea class="form-control custommap" name="picture[custommap]">' + custommap + '</textarea>' +
                    '</div>' +
                    '</div>' +
                    '<div class="form-group">' +
                    '<div class="col-md-5 col-md-offset-3">' +
                    '<button type="submit" class="btn btn-success">' + lang("Save") + '</button>' +
                    '<button type="button" class="btn" data-dismiss="modal">' + lang('Cancel') + '</button>' +
                    '</div>' +
                    '</div>' +
                    '</form>';

            }
            console.log('DEBUG: popping up the picture form.');
            addModalWide(title, html, '', 'second-win modal-ultra-wide');
            var htmlsvg = "";
            $.each($('area'), function (key, area) {
                //alert ( area.coords )
                var cX = area.coords.split(",")[0] - 30
                var cY = area.coords.split(",")[1] - 30
                //alert(cX + " " + cY )
                htmlsvg = '<div class="map_mark" id="' + area.coords + '" style="position:absolute;top:' + cY + 'px;left:' + cX + 'px;width:60px;height:60px;"><svg width="60" height="60"><g><ellipse cx="30" cy="30" rx="28" ry="28" stroke="#000000" stroke-width="2" fill="#ffffff"></ellipse><text x="50%" y="50%" text-anchor="middle" alignment-baseline="central" stroke="#000000" stroke-width="0px" dy=".2em" font-size="12" >' + area.href.replace(/.*{{NODE/g, "NODE ").replace(/}}/g, "").replace(/.*:.*/, "CUSTOM") + '</text></g></svg></div>'
                $(".follower-wrapper").append(htmlsvg)
            });

            validateLabInfo();
    });
}


function getTextObjects() {
    var deferred = $.Deferred();
    var url = '/api/labs/session/textobjects';
    var type = 'GET';
    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: got shape(s) from lab.');
                deferred.resolve(data['data']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Get Text Object By Id
function getTextObject(id) {
    var deferred = $.Deferred();
    var url = '/api/labs/session/textobjects';
    var type = 'GET';
    var data = id != null ? { id: id } : {};
    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: got shape ' + id + 'from lab');

                try {
                    if (data['data'].data.indexOf('div') != -1) {
                        // nothing to do ?
                    } else {
                        data['data'].data = new TextDecoderLite('utf-8').decode(toByteArray(data['data'].data));
                        data['data'].data = output_secure(data['data'].data);
                    }
                }
                catch (e) {
                    console.warn("Compatibility issue", e);
                }

                deferred.resolve(data['data']);
            } else {
                // Application error
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Create New Text Object
function createTextObject(newData) {
    var deferred = $.Deferred()
        , url = '/api/labs/session/textobjects/add'
        , type = 'POST';

    if (newData.data) {
        newData.data = fromByteArray(new TextEncoderLite('utf-8').encode(encodeURIComponent(newData.data)));
    }

    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        data: newData,
        dataType: 'json',
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: create shape ' + 'for lab.');
                App.topology.updateData(data['update']);
                App.topology.printTopology();
                deferred.resolve(data['result']);
            } else {
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });

    return deferred.promise();
}

// Update Text Object
function editTextObject(id, newData) {
    var deferred = $.Deferred();
    var type = 'POST';
    var url = '/api/labs/session/textobjects/edit';

    if (newData.data) {
        newData.data = fromByteArray(new TextEncoderLite('utf-8').encode(encodeURIComponent(newData.data)));
    }

    newData.id = id;

    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: newData, // newData is object with differences between old and new data
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: custom shape text object updated.');
                App.topology.updateData(data['update'])
                deferred.resolve(data['message']);
            } else {
                
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {

            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Update Multiple Text Object
function editTextObjects(newData) {
    var deferred = $.Deferred();
    if (newData.length == 0) { deferred.resolve(); return deferred.promise(); }
    var type = 'POST';
    var url = '/api/labs/session/textobjects/edit';
    var data = { data: newData };

    $.ajax({
        cache: false,

        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data, // newData is object with differences between old and new data
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: custom shape text object updated.');
                App.topology.updateData(data['update'])
                deferred.resolve(data['message']);
            } else {
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}
// Delete Text Object By Id
function deleteTextObject(id) {
    var deferred = $.Deferred();
    var type = 'post';
    var data = id != null ? { id } : {};
    var url = '/api/labs/session/textobjects/delete';
    $.ajax({
        cache: false,
        type: type,
        url: encodeURI(url),
        dataType: 'json',
        data: data,
        success: function (data) {
            if (data['status'] == 'success') {
                console.log('DEBUG: shape/text deleted.');
                App.topology.updateData(data['update'])
                deferred.resolve();
            } else {
                // Application error
                App.topology.printTopology();
                console.log('DEBUG: application error (' + data['status'] + ') on ' + type + ' ' + url + ' (' + data['message'] + ').');
                deferred.reject(data['message']);
            }
        },
        error: function (data) {
            // Server error
            App.topology.printTopology();
            var message = getJsonMessage(data['responseText']);
            console.log('DEBUG: server error (' + data['status'] + ') on ' + type + ' ' + url + '.');
            console.log('DEBUG: ' + message);
            deferred.reject(message);
        }
    });
    return deferred.promise();
}

// Text Object Drag Stop / Resize Stop
function textObjectDragStop(event, ui) {
    var id
        , objectData
        , shape_border_width
        ;
    if (event.target.id.indexOf("customShape") != -1) {
        id = event.target.id.slice("customShape".length);
        shape_border_width = $("#customShape" + id + " svg").children().attr('stroke-width');
    }
    else if (event.target.id.indexOf("customText") != -1) {
        id = event.target.id.slice("customText".length);
        shape_border_width = 5;
    }

    objectData = event.target.outerHTML;


    editTextObject(id, {
        data: objectData
    });
}

function setShapePosition(shape) {
    var id
        , objectData
        , shape_border_width
        ;
    if (shape.id.indexOf("customShape") != -1) {
        id = shape.id.slice("customShape".length);
        shape_border_width = $("#customShape" + id + " svg").children().attr('stroke-width');
    }
    else if (shape.id.indexOf("customText") != -1) {
        id = shape.id.slice("customText".length);
        shape_border_width = 5;
    }

    //objectData = shape.outerHTML;
    objectData = shape.outerHTML;
    editTextObject(id, {
        data: objectData
    });
}

// Text Object Resize Event
function textObjectResize(event, ui, shape_options) {
    var newWidth = ui.size.width
        , newHeight = ui.size.height
        ;

    $("svg", ui.element).attr({
        width: newWidth,
        height: newHeight
    });
    $("svg > rect", ui.element).attr({
        width: newWidth,
        height: newHeight
    });
    $("svg > ellipse", ui.element).attr({
        rx: newWidth / 2 - shape_options['shape_border_width'] / 2,
        ry: newHeight / 2 - shape_options['shape_border_width'] / 2,
        cx: newWidth / 2,
        cy: newHeight / 2
    });
    var n = $("br", ui.element).length;
    if (n) {
        $("p", ui.element).css({
            "font-size": newHeight / (n * 1.5 + 1)
        });
    } else {
        $("p", ui.element).css({
            "font-size": newHeight / 2
        });
    }
    if ($("p", ui.element).length && $(ui.element).width() > newWidth) {
        ui.size.width = $(ui.element).width();
    }
}

// Edit Form: Custom Shape
function printFormEditCustomShape(id) {
    $('.edit-custom-shape-form').remove();
    $('.edit-custom-text-form').remove();
    $('.customShape').each(function (index) {
        $(this).removeClass('in-editing');
    });
    getTextObject(id).done(function (res) {
        var borderTypes = ['solid', 'dashed']
            , firstShapeValues = {}
            , shape
            , transparent = false
            , colorDigits
            , bgColor
            , html = pnqEjs('/themes/default/ejs/form_edit_custom_shape.ejs').render({
                MESSAGES: MESSAGES,
                id: id
            })

        $('#body').append(html);

        if (isIE) {
            $('input[type="color"]').hide()
            $('input.shape_border_color').colorpicker({
                color: "#000000",
                defaultPalette: 'web'
            })
            $('input.shape_background_color').colorpicker({
                color: "#ffffff",
                defaultPalette: 'web'
            })
        }
        for (var i = 0; i < borderTypes.length; i++) {
            $('.edit-custom-shape-form .border-type-select').append($('<option></option>').val(borderTypes[i]).html(borderTypes[i]));
        }

        if ($("#customShape" + id + " svg").children().attr('stroke-dasharray')) {
            $('.edit-custom-shape-form .border-type-select').val(borderTypes[1]);
            firstShapeValues['border-types'] = borderTypes[1];
        } else {
            $('.edit-custom-shape-form .border-type-select').val(borderTypes[0]);
            firstShapeValues['border-types'] = borderTypes[0];
        }

        bgColor = $("#customShape" + id + " svg").children().attr('fill');
        colorDigits = /(.*?)rgba{0,1}\((\d+), (\d+), (\d+)\)/.exec(bgColor);
        if (colorDigits === null) {
            var ifHex = bgColor.indexOf('#');
            if (ifHex < 0) {
                transparent = true;
            }
        }

        if (transparent) {
            $('.edit-custom-shape-form .shape_background_transparent').addClass('active  btn-success').text('On');
        } else {
            $('.edit-custom-shape-form .shape_background_transparent').removeClass('active  btn-success').text('Off');
        }

        firstShapeValues['shape-name'] = res.name;
        firstShapeValues['shape-z-index'] = $('#customShape' + id).css('z-index');
        firstShapeValues['shape-background-color'] = rgb2hex($("#customShape" + id + " svg").children().attr('fill'));
        firstShapeValues['shape-border-color'] = rgb2hex($("#customShape" + id + " svg ").children().attr('stroke'));
        firstShapeValues['shape-border-width'] = $("#customShape" + id + " svg").children().attr('stroke-width');
        firstShapeValues['shape-rotation'] = getElementsAngle("#customShape" + id);
        // $("#customShape" + id ).attr('name');

        // fill inputs
        $('.edit-custom-shape-form .shape-z_index-input').val(firstShapeValues['shape-z-index'] - 1000);
        $('.edit-custom-shape-form .shape_background_color').val(firstShapeValues['shape-background-color']);
        $('.edit-custom-shape-form .shape_border_color').val(firstShapeValues['shape-border-color']);
        $('.edit-custom-shape-form .shape_border_width').val(firstShapeValues['shape-border-width']);
        $('.edit-custom-shape-form .shape-rotation-input').val(firstShapeValues['shape-rotation']);
        $('.edit-custom-shape-form .shape-name-input').val(firstShapeValues['shape-name']);

        // fill backup
        $('.edit-custom-shape-form .firstShapeValues-z_index').val(firstShapeValues['shape-z-index']);
        $('.edit-custom-shape-form .firstShapeValues-border-color').val(firstShapeValues['shape-border-color']);
        $('.edit-custom-shape-form .firstShapeValues-background-color').val(firstShapeValues['shape-background-color']);
        $('.edit-custom-shape-form .firstShapeValues-border-type').val(firstShapeValues['border-types']);
        $('.edit-custom-shape-form .firstShapeValues-border-width').val(firstShapeValues['shape-border-width']);
        $('.edit-custom-shape-form .firstShapeValues-rotation').val(firstShapeValues['shape-rotation']);

        if ($("#customShape" + id + " svg").children().attr('cx')) {
            $('.edit-custom-shape-form .shape_border_width').val(firstShapeValues['shape-border-width'] * 2);
            $('.edit-custom-shape-form .firstShapeValues-border-width').val(firstShapeValues['shape-border-width'] * 2);
        }
        $("#customShape" + id).addClass('in-editing');
    });

}

// Edit Form: Text
function printFormEditText(id) {
    $('.edit-custom-shape-form').remove();
    $('.edit-custom-text-form').remove();
    $('.customShape').each(function (index) {
        $(this).removeClass('in-editing');
    });

    var firstTextValues = {}
        , transparent = false
        , colorDigits
        , bgColor
        , html = pnqEjs('/themes/default/ejs/form_edit_text.ejs').render({
            id: id,
            MESSAGES: MESSAGES
        })

    $('#body').append(html);

    if (isIE) {
        $('input[type="color"]').hide()
        $('input.shape_border_color').colorpicker({
            color: "#000000",
            defaultPalette: 'web'
        })
        $('input.shape_background_color').colorpicker({
            color: "#ffffff",
            defaultPalette: 'web'
        })
    }
    bgColor = $("#customText" + id + " p").css('background-color');
    colorDigits = /(.*?)rgba{0,1}\((\d+), (\d+), (\d+)\)/.exec(bgColor);
    if (colorDigits === null) {
        var ifHex = bgColor.indexOf('#');
        if (ifHex < 0) {
            transparent = true;
        }
    }

    if (transparent) {
        $('.edit-custom-text-form .text_background_transparent').addClass('active  btn-success').text('On');
    } else {
        $('.edit-custom-text-form .text_background_transparent').removeClass('active  btn-success').text('Off');
    }

    firstTextValues['text-z-index'] = parseInt($('#customText' + id).css('z-index'));
    firstTextValues['text-color'] = rgb2hex($("#customText" + id + " p").css('color'));
    firstTextValues['text-background-color'] = rgb2hex($("#customText" + id + " p").css('background-color'));
    firstTextValues['text-rotation'] = getElementsAngle("#customText" + id);


    $('.edit-custom-text-form .text-z_index-input').val(parseInt(firstTextValues['text-z-index']) - 1000);
    $('.edit-custom-text-form .text_color').val(firstTextValues['text-color']);
    $('.edit-custom-text-form .text_background_color').val(firstTextValues['text-background-color']);
    $('.edit-custom-text-form .text-rotation-input').val(firstTextValues['text-rotation']);

    if ($("#customText" + id + " p").css('font-style') == 'italic') {
        $('.edit-custom-text-form .btn-text-italic').addClass('active');
        firstTextValues['text-type-italic'] = 'italic'
    }
    if ($("#customText" + id + " p").css('font-weight') == 'bold') {
        $('.edit-custom-text-form .btn-text-bold').addClass('active');
        firstTextValues['text-type-bold'] = 'bold';
    }
    if ($("#customText" + id + " p").attr('align') == 'left') {
        $('.edit-custom-text-form .btn-align-left').addClass('active');
        firstTextValues['text-align'] = 'left';
    } else if ($("#customText" + id + " p").attr('align') == 'center') {
        $('.edit-custom-text-form .btn-align-center').addClass('active');
        firstTextValues['text-align'] = 'center';
    } else if ($("#customText" + id + " p").attr('align') == 'right') {
        $('.edit-custom-text-form .btn-align-right').addClass('active');
        firstTextValues['text-align'] = 'right';
    }

    $('.edit-custom-text-form .firstTextValues-z_index').val(parseInt(firstTextValues['text-z-index']));
    $('.edit-custom-text-form .firstTextValues-color').val(firstTextValues['text-color']);
    $('.edit-custom-text-form .firstTextValues-background-color').val($("#customText" + id + " p").css('background-color'));
    $('.edit-custom-text-form .firstTextValues-italic').val(firstTextValues['text-type-italic']);
    $('.edit-custom-text-form .firstTextValues-bold').val(firstTextValues['text-type-bold']);
    $('.edit-custom-text-form .firstTextValues-align').val(firstTextValues['text-align']);
    $('.edit-custom-text-form .firstTextValues-rotation').val(firstTextValues['text-rotation']);

    $("#customText" + id).addClass('in-editing');
}

// Change from RGB to Hex color

/* transition shim: expose as globals (unchanged call contract) */
Object.assign(window, {
  getPictures, getPicturesMapped, deletePicture, printPictureInForm, displayPictureForm, printFormPicture, getTextObjects, getTextObject, createTextObject, editTextObject, editTextObjects, deleteTextObject, textObjectDragStop, setShapePosition, textObjectResize, printFormEditCustomShape, printFormEditText, pnqMakePicturePanZoom,
});
