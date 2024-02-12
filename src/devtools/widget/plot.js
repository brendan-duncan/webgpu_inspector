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
    this.min = 1.0e10;
    this.max = -1.0e10;
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
    for (let i = 0; i < this.count; ++i) {
      this.data[i] = oldData[i];
    }
  }

  add(value) {
    this.data[this.index] = value;
    this.index = (this.index + 1) % this._size;
    this.count = Math.min(this.count + 1, this._size);
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
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
      this.canvas.element.width = this.width;
      this.canvas.element.height = this.height;
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
    const ctx = this.context;
    ctx.fillStyle = "#333";
    ctx.fillRect(0, 0, this.width, this.height);

    for (const data of this.data.values()) {
      this._drawData(data);
    }
  }

  _drawData(data) {
    const ctx = this.context;
    ctx.strokeStyle = "#999";
    const h = this.height;
    let min = 1.0e10;
    let max = -1.0e10;
    const count = data.count;
    for (let i = 0; i < count; ++i) {
      let v = data.get(i);
      if (v < min) {
        min = v;
      }
      if (v > max) {
        max = v;
      }
    }

    if (count == 0) {
      return;
    }

    ctx.fillStyle = "#fff";
    ctx.fillText(`${max.toFixed(this.precision)}${this.suffix}`, 2, 10);
    ctx.fillText(`${min.toFixed(this.precision)}${this.suffix}`, 2, h - 1);

    if (max === min) {
      min -= 1;
      max += 1;
    }

    ctx.beginPath();
    let v = data.get(0);
    v = ((v - min) / (max - min)) * h;
    ctx.moveTo(0, h - v);
    for (let i = 1; i < data.count; ++i) {
      v = data.get(i);
      v = ((v - min) / (max - min)) * h;
      ctx.lineTo(i, h - v);
    }
    ctx.stroke();
  }
}
