// Reels Converter — 3:4 to 9:16
// Supports single or multi-frame selection.
// Each output is placed directly below its source frame.
// Optional AI background expansion via Stability AI outpainting.

// ---------------------------------------------------------------------------
// Selection types we can convert
// ---------------------------------------------------------------------------
var CONVERTIBLE_TYPES = ['FRAME', 'COMPONENT', 'INSTANCE'];

// ---------------------------------------------------------------------------
// Selection info — must be defined early so the startup listener can use it
// ---------------------------------------------------------------------------
function sendSelectionInfo() {
  var sel = figma.currentPage.selection;

  // Build a list of all selected types for debug output
  var allTypes = sel.map(function(n) { return n.type; });

  // Debug toast — tells us exactly what Figma sees
  figma.notify('Detected: [' + (allTypes.join(', ') || 'nothing') + ']', { timeout: 3000 });

  var frames = sel.filter(function(n) {
    return CONVERTIBLE_TYPES.indexOf(n.type) !== -1;
  });
  var valid = frames.filter(function(f) {
    return Math.abs((f.width / f.height) - 0.75) <= 0.08;
  });

  if (frames.length === 0) {
    figma.ui.postMessage({
      type:         'selection-info',
      count:        0,
      selectedType: allTypes.length > 0 ? allTypes[0] : null,
      allTypes:     allTypes
    });
    return;
  }
  if (frames.length === 1) {
    var f = frames[0];
    figma.ui.postMessage({
      type:       'selection-info',
      count:      1,
      validCount: valid.length,
      name:       f.name,
      width:      Math.round(f.width),
      height:     Math.round(f.height),
      ratio:      (f.width / f.height).toFixed(3),
      nodeType:   f.type
    });
  } else {
    figma.ui.postMessage({
      type:       'selection-info',
      count:      frames.length,
      validCount: valid.length
    });
  }
}

// ---------------------------------------------------------------------------
// Open the UI, push initial selection state, then watch for changes
// ---------------------------------------------------------------------------
figma.showUI(__html__, { width: 320, height: 470 });
sendSelectionInfo();                              // immediate push on open
figma.on('selectionchange', sendSelectionInfo);   // keep in sync as user clicks

// ---------------------------------------------------------------------------
// Background detection
// ---------------------------------------------------------------------------
function isBackgroundLayer(node, frameWidth, frameHeight) {
  if (node.type === 'TEXT') return false;

  var name = node.name.toLowerCase().trim();

  if (
    name === 'bg' ||
    name.includes('background') ||
    name.includes('backdrop') ||
    name.includes('wallpaper') ||
    name.startsWith('bg ') ||
    name.endsWith(' bg') ||
    name.includes('-bg') ||
    name.includes('_bg') ||
    name.includes('bg-') ||
    name.includes('bg_')
  ) { return true; }

  if ('width' in node && 'height' in node) {
    var coversWidth  = node.width  >= frameWidth  * 0.85;
    var coversHeight = node.height >= frameHeight * 0.85;
    var nearOrigin   = node.x >= -10 && node.y >= -10 &&
                       node.x <= 30  && node.y <= 30;
    if (coversWidth && coversHeight && nearOrigin) {
      if (node.type === 'RECTANGLE' || node.type === 'FRAME') return true;
      if ('fills' in node && node.fills !== figma.mixed) {
        if (node.fills.some(function(f) { return f.type === 'IMAGE'; })) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Safe-zone guide overlay
// ---------------------------------------------------------------------------
function addSafeZoneGuide(frame, topPad, originalHeight) {
  var rect = figma.createRectangle();
  rect.name = '[Safe Zone — delete when done]';
  rect.x = 0;
  rect.y = topPad;
  rect.resize(frame.width, originalHeight);
  rect.fills   = [{ type: 'SOLID', color: { r: 0.098, g: 0.627, b: 0.980 }, opacity: 0.06 }];
  rect.strokes = [{ type: 'SOLID', color: { r: 0.098, g: 0.627, b: 0.980 }, opacity: 0.9  }];
  rect.strokeWeight = 1.5;
  rect.dashPattern  = [6, 4];
  rect.strokeAlign  = 'INSIDE';
  frame.appendChild(rect);
}

// ---------------------------------------------------------------------------
// Safe fills setter
// ---------------------------------------------------------------------------
var FILLABLE_TYPES = new Set([
  'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR',
  'FRAME', 'COMPONENT', 'INSTANCE', 'TEXT'
]);

function setImageFillsToFill(node) {
  if (!FILLABLE_TYPES.has(node.type)) return;
  try {
    var fills = node.fills;
    if (fills === figma.mixed || !Array.isArray(fills)) return;
    if (!fills.some(function(f) { return f.type === 'IMAGE'; })) return;
    node.fills = fills.map(function(f) {
      return f.type === 'IMAGE' ? Object.assign({}, f, { scaleMode: 'FILL' }) : f;
    });
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// AI expansion — async round-trip through the UI iframe
// ---------------------------------------------------------------------------
var pendingExpandResolve = null;
var pendingExpandReject  = null;

function requestExpansion(imageBytes, upPx, downPx, apiKey) {
  return new Promise(function(resolve, reject) {
    pendingExpandResolve = resolve;
    pendingExpandReject  = reject;
    figma.ui.postMessage({
      type:       'expand-image',
      imageBytes: Array.from(imageBytes),
      upPx:       upPx,
      downPx:     downPx,
      apiKey:     apiKey
    });
  });
}

// ---------------------------------------------------------------------------
// Convert one validated frame
// ---------------------------------------------------------------------------
async function convertSingleFrame(original, options) {
  var W    = original.width;
  var H    = original.height;
  var newH = Math.round(W * 16 / 9);
  var extra = newH - H;

  var topPad = options.distribution === 'top'    ? extra
             : options.distribution === 'bottom' ? 0
             : Math.floor(extra / 2);
  var botPad = extra - topPad;

  // Clone, detach if instance, place below original
  var newFrame = original.clone();
  if (newFrame.type === 'INSTANCE') {
    try { newFrame = newFrame.detachInstance(); } catch (_) {}
  }
  newFrame.name = original.name + ' — 9:16 Reels';
  newFrame.x    = original.x;
  newFrame.y    = original.y + H + 40;

  // Snapshot children + find primary background node
  var snapshots = new Map();
  var bgNode    = null;
  for (var i = 0; i < newFrame.children.length; i++) {
    var child = newFrame.children[i];
    var isBg  = isBackgroundLayer(child, W, H);
    snapshots.set(child.id, {
      x: child.x, y: child.y,
      width: child.width, height: child.height,
      isBackground: isBg
    });
    if (isBg && !bgNode) bgNode = child;
  }

  // AI expansion (before any Figma modifications)
  var expandedBytes = null;
  if (options.expandBg && options.apiKey && bgNode) {
    var bgSnap = snapshots.get(bgNode.id);
    var fitsFrame = Math.abs(bgSnap.x) <= 4 &&
                    Math.abs(bgSnap.y) <= 4 &&
                    Math.abs(bgSnap.width  - W) <= 4 &&
                    Math.abs(bgSnap.height - H) <= 4;
    if (fitsFrame) {
      try {
        var rawBytes = await bgNode.exportAsync({
          format: 'PNG', constraint: { type: 'SCALE', value: 1 }
        });
        expandedBytes = await requestExpansion(rawBytes, topPad, botPad, options.apiKey);
      } catch (err) {
        figma.ui.postMessage({
          type: 'expand-warning',
          message: 'AI expansion failed for "' + original.name + '": ' +
                   (err.message || String(err)) + '. Background scaled instead.'
        });
        expandedBytes = null;
      }
    } else {
      figma.ui.postMessage({
        type: 'expand-warning',
        message: '"' + original.name + '": background doesn\'t fill the frame — scaled instead.'
      });
    }
  }

  // Resize frame
  newFrame.resizeWithoutConstraints(W, newH);
  setImageFillsToFill(newFrame);

  // Reposition / resize children
  for (var j = 0; j < newFrame.children.length; j++) {
    var c    = newFrame.children[j];
    var snap = snapshots.get(c.id);
    if (!snap) continue;

    if (snap.isBackground) {
      try { c.x = 0; c.y = 0; } catch (_) {}
      if (c.type !== 'TEXT') {
        try { c.resizeWithoutConstraints(W, newH); } catch (_) {}
      }
      if (c === bgNode && expandedBytes) {
        try {
          var newImage = figma.createImage(new Uint8Array(expandedBytes));
          if (FILLABLE_TYPES.has(c.type)) {
            var existing = (c.fills !== figma.mixed && Array.isArray(c.fills)) ? c.fills : [];
            var overlays = existing.filter(function(f) { return f.type !== 'IMAGE'; });
            c.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: newImage.hash }].concat(overlays);
          }
        } catch (_) { setImageFillsToFill(c); }
      } else {
        setImageFillsToFill(c);
      }
    } else {
      try { c.x = snap.x; c.y = snap.y + topPad; } catch (_) {}
    }
  }

  if (options.showSafeZone) addSafeZoneGuide(newFrame, topPad, H);
  return newFrame;
}

// ---------------------------------------------------------------------------
// Main entry — processes all selected valid frames
// ---------------------------------------------------------------------------
async function convertToReels(options) {
  var selection = figma.currentPage.selection;
  if (selection.length === 0) {
    return { success: false, message: 'Nothing selected. Select one or more 3:4 banner frames.' };
  }

  var frames = selection.filter(function(n) {
    return CONVERTIBLE_TYPES.indexOf(n.type) !== -1;
  });
  if (frames.length === 0) {
    var types = selection.map(function(n) { return n.type; }).join(', ');
    return { success: false, message: 'No convertible layers (got: ' + types + '). Select a Frame, Component, or Instance.' };
  }

  var converted = 0;
  var skipped   = [];
  var newFrames = [];
  var warnings  = [];

  for (var i = 0; i < frames.length; i++) {
    var original = frames[i];

    if (original.layoutMode && original.layoutMode !== 'NONE') {
      skipped.push('"' + original.name + '": Auto Layout — detach first');
      continue;
    }
    var ratio = original.width / original.height;
    if (Math.abs(ratio - 0.75) > 0.08) {
      skipped.push('"' + original.name + '": not 3:4 (' +
                   Math.round(original.width) + '\xd7' + Math.round(original.height) + ')');
      continue;
    }

    if (options.expandBg && frames.length > 1) {
      figma.ui.postMessage({ type: 'progress', current: i + 1, total: frames.length });
    }

    try {
      var result = await convertSingleFrame(original, options);
      newFrames.push(result);
      converted++;
    } catch (err) {
      skipped.push('"' + original.name + '": ' + (err.message || String(err)));
    }
  }

  if (converted === 0) {
    return { success: false, message: 'Nothing converted. ' + skipped.join('; ') };
  }

  figma.currentPage.selection = newFrames;
  figma.viewport.scrollAndZoomIntoView(newFrames);

  var msg = 'Converted ' + converted + ' frame' + (converted > 1 ? 's' : '') + ' to 9:16.';
  if (warnings.length) msg += ' ⚠️ ' + warnings.join(' | ');
  if (skipped.length)  msg += ' Skipped ' + skipped.length + ': ' + skipped.join('; ');
  return { success: true, message: msg };
}

// ---------------------------------------------------------------------------
// Message bus
// ---------------------------------------------------------------------------
figma.ui.onmessage = async function(msg) {
  if (msg.type === 'expanded-image-result') {
    if (pendingExpandResolve) {
      var res = pendingExpandResolve;
      pendingExpandResolve = null;
      pendingExpandReject  = null;
      res(msg.imageBytes);
    }
    return;
  }
  if (msg.type === 'expanded-image-error') {
    if (pendingExpandReject) {
      var rej = pendingExpandReject;
      pendingExpandResolve = null;
      pendingExpandReject  = null;
      rej(new Error(msg.message));
    }
    return;
  }
  if (msg.type === 'resize') {
    figma.ui.resize(320, msg.height);
    return;
  }

  try {
    if (msg.type === 'convert') {
      var result = await convertToReels(msg.options);
      figma.ui.postMessage(Object.assign({ type: 'result' }, result));
    } else if (msg.type === 'get-selection') {
      sendSelectionInfo();
    } else if (msg.type === 'close') {
      figma.closePlugin();
    }
  } catch (err) {
    figma.ui.postMessage({
      type: 'result',
      success: false,
      message: 'Unexpected error: ' + (err && err.message ? err.message : String(err))
    });
  }
};
