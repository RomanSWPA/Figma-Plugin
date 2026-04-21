// Reels Converter — 3:4 to 9:16
// Supports single or multi-frame selection.
// Each output is placed directly below its source frame.

var CONVERTIBLE_TYPES = ['FRAME', 'COMPONENT', 'INSTANCE'];

// ---------------------------------------------------------------------------
// Selection info
// ---------------------------------------------------------------------------
function sendSelectionInfo() {
  var sel    = figma.currentPage.selection;
  var frames = sel.filter(function(n) {
    return CONVERTIBLE_TYPES.indexOf(n.type) !== -1;
  });

  if (frames.length === 0) {
    var types = sel.map(function(n) { return n.type; });
    figma.ui.postMessage({ type: 'selection-info', count: 0, selectedType: types[0] || null });
    return;
  }
  if (frames.length === 1) {
    var f = frames[0];
    figma.ui.postMessage({
      type:   'selection-info',
      count:  1,
      name:   f.name,
      width:  Math.round(f.width),
      height: Math.round(f.height)
    });
  } else {
    figma.ui.postMessage({ type: 'selection-info', count: frames.length });
  }
}

figma.showUI(__html__, { width: 320, height: 500 });
sendSelectionInfo();
figma.on('selectionchange', sendSelectionInfo);

// ---------------------------------------------------------------------------
// Background detection
// ---------------------------------------------------------------------------
function isBackgroundLayer(node, frameWidth, frameHeight) {
  if (node.type === 'TEXT') return false;

  var name = node.name.toLowerCase().trim();
  if (
    name === 'bg' || name.includes('background') || name.includes('backdrop') ||
    name.includes('wallpaper') || name.startsWith('bg ') || name.endsWith(' bg') ||
    name.includes('-bg') || name.includes('_bg') || name.includes('bg-') || name.includes('bg_')
  ) { return true; }

  if ('width' in node && 'height' in node) {
    var coversWidth  = node.width  >= frameWidth  * 0.85;
    var coversHeight = node.height >= frameHeight * 0.85;
    var nearOrigin   = node.x >= -10 && node.y >= -10 && node.x <= 30 && node.y <= 30;
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
  rect.fills        = [{ type: 'SOLID', color: { r: 0.098, g: 0.627, b: 0.980 }, opacity: 0.06 }];
  rect.strokes      = [{ type: 'SOLID', color: { r: 0.098, g: 0.627, b: 0.980 }, opacity: 0.9  }];
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
// Convert one frame (synchronous) — returns { newFrame, topPad, botPad, W, newH }
// ---------------------------------------------------------------------------
function convertSingleFrame(original, options) {
  var W     = original.width;
  var H     = original.height;
  var newH  = Math.round(W * 16 / 9);
  var extra = newH - H;

  var topPad = options.distribution === 'top'    ? extra
             : options.distribution === 'bottom' ? 0
             : Math.floor(extra / 2);
  var botPad = extra - topPad;

  var newFrame = original.clone();
  if (newFrame.type === 'INSTANCE') {
    try { newFrame = newFrame.detachInstance(); } catch (_) {}
  }
  newFrame.name = original.name + ' — 9:16 Reels';
  newFrame.x    = original.x;
  newFrame.y    = original.y + H + 40;

  var snapshots = new Map();
  for (var i = 0; i < newFrame.children.length; i++) {
    var child = newFrame.children[i];
    snapshots.set(child.id, {
      x: child.x, y: child.y,
      width: child.width, height: child.height,
      isBackground: isBackgroundLayer(child, W, H)
    });
  }

  newFrame.resizeWithoutConstraints(W, newH);
  setImageFillsToFill(newFrame);

  for (var j = 0; j < newFrame.children.length; j++) {
    var c    = newFrame.children[j];
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

  if (options.showSafeZone) addSafeZoneGuide(newFrame, topPad, H);
  return { newFrame: newFrame, topPad: topPad, botPad: botPad, W: W, newH: newH };
}

// ---------------------------------------------------------------------------
// AI expansion — promise bridge (UI does the fetch, plugin handles Figma ops)
// ---------------------------------------------------------------------------
var pendingExpandResolve = null;
var pendingExpandReject  = null;

async function requestExpansion(frameBytes, topPad, botPad, apiKey) {
  return new Promise(function(resolve, reject) {
    pendingExpandResolve = resolve;
    pendingExpandReject  = reject;
    figma.ui.postMessage({
      type:   'expand-image',
      bytes:  Array.from(frameBytes),
      topPad: topPad,
      botPad: botPad,
      apiKey: apiKey
    });
    setTimeout(function() {
      if (pendingExpandReject) {
        pendingExpandReject(new Error('AI expansion timed out (30s)'));
        pendingExpandResolve = null;
        pendingExpandReject  = null;
      }
    }, 30000);
  });
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
async function convertToReels(options) {
  var selection = figma.currentPage.selection;
  if (selection.length === 0) {
    return { success: false, message: 'Nothing selected.' };
  }

  var frames = selection.filter(function(n) {
    return CONVERTIBLE_TYPES.indexOf(n.type) !== -1;
  });
  if (frames.length === 0) {
    var types = selection.map(function(n) { return n.type; }).join(', ');
    return { success: false, message: 'Select a Frame, Component, or Instance (got: ' + types + ').' };
  }

  var converted  = 0;
  var skipped    = [];
  var aiWarnings = [];
  var newFrames  = [];

  for (var i = 0; i < frames.length; i++) {
    var original = frames[i];
    if (original.layoutMode && original.layoutMode !== 'NONE') {
      skipped.push('"' + original.name + '": Auto Layout — detach first');
      continue;
    }
    try {
      var res      = convertSingleFrame(original, options);
      var newFrame = res.newFrame;
      newFrames.push(newFrame);

      if (options.expandBg && options.apiKey) {
        try {
          var bytes         = await original.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
          var expandedBytes = await requestExpansion(bytes, res.topPad, res.botPad, options.apiKey);
          var image         = figma.createImage(new Uint8Array(expandedBytes));
          var applied       = false;
          for (var k = 0; k < newFrame.children.length; k++) {
            var ch = newFrame.children[k];
            if (isBackgroundLayer(ch, res.W, res.newH)) {
              ch.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
              applied  = true;
              break;
            }
          }
          if (!applied) {
            newFrame.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
          }
        } catch (aiErr) {
          aiWarnings.push(aiErr.message || String(aiErr));
        }
      }

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
  if (aiWarnings.length) msg += ' AI issue: ' + aiWarnings.join('; ');
  if (skipped.length)    msg += ' Skipped: '  + skipped.join('; ');
  return { success: true, message: msg };
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
    } else if (msg.type === 'expanded-image-result') {
      if (pendingExpandResolve) {
        pendingExpandResolve(msg.bytes);
        pendingExpandResolve = null;
        pendingExpandReject  = null;
      }
    } else if (msg.type === 'expanded-image-error') {
      if (pendingExpandReject) {
        pendingExpandReject(new Error(msg.message || 'AI expansion failed'));
        pendingExpandResolve = null;
        pendingExpandReject  = null;
      }
    } else if (msg.type === 'resize') {
      figma.ui.resize(320, msg.height);
    }
  } catch (err) {
    figma.ui.postMessage({
      type: 'result', success: false,
      message: 'Unexpected error: ' + (err && err.message ? err.message : String(err))
    });
  }
};
