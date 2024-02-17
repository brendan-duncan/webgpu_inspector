import { StacktraceCache } from "../../utils/stacktrace.js";

export class GPUObject {
  constructor(id, stacktrace) {
    this.id = id;
    this.label = "";
    this._stacktrace = StacktraceCache.setStacktrace(stacktrace ?? "");
    this._deletionTime = 0;
  }

  get name() {
    return this.label || this.constructor.className;
  }

  get stacktrace() {
    return StacktraceCache.getStacktrace(this._stacktrace);
  }

  get isDeleted() {
    return this._deletionTime > 0;
  }

  get idName() {
    return this.id < 0 ? "CANVAS" : this.id;
  }
}
