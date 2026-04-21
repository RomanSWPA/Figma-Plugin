// Reels Converter — 3:4 to 9:16
// Supports single or multi-frame selection.
// Each output is placed directly below its source frame.

figma.showUI(__html__, { width: 320, height: 460 });

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
  ) {
    return true;
  }

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
  rect.fills = [{ type: 'SOLID', color: { r: 0.098, g: 0.627, b: 0.980 }, opacity: 0.06 }];
  rect.strokes = [{ type: 'SOLID', color: { r: 0.098, g: 0.627, b: 0.980 }, opacity: 0.9 }];
  rect.strokeWeight = 1.5;
  rect.dashPattern = [6, 4];
  rect.strokeAlign = 'INSIDE';
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
// Convert a single validated frame — returns the new frame node
// ---------------------------------------------------------------------------
function convertSingleFrame(original, options) {
  var W = original.width;
  var H = original.height;
  var newH = Math.round(W * 16 / 9);
  var extra = newH - H;

  var topPad, botPad;
  if (options.distribution === 'top') {
    topPad = extra; botPad = 0;
  } else if (options.distribution === 'bottom') {
    topPad = 0; botPad = extra;
  } else {
    topPad = Math.floor(extra / 2);
    botPad = extra - topPad;
  }

  // Clone and place directly below the original (40 px gap)
  var newFrame = original.clone();
  newFrame.name = original.name + ' — 9:16 Reels';
  newFrame.x    = original.x;
  newFrame.y    = original.y + H + 40;

  // Snapshot child positions before resize
  var snapshots = new Map();
  for (var i = 0; i < newFrame.children.length; i++) {
    var child = newFrame.children[i];
    snapshots.set(child.id, {
      x:            child.x,
      y:            child.y,
      width:        child.width,
      height:       child.height,
      isBackground: isBackgroundLayer(child, W, H)
    });
  }

  // Resize frame without triggering constraint-based repositioning
  newFrame.resizeWithoutConstraints(W, newH);

  // Update any image fill on the frame itself
  setImageFillsToFill(newFrame);

  // Reposition / resize children
  for (var j = 0; j < newFrame.children.length; j++) {
    var c = newFrame.children[j];
    var snap = snapshots.get(c.id);
    if (!snap) continue;

    if (snap.isBackground) {
      try { c.x = 0; c.y = 0; } catch (_) {}
      if (c.type !== 'TEXT') {
        try { c.resizeWithoutConstraints(W, newH); } catch (_) {}
      }
      setImageFillsToFill(c);
    } else {
      try { c.x = snap.x; c.y = snap.y + topPad; } catch (_) {}
    }
  }

  if (options.showSafeZone) {
    addSafeZoneGuide(newFrame, topPad, H);
  }

  return newFrame;
}

// ---------------------------------------------------------------------------
// Main entry — handles any number of selected frames
// ---------------------------------------------------------------------------
async function convertToReels(options) {
  var selection = figma.currentPage.selection;

  if (selection.length === 0) {
    return { success: false, message: 'Nothing selected. Select one or more 3:4 banner frames.' };
  }

  var frames = selection.filter(function(n) { return n.type === 'FRAME'; });

  if (frames.length === 0) {
    return { success: false, message: 'No frames in selection. Please select frame layers (not groups or components).' };
  }

  var converted = 0;
  var skipped   = [];
  var newFrames = [];

  for (var i = 0; i < frames.length; i++) {
    var original = frames[i];

    if (original.layoutMode && original.layoutMode !== 'NONE') {
      skipped.push('"' + original.name + '": Auto Layout not supported — detach it first');
      continue;
    }

    var ratio = original.width / original.height;
    if (Math.abs(ratio - 0.75) > 0.08) {
      skipped.push('"' + original.name + '": not 3:4 (' + Math.round(original.width) + '×' + Math.round(original.height) + ')');
      continue;
    }

    try {
      var result = convertSingleFrame(original, options);
      newFrames.push(result);
      converted++;
    } catch (err) {
      skipped.push('"' + original.name + '": ' + (err.message || String(err)));
    }
  }

  if (converted === 0) {
    return { success: false, message: 'Nothing converted. ' + skipped.join('; ') };
  }

  // Select all new frames and zoom to fit
  figma.currentPage.selection = newFrames;
  figma.viewport.scrollAndZoomIntoView(newFrames);

  var msg = 'Converted ' + converted + ' frame' + (converted > 1 ? 's' : '') + ' to 9:16.';
  if (skipped.length > 0) {
    msg += ' Skipped ' + skipped.length + ': ' + skipped.join('; ');
  }
  return { success: true, message: msg };
}

// ---------------------------------------------------------------------------
// Selection info — reports count and how many are valid 3:4 frames
// ---------------------------------------------------------------------------
function sendSelectionInfo() {
  var sel = figma.currentPage.selection;
  var frames = sel.filter(function(n) { return n.type === 'FRAME'; });
  var valid  = frames.filter(function(f) {
    return Math.abs((f.width / f.height) - 0.75) <= 0.08;
  });

  if (frames.length === 0) {
    figma.ui.postMessage({ type: 'selection-info', count: 0 });
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
      ratio:      (f.width / f.height).toFixed(3)
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
// Message bus
// ---------------------------------------------------------------------------
figma.ui.onmessage = async function(msg) {
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

figma.on('selectionchange', sendSelectionInfo);
