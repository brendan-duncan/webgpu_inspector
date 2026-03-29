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
    this.min = 1.0e10;
    this.max = -1.0e10;
  }

  reset() {
    this.index = 0;
    this.count = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  get size() {
    return this._size;
  }

  set size(value) {
    if (value === this._size) {
      return;
    }
    const oldData = this.data;
    this._size = value;
    this.data = new Float32Array(value);
    this.data.set(oldData.subarray(0, this.count));
  }

  add(value) {
    const oldValue = this.data[this.index];
    this.data[this.index] = value;
    this.index = (this.index + 1) % this._size;
    this.count = Math.min(this.count + 1, this._size);

    if (this.count === this._size && oldValue !== undefined) {
      if (oldValue === this.min || oldValue === this.max) {
        this._recalculateMinMax();
        return;
      }
    }
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
  }

  _recalculateMinMax() {
    this.min = Infinity;
    this.max = -Infinity;
    for (let i = 0; i < this.count; ++i) {
      const v = this.data[i];
      if (v < this.min) this.min = v;
      if (v > this.max) this.max = v;
    }
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
    this._drawPending = false;

    this.onResize();
    this.draw();
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
    }
  }

  addData(name) {
    const data = new PlotData(name, this.width);
    this.data.set(name, data);
    return data;
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
    ctx.fillStyle = "#333";
    ctx.fillRect(0, 0, this.width, this.height);

    for (const data of this.data.values()) {
      this._drawData(data);
    }
  }

  _drawData(data) {
    const ctx = this.context;
    const h = this.height;
    const count = data.count;

    if (count === 0) {
      return;
    }

    let min = data.min;
    let max = data.max;

    if (max === min) {
      min -= 1;
      max += 1;
    }

    const format = (v) => `${v.toFixed(this.precision)}${this.suffix}`;
    ctx.fillStyle = "#fff";
    ctx.fillText(format(max), 2, 10);
    ctx.fillText(format(min), 2, h - 1);

    const range = max - min;
    ctx.strokeStyle = "#999";
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
