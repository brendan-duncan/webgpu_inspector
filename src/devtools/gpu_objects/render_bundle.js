import { GPUObject } from "./gpu_object.js";

export class RenderBundle extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
    this.commands = [];
  }
}
RenderBundle.className = "RenderBundle";
