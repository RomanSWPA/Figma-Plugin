// Reels Converter — 3:4 to 9:16
// Converts a banner frame to Instagram Reels format.
// Background layers are extended to fill the new canvas; all other content
// is shifted into the safe zone (the original 3:4 content area).

figma.showUI(__html__, { width: 320, height: 460 });

// ---------------------------------------------------------------------------
// Background detection
// A layer is treated as a background when it is named like one OR when it is
// a rectangle/frame that covers ≥85 % of the parent frame from its origin.
// ---------------------------------------------------------------------------
function isBackgroundLayer(node, frameWidth, frameHeight) {
  if (node.type === 'TEXT') return false;

  const name = node.name.toLowerCase().trim();

  // Name-based heuristics
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

  // Size-based heuristics — large element anchored near the frame origin
  if ('width' in node && 'height' in node) {
    const coversWidth  = node.width  >= frameWidth  * 0.85;
    const coversHeight = node.height >= frameHeight * 0.85;
    const nearOrigin   = node.x >= -10 && node.y >= -10 &&
                         node.x <= 30  && node.y <= 30;

    if (coversWidth && coversHeight && nearOrigin) {
      // Rectangles and plain frames → background
      if (node.type === 'RECTANGLE' || node.type === 'FRAME') return true;

      // Groups / components → background only when they carry an image fill
      if ('fills' in node && node.fills !== figma.mixed) {
        if (node.fills.some(f => f.type === 'IMAGE')) return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Safe-zone guide overlay
// ---------------------------------------------------------------------------
function addSafeZoneGuide(frame, topPad, originalHeight) {
  const rect = figma.createRectangle();
  rect.name = '[Safe Zone — delete when done]';
  rect.x = 0;
  rect.y = topPad;
  rect.resize(frame.width, originalHeight);
  rect.fills = [{
    type: 'SOLID',
    color: { r: 0.098, g: 0.627, b: 0.980 },
    opacity: 0.06
  }];
  rect.strokes = [{
    type: 'SOLID',
    color: { r: 0.098, g: 0.627, b: 0.980 },
    opacity: 0.9
  }];
  rect.strokeWeight = 1.5;
  rect.dashPattern = [6, 4];
  rect.strokeAlign = 'INSIDE';
  frame.appendChild(rect);
}

// ---------------------------------------------------------------------------
// Safe fills setter — silently skips node types that don't support it
// ---------------------------------------------------------------------------
const FILLABLE_TYPES = new Set([
  'RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR',
  'FRAME', 'COMPONENT', 'INSTANCE', 'TEXT'
]);

function setImageFillsToFill(node) {
  if (!FILLABLE_TYPES.has(node.type)) return;
  try {
    const fills = node.fills;
    if (fills === figma.mixed || !Array.isArray(fills)) return;
    if (!fills.some(f => f.type === 'IMAGE')) return;
    node.fills = fills.map(f =>
      f.type === 'IMAGE' ? { ...f, scaleMode: 'FILL' } : f
    );
  } catch (_) { /* read-only or unsupported node — skip */ }
}

// ---------------------------------------------------------------------------
// Core conversion
// ---------------------------------------------------------------------------
async function convertToReels(options) {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    return { success: false, message: 'Nothing selected. Please select a 3:4 banner frame first.' };
  }

  const original = selection[0];

  if (original.type !== 'FRAME') {
    return { success: false, message: 'Selection must be a Frame. Groups and components are not supported directly — try wrapping them in a frame.' };
  }

  if (original.layoutMode && original.layoutMode !== 'NONE') {
    return { success: false, message: 'Auto Layout frames are not supported. Detach Auto Layout (Cmd/Ctrl + Shift + G) before converting.' };
  }

  const W = original.width;
  const H = original.height;
  const ratio = W / H;

  // Accept anything within 8 % of 3:4 (= 0.75)
  if (Math.abs(ratio - 0.75) > 0.08) {
    return {
      success: false,
      message: `Frame ratio is not 3:4 (detected ${Math.round(W)}×${Math.round(H)}, ratio ${ratio.toFixed(3)}). Please select a 3:4 banner.`
    };
  }

  const newH   = Math.round(W * 16 / 9);
  const extra  = newH - H;

  // Determine how extra vertical space is distributed
  let topPad, botPad;
  if (options.distribution === 'top') {
    topPad = extra; botPad = 0;
  } else if (options.distribution === 'bottom') {
    topPad = 0; botPad = extra;
  } else {
    // 'even' — default
    topPad = Math.floor(extra / 2);
    botPad = extra - topPad;
  }

  // ------------------------------------------------------------------
  // 1. Clone the original frame and position it to the right
  // ------------------------------------------------------------------
  const newFrame = original.clone();
  newFrame.name = `${original.name} — 9:16 Reels`;
  newFrame.x    = original.x + W + 80;
  newFrame.y    = original.y;

  // ------------------------------------------------------------------
  // 2. Snapshot child positions BEFORE the frame is resized, and
  //    classify each child as background vs. content
  // ------------------------------------------------------------------
  const snapshots = new Map();
  for (const child of newFrame.children) {
    snapshots.set(child.id, {
      x:            child.x,
      y:            child.y,
      width:        child.width,
      height:       child.height,
      isBackground: isBackgroundLayer(child, W, H)
    });
  }

  // ------------------------------------------------------------------
  // 3. Resize the frame — use resizeWithoutConstraints so children
  //    stay at their original coordinates; we reposition them below.
  // ------------------------------------------------------------------
  newFrame.resizeWithoutConstraints(W, newH);

  // If the frame itself carries an image fill, switch it to FILL mode.
  setImageFillsToFill(newFrame);

  // ------------------------------------------------------------------
  // 4. Reposition / resize each child
  // ------------------------------------------------------------------
  for (const child of newFrame.children) {
    const snap = snapshots.get(child.id);
    if (!snap) continue;

    if (snap.isBackground) {
      // Stretch background to fill the entire new canvas
      try { child.x = 0; child.y = 0; } catch (_) {}
      if (child.type !== 'TEXT') {
        try { child.resizeWithoutConstraints(W, newH); } catch (_) {}
      }
      setImageFillsToFill(child);
    } else {
      // Shift content into the safe zone by the top padding amount
      try {
        child.x = snap.x;
        child.y = snap.y + topPad;
      } catch (_) {}
    }
  }

  // ------------------------------------------------------------------
  // 5. Optional safe-zone guide overlay
  // ------------------------------------------------------------------
  if (options.showSafeZone) {
    addSafeZoneGuide(newFrame, topPad, H);
  }

  // Focus the result
  figma.currentPage.selection = [newFrame];
  figma.viewport.scrollAndZoomIntoView([newFrame]);

  return {
    success: true,
    message: `Done! "${original.name}" converted to ${Math.round(W)}×${newH}px (9:16). Added ${topPad}px top / ${botPad}px bottom.`
  };
}

// ---------------------------------------------------------------------------
// Selection info helper — sent on open and on every selection change
// ---------------------------------------------------------------------------
function sendSelectionInfo() {
  const sel = figma.currentPage.selection;
  if (sel.length > 0 && sel[0].type === 'FRAME') {
    const f = sel[0];
    figma.ui.postMessage({
      type:   'selection-info',
      name:   f.name,
      width:  Math.round(f.width),
      height: Math.round(f.height),
      ratio:  (f.width / f.height).toFixed(3)
    });
  } else {
    figma.ui.postMessage({ type: 'selection-info', name: null });
  }
}

// ---------------------------------------------------------------------------
// Message bus
// ---------------------------------------------------------------------------
figma.ui.onmessage = async (msg) => {
  try {
    if (msg.type === 'convert') {
      const result = await convertToReels(msg.options);
      figma.ui.postMessage({ type: 'result', ...result });
    } else if (msg.type === 'get-selection') {
      sendSelectionInfo();
    } else if (msg.type === 'close') {
      figma.closePlugin();
    }
  } catch (err) {
    figma.ui.postMessage({
      type: 'result',
      success: false,
      message: `Unexpected error: ${err && err.message ? err.message : String(err)}`
    });
  }
};

figma.on('selectionchange', sendSelectionInfo);
