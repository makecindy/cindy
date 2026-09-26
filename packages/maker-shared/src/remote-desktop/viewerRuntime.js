/** Shared browser viewer. Mobile bundles this exact source; Desktop imports it as a CSP-safe module. */
export function mountRemoteDesktopViewer(root, postMessage, config) {
  const cleanups = [];
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    cleanups.push(() => target.removeEventListener(type, fn, options));
  };
  const find = (id) =>
    root.getElementById
      ? root.getElementById(id)
      : root.querySelector("#" + id);
  const { net, iceServers } = config;
  let nativeVideoActive = false;
  const validKeys = new Set(config.keyCodes);
  const transform =
    /* BEGIN TRANSFORM */
    function desktopTransform(
      vw,
      vh,
      dw,
      dh,
      zoom,
      fx,
      fy,
      fillHeight = false,
    ) {
      const scale =
        (fillHeight
          ? vh / Math.max(1, dh)
          : Math.min(vw / Math.max(1, dw), vh / Math.max(1, dh))) *
        Math.max(1, Math.min(5, zoom));
      const width = dw * scale;
      const height = dh * scale;
      const x =
        width <= vw
          ? (vw - width) / 2
          : Math.min(0, Math.max(vw - width, vw / 2 - fx * width));
      const y =
        height <= vh
          ? (vh - height) / 2
          : Math.min(0, Math.max(vh - height, vh / 2 - fy * height));
      return { x, y, width, height, scale };
    };
  /* END TRANSFORM */ const networkStats =
    /* BEGIN NETWORK_STATS */
    function networkStats(stats, previous) {
      const rows = [...stats.values()];
      const video = rows.find(
        (s) =>
          s.type === "inbound-rtp" &&
          (s.kind === "video" || s.mediaType === "video"),
      );
      const transport = rows.find(
        (s) => s.type === "transport" && s.selectedCandidatePairId,
      );
      const pair = transport
        ? stats.get(transport.selectedCandidatePairId)
        : rows.find(
            (s) =>
              s.type === "candidate-pair" &&
              s.state === "succeeded" &&
              s.nominated,
          );
      const local = pair && stats.get(pair.localCandidateId),
        remote = pair && stats.get(pair.remoteCandidateId);
      const direct = ["host", "srflx", "prflx"];
      const route =
        local?.candidateType === "relay" || remote?.candidateType === "relay"
          ? "relay"
          : direct.includes(local?.candidateType) &&
              direct.includes(remote?.candidateType)
            ? "direct"
            : "video";
      const sample =
        video &&
        Number.isFinite(video.bytesReceived) &&
        Number.isFinite(video.timestamp)
          ? {
              id: video.id,
              path: pair?.id,
              bytes: video.bytesReceived,
              time: video.timestamp,
            }
          : null;
      let bytesPerSecond = null;
      if (
        sample &&
        previous &&
        sample.id === previous.id &&
        sample.path === previous.path &&
        sample.time > previous.time &&
        sample.bytes >= previous.bytes
      )
        bytesPerSecond =
          ((sample.bytes - previous.bytes) * 1000) /
          (sample.time - previous.time);
      const latencyMs =
        Number.isFinite(pair?.currentRoundTripTime) &&
        pair.currentRoundTripTime >= 0
          ? pair.currentRoundTripTime * 1000
          : null;
      return { transport: route, bytesPerSecond, latencyMs, sample };
    };

  /* END NETWORK_STATS */ const stage = find("stage"),
    image = find("image"),
    video = find("video"),
    cursor = find("cursor");
  // Shared ambient backdrop. Minimal viewer embeds may omit its subtree.
  const bg = find("bg") || null,
    bgCanvas = find("bg-canvas") || null,
    bgContext = bgCanvas ? bgCanvas.getContext("2d") : null;
  let dw = 1920,
    dh = 1080,
    viewerSized = false,
    zoom = 1,
    desktopScale = null,
    reportedScaleMode = null,
    desktopPan = null,
    edgePointer = null,
    edgeFrame = null,
    edgeTime = 0,
    fx = 0.5,
    fy = 0.5,
    mode = "pointer",
    control = false,
    clipboardShortcuts = false,
    clipboardModifier = "control",
    deferredClipboardModifier = null,
    pc = null,
    dc = null,
    seq = 0,
    generation = 0,
    epoch = null,
    gestureFrame = null;
  let remoteCursor = null,
    lastLocalMove = 0,
    localCursorAwake = false;
  let touchCursor = null,
    touchCursorTimer = null,
    touchCursorVisible = false;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const cursorImage = find("cursor-image");
  let pending = [],
    sending = false,
    cx = 0.5,
    cy = 0.5,
    drag = false,
    start = null,
    last = null,
    multi = null,
    hold = null,
    moved = false;
  const pointers = new Map();
  const mouseButtons = find("mouse-buttons"),
    wheel = find("mouse-wheel"),
    wheelGrip = find("mouse-wheel-grip");
  let nativeMouseControls = false;
  const mouseControlHandlers = new Map();
  function listenMouse(el, type, handler) {
    listen(el, type, handler);
    mouseControlHandlers.set(el.id + ":" + type, handler);
  }
  const keyboardInput = find("keyboard-input");
  let keyboardEnabled = false,
    composing = false;
  const keyboardSentinel = "\u200b";
  function resetKeyboard() {
    keyboardInput.value = keyboardSentinel;
    keyboardInput.setSelectionRange(1, 1);
  }
  function showKeyboard(enabled) {
    keyboardEnabled = enabled && control;
    if (!keyboardEnabled) {
      composing = false;
      resetKeyboard();
      keyboardInput.blur();
      return;
    }
    if (composing) return;
    if (config.desktop && document.activeElement === keyboardInput) return;
    // Keep focus inside the native evaluateJavaScript call; WebKit can reject
    // keyboard presentation after requestAnimationFrame loses user activation.
    keyboardInput.blur();
    resetKeyboard();
    keyboardInput.focus({ preventScroll: true });
  }
  function keyboardKey(code) {
    if (!keyboardEnabled || !control) return;
    queue({ kind: "key", code, down: true });
    queue({ kind: "key", code, down: false });
    flush();
  }
  function commitKeyboard() {
    if (!keyboardEnabled || !control || composing) return;
    const text = keyboardInput.value.replace(keyboardSentinel, "");
    if (text) {
      for (let i = 0; i < text.length; i += 4096)
        queue({ kind: "text", text: text.slice(i, i + 4096) });
      flush();
    }
    resetKeyboard();
  }
  listen(keyboardInput, "compositionstart", () => {
    composing = true;
  });
  listen(keyboardInput, "compositionend", () => {
    composing = false;
    commitKeyboard();
  });
  listen(keyboardInput, "input", (e) => {
    if (!e.isComposing) commitKeyboard();
  });
  listen(keyboardInput, "beforeinput", (e) => {
    if (composing || e.isComposing) return;
    if (e.inputType === "deleteContentBackward") {
      e.preventDefault();
      keyboardKey("Backspace");
      resetKeyboard();
    } else if (
      e.inputType === "insertLineBreak" ||
      e.inputType === "insertParagraph"
    ) {
      e.preventDefault();
      keyboardKey("Enter");
      resetKeyboard();
    }
  });
  const heldMouse = new Map();
  let showMouseButtons = false,
    wheelY = null;
  function resetWheel() {
    wheelY = null;
    wheelGrip.style.transform = "translateY(0px)";
  }
  let statsTimer = null,
    statsSample = null;
  const post = (message) => postMessage({ ...message, epoch });
  const clamp = (v) => Math.max(0, Math.min(1, v));
  let fillHeight = false;
  let fitToInsets = false;
  const usesViewportInsets = () => viewerSized || fitToInsets;
  let panAnimation = null,
    viewportRightInset = 0,
    viewportLeftInset = 0,
    viewportBottomInset = 0,
    viewportTopInset = 0,
    keyboardViewportInset = 0,
    portraitKeyboardTopInset = 0;
  let keyboardViewportOpen = false;
  let keyboardFitWidth = null;
  let cursorNeedsEntry = true,
    manualViewMoved = false,
    followRest = null;
  // Insets guide centering and pan limits without clipping the full-screen
  // video surface or adding an opaque strip beside the Dynamic Island.
  const viewportLeft = () => (fillHeight ? viewportLeftInset : 0);
  const usableHeight = () =>
    Math.max(1, stage.clientHeight - viewportTopInset - viewportBottomInset);
  const viewportHeight = () =>
    usesViewportInsets() ? usableHeight() : Math.max(1, stage.clientHeight);
  const viewportWidth = () =>
    Math.max(
      1,
      stage.clientWidth -
        viewportLeft() -
        (fillHeight ? viewportRightInset : 0),
    );
  // Center between the measured top controls and the keyboard edge (stage bottom).
  // The usable center is (topInset + stageHeight) / 2, so shift by topInset / 2.
  // Keep the fitted size and cap the shift when the desktop is too tall to fit.
  const verticalOffset = (height) =>
    (usesViewportInsets() ? viewportTopInset : 0) +
    (fillHeight
      ? 0
      : Math.min(
          Math.max(
            0,
            portraitKeyboardTopInset - (usesViewportInsets() ? viewportTopInset : 0),
          ) / 2,
          Math.max(0, (viewportHeight() - height) / 2),
        ));
  const layout = () => {
    const r =
      config.desktop && desktopScale !== null
        ? {
            scale: desktopScale,
            width: dw * desktopScale,
            height: dh * desktopScale,
          }
        : transform(
            keyboardFitWidth?.stageWidth === stage.clientWidth
              ? keyboardFitWidth.width : viewportWidth(),
            viewportHeight(),
            dw,
            dh,
            zoom,
            fx,
            fy,
            // Mobile fits both axes; retain Desktop scale semantics.
            config.desktop ? fillHeight && !viewerSized : false,
          );
    return {
      ...r,
      x: viewportLeft() + viewportWidth() / 2 - fx * r.width,
      y: viewportHeight() / 2 + verticalOffset(r.height) - fy * r.height,
    };
  };
  // The backdrop uses 5% / 90% / 5% source segments. The middle 90%
  // keeps the fitted picture's scale; each outer 5% stretches uniformly
  // to fill the remaining space, horizontally or vertically as needed.
  // Zoom and pan never move the backdrop: where the picture covers it, the
  // opaque picture simply occludes it, so input mapping stays uniform. Returns
  // null when the fitted picture already covers the stage, unless a Desktop
  // viewer has shrunk its foreground below fit and still needs the backdrop.
  const bgEdgeFraction = 0.05;
  const bgCenterFraction = 1 - 2 * bgEdgeFraction;
  function backgroundSegments(vw, vh, dw, dh, fill, includeFitted = false) {
    if (!(vw > 0 && vh > 0 && dw > 0 && dh > 0)) return null;
    const s = fill
      ? vh / Math.max(1, dh)
      : Math.min(vw / dw, vh / Math.max(1, dh));
    const w = dw * s,
      h = dh * s;
    if (w < vw || (includeFitted && w === vw && h === vh)) {
      const centerW = w * bgCenterFraction,
        centerX = vw / 2 - centerW / 2,
        sideW = centerX,
        top = (vh - h) / 2;
      return { axis: "x", s, w, h, top, centerW, centerX, sideW };
    }
    if (h < vh) {
      const centerH = h * bgCenterFraction,
        centerY = vh / 2 - centerH / 2,
        sideH = centerY,
        left = (vw - w) / 2;
      return { axis: "y", s, w, h, left, centerH, centerY, sideH };
    }
    return null;
  }
  function paintBackground() {
    if (nativeVideoActive) {
      if (bg) bg.style.display = "none";
      return;
    }
    if (!bg || !bgCanvas || !bgContext) return;
    const vw = stage.clientWidth,
      vh = stage.clientHeight;
    const picture = config.desktop ? layout() : null;
    const coversStage =
      picture &&
      picture.x <= 0 &&
      picture.y <= 0 &&
      picture.x + picture.width >= vw &&
      picture.y + picture.height >= vh;
    const seg = coversStage
      ? null
      : backgroundSegments(vw, vh, dw, dh, config.desktop ? fillHeight : false, config.desktop);
    if (!seg) {
      bg.style.display = "none";
      bgRects = null;
      stopBackgroundLoop();
      return;
    }
    bg.style.display = "block";
    bgAxis = seg.axis;
    // The ambient layer also fills the notch and the area beneath native
    // controls. Only the interactive picture respects viewport insets.
    const originX = 0;
    // Source segments are resolved at draw time from the live source dimensions;
    // these dest rects only encode where each segment lands on the stage.
    bgRects =
      seg.axis === "x"
        ? [
            {
              x: originX,
              y: seg.top,
              w: seg.sideW,
              h: seg.h,
            },
            {
              x: originX + seg.centerX,
              y: seg.top,
              w: seg.centerW,
              h: seg.h,
            },
            {
              x: originX + seg.centerX + seg.centerW,
              y: seg.top,
              w: seg.sideW,
              h: seg.h,
            },
          ]
        : [
            {
              x: seg.left,
              y: 0,
              w: seg.w,
              h: seg.sideH,
            },
            {
              x: seg.left,
              y: seg.centerY,
              w: seg.w,
              h: seg.centerH,
            },
            {
              x: seg.left,
              y: seg.centerY + seg.centerH,
              w: seg.w,
              h: seg.sideH,
            },
          ];
    // Keep the backing store at stage resolution (capped) so the stretched
    // edges stay crisp without oversized allocations.
    bgDpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.round(stage.clientWidth * bgDpr),
      bh = Math.round(vh * bgDpr);
    if (bgCanvas.width !== bw || bgCanvas.height !== bh) {
      bgCanvas.width = bw;
      bgCanvas.height = bh;
    }
    scheduleBackgroundDraw();
    startBackgroundLoop();
  }
  // One canvas, three draws: each source segment stretches into whatever bar
  // the picture leaves open. The live video feeds it once presented; until
  // then the decoded JPEG frame does, so the backdrop always matches the
  // picture's own pixels and scale in the center segment.
  let bgRects = null,
    bgAxis = "x",
    bgDpr = 1,
    bgDrawFrame = null,
    bgLoopFrame = null;
  function drawBackground() {
    if (!bgContext || !bgRects) return;
    const useVideo =
      videoPresented && video.videoWidth > 0 && video.videoHeight > 0;
    const src = useVideo ? video : image;
    // drawImage source rects live in the source's own pixel space, which can
    // differ from dw/dh; fractions of the real bitmap keep every segment lined
    // up with what the picture element actually shows.
    const sw = useVideo ? video.videoWidth : image.naturalWidth;
    const sh = useVideo ? video.videoHeight : image.naturalHeight;
    // Cursor updates can schedule a repaint while the next JPEG is loading.
    // Keep the last backdrop until the replacement has drawable pixels.
    if ((!useVideo && !image.complete) || !(sw > 0 && sh > 0)) return;
    bgContext.setTransform(bgDpr, 0, 0, bgDpr, 0, 0);
    bgContext.clearRect(0, 0, stage.clientWidth, stage.clientHeight);
    const horizontal = bgAxis === "x";
    const sourceLength = horizontal ? sw : sh;
    const cuts = [0, bgEdgeFraction, 1 - bgEdgeFraction, 1];
    for (let i = 0; i < bgRects.length; i++) {
      const rect = bgRects[i];
      const origin = cuts[i] * sourceLength;
      const length = (cuts[i + 1] - cuts[i]) * sourceLength;
      bgContext.drawImage(
        src,
        horizontal ? origin : 0,
        horizontal ? 0 : origin,
        horizontal ? length : sw,
        horizontal ? sh : length,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
      );
    }
  }
  function scheduleBackgroundDraw() {
    if (bgDrawFrame !== null || !bgRects || !bgContext) return;
    bgDrawFrame = requestAnimationFrame(() => {
      bgDrawFrame = null;
      drawBackground();
    });
  }
  function startBackgroundLoop() {
    if (
      bgLoopFrame !== null ||
      !bgContext ||
      !bgRects ||
      !videoPresented ||
      typeof video.requestVideoFrameCallback !== "function"
    )
      return;
    const frame = video.requestVideoFrameCallback(() => {
      if (bgLoopFrame !== frame) return;
      bgLoopFrame = null;
      drawBackground();
      startBackgroundLoop();
    });
    bgLoopFrame = frame;
  }
  // Only the streaming loop stops here; a pending one-shot draw is harmless
  // (it re-paints the preserved frame) and must survive reconnects.
  function stopBackgroundLoop() {
    if (bgLoopFrame !== null) video.cancelVideoFrameCallback?.(bgLoopFrame);
    bgLoopFrame = null;
  }
  function clearBackground() {
    stopBackgroundLoop();
    bgRects = null;
    // Resizing a canvas resets its bitmap; same-value assignment still clears.
    if (bgCanvas) bgCanvas.width = bgCanvas.width;
  }
  listen(image, "load", () => scheduleBackgroundDraw());
  // Older WebViews update the ambient layer on media progress, never with an
  // idle display-refresh loop. Geometry changes still get a one-shot repaint.
  listen(video, "timeupdate", () => {
    if (videoPresented && typeof video.requestVideoFrameCallback !== "function")
      scheduleBackgroundDraw();
  });
  function panBounds(r) {
    const vw = viewportWidth(),
      vh = viewportHeight();
    // Grow extra resting travel continuously from zero at fit to 180 screen
    // points at maximum zoom. Never count the unused space of a fitting axis.
    const clearance = (180 * (Math.max(1, Math.min(5, zoom)) - 1)) / 4;
    const axis = (viewport, content) =>
      content <= viewport
        ? {
            min: (viewport - content) / 2 - clearance,
            max: (viewport - content) / 2 + clearance,
          }
        : { min: viewport - content - clearance, max: clearance };
    const x = axis(vw, r.width),
      y = axis(vh, r.height);
    const bounds = {
      minX: viewportLeft() + x.min,
      maxX: viewportLeft() + x.max,
      minY: y.min + verticalOffset(r.height),
      maxY: y.max + verticalOffset(r.height),
    };
    // A camera position required to expose the cursor is a valid resting point,
    // not elastic overshoot. Preserve it across the next pan/pinch handoff.
    if (followRest) {
      const restX = viewportLeft() + vw / 2 - followRest.fx * r.width,
        restY = vh / 2 + verticalOffset(r.height) - followRest.fy * r.height;
      const weight =
        followRest.zoom > 1 ? clamp((zoom - 1) / (followRest.zoom - 1)) : 1;
      bounds.minX += Math.min(0, restX - bounds.minX) * weight;
      bounds.maxX += Math.max(0, restX - bounds.maxX) * weight;
      bounds.minY += Math.min(0, restY - bounds.minY) * weight;
      bounds.maxY += Math.max(0, restY - bounds.maxY) * weight;
    }
    return bounds;
  }
  const bounded = (v, min, max) => Math.max(min, Math.min(max, v));
  // Convert displayed overshoot back to finger travel before the next delta,
  // so reversing direction unwinds smoothly without an edge jump.
  function rubber(v, min, max, inverse = false) {
    const edge = bounded(v, min, max),
      d = v - edge;
    const reach = 40 + 10 * (Math.max(1, Math.min(5, zoom)) - 1);
    return (
      edge +
      Math.sign(d) *
        (inverse
          ? (reach * Math.abs(d)) / Math.max(1, reach - Math.abs(d))
          : (reach * Math.abs(d)) / (reach + Math.abs(d)))
    );
  }
  function place(x, y, r) {
    fx = (viewportLeft() + viewportWidth() / 2 - x) / r.width;
    fy = (viewportHeight() / 2 + verticalOffset(r.height) - y) / r.height;
  }
  function cursorViewport() {
    const hotX = remoteCursor?.hotX ?? 9,
      hotY = remoteCursor?.hotY ?? 9;
    const w = remoteCursor?.width ?? 18,
      h = remoteCursor?.height ?? 18;
    const left = viewportLeft(),
      right = left + viewportWidth(),
      bottom = Math.max(1, stage.clientHeight - viewportBottomInset);
    // Keep the entire cursor, including its hotspot offset, clear of chrome.
    const minX = Math.min(right - 1, left + 8 + hotX),
      minY = Math.min(
        bottom - 1,
        (usesViewportInsets() ? viewportTopInset : 0) + 8 + hotY,
      );
    return {
      minX,
      maxX: Math.max(minX, right - 8 - (w - hotX)),
      minY,
      maxY: Math.max(minY, bottom - 8 - (h - hotY)),
    };
  }
  function moveTouchpad(dx, dy) {
    stopPanAnimation();
    const r = layout(),
      v = cursorViewport();
    if (cursorNeedsEntry) {
      // Re-enter at the nearest visible edge; do not pull a manually positioned
      // desktop back to the old off-screen cursor before applying this movement.
      cx = clamp((bounded(r.x + cx * r.width, v.minX, v.maxX) - r.x) / r.width);
      cy = clamp(
        (bounded(r.y + cy * r.height, v.minY, v.maxY) - r.y) / r.height,
      );
      cursorNeedsEntry = false;
    }
    cx = clamp(cx + dx / r.width);
    cy = clamp(cy + dy / r.height);
    const x = r.x + cx * r.width,
      y = r.y + cy * r.height;
    if (
      zoom > 1 ||
      r.width > viewportWidth() ||
      r.height > stage.clientHeight - viewportBottomInset
    ) {
      place(
        r.x + bounded(x, v.minX, v.maxX) - x,
        r.y + bounded(y, v.minY, v.maxY) - y,
        r,
      );
      followRest = { fx, fy, zoom };
    }
    manualViewMoved = false;
  }
  function stopPanAnimation() {
    if (panAnimation !== null) cancelAnimationFrame(panAnimation);
    panAnimation = null;
  }
  function settlePan() {
    stopPanAnimation();
    const r = layout(),
      b = panBounds(r),
      x = bounded(r.x, b.minX, b.maxX),
      y = bounded(r.y, b.minY, b.maxY);
    if (x === r.x && y === r.y) return;
    if (reducedMotion.matches) {
      place(x, y, r);
      render();
      return;
    }
    const started = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - started) / 280),
        ease = 1 - Math.pow(1 - t, 3);
      place(r.x + (x - r.x) * ease, r.y + (y - r.y) * ease, r);
      render();
      panAnimation = t < 1 ? requestAnimationFrame(tick) : null;
    };
    panAnimation = requestAnimationFrame(tick);
  }
  function render() {
    const r = layout();
    if (config.nativeMedia && epoch)
      post({
        type: "nativeViewport",
        fillHeight: false,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      });
    if (config.desktop && epoch) {
      const scaleMode =
        desktopScale === null
          ? "fit"
          : desktopScale === 1
            ? "actual"
            : "custom";
      if (reportedScaleMode !== scaleMode) {
        reportedScaleMode = scaleMode;
        post({ type: "scaleMode", mode: scaleMode });
      }
    }
    const touchFeedback = control && mode === "touch" && touchCursorVisible;
    const cursorX = mode === "touch" && touchCursor ? touchCursor.x : cx;
    const cursorY = mode === "touch" && touchCursor ? touchCursor.y : cy;
    cursor.style.transition =
      mode === "touch" && !touchFeedback && !reducedMotion.matches
        ? "opacity 120ms ease-out"
        : "none";
    for (const el of [image, video]) {
      el.style.width = r.width + "px";
      el.style.height = r.height + "px";
      el.style.left = r.x + "px";
      el.style.top = r.y + "px";
    }
    paintBackground();
    if (remoteCursor) {
      cursor.style.width = remoteCursor.width + "px";
      cursor.style.height = remoteCursor.height + "px";
      cursor.style.border = "0";
      cursor.style.borderRadius = "0";
      cursor.style.transform = "none";
      cursor.style.left = r.x + cursorX * r.width - remoteCursor.hotX + "px";
      cursor.style.top = r.y + cursorY * r.height - remoteCursor.hotY + "px";
      cursor.style.display = "block";
      cursor.style.opacity = (
        mode === "touch"
          ? touchFeedback
          : remoteCursor.visible ||
            (control && mode === "pointer" && localCursorAwake)
      )
        ? "1"
        : "0";
    } else {
      cursor.style.opacity = (mode === "touch" ? !touchFeedback : false)
        ? "0"
        : "1";
      cursor.style.width = "18px";
      cursor.style.height = "18px";
      cursor.style.border = "2px solid var(--foreground)";
      cursor.style.borderRadius = "50%";
      cursor.style.transform = "translate(-50%,-50%)";
      cursor.style.left = r.x + cursorX * r.width + "px";
      cursor.style.top = r.y + cursorY * r.height + "px";
      cursor.style.display =
        !config.desktop && control && (mode === "pointer" || mode === "touch")
          ? "block"
          : "none";
    }
    if (config.desktop) {
      // Let the local OS own pointer size, DPI and accessibility preferences.
      // Never use a remote URL or bitmap as the desktop's native cursor.
      cursor.style.display = "none";
      const shape = remoteCursor?.shape;
      stage.style.cursor =
        control &&
        [
          "default",
          "text",
          "vertical-text",
          "pointer",
          "crosshair",
          "grab",
          "grabbing",
          "ew-resize",
          "ns-resize",
          "nwse-resize",
          "nesw-resize",
          "move",
          "not-allowed",
          "copy",
          "alias",
          "wait",
          "progress",
          "help",
        ].includes(shape)
          ? shape
          : "default";
    }
  }
  // Literal source is required: Hermes function.toString() yields bytecode.
  function validCursor(v) {
    return (
      !!v &&
      typeof v === "object" &&
      typeof v.visible === "boolean" &&
      [v.x, v.y, v.width, v.height, v.hotX, v.hotY].every(Number.isFinite) &&
      v.x >= 0 &&
      v.x <= 1 &&
      v.y >= 0 &&
      v.y <= 1 &&
      v.width > 0 &&
      v.width <= 256 &&
      v.height > 0 &&
      v.height <= 256 &&
      v.hotX >= 0 &&
      v.hotX <= v.width &&
      v.hotY >= 0 &&
      v.hotY <= v.height &&
      typeof v.png === "string" &&
      v.png.length <= 65536 &&
      /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(v.png)
    );
  }
  function receiveCursor(value) {
    if (value === null) {
      if (remoteCursor) {
        remoteCursor = { ...remoteCursor, visible: false };
        render();
      }
      return;
    }
    if (!validCursor(value)) return;
    if (!remoteCursor || remoteCursor.png !== value.png)
      cursorImage.src = "data:image/png;base64," + value.png;
    // Keep delayed host coordinates from pulling the local touchpad backwards.
    if (
      !remoteCursor ||
      !control ||
      mode !== "pointer" ||
      (!pointers.size && performance.now() - lastLocalMove > 200)
    ) {
      cx = value.x;
      cy = value.y;
    }
    if (value.visible) localCursorAwake = false;
    remoteCursor = value;
    render();
  }
  function resetCursor() {
    clearTimeout(touchCursorTimer);
    touchCursorVisible = false;
    touchCursor = null;
    localCursorAwake = false;
    remoteCursor = null;
    cursorImage.removeAttribute("src");
    render();
  }
  function queue(event) {
    if (!control) return;
    if (config.desktop && (event.kind === "button" || event.kind === "scroll"))
      flushClipboardModifier();
    // Remote visibility can remain hidden after synthetic mouse movement. Wake
    // the local touchpad cursor until the host reports a visible cursor again.
    if (event.kind === "move" && mode === "pointer") localCursorAwake = true;
    if (event.kind === "key" || event.kind === "text") {
      localCursorAwake = false;
      render();
    }
    if (event.kind === "move" || event.kind === "button")
      lastLocalMove = performance.now();
    const tail = pending[pending.length - 1];
    if (event.kind === "move" && tail?.kind === "move")
      pending[pending.length - 1] = event;
    // Coalesce only adjacent scrolls, preserving button/key ordering. Bound the
    // accumulated distance so a delayed ACK cannot replay a large scroll backlog.
    else if (event.kind === "scroll" && tail?.kind === "scroll") {
      tail.dx = Math.max(-2000, Math.min(2000, tail.dx + event.dx));
      tail.dy = Math.max(-2000, Math.min(2000, tail.dy + event.dy));
    } else pending.push(event);
    if (pending.length > 64) {
      pending = [{ kind: "release" }];
      control = false;
      post({ type: "inputOverflow" });
    }
  }
  function flush() {
    if (!pending.length || sending) return;
    const events = pending.splice(0, 64),
      sequence = ++seq;
    if (
      pc?.connectionState === "connected" &&
      dc &&
      dc.readyState === "open" &&
      dc.bufferedAmount < 16384
    ) {
      dc.send(JSON.stringify({ sequence, events }));
    } else {
      sending = true;
      post({ type: "input", sequence, events });
    }
  }
  const inputTimer = setInterval(() => {
    // Hold displacement controls speed, even without further pointer moves.
    // Skip missed ticks while awaiting ACK instead of building a scroll backlog.
    if (wheelY?.moved && !sending) {
      const offset = Math.max(-24, Math.min(24, wheelY.y - wheelY.start));
      if (Math.abs(offset) > 4)
        scrollMouse(Math.sign(offset) * (Math.abs(offset) - 4) * 1.5);
    }
    flush();
  }, 33);
  cleanups.push(() => clearInterval(inputTimer));
  function release() {
    stopEdgePan();
    desktopPan = null;
    deferredClipboardModifier = null;
    clearTimeout(hold);
    if (gestureFrame !== null) cancelAnimationFrame(gestureFrame);
    gestureFrame = null;
    if (control) {
      queue({ kind: "release" });
      flush();
    }
    heldMouse.clear();
    resetWheel();
    updateMouseButtons();
    drag = false;
    pointers.clear();
    start = null;
    last = null;
    multi = null;
  }
  function updateMouseButtons() {
    mouseButtons.style.display =
      showMouseButtons && control && !nativeMouseControls ? "block" : "none";
    for (const [name, button] of [
      ["left", 0],
      ["right", 2],
    ])
      find("mouse-" + name).setAttribute(
        "aria-pressed",
        String(heldMouse.has(button)),
      );
  }
  for (const [name, button] of [
    ["left", 0],
    ["right", 2],
  ]) {
    const el = find("mouse-" + name);
    listenMouse(el, "pointerdown", (e) => {
      e.preventDefault();
      if (!control || !showMouseButtons || heldMouse.has(button)) return;
      clearTimeout(hold);
      if (!e.nativeInput) el.setPointerCapture(e.pointerId);
      heldMouse.set(button, e.pointerId);
      queue({ kind: "button", button, down: true, x: cx, y: cy });
      flush();
      updateMouseButtons();
    });
    const up = (e) => {
      e.preventDefault();
      if (heldMouse.get(button) !== e.pointerId) return;
      heldMouse.delete(button);
      queue({ kind: "button", button, down: false, x: cx, y: cy });
      flush();
      updateMouseButtons();
    };
    listenMouse(el, "pointerup", up);
    listenMouse(el, "pointercancel", up);
    listenMouse(el, "lostpointercapture", up);
    listenMouse(el, "click", (e) => {
      if (e.detail === 0 && control && showMouseButtons) {
        click(button);
        flush();
      }
    });
  }
  const scrollMouse = (dy) => {
    if (control && showMouseButtons && Number.isFinite(dy)) {
      queue({ kind: "scroll", dx: 0, dy: Math.max(-2000, Math.min(2000, dy)) });
    }
  };
  listenMouse(wheel, "pointerdown", (e) => {
    e.preventDefault();
    if (!control || !showMouseButtons || wheelY) return;
    if (!e.nativeInput) wheel.setPointerCapture(e.pointerId);
    wheelY = { id: e.pointerId, y: e.clientY, start: e.clientY, moved: false };
  });
  // A small dead zone preserves middle clicks; displacement drives the timer.
  listenMouse(wheel, "pointermove", (e) => {
    if (!wheelY || wheelY.id !== e.pointerId) return;
    e.preventDefault();
    wheelGrip.style.transform =
      "translateY(" +
      Math.max(-24, Math.min(24, e.clientY - wheelY.start)) +
      "px)";
    wheelY.y = e.clientY;
    if (Math.abs(e.clientY - wheelY.start) > 4) wheelY.moved = true;
  });
  listenMouse(wheel, "pointerup", (e) => {
    if (!wheelY || wheelY.id !== e.pointerId) return;
    e.preventDefault();
    if (!wheelY.moved && control && showMouseButtons) {
      click(1);
      flush();
    }
    resetWheel();
  });
  const cancelWheel = (e) => {
    if (wheelY?.id === e.pointerId) resetWheel();
  };
  listenMouse(wheel, "pointercancel", cancelWheel);
  listenMouse(wheel, "lostpointercapture", cancelWheel);
  listenMouse(wheel, "click", (e) => {
    if (e.detail === 0 && control && showMouseButtons) {
      click(1);
      flush();
    }
  });
  listenMouse(wheel, "keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      scrollMouse(e.key === "ArrowUp" ? -120 : 120);
    }
  });
  function insideDesktop(p) {
    const r = layout();
    return (
      p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
    );
  }
  function point(p) {
    const r = layout();
    return {
      x: clamp((p.x - r.x) / r.width),
      y: clamp((p.y - r.y) / r.height),
    };
  }
  const desktopPoint = (e) => {
    const bounds = stage.getBoundingClientRect();
    return { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
  };
  function stopEdgePan() {
    if (edgeFrame !== null) cancelAnimationFrame(edgeFrame);
    edgeFrame = null;
    edgePointer = null;
  }
  function edgePanTick(now) {
    edgeFrame = null;
    if (!edgePointer || desktopPan || !epoch) return;
    const r = layout(),
      vw = viewportWidth(),
      vh = viewportHeight();
    const p = edgePointer;
    const dt = Math.min(32, Math.max(0, now - edgeTime)) / 1000;
    edgeTime = now;
    // rAF timestamps describe the frame start and can precede the pointer
    // handler's performance.now(). A zero-time first frame is not a boundary.
    if (dt === 0) {
      edgeFrame = requestAnimationFrame(edgePanTick);
      return;
    }
    // A narrow edge band accelerates smoothly to 720 local pixels per second.
    const velocity = (position, extent) => {
      const band = Math.min(28, extent / 4);
      return position < band
        ? -(1 - position / band)
        : position > extent - band
          ? (position - extent + band) / band
          : 0;
    };
    const x =
      r.width > vw
        ? bounded(
            r.x - velocity(p.x - viewportLeft(), vw) * 720 * dt,
            viewportLeft() + vw - r.width,
            viewportLeft(),
          )
        : r.x;
    const y =
      r.height > vh
        ? bounded(r.y - velocity(p.y, vh) * 720 * dt, vh - r.height, 0)
        : r.y;
    if (Math.abs(x - r.x) < 0.001 && Math.abs(y - r.y) < 0.001) return;
    stopPanAnimation();
    manualViewMoved = true;
    place(x, y, r);
    // Keep remote hover/drag attached to the local pointer as the picture moves.
    if (control) {
      const next = point(p);
      cx = next.x;
      cy = next.y;
      queue({ kind: "move", x: cx, y: cy });
    }
    render();
    edgeFrame = requestAnimationFrame(edgePanTick);
  }
  function trackEdgePointer(e) {
    const p = desktopPoint(e);
    if (
      !epoch ||
      desktopPan ||
      p.x < viewportLeft() ||
      p.x > viewportLeft() + viewportWidth() ||
      p.y < 0 ||
      p.y > viewportHeight() ||
      !insideDesktop(p)
    ) {
      stopEdgePan();
      return;
    }
    edgePointer = p;
    if (edgeFrame === null) {
      edgeTime = performance.now();
      edgeFrame = requestAnimationFrame(edgePanTick);
    }
  }
  listen(stage, "pointerleave", stopEdgePan);
  function mouse(e, down) {
    if (!control || ![0, 1, 2].includes(e.button)) return;
    const local = desktopPoint(e);
    if (down && !insideDesktop(local)) return;
    const p = point(local);
    cx = p.x;
    cy = p.y;
    if (down) {
      showKeyboard(true);
      stage.setPointerCapture(e.pointerId);
      heldMouse.set(e.button, e.pointerId);
    } else if (!heldMouse.delete(e.button)) return;
    queue({ kind: "button", button: e.button, down, x: cx, y: cy });
    flush();
    render();
  }
  function click(button = 0) {
    if (control && mode === "touch") {
      clearTimeout(touchCursorTimer);
      touchCursor = { x: cx, y: cy };
      touchCursorVisible = true;
      render();
      touchCursorTimer = setTimeout(() => {
        touchCursorVisible = false;
        render();
      }, 450);
    }
    queue({ kind: "button", button, down: true, x: cx, y: cy });
    queue({ kind: "button", button, down: false, x: cx, y: cy });
  }
  function pan(dx, dy) {
    manualViewMoved = true;
    cursorNeedsEntry = true;
    stopPanAnimation();
    const r = layout(),
      b = panBounds(r);
    place(
      rubber(rubber(r.x, b.minX, b.maxX, true) + dx, b.minX, b.maxX),
      rubber(rubber(r.y, b.minY, b.maxY, true) + dy, b.minY, b.maxY),
      r,
    );
    render();
  }
  function pair() {
    const [a, b] = [...pointers.values()];
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      d: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }
  function movePair() {
    gestureFrame = null;
    if (pointers.size < 2 || !multi) return;
    const next = pair(),
      span = Math.abs(next.d - multi.d),
      travel = Math.hypot(next.x - multi.x, next.y - multi.y);
    if (multi.kind !== "pinch") {
      const pinchSlop = Math.max(6, Math.min(12, multi.d * 0.04));
      if (span >= pinchSlop && span > travel * 0.65) {
        // A parallel scroll may deliver its two pointer updates in different
        // frames. Confirm separation briefly before taking over as a pinch.
        if (!multi.candidate)
          multi.candidate = {
            at: Date.now(),
            d: next.d,
            zoom,
            anchor: point(next),
          };
        if (Date.now() - multi.candidate.at >= 40) {
          if (multi.kind === "scroll") {
            multi.d = multi.candidate.d;
            multi.zoom = multi.candidate.zoom;
            multi.anchor = multi.candidate.anchor;
          }
          multi.kind = "pinch";
          multi.candidate = null;
        } else {
          gestureFrame = requestAnimationFrame(movePair);
          return;
        }
      } else {
        multi.candidate = null;
        if (!multi.kind && travel > 8 && travel > span) multi.kind = "scroll";
      }
    }
    if (multi.kind === "pinch") {
      manualViewMoved = true;
      cursorNeedsEntry = true;
      zoom = Math.max(
        1,
        Math.min(5, (multi.zoom * next.d) / Math.max(1, multi.d)),
      );
      const r = layout();
      fx =
        multi.anchor.x +
        (viewportLeft() + viewportWidth() / 2 - next.x) / r.width;
      fy =
        multi.anchor.y +
        (viewportHeight() / 2 + verticalOffset(r.height) - next.y) / r.height;
      const moved = layout(),
        b = panBounds(moved);
      place(
        rubber(moved.x, b.minX, b.maxX),
        rubber(moved.y, b.minY, b.maxY),
        moved,
      );
    } else if (multi.kind === "scroll") {
      const dx = next.x - multi.lastX,
        dy = next.y - multi.lastY;
      if (control && mode !== "pan")
        queue({
          kind: "scroll",
          dx: Math.max(-2000, Math.min(2000, -dx)),
          dy: Math.max(-2000, Math.min(2000, -dy)),
        });
      else pan(dx, dy);
    }
    if (multi.kind) {
      multi.lastX = next.x;
      multi.lastY = next.y;
    }
    render();
  }
  listen(stage, "pointerdown", (e) => {
    if (config.desktop) {
      e.preventDefault();
      if (
        e.button === 1 &&
        (layout().width > viewportWidth() || layout().height > viewportHeight())
      ) {
        stopEdgePan();
        stopPanAnimation();
        desktopPan = {
          id: e.pointerId,
          x: e.clientX,
          y: e.clientY,
          start: e,
          moved: false,
        };
        stage.setPointerCapture(e.pointerId);
        return;
      }
      mouse(e, true);
      return;
    }
    e.preventDefault();
    stopPanAnimation();
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      cursorNeedsEntry = true;
      start = { x: e.clientX, y: e.clientY };
      last = start;
      moved = false;
      hold = setTimeout(() => {
        if (
          control &&
          mode !== "pan" &&
          !moved &&
          pointers.size === 1 &&
          !heldMouse.size &&
          (mode !== "touch" || insideDesktop(start))
        ) {
          if (mode === "touch") {
            const p = point(start);
            cx = p.x;
            cy = p.y;
          }
          queue({ kind: "button", button: 0, down: true, x: cx, y: cy });
          drag = true;
        }
      }, 400);
    } else {
      clearTimeout(hold);
      if (drag) queue({ kind: "release" });
      drag = false;
      start = null;
      const p = pair();
      multi = {
        ...p,
        lastX: p.x,
        lastY: p.y,
        zoom,
        anchor: point(p),
        kind: null,
      };
    }
  });
  listen(stage, "pointermove", (e) => {
    if (config.desktop) {
      if (desktopPan?.id === e.pointerId) {
        const dx = e.clientX - desktopPan.x,
          dy = e.clientY - desktopPan.y;
        if (!desktopPan.moved && Math.hypot(dx, dy) < 3) return;
        desktopPan.moved = true;
        desktopPan.x = e.clientX;
        desktopPan.y = e.clientY;
        pan(dx, dy);
        return;
      }
      trackEdgePointer(e);
      if (!control) return;
      const local = desktopPoint(e);
      if (!heldMouse.size && !insideDesktop(local)) return;
      const p = point(local);
      cx = p.x;
      cy = p.y;
      queue({ kind: "move", x: cx, y: cy });
      render();
      return;
    }
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) {
      if (gestureFrame === null) gestureFrame = requestAnimationFrame(movePair);
      return;
    }
    if (!start || !last) return;
    const now = { x: e.clientX, y: e.clientY },
      dx = now.x - last.x,
      dy = now.y - last.y;
    last = now;
    if (Math.hypot(now.x - start.x, now.y - start.y) > 6) {
      moved = true;
      clearTimeout(hold);
    }
    if (
      !control ||
      mode === "pan" ||
      (mode === "touch" && !drag && !heldMouse.size)
    ) {
      pan(dx, dy);
      return;
    }
    if (mode === "pointer") {
      moveTouchpad(dx, dy);
    } else {
      const p = point(now);
      cx = p.x;
      cy = p.y;
    }
    queue({ kind: "move", x: cx, y: cy });
    render();
  });
  function up(e) {
    if (config.desktop) {
      if (desktopPan?.id === e.pointerId) {
        const gesture = desktopPan;
        desktopPan = null;
        if (gesture.moved) settlePan();
        else {
          mouse(gesture.start, true);
          mouse(e, false);
        }
        return;
      }
      mouse(e, false);
      return;
    }
    if (!pointers.has(e.pointerId)) return;
    clearTimeout(hold);
    if (pointers.size >= 2 && multi) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gestureFrame !== null) cancelAnimationFrame(gestureFrame);
      movePair();
      if (gestureFrame !== null) cancelAnimationFrame(gestureFrame);
      gestureFrame = null;
    }
    pointers.delete(e.pointerId);
    if (drag) {
      queue({ kind: "button", button: 0, down: false, x: cx, y: cy });
      drag = false;
    } else if (
      start &&
      !moved &&
      control &&
      mode !== "pan" &&
      !heldMouse.size &&
      e.type === "pointerup" &&
      (mode !== "touch" || insideDesktop({ x: e.clientX, y: e.clientY }))
    ) {
      if (mode === "touch") {
        const p = point({ x: e.clientX, y: e.clientY });
        cx = p.x;
        cy = p.y;
      }
      click();
    }
    start = null;
    last = null;
    multi = null;
    render();
    if (!pointers.size && manualViewMoved) settlePan();
  }
  listen(stage, "pointerup", up);
  listen(stage, "pointercancel", () => {
    release();
    settlePan();
  });
  listen(stage, "lostpointercapture", () => {
    desktopPan = null;
    if (config.desktop && heldMouse.size) release();
  });
  if (config.desktop)
    listen(
      stage,
      "wheel",
      (e) => {
        e.preventDefault();
        if (!control) return;
        const factor =
          e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
        queue({
          kind: "scroll",
          dx: Math.max(-2000, Math.min(2000, e.deltaX * factor)),
          dy: Math.max(-2000, Math.min(2000, e.deltaY * factor)),
        });
        flush();
      },
      { passive: false },
    );
  listen(config.desktop ? stage : document, "contextmenu", (e) =>
    e.preventDefault(),
  );
  // Scope selection suppression to the desktop surface, preserving the hidden
  // textarea's native keyboard/IME editing and programmatic selection.
  listen(stage, "selectstart", (e) => e.preventDefault());
  listen(stage, "dragstart", (e) => e.preventDefault());
  const normalizedKey = (code) =>
    /^(Shift|Control|Alt|Meta)Right$/.test(code)
      ? code.replace(/Right$/, "Left")
      : code;
  const hardwareKeys = new Set();
  function flushClipboardModifier() {
    if (!deferredClipboardModifier) return;
    const code = deferredClipboardModifier;
    deferredClipboardModifier = null;
    hardwareKeys.add(code);
    queue({ kind: "key", code, down: true });
  }
  listen(document, "keydown", (e) => {
    if (config.desktop) {
      if (e.ctrlKey && e.altKey && e.code === "Escape") {
        e.preventDefault();
        release();
        showKeyboard(false);
        post({ type: "releaseFocus" });
        return;
      }
      if (
        document.activeElement !== keyboardInput ||
        e.isComposing ||
        composing
      )
        return;
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyW") return; // always retain a local close shortcut
      if (
        control &&
        clipboardShortcuts &&
        normalizedKey(e.code) ===
          (clipboardModifier === "meta" ? "MetaLeft" : "ControlLeft")
      ) {
        e.preventDefault();
        if (!hardwareKeys.has(normalizedKey(e.code)))
          deferredClipboardModifier = normalizedKey(e.code);
        return;
      }
      if (
        control &&
        clipboardShortcuts &&
        (clipboardModifier === "meta"
          ? e.metaKey && !e.ctrlKey
          : e.ctrlKey && !e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.code === "KeyC" || e.code === "KeyV")
      ) {
        e.preventDefault();
        if (!e.repeat) {
          release();
          hardwareKeys.clear();
          post({
            type: "clipboard",
            action: e.code === "KeyC" ? "copy" : "paste",
          });
        }
        return;
      }
    }
    // The focused textarea delivers characters through input (and editing
    // keys through beforeinput). Forwarding their keydown too types twice on
    // iOS, where the software keyboard reports both events.
    if (
      (config.desktop || keyboardEnabled) &&
      document.activeElement === keyboardInput &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      (e.key?.length === 1 ||
        e.key === "Process" ||
        e.key === "Dead" ||
        (keyboardEnabled && ["Backspace", "Enter"].includes(e.code)))
    )
      return;
    if (control && validKeys.has(normalizedKey(e.code))) {
      e.preventDefault();
      flushClipboardModifier();
      hardwareKeys.add(normalizedKey(e.code));
      queue({ kind: "key", code: normalizedKey(e.code), down: true });
    }
  });
  listen(document, "keyup", (e) => {
    const code = normalizedKey(e.code);
    if (config.desktop && control && deferredClipboardModifier === code) {
      flushClipboardModifier();
    }
    if (!hardwareKeys.delete(code)) return;
    if (control && validKeys.has(code)) {
      e.preventDefault();
      queue({ kind: "key", code, down: false });
    }
  });
  if (config.desktop)
    listen(keyboardInput, "blur", () => {
      hardwareKeys.clear();
      release();
    });
  listen(window, "blur", () => {
    release();
    settlePan();
  });
  function reportViewport() {
    post({
      type: "viewportChanged",
      width: viewportWidth(),
      height: usableHeight(),
    });
  }
  const observer = new ResizeObserver(() => {
    reportViewport();
    release();
    settlePan();
    render();
  });
  observer.observe(stage);
  cleanups.push(
    () => observer.disconnect(),
    () => stopPanAnimation(),
    () => stopBackgroundLoop(),
    () => clearTimeout(touchCursorTimer),
  );
  // Keep one bounded frame in this document only; never persist desktop pixels.
  // Snapshot before detaching the track. A JPEG fallback already lives in image.
  function retainFrame() {
    if (
      !videoPresented ||
      video.style.display !== "block" ||
      video.readyState < 2 ||
      !video.videoWidth ||
      !video.videoHeight
    )
      return;
    const canvas = document.createElement("canvas");
    try {
      const scale = Math.min(
        1,
        1280 / Math.max(video.videoWidth, video.videoHeight),
      );
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (context) {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        image.src = canvas.toDataURL("image/jpeg", 0.7);
      }
    } catch {
      /* Keep the previous compatibility frame if WebKit cannot read video. */
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  /* BEGIN RTC */

  let trickleIce = false,
    attemptId = null,
    retries = 0,
    exchangeId = 0;
  let configPending = false;
  let videoPresented = false,
    videoFrameCallback = null,
    videoPaintCallback = null;
  function cancelVideoHandoff() {
    if (videoFrameCallback !== null)
      video.cancelVideoFrameCallback?.(videoFrameCallback);
    if (videoPaintCallback !== null) cancelAnimationFrame(videoPaintCallback);
    videoFrameCallback = videoPaintCallback = null;
  }
  function revealVideo(g) {
    post({ type: "videoFrameReady", attemptId });
    // Keep the JPEG decoded and painted as a backing layer. Promote the video
    // only after its first frame; removing the image exposes WebKit repaint gaps.
    videoPaintCallback = requestAnimationFrame(() => {
      if (g !== generation) return;
      videoPaintCallback = requestAnimationFrame(() => {
        if (g !== generation) return;
        videoPaintCallback = null;
        videoPresented = true;
        video.style.zIndex = "2";
        if (typeof startBackgroundLoop === "function") startBackgroundLoop();
        post({ type: "streaming", attemptId });
        post({
          type: "pipCapability",
          supported: !!(
            video.webkitSupportsPresentationMode?.("picture-in-picture") ||
            document.pictureInPictureEnabled
          ),
        });
      });
    });
  }
  function waitForVideoFrame(g) {
    if (g !== generation) return;
    if (
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0
    ) {
      revealVideo(g);
      return;
    }
    videoPaintCallback = requestAnimationFrame(() => waitForVideoFrame(g));
  }
  let retryTimer = null,
    deadlineTimer = null,
    disconnectTimer = null,
    stableTimer = null,
    iceTimer = null,
    gatherTimer = null,
    gatherDone = null;
  let localCandidates = [],
    localAck = 0,
    remoteAfter = 0,
    icePending = null,
    remoteSeen = new Set(),
    exchangeUntil = 0,
    remoteComplete = false;
  function clearRtcTimers() {
    for (const timer of [
      retryTimer,
      deadlineTimer,
      disconnectTimer,
      stableTimer,
      iceTimer,
      gatherTimer,
    ])
      clearTimeout(timer);
    retryTimer =
      deadlineTimer =
      disconnectTimer =
      stableTimer =
      iceTimer =
      gatherTimer =
        null;
    if (gatherDone) {
      gatherDone();
      gatherDone = null;
    }
  }
  function closeRtc(preserveFrame = true) {
    configPending = false;
    if (preserveFrame) retainFrame();
    generation++;
    clearRtcTimers();
    cancelVideoHandoff();
    videoPresented = false;
    localCandidates = [];
    localAck = remoteAfter = 0;
    icePending = null;
    remoteSeen = new Set();
    attemptId = null;
    clearInterval(statsTimer);
    statsTimer = null;
    statsSample = null;
    if (dc) dc.close();
    if (pc) pc.close();
    pc = null;
    dc = null;
    video.onplaying = null;
    video.srcObject = null;
    video.style.display = "none";
    video.style.zIndex = "0";
    image.style.display = "block";
    if (typeof stopBackgroundLoop === "function") stopBackgroundLoop();
    if (!preserveFrame) {
      image.removeAttribute("src");
      if (typeof clearBackground === "function") clearBackground();
    }
  }
  function failRtc(reason, canRetry = true) {
    const failedAttempt = attemptId;
    release();
    closeRtc();
    post({ type: "fallback", attemptId: failedAttempt, reason });
    // Local consent is bounded by the host's picker lifetime. Reuse this retry
    // timer without consuming the finite network-recovery attempts.
    const capturePending = reason === "capture-pending";
    if (canRetry && epoch && (capturePending || retries < net.retryMs.length)) {
      const delay = capturePending
        ? net.retryMs[net.retryMs.length - 1]
        : net.retryMs[retries++];
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (epoch) connect();
      }, delay);
    }
  }
  function pollIce() {
    if (
      !pc ||
      !trickleIce ||
      !pc.remoteDescription ||
      icePending ||
      Date.now() >= exchangeUntil
    )
      return;
    const candidates = localCandidates.slice(
      localAck,
      localAck + net.batchSize,
    );
    icePending = {
      after: remoteAfter,
      sent: candidates.length,
      exchangeId: ++exchangeId,
    };
    post({
      type: "ice",
      attemptId,
      candidates,
      after: remoteAfter,
      exchangeId,
    });
    iceTimer = setTimeout(() => {
      icePending = null;
      pollIce();
    }, 4500);
  }
  async function receiveIce(message) {
    if (
      !pc ||
      !icePending ||
      message.attemptId !== attemptId ||
      message.exchangeId !== icePending.exchangeId
    )
      return;
    const rtc = pc,
      g = generation,
      batch = icePending;
    clearTimeout(iceTimer);
    try {
      if (message.error) {
        icePending = null;
        iceTimer = setTimeout(pollIce, 1000);
        return;
      }
      if (
        !Array.isArray(message.candidates) ||
        message.candidates.length > net.batchSize ||
        message.next !== batch.after + message.candidates.length ||
        message.next > net.maxCandidates
      )
        throw new Error();
      for (const candidate of message.candidates) {
        if (g !== generation) return;
        const key = JSON.stringify(candidate);
        if (remoteSeen.has(key)) continue;
        if (remoteSeen.size >= net.maxCandidates) throw new Error();
        await rtc.addIceCandidate(candidate);
        if (g !== generation) return;
        remoteSeen.add(key);
      }
      if (g !== generation) return;
      localAck += batch.sent;
      remoteAfter = message.next;
      remoteComplete = message.complete === true;
      icePending = null;
      if (!(
        remoteComplete &&
        rtc.iceGatheringState === "complete" &&
        localAck === localCandidates.length
      ))
        iceTimer = setTimeout(pollIce, net.pollMs);
    } catch {
      if (g === generation) failRtc("candidates");
    }
  }
  async function receiveAnswer(message) {
    if (!pc || message.attemptId !== attemptId) return;
    const rtc = pc,
      g = generation;
    try {
      await rtc.setRemoteDescription({ type: "answer", sdp: message.sdp });
      if (g !== generation) return;
      clearTimeout(deadlineTimer);
      deadlineTimer = setTimeout(() => {
        if (g === generation && rtc.connectionState !== "connected")
          failRtc("connect-timeout");
      }, net.connectMs);
      exchangeUntil = Date.now() + net.exchangeMs;
      pollIce();
    } catch {
      if (g === generation) failRtc("answer");
    }
  }
  async function connect() {
    closeRtc();
    const g = generation;
    attemptId = String(g);
    if (!window.RTCPeerConnection) {
      failRtc("unsupported", false);
      return;
    }
    configPending = true;
    deadlineTimer = setTimeout(
      () => {
        if (g === generation && configPending) {
          configPending = false;
          void startRtc(g, iceServers);
        }
      },
      (net.iceConfigMs ?? 8000) + (net.iceConfigBridgeMs ?? 500),
    );
    return post({ type: "iceConfig", attemptId });
  }
  async function receiveIceConfig(message) {
    if (!epoch || !configPending || message.attemptId !== attemptId) return;
    configPending = false;
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
    await startRtc(generation, message.iceServers);
  }
  async function startRtc(g, servers) {
    try {
      const rtc = new RTCPeerConnection({ iceServers: servers });
      pc = rtc;
      dc = rtc.createDataChannel("input-v1");
      rtc.addTransceiver("video", { direction: "recvonly" });
      rtc.addTransceiver("audio", { direction: "recvonly" });
      rtc.onicecandidate = ({ candidate }) => {
        if (g !== generation || !candidate?.candidate || !trickleIce) return;
        if (localCandidates.length >= net.maxCandidates) {
          failRtc("candidate-limit", false);
          return;
        }
        localCandidates.push({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          ...(candidate.usernameFragment
            ? { usernameFragment: candidate.usernameFragment }
            : {}),
        });
        // Gathering continues after the offer; the serial exchange flushes late addresses.
      };
      dc.onmessage = (e) => {
        try {
          if (g !== generation || pc !== rtc) return;
          if (typeof e.data !== "string" || e.data.length > 80000) return;
          const message = JSON.parse(e.data);
          if (message.type === "cursor") receiveCursor(message.cursor);
          if (
            (video.webkitPresentationMode === "picture-in-picture" ||
              document.pictureInPictureElement === video) &&
            message.type === "viewPing" &&
            typeof message.challenge === "string" &&
            message.challenge.length <= 64 &&
            dc?.readyState === "open"
          )
            dc.send(message.challenge);
        } catch {}
      };
      let readingStats = false;
      statsTimer = setInterval(async () => {
        if (readingStats || g !== generation) return;
        readingStats = true;
        try {
          const stats = await rtc.getStats();
          if (g !== generation || pc !== rtc) return;
          const result = networkStats(stats, statsSample);
          statsSample = result.sample;
          post({
            type: "network",
            transport: result.transport,
            bytesPerSecond: result.bytesPerSecond,
            latencyMs: result.latencyMs,
          });
        } catch {
        } finally {
          readingStats = false;
        }
      }, 1000);
      rtc.ontrack = (e) => {
        if (g !== generation) return;
        video.srcObject = e.streams[0] || new MediaStream([e.track]);
        video.play().catch(() => {});
      };
      video.onplaying = () => {
        if (
          g !== generation ||
          videoPresented ||
          videoFrameCallback !== null ||
          videoPaintCallback !== null
        )
          return;
        video.style.display = "block";
        render();
        if (typeof scheduleBackgroundDraw === "function")
          scheduleBackgroundDraw();
        if (typeof video.requestVideoFrameCallback === "function") {
          videoFrameCallback = video.requestVideoFrameCallback(() => {
            if (g !== generation) return;
            videoFrameCallback = null;
            revealVideo(g);
          });
        } else waitForVideoFrame(g);
      };
      rtc.onconnectionstatechange = () => {
        if (g !== generation) return;
        if (["failed", "closed"].includes(rtc.connectionState)) {
          failRtc("transport");
          return;
        }
        if (rtc.connectionState === "disconnected") {
          clearTimeout(stableTimer);
          stableTimer = null;
          if (!disconnectTimer) {
            release();
            post({ type: "reconnecting", attemptId });
            disconnectTimer = setTimeout(() => {
              if (g === generation) failRtc("disconnected");
            }, net.disconnectedMs);
          }
        } else if (rtc.connectionState === "connected") {
          clearTimeout(disconnectTimer);
          disconnectTimer = null;
          clearTimeout(deadlineTimer);
          if (!stableTimer)
            stableTimer = setTimeout(() => {
              if (g === generation) retries = 0;
            }, net.stableMs);
          if (videoPresented) post({ type: "streaming", attemptId });
        }
      };
      await rtc.setLocalDescription(await rtc.createOffer());
      if (!trickleIce)
        await new Promise((resolve) => {
          if (rtc.iceGatheringState === "complete") return resolve();
          gatherDone = resolve;
          gatherTimer = setTimeout(resolve, net.legacyGatherMs);
          rtc.onicegatheringstatechange = () => {
            if (rtc.iceGatheringState === "complete") {
              clearTimeout(gatherTimer);
              resolve();
            }
          };
        });
      if (g !== generation) return;
      post({ type: "offer", attemptId, sdp: rtc.localDescription.sdp });
      deadlineTimer = setTimeout(() => {
        if (g === generation) failRtc("answer-timeout");
      }, net.answerMs);
    } catch {
      if (g === generation) failRtc("setup");
    }
  }

  /* END RTC */
  function reportPresentation() {
    post({
      type: "presentation",
      active:
        video.webkitPresentationMode === "picture-in-picture" ||
        document.pictureInPictureElement === video,
    });
  }
  listen(video, "webkitpresentationmodechanged", reportPresentation);
  listen(video, "enterpictureinpicture", reportPresentation);
  listen(video, "leavepictureinpicture", reportPresentation);
  function receive(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (message.type) {
      case "measureViewport":
        post({
          type: "viewportSize",
          width: viewportWidth(),
          height: usableHeight(),
        });
        break;
      case "presentation":
        if (config.nativeMedia) {
          release();
          showKeyboard(false);
          break;
        }
        try {
          if (message.enabled) {
            release();
            showKeyboard(false);
            if (video.webkitSupportsPresentationMode?.("picture-in-picture"))
              video.webkitSetPresentationMode("picture-in-picture");
            else if (video.requestPictureInPicture)
              video
                .requestPictureInPicture()
                .catch(() => post({ type: "presentationFailed" }));
            else post({ type: "presentationFailed" });
          } else if (video.webkitSetPresentationMode)
            video.webkitSetPresentationMode("inline");
          else if (document.pictureInPictureElement)
            document.exitPictureInPicture().catch(() => {});
        } catch {
          post({ type: "presentationFailed" });
        }
        break;
      case "videoSettings":
        if (
          Number.isInteger(message.width) &&
          Number.isInteger(message.height) &&
          message.width >= 320 &&
          message.height >= 320 &&
          (message.restore === true ||
            (message.width <= 2560 && message.height <= 2560))
        ) {
          release();
          stopPanAnimation();
          viewerSized = message.restore !== true;
          zoom = 1;
          desktopScale = null;
          fx = fy = 0.5;
          followRest = null;
          dw = message.width;
          dh = message.height;
          render();
        }
        video.muted = !message.audio;
        retries = 0;
        if (!config.nativeMedia) connect();
        break;
      case "keyboard":
        showKeyboard(message.enabled === true);
        break;
      case "resume":
        if (video.srcObject) video.play().catch(() => {});
        break;
      case "releaseInput":
        release();
        break;
      case "theme":
        if (/^#[0-9a-f]{3,8}$/i.test(message.surface)) {
          document.body.style.background = config.nativeMedia
            ? "transparent"
            : message.surface;
          document.documentElement.style.background = config.nativeMedia
            ? "transparent"
            : message.surface;
          document.documentElement.style.setProperty(
            "--surface",
            message.surface,
          );
        }
        if (/^#[0-9a-f]{3,8}$/i.test(message.foreground)) {
          cursor.style.borderColor = message.foreground;
          document.documentElement.style.setProperty(
            "--foreground",
            message.foreground,
          );
        }
        break;
      case "networkStatus": {
        const status = document.getElementById("network-status");
        if (!status) break;
        status.textContent =
          typeof message.text === "string" ? message.text : "";
        status.style.display = status.textContent ? "block" : "none";
        for (const key of ["top", "right", "fontSize"]) {
          if (Number.isFinite(message[key]) && message[key] >= 0)
            status.style[key] = message[key] + "px";
        }
        if (/^#[0-9a-f]{3,8}$/i.test(message.color))
          status.style.color = message.color;
        break;
      }
      case "nativeTouchpad": {
        if (!nativeMouseControls || !control) break;
        if (message.tap === true) {
          if (!heldMouse.size) { click(); flush(); }
          break;
        }
        if (!Number.isFinite(message.dx) || !Number.isFinite(message.dy)) break;
        moveTouchpad(message.dx, message.dy);
        queue({ kind: "move", x: cx, y: cy });
        touchCursor = { x: cx, y: cy };
        touchCursorVisible = true;
        render();
        break;
      }
      case "nativeMouse": {
        if (
          !nativeMouseControls ||
          !["left", "right", "wheel"].includes(message.control)
        )
          break;
        if (
          ![
            "pointerdown",
            "pointermove",
            "pointerup",
            "pointercancel",
            "click",
          ].includes(message.event)
        )
          break;
        if (!Number.isFinite(message.id) || !Number.isFinite(message.y)) break;
        mouseControlHandlers.get(
          "mouse-" + message.control + ":" + message.event,
        )?.({
          pointerId: message.id,
          clientY: message.y,
          detail: 0,
          nativeInput: true,
          preventDefault() {},
        });
        break;
      }
      case "mouseButtons": {
        nativeMouseControls = message.native === true;
        const before = layout(),
          previousTopInset = viewportTopInset,
          previousBottomInset = viewportBottomInset,
          keyboardOpen = fillHeight && message.keyboardOpen === true;
        const keepHorizontal =
          fillHeight && (keyboardOpen || keyboardViewportOpen);
        // Hiding the rail for the keyboard must not enlarge a width-fitted desktop.
        if (keyboardOpen && (!keyboardViewportOpen || !keyboardFitWidth)) {
          keyboardFitWidth = { stageWidth: stage.clientWidth, width: viewportWidth() };
        }
        if (!keyboardOpen) keyboardFitWidth = null;
        // Opening is observable before the native keyboard has a measured height.
        keyboardViewportOpen = keyboardOpen;
        const fitChanged = fitToInsets !== (message.fitToInsets === true);
        fitToInsets = message.fitToInsets === true;
        const previousOffset = portraitKeyboardTopInset;
        if (Number.isFinite(message.portraitKeyboardTopInset))
          portraitKeyboardTopInset = Math.max(
            0,
            message.portraitKeyboardTopInset,
          );
        const offsetChanged = previousOffset !== portraitKeyboardTopInset;
        let sideInsetsChanged = false;
        if (Number.isFinite(message.topInset))
          viewportTopInset = Math.max(
            0,
            Math.min(stage.clientHeight - 1, message.topInset),
          );
        if (Number.isFinite(message.bottomInset))
          viewportBottomInset = Math.max(
            0,
            Math.min(stage.clientHeight - 1, message.bottomInset),
          );
        if (Number.isFinite(message.leftInset)) {
          const inset = Math.max(
            0,
            Math.min(stage.clientWidth - 1, message.leftInset),
          );
          sideInsetsChanged = sideInsetsChanged || inset !== viewportLeftInset;
          viewportLeftInset = inset;
        }
        if (Number.isFinite(message.rightInset)) {
          const inset = Math.max(
            0,
            Math.min(stage.clientWidth - 1, message.rightInset),
          );
          sideInsetsChanged = sideInsetsChanged || inset !== viewportRightInset;
          viewportRightInset = inset;
        }
        // Hiding the side toolbar changes the viewport center. Keep the image's
        // actual horizontal position instead of following that center sideways.
        if (keepHorizontal) {
          stopPanAnimation();
          const r = layout();
          place(before.x, r.y, r);
        }
        const keyboardInset = keyboardOpen ? viewportBottomInset : 0;
        if (keyboardInset !== keyboardViewportInset) {
          const wasOpen = keyboardViewportInset > 0;
          keyboardViewportInset = keyboardInset;
          if (fillHeight && (keyboardInset > 0 || wasOpen)) {
            const r = layout(),
              v = cursorViewport();
            place(r.x, (v.minY + v.maxY) / 2 - cy * r.height, r);
            cursorNeedsEntry = false;
            manualViewMoved = false;
          }
        }
        if (keepHorizontal) {
          // Restoring the toolbar can cover the cursor even after a zero-height opening.
          if (!keyboardOpen || keyboardInset > 0) {
            const r = layout(),
              v = cursorViewport(),
              x = r.x + cx * r.width;
            place(r.x + bounded(x, v.minX, v.maxX) - x, r.y, r);
          }
          followRest = { fx, fy, zoom };
          render();
        } else if (
          fitChanged ||
          sideInsetsChanged ||
          offsetChanged ||
          (usesViewportInsets() && previousTopInset !== viewportTopInset) ||
          (usesViewportInsets() && previousBottomInset !== viewportBottomInset)
        ) {
          settlePan();
          render();
        }
        reportViewport();
        if (!message.enabled) {
          for (const button of heldMouse.keys())
            queue({ kind: "button", button, down: false, x: cx, y: cy });
          heldMouse.clear();
          resetWheel();
          flush();
        }
        for (const [edge, value] of [
          ["bottom", message.bottomInset],
          ["right", message.rightInset],
        ])
          if (Number.isFinite(value) && value >= 0 && value <= 4096)
            mouseButtons.style[edge] = value + "px";
        showMouseButtons = message.enabled === true;
        for (const name of ["left", "right", "wheel"])
          if (typeof message.labels?.[name] === "string")
            find("mouse-" + name).setAttribute(
              "aria-label",
              message.labels[name],
            );
        updateMouseButtons();
        break;
      }
      case "init":
        nativeVideoActive = false;
        image.style.visibility = "visible";
        desktopScale = null;
        reportedScaleMode = null;
        if (config.desktop) {
          zoom = 1;
          fx = 0.5;
          fy = 0.5;
        }
        viewerSized = false;
        followRest = null;
        cursorNeedsEntry = true;
        stopPanAnimation();
        resetCursor();
        control = false;
        release();
        pending = [];
        sending = false;
        seq = 0;
        epoch = message.epoch;
        clipboardShortcuts =
          config.desktop && message.clipboardShortcuts === true;
        clipboardModifier =
          message.clipboardModifier === "meta" ? "meta" : "control";
        dw = message.width;
        dh = message.height;
        fillHeight = message.fillHeight === true;
        video.muted = !message.audio;
        trickleIce = message.trickleIce === true;
        retries = 0;
        render();
        if (!config.nativeMedia) connect();
        break;
      case "nativeVideo":
        if (!config.nativeMedia || message.epoch !== epoch) break;
        nativeVideoActive = message.active === true;
        image.style.visibility = nativeVideoActive ? "hidden" : "visible";
        paintBackground();
        break;
      case "nativeCursor":
        if (config.nativeMedia && message.epoch === epoch)
          receiveCursor(message.cursor);
        break;
      case "viewport":
        if (fillHeight !== (message.fillHeight === true)) keyboardFitWidth = null;
        fillHeight = message.fillHeight === true;
        release();
        render();
        break;
      case "answer":
        if (message.epoch === epoch) void receiveAnswer(message);
        break;
      case "iceConfig":
        if (message.epoch === epoch) void receiveIceConfig(message);
        break;
      case "ice":
        if (message.epoch === epoch) void receiveIce(message);
        break;
      case "fallback":
        if (message.epoch === epoch && message.attemptId === attemptId)
          failRtc(
            message.capturePending === true ? "capture-pending" : "host",
            message.retry !== false,
          );
        break;
      case "frame": {
        if ("cursor" in message) receiveCursor(message.cursor);
        else resetCursor();
        const frameEpoch = epoch;
        image.onload = () => {
          if (epoch === frameEpoch) {
            scheduleBackgroundDraw();
            post({ type: "framePresented" });
          }
        };
        image.src = "data:image/jpeg;base64," + message.jpeg;
        break;
      }
      case "control":
        release();
        control = message.enabled;
        if (!control) showKeyboard(false);
        pending = [];
        updateMouseButtons();
        render();
        break;
      case "mode":
        release();
        if (message.mode !== "pointer") followRest = null;
        settlePan();
        clearTimeout(touchCursorTimer);
        touchCursorVisible = false;
        mode = message.mode;
        render();
        break;
      case "zoom":
        stopEdgePan();
        if (
          !config.desktop ||
          !Number.isFinite(message.factor) ||
          message.factor <= 0
        )
          break;
        followRest = null;
        cursorNeedsEntry = true;
        manualViewMoved = true;
        stopPanAnimation();
        const fitScale = Math.min(viewportWidth() / dw, viewportHeight() / dh);
        // Include actual size even when it lies outside the fit-relative range.
        desktopScale = Math.max(
          Math.min(fitScale, 1) * 0.1,
          Math.min(Math.max(5 * fitScale, 5), layout().scale * message.factor),
        );
        if (Math.abs(desktopScale - fitScale) < 1e-9) desktopScale = null;
        if (desktopScale === null) {
          fx = 0.5;
          fy = 0.5;
          manualViewMoved = false;
        }
        render();
        settlePan();
        break;
      case "actualSize":
        stopEdgePan();
        if (!config.desktop) break;
        followRest = null;
        cursorNeedsEntry = true;
        manualViewMoved = true;
        stopPanAnimation();
        desktopScale = 1;
        fx = 0.5;
        fy = 0.5;
        render();
        break;
      case "fit":
        stopEdgePan();
        desktopScale = null;
        followRest = null;
        cursorNeedsEntry = true;
        manualViewMoved = false;
        stopPanAnimation();
        zoom = 1;
        fx = 0.5;
        fy = 0.5;
        render();
        break;
      case "rightClick":
        click(2);
        break;
      case "events":
        for (const e of message.events) queue(e);
        flush();
        break;
      case "ack":
        if (message.epoch === epoch && message.sequence === seq)
          sending = false;
        break;
      case "stop":
        nativeVideoActive = false;
        image.style.visibility = "visible";
        showKeyboard(false);
        control = false;
        release();
        pending = [];
        sending = false;
        epoch = null;
        closeRtc(message.preserveFrame === true);
        updateMouseButtons();
        render();
        break;
    }
  }
  // iOS can report equal left/right safe areas in both landscape directions.
  // Its interface angle distinguishes the notch side even on a 180-degree turn.
  const reportOrientation = () => {
    const angle =
      typeof window.orientation === "number"
        ? window.orientation
        : window.screen?.orientation?.angle;
    if (Number.isFinite(angle)) post({ type: "orientation", angle });
  };
  listen(window, "orientationchange", reportOrientation);
  if (window.screen?.orientation?.addEventListener)
    listen(window.screen.orientation, "change", reportOrientation);
  render();
  reportOrientation();
  post({ type: "ready" });
  return {
    receive: (message) => receive({ data: JSON.stringify(message) }),
    dispose: () => {
      release();
      epoch = null;
      closeRtc(false);
      if (bgDrawFrame !== null) cancelAnimationFrame(bgDrawFrame);
      bgDrawFrame = null;
      for (const cleanup of cleanups) cleanup();
    },
  };
}
