export function getStacktrace() {
  if (!Error.captureStackTrace) {
    return "";
  }
  const stacktrace = {};
  Error.captureStackTrace(stacktrace, getStacktrace);
  if (!stacktrace.stack) {
    return "";
  }
  let stack = stacktrace.stack
    .split("\n")
    .map((line) => line.split("at ")[1])
    .slice(2) // Skip the Error line and the GPU.* line.
    .filter((line) => line && !line.includes("webgpu_inspector.js"));

  return stack.join("\n");
}

// Cache stacktraces since many objects will have the same stacktrace.
// Used as a singleton.
export class StacktraceCache {
  constructor() {
    this._cache = [];
  }

  _getStacktrace(id) {
    return id < 0 ? "" : this._cache[id] ?? "";
  }

  _setStacktrace(stacktrace) {
    if (!stacktrace) {
      return -1;
    }
    const id = this._cache.indexOf(stacktrace);
    if (id !== -1) {
      return id;
    }
    this._cache.push(stacktrace);
    return this._cache.length - 1;
  }

  static getStacktrace(id) {
    return StacktraceCache._global._getStacktrace(id);
  }

  static setStacktrace(stacktrace) {
    return StacktraceCache._global._setStacktrace(stacktrace);
  }
}

StacktraceCache._global = new StacktraceCache();
