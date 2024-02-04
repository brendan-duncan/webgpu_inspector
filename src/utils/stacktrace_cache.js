// Cache stacktraces since many objects will have the same stacktrace.
export class StacktraceCache {
  constructor() {
    this._cache = [];
  }

  getStacktrace(id) {
    return id < 0 ? "" : this._cache[id] ?? "";
  }

  setStacktrace(stacktrace) {
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
}
