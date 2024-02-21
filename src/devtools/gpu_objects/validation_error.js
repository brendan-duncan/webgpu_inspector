import { GPUObject } from "./gpu_object.js";

export class ValidationError extends GPUObject {
  constructor(id, object, message, stacktrace) {
    super(id, null, stacktrace);
    this.message = message;
    this.object = object ?? 0;
  }
}
ValidationError.className = "ValidationError";
