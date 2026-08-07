// Capturing a stacktrace is expensive, and the cost is dominated by
// Error.captureStackTrace walking and recording the frames — not by symbolizing
// or formatting them afterwards. Measured in V8 at a call depth typical of an
// engine's draw path: ~16us per capture at the default Error.stackTraceLimit of
// 10, falling roughly linearly to ~3.8us at a limit of 1. Formatting the result
// is only ~3us of that, so caching formatted strings alone saves little.
//
// Captures repeat heavily, though: an engine creates its views and bind groups
// from a handful of call sites. So identify the call site with a short (cheap)
// capture and only pay for the full one the first time that site is seen. That
// brings a repeat capture down to ~5us while still reporting the complete stack.
//
// Tradeoff: the key only sees the top few frames, so two call sites that share
// them but differ further down — a shared helper reached from several places —
// collide, and the later one reports the earlier one's ancestry. Widen the key
// with setStacktraceKeyDepth, or pass 0 to disable caching and always capture in
// full. See test/unit/stacktrace.test.js, which pins both behaviors.

// Frames in the cheap key capture. The first is the inspector's own method
// wrapper, constant across every call, so the default of 3 distinguishes call
// sites by their immediate caller plus one level above it.
const _defaultKeyDepth = 3;
let _keyDepth = _defaultKeyDepth;

// call-site key (raw truncated stack) -> formatted stack.
const _callSiteCache = new Map();
// Bounded so a page generating call sites dynamically (eval, JIT'd shaders)
// can't grow this without limit. Past the cap we simply stop caching.
const _maxCacheEntries = 4096;

/**
 * Set how many stack frames identify a call site for caching purposes.
 * Higher is more precise and more expensive; 0 disables caching entirely and
 * captures every stacktrace in full.
 * @param {number} depth
 */
export function setStacktraceKeyDepth(depth) {
  _keyDepth = Math.max(0, depth | 0);
  _callSiteCache.clear();
}

/**
 * Drop cached call sites. Used when the page is reset.
 */
export function clearStacktraceCache() {
  _callSiteCache.clear();
}

// A full capture, honoring whatever Error.stackTraceLimit the page has set (the
// original behavior). constructorOpt is getStacktrace rather than this helper so
// the frames start at getStacktrace's caller no matter where this is called from.
function _captureFull() {
  const holder = {};
  Error.captureStackTrace(holder, getStacktrace);
  return holder.stack || "";
}

// A deliberately truncated capture used only as a cache key. Cost scales with
// the frame count, which is the whole point.
function _captureKey(depth) {
  const prevLimit = Error.stackTraceLimit;
  const holder = {};
  try {
    Error.stackTraceLimit = depth;
    Error.captureStackTrace(holder, getStacktrace);
    return holder.stack || "";
  } finally {
    Error.stackTraceLimit = prevLimit;
  }
}

function _format(rawStack) {
  return rawStack
    .split("\n")
    .map((line) => line.split("at ")[1])
    .slice(2) // Skip the Error line and the GPU.* line.
    .filter((line) => line && !line.includes("webgpu_inspector_loader.js"))
    .join("\n");
}

export function getStacktrace() {
  if (!Error.captureStackTrace) {
    return "";
  }

  const limit = Error.stackTraceLimit;
  // If caching is off, or the page's own limit is already at or below the key
  // depth, the key capture would cost as much as the full one — skip it.
  if (_keyDepth <= 0 || (typeof limit === "number" && limit <= _keyDepth)) {
    const raw = _captureFull();
    return raw ? _format(raw) : "";
  }

  const key = _captureKey(_keyDepth);
  if (!key) {
    return "";
  }

  const cached = _callSiteCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const raw = _captureFull();
  const formatted = raw ? _format(raw) : "";
  if (_callSiteCache.size < _maxCacheEntries) {
    _callSiteCache.set(key, formatted);
  }
  return formatted;
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
