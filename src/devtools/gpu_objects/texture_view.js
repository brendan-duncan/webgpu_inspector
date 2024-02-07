import { GPUObject } from "./gpu_object.js";

export class TextureView extends GPUObject {
  constructor(id, texture, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
    this.texture = texture;
  }
}
TextureView.className = "TextureView";
