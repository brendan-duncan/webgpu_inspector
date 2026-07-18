import { Widget } from './widget.js';
import { Div } from './div.js';

// Uses a circular buffer to store data for a plot.
export class PlotData { 
  constructor(name, size) {
    this.name = name;
    this._size = size;
    this.data = new Float32Array(size);
    this.index = 0;
    this.count = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  reset() {
    this.index = 0;
    this.count = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.data.fill(0);
  }

  get size() {
    return this._size;
  }

  set size(value) {
    if (value === this._size) {
      return;
    }
    const oldData = this.data;
    const copyCount = Math.min(this.count, value);
    this._size = value;
    this.data = new Float32Array(value);
    this.data.set(oldData.subarray(0, copyCount));
    this.count = copyCount;
    if (this.index >= value) {
      this.index = 0;
    }
  }

  add(value) {
    this.data[this.index] = value;
    this.index = (this.index + 1) % this._size;

    if (this.count < this._size) {
      this.count++;
      if (value < this.min) {
        this.min = value;
      } else if (value > this.max) {
        this.max = value;
      }
    } else {
      // Can probably find a way to effectively only call this if the min or max value is being overwritten,
      // but this is simpler and not too expensive.
      this._recalculateMinMax();
    }
  }

  _recalculateMinMax() {
    let min = Infinity;
    let max = -Infinity;
    const data = this.data;
    const count = this.count;
    for (let i = 0; i < count; ++i) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    this.min = min;
    this.max = max;
  }

  get(index) {
    if (this.count < this._size) {
      return this.data[index];
    }
    return this.data[(this.index + index) % this._size];
  }
}

export class Plot extends Div {
  constructor(parent, options) {
    options ??= {};
    options.class = options.class ? options.class + " plot" : "plot";
    super(parent, options);

    this.canvas = new Widget("canvas", this);
    this.context = this.canvas.element.getContext("2d");

    this.data = new Map();

    this.suffix = options.suffix ?? "";
    this.precision = options.precision ?? 0;
    // When true, every series (and the threshold line) share one value scale so the
    // lines are directly comparable. Single-series plots leave this off and self-scale.
    this.sharedScale = options.sharedScale ?? false;
    this.threshold = options.threshold ?? null;         // horizontal reference value
    this.thresholdColor = options.thresholdColor ?? "#e0b050";
    // Optional fixed scale bounds (shared-scale plots only). Anchors the baseline and
    // clips outliers so one spike can't crush the range; values outside just clip.
    this.minValue = options.minValue ?? null;
    this.maxValue = options.maxValue ?? null;
    this._drawPending = false;

    this.onResize();
    this.draw();

    // The element's real width isn't known until flex layout settles, and can change
    // afterwards without a window resize (sibling/panel changes). Observe it directly so
    // the canvas and sample buffers track the visible width. Without this they keep their
    // construction-time size, which is often wider than the visible canvas, so the plot
    // fills well past the right edge before it starts scrolling.
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this.onResize());
      this._resizeObserver.observe(this.element);
    }
  }

  reset() {
    for (const data of this.data.values()) {
      data.reset();
    }
  }

  onResize() {
    if (this.canvas) {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.element.width = this.width * dpr;
      this.canvas.element.height = this.height * dpr;
      this.canvas.element.style.width = `${this.width}px`;
      this.canvas.element.style.height = `${this.height}px`;
      this.context.scale(dpr, dpr);
      for (const data of this.data.values()) {
        data.size = this.width;
      }
      // Setting canvas.width clears it; redraw so the plot isn't blank until the next
      // data tick (matters for plots that only update on a running render loop).
      this.draw();
    }
  }

  addData(name, color) {
    const data = new PlotData(name, this.width);
    data.color = color ?? "#999";
    this.data.set(name, data);
    return data;
  }

  setThreshold(value, color) {
    this.threshold = value;
    if (color) {
      this.thresholdColor = color;
    }
  }

  setMaxValue(value) {
    this.maxValue = value;
  }

  getData(name) {
    return this.data.get(name);
  }

  draw() {
    if (this._drawPending) {
      return;
    }
    this._drawPending = true;
    requestAnimationFrame(() => {
      this._drawPending = false;
      this._render();
    });
  }

  _render() {
    const ctx = this.context;
    const h = this.height;
    ctx.fillStyle = "#333";
    ctx.fillRect(0, 0, this.width, this.height);

    if (!this.sharedScale) {
      // Legacy path: each series self-scales and draws its own labels.
      for (const data of this.data.values()) {
        this._drawData(data);
      }
      return;
    }

    // Shared scale: one value range spanning every series and the threshold.
    let min = Infinity;
    let max = -Infinity;
    for (const data of this.data.values()) {
      if (data.count === 0) {
        continue;
      }
      if (data.min < min) min = data.min;
      if (data.max > max) max = data.max;
    }
    if (this.threshold != null) {
      if (this.threshold < min) min = this.threshold;
      if (this.threshold > max) max = this.threshold;
    }
    if (!isFinite(min)) {
      min = 0;
      max = 1;
    }
    // Fixed bounds override the data-derived range (baseline anchor + outlier clip).
    if (this.minValue != null) {
      min = this.minValue;
    }
    if (this.maxValue != null) {
      max = this.maxValue;
    }
    if (max === min) {
      min -= 1;
      max += 1;
    }
    const range = max - min;

    // Threshold line under the series (e.g. the display refresh interval).
    if (this.threshold != null && range > 0) {
      const y = h - ((this.threshold - min) / range) * h;
      ctx.strokeStyle = this.thresholdColor;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const data of this.data.values()) {
      this._drawData(data, min, max);
    }

    const format = (v) => `${v.toFixed(this.precision)}${this.suffix}`;
    ctx.fillStyle = "#fff";
    ctx.fillText(format(max), 2, 10);
    ctx.fillText(format(min), 2, h - 1);
  }

  _drawData(data, sharedMin, sharedMax) {
    const ctx = this.context;
    const h = this.height;
    const count = data.count;

    if (count === 0) {
      return;
    }

    let min;
    let max;
    if (sharedMin != null) {
      min = sharedMin;
      max = sharedMax;
    } else {
      min = data.min;
      max = data.max;
      if (max === min) {
        min -= 1;
        max += 1;
      }
      const format = (v) => `${v.toFixed(this.precision)}${this.suffix}`;
      ctx.fillStyle = "#fff";
      ctx.fillText(format(max), 2, 10);
      ctx.fillText(format(min), 2, h - 1);
    }

    const range = max - min;
    if (range <= 0) {
      return;
    }
    ctx.strokeStyle = data.color || "#999";
    ctx.beginPath();
    let v = data.get(0);
    v = ((v - min) / range) * h;
    ctx.moveTo(0, h - v);
    for (let i = 1; i < count; ++i) {
      v = data.get(i);
      v = ((v - min) / range) * h;
      ctx.lineTo(i, h - v);
    }
    ctx.stroke();
  }
}
