// Copied verbatim from vocab.html. Keep this class unchanged.
class StrokeCanvas {
  constructor(canvasEl, opts = {}) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext("2d");
    this.strokes = [];
    this.currentStroke = null;
    this.tool = "pen";
    this.readOnly = !!opts.readOnly;
    this.penColor = opts.penColor || "#1F2421";
    // WebKit exposes Apple Pencil separately from direct finger touches. On
    // supported iPads, prefer that independent event stream over Pointer Events.
    this.useStylusTouchEvents = !!(window.Touch && "touchType" in window.Touch.prototype);
    // Finished strokes are cached to an offscreen bitmap so a redraw during an
    // active stroke only has to re-render that one stroke, not the card's
    // entire history. Redrawing everything on every pointermove gets slower as
    // a card fills up, and that lost headroom is what starts dropping fast,
    // short strokes first.
    this._base = document.createElement("canvas");
    this._baseCtx = this._base.getContext("2d");
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(this.canvas.parentElement);
    this._resize();
    if (!this.readOnly) this._bindEvents();
  }
  _resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, rect.width * dpr);
    this.canvas.height = Math.max(1, rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._base.width = this.canvas.width;
    this._base.height = this.canvas.height;
    this._baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width; this.h = rect.height;
    this._rebuildBase();
  }
  _rebuildBase() {
    this._drawStrokes(this._baseCtx, this.strokes, { clear: true });
    this.redraw();
  }
  _appendStrokeToBase(stroke) {
    this._drawStrokes(this._baseCtx, [stroke], { clear: false });
    this.redraw();
  }
  _drawStrokes(ctx, strokes, opts = {}) {
    if (opts.clear !== false) ctx.clearRect(0, 0, this.w, this.h);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = this.penColor;
    for (const s of strokes) {
      ctx.lineWidth = s.width || 2.4;
      if (s.points.length === 1) {
        const p = this._toPixel(s.points[0]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fillStyle = this.penColor;
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      const p0 = this._toPixel(s.points[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < s.points.length; i++) {
        const p = this._toPixel(s.points[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }
  _toNorm(x, y) { return { x: x / this.w, y: y / this.h }; }
  _toPixel(pt) { return { x: pt.x * this.w, y: pt.y * this.h }; }
  _bindEvents() {
    const el = this.canvas;
    el.addEventListener("pointerdown", (e) => this._down(e));
    el.addEventListener("pointermove", (e) => this._move(e));
    // Some stylus drivers deliver rapid samples here more reliably than through
    // pointermove. The pointer-ID guard keeps mouse/touch input unaffected.
    el.addEventListener("pointerrawupdate", (e) => this._move(e));
    el.addEventListener("pointerup", (e) => this._up(e));
    el.addEventListener("pointercancel", (e) => this._up(e));
    // Pen lifts can occasionally be delivered after capture has been released,
    // particularly during rapid handwriting. Listen outside the canvas as a
    // fallback; _up's pointer-ID check makes a duplicate event a no-op.
    el.addEventListener("lostpointercapture", (e) => this._up(e));
    window.addEventListener("pointerup", (e) => this._up(e));
    window.addEventListener("pointercancel", (e) => this._up(e));
    if (this.useStylusTouchEvents) {
      el.addEventListener("touchstart", (e) => this._touchStart(e), { passive: false });
      el.addEventListener("touchmove", (e) => this._touchMove(e), { passive: false });
      window.addEventListener("touchend", (e) => this._touchEnd(e), { passive: false });
      window.addEventListener("touchcancel", (e) => this._touchEnd(e), { passive: false });
    }
  }
  _stylusTouches(event) {
    return [...event.changedTouches].filter(touch => touch.touchType === "stylus");
  }
  _touchAsPointer(touch, event) {
    return {
      pointerId: `stylus-${touch.identifier}`,
      pointerType: "pen",
      clientX: touch.clientX,
      clientY: touch.clientY,
      pressure: touch.force || 0.5,
      buttons: 1,
      timeStamp: event.timeStamp,
      fromStylusTouch: true,
      preventDefault: () => event.preventDefault()
    };
  }
  _touchStart(event) {
    const touch = this._stylusTouches(event)[0];
    if (touch) this._down(this._touchAsPointer(touch, event));
  }
  _touchMove(event) {
    const touch = this._stylusTouches(event).find(item => `stylus-${item.identifier}` === this.activePointerId);
    if (touch) this._move(this._touchAsPointer(touch, event));
  }
  _touchEnd(event) {
    const touch = this._stylusTouches(event).find(item => `stylus-${item.identifier}` === this.activePointerId);
    if (touch) this._up(this._touchAsPointer(touch, event));
  }
  _localXY(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  _down(e) {
    // A resting palm is reported as a touch pointer while a stylus is a pen.
    // Ignore touch entirely so it cannot start or interfere with a pen stroke.
    if (e.pointerType === "touch" || (e.pointerType === "mouse" && e.button !== 0)) return;
    const inputSource = e.fromStylusTouch ? "stylus-touch" : "pointer";
    // Pointer and Touch Events may both describe the same Pencil contact. If
    // Touch Events arrive just after pointerdown, discard that provisional
    // pointer stroke and let the preferred stylus stream take over. Conversely,
    // a later pointerdown can recover automatically from a stalled touch stream.
    if (inputSource === "pointer" && this.activeInputSource === "stylus-touch"
        && e.timeStamp - this.activeInputStartedAt < 80) return;
    if (inputSource === "stylus-touch" && this.activeInputSource === "pointer") {
      this._discardActiveStroke();
    }
    e.preventDefault();
    // If the browser missed a previous pen-lift event, commit that stroke now
    // instead of overwriting it when the next quick stroke begins. A single
    // stylus commonly reuses the same pointerId across strokes in a session,
    // so this must fire even when the new pointerId matches the stale one —
    // checking for a *different* id let same-id reuse silently discard the
    // previous (often short, fast) stroke whenever its pointerup was missed.
    if (this.activePointerId != null) this._finishActiveStroke();
    if (!e.fromStylusTouch) {
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* capture is a best-effort safeguard */ }
    }
    this.activePointerId = e.pointerId;
    this.activeInputSource = inputSource;
    this.activeInputStartedAt = e.timeStamp;
    const { x, y } = this._localXY(e);
    if (this.tool === "pen") {
      this.currentStroke = { points: [{ ...this._toNorm(x, y), p: e.pressure || 0.5, t: e.timeStamp }], width: 2.4 };
      this.drawing = true;
    } else {
      this.erasing = true;
      this._eraseNear(x, y);
    }
  }
  _move(e) {
    // Self-heal: on iPad Safari, a very brief, very small Apple Pencil
    // contact sometimes never dispatches pointerdown at all (likely tied to
    // how Safari disambiguates real contact from Pencil hover-detection),
    // even though pointermove samples for that same contact still arrive.
    // If we see pen movement while nothing is currently being tracked,
    // treat it as an implicit stroke start rather than losing it outright.
    if (this.tool === "pen" && !this.drawing && !this.erasing
        && e.pointerType === "pen" && (e.pressure > 0 || e.buttons > 0)) {
      this.activePointerId = e.pointerId;
      this.activeInputSource = e.fromStylusTouch ? "stylus-touch" : "pointer";
      this.activeInputStartedAt = e.timeStamp;
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* best-effort */ }
      const { x, y } = this._localXY(e);
      this.currentStroke = { points: [{ ...this._toNorm(x, y), p: e.pressure || 0.5, t: e.timeStamp }], width: 2.4 };
      this.drawing = true;
    }
    if (e.pointerId !== this.activePointerId || (!this.drawing && !this.erasing)) return;
    e.preventDefault();
    if (this.tool === "pen" && this.drawing) {
      // Browsers can batch fast stylus samples into a single pointer event.
      // Keeping those samples makes small handwriting substantially more reliable.
      const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const samples = coalesced.length ? coalesced : [e];
      samples.forEach(sample => {
        const { x, y } = this._localXY(sample);
        const point = { ...this._toNorm(x, y), p: sample.pressure || 0.5, t: sample.timeStamp };
        const last = this.currentStroke.points[this.currentStroke.points.length - 1];
        if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 0.00001) this.currentStroke.points.push(point);
      });
      this.redraw();
    } else if (this.erasing) {
      const { x, y } = this._localXY(e);
      this._eraseNear(x, y);
    }
  }
  _up(e) {
    if (e.pointerId !== this.activePointerId) return;
    // A quick pen stroke can begin and end between pointermove deliveries.
    // Save the final coordinate so its last segment is never dropped.
    if (this.drawing && this.currentStroke) {
      const { x, y } = this._localXY(e);
      const point = { ...this._toNorm(x, y), p: e.pressure || 0.5, t: e.timeStamp };
      const last = this.currentStroke.points[this.currentStroke.points.length - 1];
      if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 0.0001) this.currentStroke.points.push(point);
    }
    this._finishActiveStroke();
  }
  _discardActiveStroke() {
    this.currentStroke = null;
    this.drawing = false;
    this.erasing = false;
    this.activePointerId = null;
    this.activeInputSource = null;
    this.activeInputStartedAt = null;
    this.redraw();
  }
  _finishActiveStroke() {
    const hadStroke = this.drawing && this.currentStroke;
    const finished = hadStroke ? this.currentStroke : null;
    if (hadStroke) this.strokes.push(this.currentStroke);
    this.currentStroke = null;
    this.drawing = false;
    this.erasing = false;
    this.activePointerId = null;
    this.activeInputSource = null;
    this.activeInputStartedAt = null;
    // Normal writing only adds ink, so append the new stroke to the cached
    // bitmap. Rebuilding all prior strokes is reserved for erase/resize/load.
    if (hadStroke) this._appendStrokeToBase(finished); else this.redraw();
    if (finished && this.onStrokeComplete) this.onStrokeComplete(finished);
  }
  _eraseNear(x, y) {
    const nx = x / this.w, ny = y / this.h;
    const thresh = 22 / Math.min(this.w, this.h);
    const before = this.strokes.length;
    this.strokes = this.strokes.filter(s => !s.points.some(pt => Math.hypot(pt.x - nx, pt.y - ny) < thresh));
    if (this.strokes.length !== before) this._rebuildBase();
  }
  redraw() {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this._base, 0, 0);
    ctx.restore();
    if (this.currentStroke) this._drawStrokes(ctx, [this.currentStroke], { clear: false });
  }
  setTool(t) { this.tool = t; }
  clear() { this.strokes = []; this._rebuildBase(); }
  loadStrokes(strokes) { this.strokes = strokes || []; this._rebuildBase(); }
  getStrokes() { return this.strokes; }
}
