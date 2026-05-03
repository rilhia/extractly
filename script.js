/* =============================================================================
 * Extractly — Image Asset Extractor
 * Core canvas interaction, state management, pixel processing, and touch support.
 *
 * Wizard Steps:
 *   1. Load Image      — Upload source file, set up canvas
 *   2. Remove Content  — Pick background colour, draw redaction boxes
 *   3. Remove BG       — Flood fill or global colour removal to transparency
 *   4. Colour Cleanup  — Protect palette colours, erase the rest
 *   5. Blemish Removal — Draw boxes to erase localised artefacts
 *   6. Export          — Select/size crop region, download PNG
 * ============================================================================= */


/* -------------------------------------------------------------------------- */
/* DOM ELEMENTS                                                                */
/* -------------------------------------------------------------------------- */

const canvas   = document.getElementById('mainCanvas');
const ctx      = canvas.getContext('2d', { willReadFrequently: true });
const overlay  = document.getElementById('overlayCanvas');
const octx     = overlay.getContext('2d');
const wrapper  = document.getElementById('wrapper');
const viewport = document.getElementById('viewport');

const targetW      = document.getElementById('targetW');
const targetH      = document.getElementById('targetH');
const cropWInput   = document.getElementById('cropW');
const cropHInput   = document.getElementById('cropH');
const cropTemplate = document.getElementById('cropTemplate');


/* -------------------------------------------------------------------------- */
/* APP STATE                                                                   */
/* -------------------------------------------------------------------------- */

/** Current wizard step (1–6). */
let currentStep = 1;

/** Full ImageData snapshot saved at each step transition for Back navigation. */
let stepSnapshots = [];

/** The working ImageData that all edits are applied to. */
let baseImageData = null;

/**
 * Sub-step history for Undo within a single wizard step.
 * Each entry is an ImageData captured before a discrete user action.
 */
let stepHistoryStack = [];

/** Current CSS zoom multiplier applied to the canvas. */
let currentZoom = 1;

/** True while the user is click-dragging to draw or resize a selection box. */
let isDrawing = false;

/** True while the user is right-click panning the viewport. */
let isPanning = false;

/** True while the user is dragging an existing crop window (Step 6). */
let isMovingCrop = false;

/** Mouse X/Y at the start of a drag operation, in image-pixel space. */
let startX, startY;

/** Seed data {x, y, color} for the active flood fill operation (Step 3). */
let floodSeed = null;

/**
 * When true, a single touch finger pans the viewport instead of triggering
 * the current step action. Toggled by the floating pan button on touch devices.
 * Replaces the right-click pan gesture, which isn't available on touchscreens.
 */
let panModeActive = false;

/** Clean image snapshot captured immediately before a flood fill, enabling
 *  live tolerance preview without re-running from scratch each time. */
let preFloodImageData = null;


/* -------------------------------------------------------------------------- */
/* CROPPING STATE                                                              */
/* -------------------------------------------------------------------------- */

/** Crop box geometry and active flag. Coordinates are in image-pixel space. */
let cropRect = { x: 0, y: 0, w: 0, h: 0, active: false };

/** Pixel offset between the drag start and the crop box origin, used to
 *  keep the box under the cursor when dragging it to a new position. */
let dragOffset = { x: 0, y: 0 };

/** Step 2 gate — must be true (background colour confirmed) before
 *  redaction boxes are committed to the canvas. */
let step2Confirmed = false;

/** Step 4 gate — enables the tolerance cleanup slider once the user
 *  has finished building their protected palette and clicked Enable. */
let step4Armed = false;

/** Background colour selected in Step 2 ({r, g, b}). */
let bgColor = null;

/** Array of {r, g, b} colours marked as protected in Step 4.
 *  These pixels are excluded from cleanup operations. */
let protectedPalette = [];

/** The most recently picked anchor colour, used as the reference for
 *  transparency removal (Step 3) and protection (Step 4). */
let lastAnchorColor = null;


/* -------------------------------------------------------------------------- */
/* STEP CONFIGURATION                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Per-step title and instruction text rendered in the UI header.
 * @type {{ title: string, inst: string }[]}
 */
/*
 * Step instructions are written for the primary use case: extracting clean
 * assets from property floorplans (e.g. from Zoopla, Rightmove) for use as
 * Home Assistant Lovelace dashboard floorplan cards.
 *
 * Key expectation to set throughout: Extractly uses rule-based colour maths,
 * NOT AI or machine learning. It works best on images with clearly defined,
 * solid-colour regions — printed floorplans, diagrams, logos, and icons.
 * Photographic images with gradients and noise can still be processed but
 * require more passes and careful tolerance tuning.
 */
const stepConfig = [
    {
        title: "Step 1: Load Your Image",
        inst:  `Load the image you want to extract an asset from. 
                <b>Extractly works best on clean, flat-colour images</b> - property floorplans 
                (from sites like Zoopla or Rightmove), architectural diagrams, icons, and logos. 
                It uses <b>colour-matching maths, not AI</b>, so sharply defined colour boundaries 
                give the best results. Photographs with gradients or complex backgrounds can still 
                be processed, but may need several passes through the steps. 
                <b>Tip:</b> if your image is inside a PDF, take a screenshot or export it as a PNG first. 
                The higher the resolution, the more precise your extraction.`
    },
    {
        title: "Step 2: Remove Unwanted Content",
        inst:  `Cover up text, logos, labels, or any other content you want to remove before 
                background extraction. 
                <b>First, click the background area</b> of the image to sample its colour — 
                the colour will appear so you can confirm it's correct, then click <i>Confirm Background</i>. 
                <b>Then draw boxes</b> over anything you want to paint out. Each box is filled with 
                the background colour you just sampled, seamlessly hiding the content underneath. 
                <b>Why do this now?</b> It's a simplification process. If we first cover content we do not want using the background colour, it'll be rendered transparent 
                when we get to remove the background.  
                Use <i>Undo</i> to remove the last box if needed.`
    },
    {
        title: "Step 3: Remove the Background",
        inst:  `Make the background transparent. <b>Click anywhere on the background colour</b> you want to 
                remove. The chosen colour will be shown. Then <b>play with the Tolerance slider</b> 
                to remove the content. 
                <b>Contiguous mode</b> (flood fill): only removes pixels <i>connected</i> to where you clicked — 
                ideal for removing a clean white background without touching white areas inside the floorplan. 
                <b>Global mode</b> (checkbox off): removes that colour everywhere in the image — 
                useful if the background appears in disconnected patches. 
                <b>Reminder:</b> this step relies on colour boundaries. A floorplan printed on white paper 
                with white room interiors will need careful tolerance control and may require a follow-up 
                pass in Step 4 to clean up leftover fringe pixels. Click the image again to start a fresh pick.`
    },
    {
        title: "Step 4: Colour Cleanup",
        inst:  `Fine-tune the result by protecting the colours you want to keep, then erasing everything else. 
                <b>Click on each colour in your image that you want to preserve</b>. Each click adds the colour to the Protected Palette. 
                Build up as many colours as needed. 
                Now select a replacement colour. This can be used if you process the image again to be removed in Step 3.
                When your palette is complete, click <i>Enable Cleanup Slider</i> and then 
                <b>slowly drag the Tolerance slider</b>. Pixels that don't match any protected colour 
                will be converted to the replacement colour. 
                This is especially useful for clearing residual fringe pixels or 
                off-white noise left over from Step 3.`
    },
    {
        title: "Step 5: Blemish Removal",
        inst:  `Erase any remaining artefacts by drawing boxes around them. 
                Anything inside a box is made fully transparent. This is a precision eraser 
                for spots, stray lines, leftover text fragments, or scan noise that survived the 
                previous steps. <b>Zoom in</b> using the slider or the <b>+</b> button to work precisely 
                on small areas.`
    },
    {
        title: "Step 6: Export Your Asset",
        inst:  `Crop and download the finished asset. 
                <b>Choose a template</b> from the dropdown to lock an aspect ratio, or use 
                <i>Free Draw</i> to select any region. If you've entered a target pixel size, 
                a fixed-size crop window will follow your finger/cursor. Click to place it, 
                then drag to reposition. 
                <b>Download Crop</b> saves the selected region as a transparent PNG.
                You can extract as many assets as you choose from this.`
    }
];


/* -------------------------------------------------------------------------- */
/* CROP / RATIO HELPERS                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Returns the active aspect ratio based on the selected template or manual
 * target dimensions, or null if no ratio constraint is in effect.
 * @returns {number|null}
 */
function getActiveRatio() {
    const temp = cropTemplate.value;
    if (temp === '1:1')    return 1;
    if (temp === '4:3')    return 4 / 3;
    if (temp === '16:9')   return 16 / 9;
    if (temp === 'bespoke') {
        const tw = parseFloat(targetW.value);
        const th = parseFloat(targetH.value);
        if (tw > 0 && th > 0) return tw / th;
    }
    return null;
}

/**
 * Handles template dropdown changes. Resets crop window and syncs target inputs.
 */
cropTemplate.onchange = () => {
    const temp = cropTemplate.value;
    cropWInput.value = 0;
    cropHInput.value = 0;

    if (temp === '1:1')    { targetW.value = 1;  targetH.value = 1;  }
    else if (temp === '4:3')  { targetW.value = 4;  targetH.value = 3;  }
    else if (temp === '16:9') { targetW.value = 16; targetH.value = 9;  }
    else if (temp === 'custom') { targetW.value = 0; targetH.value = 0; }

    cropRect.active = false;
    drawFrame();
};

/**
 * Width input handler. Calculates locked height when a ratio is active,
 * then synchronises the cropRect object.
 */
cropWInput.oninput = () => {
    const ratio = getActiveRatio();
    const val   = parseFloat(cropWInput.value) || 0;
    if (ratio && val > 0) cropHInput.value = Math.round(val / ratio);
    syncRectFromInputs();
};

/**
 * Height input handler. Calculates locked width when a ratio is active,
 * then synchronises the cropRect object.
 */
cropHInput.oninput = () => {
    const ratio = getActiveRatio();
    const val   = parseFloat(cropHInput.value) || 0;
    if (ratio && val > 0) cropWInput.value = Math.round(val * ratio);
    syncRectFromInputs();
};

/**
 * Reads the current width/height inputs and updates cropRect, then redraws.
 * Called after any numeric input change to keep state in sync.
 */
function syncRectFromInputs() {
    const cw = parseFloat(cropWInput.value);
    const ch = parseFloat(cropHInput.value);
    if (cw > 0 && ch > 0) {
        cropRect.w = cw;
        cropRect.h = ch;
        cropRect.active = true;
        drawFrame();
    }
}


/* -------------------------------------------------------------------------- */
/* RENDERING                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Redraws the working image onto the main canvas and updates both the canvas
 * and overlay CSS dimensions to reflect the current zoom level.
 *
 * Design note: both canvases share the same internal resolution as the source
 * image. Zoom is applied purely via CSS width/height so that getMousePos()
 * can always work in native pixel coordinates without any offset arithmetic.
 *
 * Also draws the Step 6 crop selection box on the overlay when active.
 */
function drawFrame() {
    if (!baseImageData) return;

    // Sync pixel data to main canvas
    ctx.putImageData(baseImageData, 0, 0);

    // Scale both canvases and the wrapper via CSS to produce the zoom effect
    const zoomW = (canvas.width  * currentZoom) + 'px';
    const zoomH = (canvas.height * currentZoom) + 'px';

    canvas.style.width    = zoomW;
    canvas.style.height   = zoomH;
    overlay.style.width   = zoomW;
    overlay.style.height  = zoomH;
    wrapper.style.width   = zoomW;
    wrapper.style.height  = zoomH;

    // Match overlay internal resolution to the image so coordinates stay 1:1
    overlay.width  = canvas.width;
    overlay.height = canvas.height;
    octx.clearRect(0, 0, overlay.width, overlay.height);

    // Draw the crop selection on the overlay (Step 6 only)
    if (currentStep === 6 && cropRect.active) {
        octx.setLineDash([6, 4]);
        octx.strokeStyle = '#47b8e5';
        octx.lineWidth   = 2 / currentZoom; // Keep apparent line width constant
        octx.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);

        octx.fillStyle = 'rgba(71, 184, 229, 0.15)';
        octx.fillRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
    }
}

/**
 * Converts a screen-space mouse event position into image-pixel coordinates,
 * accounting for the wrapper's current on-screen position and zoom level.
 *
 * @param {MouseEvent} e
 * @returns {{ x: number, y: number }}
 */
function getMousePos(e) {
    const rect = wrapper.getBoundingClientRect();
    return {
        x: (e.clientX - rect.left) / currentZoom,
        y: (e.clientY - rect.top)  / currentZoom
    };
}


/* -------------------------------------------------------------------------- */
/* UI STATE MANAGEMENT                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Updates all step-dependent UI: title, instructions, button states, and
 * panel visibility. Called whenever the wizard step changes.
 */
function updateStepUI() {
    const config = stepConfig[currentStep - 1];
    document.getElementById('stepTitle').innerText       = config.title;
    document.getElementById('instructionSpan').innerHTML = config.inst;

    document.getElementById('btnBack').disabled = (currentStep === 1);
    document.getElementById('btnNext').disabled = (currentStep === 1 && !baseImageData);
    document.getElementById('btnNext').innerText = (currentStep === 6 ? 'New File' : 'Next Step');

    // Show/hide panels based on the current step
    document.getElementById('loadBox').classList.toggle('hidden',      currentStep !== 1);
    document.getElementById('zoomBox').classList.toggle('hidden',      currentStep === 1);
    document.getElementById('tintBox').classList.toggle('hidden',      currentStep === 1);
    document.getElementById('tolBox').classList.toggle('hidden',       ![3, 4].includes(currentStep));
    document.getElementById('colorPickerBox').classList.toggle('hidden', currentStep !== 4);
    document.getElementById('undoBoxTool').classList.toggle('hidden',  ![2, 3, 4, 5].includes(currentStep));
    document.getElementById('cropTools').classList.toggle('hidden',    currentStep !== 6);
    document.getElementById('floodBox').classList.toggle('hidden',     currentStep !== 3);
    document.getElementById('step3SwatchContainer').classList.toggle('hidden',
        currentStep !== 3 || !lastAnchorColor
    );

    cropRect.active = false;
    drawFrame();
    updateStepSettings();

    // Show floating controls once an image is loaded (Step 2+)
    const fc = document.getElementById('floatingControls');
    if (fc) fc.classList.toggle('hidden', currentStep === 1 || !baseImageData);
}

/**
 * Resets per-step working state (history, palette, slider, flags).
 * Called by updateStepUI after every step transition.
 */
function updateStepSettings() {
    document.getElementById('tolerance').value = 0;
    document.getElementById('tolVal').innerText = '0';

    stepHistoryStack  = [];
    protectedPalette  = [];
    lastAnchorColor   = null;
    step4Armed        = false;
    floodSeed         = null;

    // Reset pan mode so it doesn't carry over between steps
    panModeActive = false;
    const panBtn = document.getElementById('btnPanToggle');
    if (panBtn) panBtn.classList.remove('pan-active');

    const palBtn = document.getElementById('btnEnableSlider');
    palBtn.disabled  = false;
    palBtn.innerText = 'Enable Cleanup Slider';

    if (currentStep === 2) {
        step2Confirmed = false;
        bgColor        = null;
    }

    wrapper.classList.toggle('hidden', !baseImageData);

    document.getElementById('step2SwatchContainer').classList.toggle('hidden', currentStep !== 2);
    document.getElementById('paletteDisplay').classList.toggle('hidden',       currentStep !== 4);
    document.getElementById('step3SwatchContainer').classList.toggle('hidden', currentStep !== 3);

    renderPalette();
}


/* -------------------------------------------------------------------------- */
/* MOUSE EVENT HANDLERS                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Handles mousedown on the viewport.
 *
 * - Right-click: begins viewport panning.
 * - Step 6: moves an existing crop box or begins drawing a new one.
 * - Step 2 (unconfirmed): samples the background colour.
 * - Step 3: picks an anchor colour, then runs flood fill or global removal.
 * - Step 4: adds the clicked colour to the protected palette.
 * - Step 5: records a history snapshot and begins a blemish-erase draw.
 */
viewport.onmousedown = (e) => {
    if (!baseImageData || currentStep === 1) return;

    const pos = getMousePos(e);

    // Right-click → pan mode
    if (e.button === 2) {
        isPanning = true;
        startX = e.clientX;
        startY = e.clientY;
        return;
    }

    // ── Step 6: crop box placement / movement ──
    if (currentStep === 6) {
        const cw = parseFloat(cropWInput.value) || 0;
        const ch = parseFloat(cropHInput.value) || 0;
        const insideExisting = cropRect.active
            && pos.x >= cropRect.x && pos.x <= cropRect.x + cropRect.w
            && pos.y >= cropRect.y && pos.y <= cropRect.y + cropRect.h;

        if (insideExisting) {
            // Drag existing box
            isMovingCrop  = true;
            dragOffset.x  = pos.x - cropRect.x;
            dragOffset.y  = pos.y - cropRect.y;
        } else if (cw > 0 && ch > 0 && cropTemplate.value !== 'custom') {
            // Stamp a fixed-size box centred on the click
            cropRect = { active: true, w: cw, h: ch, x: pos.x - cw / 2, y: pos.y - ch / 2 };
            isMovingCrop = true;
            dragOffset   = { x: cw / 2, y: ch / 2 };
        } else {
            // Free-draw a new box
            isDrawing = true;
            startX    = pos.x;
            startY    = pos.y;
            cropRect  = { active: true, x: pos.x, y: pos.y, w: 0, h: 0 };
            cropWInput.value = 0;
            cropHInput.value = 0;
        }

        drawFrame();
        return;
    }

    startX = pos.x;
    startY = pos.y;

    // ── Step 2: background colour pick ──
    if (currentStep === 2 && !step2Confirmed) {
        const i = (Math.floor(pos.y) * canvas.width + Math.floor(pos.x)) * 4;
        bgColor = {
            r: baseImageData.data[i],
            g: baseImageData.data[i + 1],
            b: baseImageData.data[i + 2]
        };
        document.getElementById('step2Swatch').style.backgroundColor =
            `rgb(${bgColor.r},${bgColor.g},${bgColor.b})`;
        document.getElementById('step2SwatchContainer').classList.remove('hidden');
        return;
    }

    // ── Step 3: background removal ──
    if (currentStep === 3) {
        stepHistoryStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));

        const i = (Math.floor(pos.y) * canvas.width + Math.floor(pos.x)) * 4;
        const pickedColor = {
            r: baseImageData.data[i],
            g: baseImageData.data[i + 1],
            b: baseImageData.data[i + 2]
        };
        lastAnchorColor = pickedColor;

        // Reset the tolerance slider for the new pick
        document.getElementById('tolerance').value  = 0;
        document.getElementById('tolVal').innerText = '0';

        // Show the colour swatch
        const swatch = document.getElementById('step3Swatch');
        swatch.style.backgroundColor = `rgb(${pickedColor.r},${pickedColor.g},${pickedColor.b})`;
        document.getElementById('step3SwatchContainer').classList.remove('hidden');

        // Restore the pre-pick state so the history entry is clean
        const snapshot = stepHistoryStack[stepHistoryStack.length - 1];
        if (snapshot) {
            ctx.putImageData(snapshot, 0, 0);
            baseImageData = snapshot;
        }

        if (document.getElementById('floodFillToggle').checked) {
            preFloodImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            floodSeed         = { x: pos.x, y: pos.y, color: pickedColor };
            applyFloodFill(floodSeed.x, floodSeed.y, floodSeed.color,
                           document.getElementById('tolerance').value, true);
        } else {
            floodSeed         = null;
            preFloodImageData = null;
            applyEffect(true);
        }
        return;
    }

    // ── Step 4: protected palette pick ──
    if (currentStep === 4) {
        stepHistoryStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));

        const i = (Math.floor(pos.y) * canvas.width + Math.floor(pos.x)) * 4;
        lastAnchorColor = {
            r: baseImageData.data[i],
            g: baseImageData.data[i + 1],
            b: baseImageData.data[i + 2]
        };

        if (!step4Armed) {
            protectedPalette.push(lastAnchorColor);
            renderPalette();
            applyEffect(true);
        }
        return;
    }

    // ── Step 5: blemish erase draw ──
    stepHistoryStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    isDrawing = true;
};

/**
 * Handles mousemove globally to support panning, crop box dragging, and
 * live selection box drawing across all relevant steps.
 */
window.onmousemove = (e) => {
    // Panning (right-click drag)
    if (isPanning) {
        viewport.scrollLeft -= (e.clientX - startX);
        viewport.scrollTop  -= (e.clientY - startY);
        startX = e.clientX;
        startY = e.clientY;
        return;
    }

    const pos = getMousePos(e);

    if (isMovingCrop) {
        // Translate crop box while dragging
        cropRect.x = pos.x - dragOffset.x;
        cropRect.y = pos.y - dragOffset.y;
        drawFrame();
        return;
    }

    if (!isDrawing) return;

    if (currentStep === 6) {
        // Live crop box resize in Step 6
        const ratio = getActiveRatio();
        cropRect.w  = pos.x - startX;
        cropRect.h  = ratio
            ? (Math.abs(cropRect.w) / ratio) * Math.sign(pos.y - startY)
            : pos.y - startY;
        cropWInput.value = Math.round(Math.abs(cropRect.w));
        cropHInput.value = Math.round(Math.abs(cropRect.h));
        drawFrame();

    } else if (currentStep === 5 || currentStep === 2) {
        // Draw a live selection outline on the overlay
        // Coordinates are in image-pixel space; CSS zoom handles visual scaling
        octx.clearRect(0, 0, overlay.width, overlay.height);
        octx.setLineDash([6, 4]);
        octx.strokeStyle = '#47b8e5';
        octx.lineWidth   = 2 / currentZoom;
        octx.strokeRect(startX, startY, pos.x - startX, pos.y - startY);

    } else {
        // Fallback: draw dashed outline directly on the main canvas (preview only)
        ctx.putImageData(baseImageData, 0, 0);
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = '#47b8e5';
        ctx.strokeRect(startX, startY, pos.x - startX, pos.y - startY);
    }
};

/**
 * Handles mouseup globally. Commits completed selection boxes to the image
 * for Steps 2 (redaction) and 5 (blemish erase), then resets drag flags.
 */
window.onmouseup = () => {
    if (isDrawing && (currentStep === 2 || currentStep === 5)) {
        const pos = getMousePos({ clientX: event.clientX, clientY: event.clientY });
        octx.clearRect(0, 0, overlay.width, overlay.height);

        if (currentStep === 2 && step2Confirmed) {
            commitBox(startX, startY, pos.x - startX, pos.y - startY, bgColor);
        }
        if (currentStep === 5) {
            commitBox(startX, startY, pos.x - startX, pos.y - startY, null, true);
        }
        baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    isPanning = isDrawing = isMovingCrop = false;
};


/* -------------------------------------------------------------------------- */
/* PIXEL PROCESSING                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Calculates the perceptual (luma-weighted) colour distance between the pixel
 * at byte offset `i` in `data` and a target {r, g, b} colour.
 *
 * Weights: R × 0.299, G × 0.587, B × 0.114 — matching human eye sensitivity.
 *
 * @param {Uint8ClampedArray} data   Raw RGBA pixel buffer.
 * @param {number}            i     Byte index of the pixel's red channel.
 * @param {{ r: number, g: number, b: number }} target  Reference colour.
 * @returns {number} Perceptual distance (0 = identical).
 */
function colourDistance(data, i, target) {
    const r = data[i]     - target.r;
    const g = data[i + 1] - target.g;
    const b = data[i + 2] - target.b;
    return Math.sqrt(r * r * 0.299 + g * g * 0.587 + b * b * 0.114);
}

/**
 * Converts the raw 0–1 slider value to a cubic-curved tolerance (0–200).
 *
 * Using a cubic curve (exponent 3) keeps the lower two-thirds of the slider
 * highly granular, reserving aggressive removal for the upper range.
 *
 * @returns {number} Effective tolerance value.
 */
function getQuadraticTol() {
    const raw = parseFloat(document.getElementById('tolerance').value);
    return Math.pow(raw, 3) * 200;
}

/**
 * Applies the current colour effect to every pixel in the working image.
 *
 * - Step 3: makes pixels within tolerance of lastAnchorColor transparent.
 * - Step 4 (armed): replaces pixels outside the protected palette with the
 *   target replacement colour.
 *
 * @param {boolean} isFinal  If true, commits the result to baseImageData.
 */
function applyEffect(isFinal) {
    const temp = new ImageData(
        new Uint8ClampedArray(baseImageData.data),
        canvas.width, canvas.height
    );
    const data = temp.data;
    const tol  = getQuadraticTol();
    const repl = hexToRgb(document.getElementById('targetColor').value);

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue; // Skip already-transparent pixels

        const dist = colourDistance(data, i, lastAnchorColor);

        if (currentStep === 3) {
            if (dist < tol) data[i + 3] = 0;

        } else if (currentStep === 4 && step4Armed) {
            let protected_ = false;
            for (const c of protectedPalette) {
                if (colourDistance(data, i, c) < tol) { protected_ = true; break; }
            }
            if (!protected_) {
                data[i]     = repl.r;
                data[i + 1] = repl.g;
                data[i + 2] = repl.b;
                data[i + 3] = 255;
            }
        }
    }

    ctx.putImageData(temp, 0, 0);
    if (isFinal) baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Performs a contiguous flood fill from a seed pixel, making all connected
 * pixels within tolerance transparent. Uses an iterative stack (no recursion).
 *
 * When called for a live preview (`commit = false`), it always operates on
 * `preFloodImageData` so the slider can be scrubbed without data loss.
 *
 * @param {number}  x          Seed X in image-pixel coordinates.
 * @param {number}  y          Seed Y in image-pixel coordinates.
 * @param {{ r: number, g: number, b: number }} targetColor  Anchor colour.
 * @param {number}  tolerance  Maximum perceptual distance to include.
 * @param {boolean} commit     If true, writes the result to baseImageData.
 */
function applyFloodFill(x, y, targetColor, tolerance, commit = false) {
    const source  = preFloodImageData || baseImageData;
    const temp    = new ImageData(new Uint8ClampedArray(source.data), canvas.width, canvas.height);
    const data    = temp.data;
    const width   = canvas.width;
    const height  = canvas.height;
    const visited = new Uint8Array(width * height);
    const stack   = [[Math.floor(x), Math.floor(y)]];

    while (stack.length > 0) {
        const [cx, cy] = stack.pop();
        if (cx < 0 || cx >= width || cy < 0 || cy >= height) continue;

        const vIdx = cy * width + cx;
        if (visited[vIdx]) continue;

        const idx = vIdx * 4;
        if (data[idx + 3] === 0) continue; // Already transparent

        if (colourDistance(data, idx, targetColor) <= tolerance) {
            data[idx + 3] = 0;
            visited[vIdx] = 1;
            stack.push(
                [cx + 1, cy], [cx - 1, cy],
                [cx, cy + 1], [cx, cy - 1]
            );
        }
    }

    ctx.putImageData(temp, 0, 0);
    if (commit) baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Fills a rectangular region of the canvas with either a solid colour or
 * full transparency (alpha = 0). Handles negative width/height from
 * right-to-left or bottom-to-top draw directions.
 *
 * @param {number}  x      Box origin X (image pixels).
 * @param {number}  y      Box origin Y (image pixels).
 * @param {number}  w      Box width  (may be negative).
 * @param {number}  h      Box height (may be negative).
 * @param {{ r: number, g: number, b: number }|null} color  Fill colour, or null when using trans.
 * @param {boolean} trans  If true, sets pixels transparent instead of filling with color.
 */
function commitBox(x, y, w, h, color, trans = false) {
    const xS   = Math.floor(w > 0 ? x : x + w);
    const yS   = Math.floor(h > 0 ? y : y + h);
    const absW = Math.abs(w);
    const absH = Math.abs(h);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);

    for (let r = yS; r < yS + absH; r++) {
        for (let c = xS; c < xS + absW; c++) {
            if (r < 0 || r >= canvas.height || c < 0 || c >= canvas.width) continue;
            const i = (r * canvas.width + c) * 4;
            if (trans) {
                data.data[i + 3] = 0;
            } else if (color) {
                data.data[i]     = color.r;
                data.data[i + 1] = color.g;
                data.data[i + 2] = color.b;
                data.data[i + 3] = 255;
            }
        }
    }
    ctx.putImageData(data, 0, 0);
}


/* -------------------------------------------------------------------------- */
/* BUTTON / INPUT HANDLERS                                                    */
/* -------------------------------------------------------------------------- */

/** Advances to the next wizard step, saving a snapshot for Back navigation. */
document.getElementById('btnNext').onclick = () => {
    if (currentStep < 6) {
        stepSnapshots[currentStep] = ctx.getImageData(0, 0, canvas.width, canvas.height);
        currentStep++;
        baseImageData = stepSnapshots[currentStep - 1];
        updateStepUI();
    } else {
        location.reload(); // "New File" on Step 6
    }
};

/** Returns to the previous wizard step, restoring its saved snapshot. */
document.getElementById('btnBack').onclick = () => {
    if (currentStep > 1) {
        currentStep--;
        baseImageData = stepSnapshots[currentStep - 1];
        ctx.putImageData(baseImageData, 0, 0);
        updateStepUI();
    }
};

/**
 * Confirms the background colour pick in Step 2, allowing redaction boxes
 * to be drawn.
 */
document.getElementById('btnAcceptColor').onclick = () => {
    step2Confirmed = true;
    document.getElementById('step2SwatchContainer').classList.add('hidden');
};

/**
 * Arms the Step 4 cleanup slider. Captures a history snapshot first so the
 * operation can be undone.
 */
document.getElementById('btnEnableSlider').onclick = () => {
    stepHistoryStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    step4Armed = true;
    const btn    = document.getElementById('btnEnableSlider');
    btn.disabled = true;
    btn.innerText = 'Cleanup Active';
};

/**
 * Undoes the last discrete action within the current step.
 *
 * - Step 2: if no history remains, reverts to the colour-picking state.
 * - Step 4: pops the most recent palette entry and re-arms the slider if needed.
 * - All steps: restores the previous ImageData from stepHistoryStack.
 */
document.getElementById('btnLocalUndo').onclick = () => {
    if (currentStep === 2 && stepHistoryStack.length === 0) {
        step2Confirmed = false;
        document.getElementById('step2SwatchContainer').classList.remove('hidden');
    }

    if (currentStep === 4) {
        protectedPalette.pop();
        renderPalette();

        if (step4Armed) {
            step4Armed = false;
            const btn    = document.getElementById('btnEnableSlider');
            btn.disabled = false;
            btn.innerText = 'Enable Cleanup Slider';
        }
    }

    if (stepHistoryStack.length > 0) {
        const d = stepHistoryStack.pop();
        ctx.putImageData(d, 0, 0);
        baseImageData = d;
    }
};

/**
 * Exports the current crop selection as a PNG download.
 * Normalises negative dimensions from right-to-left or bottom-to-top draws.
 */
document.getElementById('btnDownload').onclick = () => {
    if (!cropRect.active) return;

    const w = Math.abs(Math.round(cropRect.w));
    const h = Math.abs(Math.round(cropRect.h));
    const x = Math.min(cropRect.x, cropRect.x + cropRect.w);
    const y = Math.min(cropRect.y, cropRect.y + cropRect.h);

    const out    = document.createElement('canvas');
    out.width    = w;
    out.height   = h;
    out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);

    const a      = document.createElement('a');
    a.download   = 'Extractly_Export.png';
    a.href       = out.toDataURL();
    a.click();
};

/**
 * Handles image file selection. Loads the image onto the canvas, captures the
 * initial ImageData snapshot, and scrolls the viewport to the centre.
 */
document.getElementById('fileInput').onchange = (e) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
        const img   = new Image();
        img.onload  = () => {
            canvas.width  = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);

            wrapper.style.width  = canvas.width  + 'px';
            wrapper.style.height = canvas.height + 'px';

            baseImageData   = ctx.getImageData(0, 0, canvas.width, canvas.height);
            stepSnapshots[0] = baseImageData;

            document.getElementById('btnNext').disabled = false;

            // Centre the canvas in the viewport by scrolling to the midpoint
            // of the total scrollable area. setTimeout(0) lets the browser
            // finish updating scroll dimensions before we read them.
            // This replaces the previous hardcoded scrollLeft/Top = 500, which
            // only worked correctly when the canvas exactly filled the viewport.
            setTimeout(() => {
                viewport.scrollLeft = Math.max(0, (viewport.scrollWidth  - viewport.clientWidth)  / 2);
                viewport.scrollTop  = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
            }, 0);

            updateStepUI();
        };
        img.src = ev.target.result;
    };
    reader.readAsDataURL(e.target.files[0]);
};

/**
 * Tolerance slider input handler. Recalculates the curved tolerance value,
 * updates the label, and re-runs the appropriate effect (flood fill or global).
 */
document.getElementById('tolerance').oninput = () => {
    const tol = getQuadraticTol();
    document.getElementById('tolVal').innerText = tol.toFixed(1);

    if (document.getElementById('floodFillToggle').checked && floodSeed && preFloodImageData) {
        applyFloodFill(floodSeed.x, floodSeed.y, floodSeed.color, tol, false);
    } else {
        applyEffect(false);
    }
};

/** Zoom slider input handler. Updates zoom level and redraws. */
document.getElementById('zoomRange').oninput = (e) => {
    currentZoom = parseFloat(e.target.value);
    document.getElementById('zoomVal').innerText = currentZoom.toFixed(2);
    drawFrame();
};

/** Background tint slider. Adjusts the viewport background grey level. */
document.getElementById('bgTint').oninput = (e) => {
    const v = e.target.value;
    wrapper.style.background = `rgb(${v},${v},${v})`;
};

/** Redraws the crop overlay whenever the viewport is scrolled. */
viewport.onscroll = () => drawFrame();

/** Suppresses the browser right-click context menu (used for panning). */
window.oncontextmenu = (e) => e.preventDefault();


/* -------------------------------------------------------------------------- */
/* UTILITIES                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Parses a CSS hex colour string into an {r, g, b} object.
 *
 * @param {string} h  Hex colour (e.g. '#ff8800' or 'ff8800').
 * @returns {{ r: number, g: number, b: number }}
 */
function hexToRgb(h) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
    return result
        ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
        : { r: 0, g: 0, b: 0 };
}

/**
 * Renders the protected colour palette swatches in Step 4.
 * Also re-enables the "Enable Cleanup Slider" button when the palette is empty.
 */
function renderPalette() {
    const list = document.getElementById('swatchList');
    list.innerHTML = '';

    protectedPalette.forEach((c) => {
        const swatch = document.createElement('div');
        swatch.className              = 'swatch';
        swatch.style.backgroundColor = `rgb(${c.r},${c.g},${c.b})`;
        list.appendChild(swatch);
    });

    if (protectedPalette.length < 1) {
        const btn    = document.getElementById('btnEnableSlider');
        btn.disabled = false;
        btn.innerText = 'Enable Cleanup Slider';
    }
}


/* -------------------------------------------------------------------------- */
/* TOUCH SUPPORT                                                               */
/*                                                                             */
/* Touch events are normalised into the same image-pixel coordinate space as  */
/* the mouse handlers, then forwarded to the existing mouse handler functions. */
/* This keeps all step logic in one place and avoids duplication.             */
/*                                                                             */
/* Gesture mapping:                                                            */
/*   Single finger tap/drag  →  equivalent to left-click / left-drag          */
/*   Two-finger drag         →  equivalent to right-click pan                 */
/*   Two-finger pinch        →  zoom (mirrors the zoom slider)                */
/* -------------------------------------------------------------------------- */

/**
 * Converts a Touch object into image-pixel coordinates, using the same
 * wrapper-relative calculation as getMousePos.
 *
 * @param {Touch} touch  A single entry from a TouchEvent touches list.
 * @returns {{ x: number, y: number }}
 */
function getTouchPos(touch) {
    const rect = wrapper.getBoundingClientRect();
    return {
        x: (touch.clientX - rect.left) / currentZoom,
        y: (touch.clientY - rect.top)  / currentZoom
    };
}

/**
 * Returns the pixel distance between two Touch points.
 * Used to calculate the pinch-to-zoom scale factor.
 *
 * @param {Touch} t1
 * @param {Touch} t2
 * @returns {number}
 */
function touchDistance(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

/** Finger separation (screen pixels) captured at the start of a pinch gesture. */
let pinchStartDist = null;

/** Zoom level captured at the moment a pinch gesture begins. */
let pinchStartZoom = null;

/**
 * Touch equivalent of viewport.onmousedown.
 *
 * Two fingers: begins a combined pan + pinch-zoom gesture.
 * One finger:  constructs a synthetic mouse-event object and forwards to the
 *              existing onmousedown handler so all step logic stays in one place.
 */
viewport.addEventListener('touchstart', (e) => {
    e.preventDefault();

    if (e.touches.length === 2) {
        isPanning      = true;
        startX         = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        startY         = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
        pinchStartZoom = currentZoom;
        return;
    }

    const touch = e.touches[0];

    // Pan mode: single finger pans the viewport (same as right-click drag on desktop).
    // This lets users move the image without needing awkward two-finger drag while
    // simultaneously trying to draw or pick a colour on a small screen.
    if (panModeActive) {
        isPanning = true;
        startX    = touch.clientX;
        startY    = touch.clientY;
        return;
    }

    viewport.onmousedown({ button: 0, clientX: touch.clientX, clientY: touch.clientY });

}, { passive: false });

/**
 * Touch equivalent of window.onmousemove.
 *
 * Two fingers: pans the viewport by tracking midpoint movement, and
 *              simultaneously updates zoom from the pinch scale factor.
 * One finger:  forwards to the existing onmousemove handler.
 *
 * Important: e.preventDefault() is only called when the user is actively
 * interacting with the canvas (drawing, panning, or pinching). Without this
 * guard, preventDefault() fires on every touchmove on the page — including
 * swipes on the toolbar — and kills horizontal toolbar scrolling on mobile.
 */
window.addEventListener('touchmove', (e) => {
    const isCanvasInteraction = isPanning || isDrawing || isMovingCrop || e.touches.length >= 2;
    if (!isCanvasInteraction) return; // Let the browser handle toolbar swipes etc.
    e.preventDefault();

    if (e.touches.length === 2) {
        // Pan — track midpoint delta
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        viewport.scrollLeft -= (midX - startX);
        viewport.scrollTop  -= (midY - startY);
        startX = midX;
        startY = midY;

        // Pinch zoom — scale from the distance ratio relative to pinch start
        if (pinchStartDist !== null) {
            const zoomRange = document.getElementById('zoomRange');
            const scale     = touchDistance(e.touches[0], e.touches[1]) / pinchStartDist;

            currentZoom = Math.min(
                parseFloat(zoomRange.max),
                Math.max(parseFloat(zoomRange.min), pinchStartZoom * scale)
            );

            zoomRange.value = currentZoom;
            document.getElementById('zoomVal').innerText = currentZoom.toFixed(2);
            drawFrame();
        }
        return;
    }

    const touch = e.touches[0];
    window.onmousemove({ clientX: touch.clientX, clientY: touch.clientY });

}, { passive: false });

/**
 * Touch equivalent of window.onmouseup.
 *
 * Resets pinch state. If a second finger is still down (i.e. the user lifted
 * one finger of a two-finger gesture), cancels draw state without committing.
 * Otherwise forwards to the existing onmouseup handler.
 */
window.addEventListener('touchend', (e) => {
    pinchStartDist = null;
    pinchStartZoom = null;

    if (e.touches.length > 0) {
        // At least one finger remains — abort any draw in progress cleanly
        isPanning = isDrawing = isMovingCrop = false;
        return;
    }

    // All fingers lifted — use changedTouches to get the final position
    const touch = e.changedTouches[0];
    window.onmouseup({ clientX: touch.clientX, clientY: touch.clientY });
});


/* -------------------------------------------------------------------------- */
/* FLOATING CONTROLS & MOBILE UI                                              */
/* -------------------------------------------------------------------------- */

/**
 * Pan mode toggle — switches single-finger touch between step action and pan.
 *
 * When active, one finger drags the viewport freely. When off, one finger
 * triggers the current step's interaction (draw box, pick colour, etc.).
 * Two-finger drag always pans regardless of this setting.
 */
document.getElementById('btnPanToggle').onclick = () => {
    panModeActive = !panModeActive;
    document.getElementById('btnPanToggle').classList.toggle('pan-active', panModeActive);
};

/**
 * Zoom in — increments zoom by 0.25 and syncs the range slider.
 */
document.getElementById('btnZoomIn').onclick = () => {
    const range = document.getElementById('zoomRange');
    currentZoom = Math.min(parseFloat(range.max), parseFloat((currentZoom + 0.25).toFixed(2)));
    range.value = currentZoom;
    document.getElementById('zoomVal').innerText = currentZoom.toFixed(2);
    drawFrame();
};

/**
 * Zoom out — decrements zoom by 0.25 and syncs the range slider.
 */
document.getElementById('btnZoomOut').onclick = () => {
    const range = document.getElementById('zoomRange');
    currentZoom = Math.max(parseFloat(range.min), parseFloat((currentZoom - 0.25).toFixed(2)));
    range.value = currentZoom;
    document.getElementById('zoomVal').innerText = currentZoom.toFixed(2);
    drawFrame();
};

/**
 * Instruction bar collapse toggle (mobile only).
 * Toggles .bar-open on the instruction bar, which CSS uses to show/hide
 * the .bar-collapsible zone containing instruction text and step swatches.
 */
document.getElementById('btnToggleBar').onclick = () => {
    document.getElementById('instructionBar').classList.toggle('bar-open');
};


/* -------------------------------------------------------------------------- */
/* INITIALISE                                                                  */
/* -------------------------------------------------------------------------- */

updateStepUI();
