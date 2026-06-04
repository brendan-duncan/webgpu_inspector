import { GPUObject } from "./gpu_object.js";

export class CanvasContext extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, descriptor, stacktrace);
    this.descriptor = descriptor;
  }

  get canvasId() {
    return this.descriptor?.canvasId ?? "";
  }

  get name() {
    if (this.label) {
      return this.label;
    }
    if (this.canvasId) {
      return `Canvas "${this.canvasId}"`;
    }
    return this.constructor.className;
  }
}
CanvasContext.className = "CanvasContext";
