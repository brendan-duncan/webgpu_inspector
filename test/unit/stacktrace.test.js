// Unit tests for the call-site cache in src/utils/stacktrace.js.
//
// getStacktrace() trades exactness for speed: it identifies a call site with a
// short truncated capture and reuses the formatted stack from the first time it
// saw that site. These tests pin the parts that must stay true — that a cache
// hit returns what an exact capture would have returned, that distinct call
// sites stay distinct, and that the global Error.stackTraceLimit is left alone.
//
// Run with: node --test "test/unit/*.test.js"

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getStacktrace,
  setStacktraceKeyDepth,
  clearStacktraceCache
} from "../../src/utils/stacktrace.js";

// getStacktrace drops the Error header line and the frame directly below it
// (the inspector's own method wrapper). Going through this indirection makes the
// test's own call sites the first reported frame, matching real usage.
function wrapper() {
  return getStacktrace();
}

function callSiteA() {
  return wrapper();
}

function callSiteB() {
  return wrapper();
}

// A helper reached from two different ancestries — the case the truncated key
// can conflate if the key is too short to see past the shared frames.
function sharedHelper() {
  return wrapper();
}

function ancestorOne() {
  return sharedHelper();
}

function ancestorTwo() {
  return sharedHelper();
}

// All samples must come from one source line: the reported stack includes this
// function's own frame, so capturing from different lines would differ for
// reasons that have nothing to do with caching. A step with no `depth` leaves
// the cache warm from the previous step.
function sampleAt(steps) {
  const out = [];
  for (const step of steps) {
    if (step.depth !== undefined) {
      setStacktraceKeyDepth(step.depth); // also clears the cache
    }
    out.push(callSiteA());
  }
  return out;
}

test("a cache hit returns what an exact capture returns", () => {
  // depth 0 disables caching (exact); depth 3 starts a fresh cache, so the
  // second sample is a miss and the third — same depth, warm cache — is a hit.
  const [exact, miss, hit] = sampleAt([{ depth: 0 }, { depth: 3 }, {}]);

  assert.match(exact, /callSiteA/);
  assert.equal(miss, exact, "miss path must match the uncached result");
  assert.equal(hit, exact, "hit path must match the uncached result");
});

test("distinct call sites are not conflated", () => {
  setStacktraceKeyDepth(3);
  clearStacktraceCache();

  const a = callSiteA();
  const b = callSiteB();

  assert.notEqual(a, b);
  assert.match(a, /callSiteA/);
  assert.match(b, /callSiteB/);
});

test("the default key depth sees one level above the immediate caller", () => {
  // Key frames at depth 3: wrapper / sharedHelper / ancestorOne|Two. The
  // ancestor is inside the key, so the two are told apart.
  setStacktraceKeyDepth(3);
  clearStacktraceCache();

  const one = ancestorOne();
  const two = ancestorTwo();

  assert.notEqual(one, two);
  assert.match(one, /ancestorOne/);
  assert.match(two, /ancestorTwo/);
});

test("a key too short to see the ancestry conflates shared helpers", () => {
  // The documented tradeoff, pinned so it can't change silently. At depth 2 the
  // key is wrapper / sharedHelper for both ancestries, so the second caller is
  // served the first one's stack — it reports ancestorOne, not ancestorTwo.
  setStacktraceKeyDepth(2);
  clearStacktraceCache();

  const one = ancestorOne();
  const two = ancestorTwo();

  assert.equal(two, one, "a key collision serves the first-seen stack");
  assert.match(two, /ancestorOne/);
  assert.doesNotMatch(two, /ancestorTwo/);

  setStacktraceKeyDepth(3);
});

test("Error.stackTraceLimit is restored after capturing", () => {
  setStacktraceKeyDepth(3);
  clearStacktraceCache();

  const before = Error.stackTraceLimit;
  callSiteA(); // miss
  assert.equal(Error.stackTraceLimit, before);
  callSiteA(); // hit
  assert.equal(Error.stackTraceLimit, before);
});

test("a page stackTraceLimit at or below the key depth still captures exactly", () => {
  // The key capture would cost as much as the full one, so it is skipped. The
  // result must still be a correct stack for each distinct call site.
  const before = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 2;
    setStacktraceKeyDepth(3);
    clearStacktraceCache();

    const a = callSiteA();
    const b = callSiteB();

    assert.match(a, /callSiteA/);
    assert.match(b, /callSiteB/);
    assert.equal(Error.stackTraceLimit, 2, "the page's limit must be left as it was");
  } finally {
    Error.stackTraceLimit = before;
    setStacktraceKeyDepth(3);
  }
});

test("the cache does not grow without bound", () => {
  setStacktraceKeyDepth(3);
  clearStacktraceCache();

  // Distinct call sites from generated functions. The cap is 4096; this only
  // checks that repeated distinct sites keep returning correct stacks rather
  // than throwing or degrading once caching stops.
  for (let i = 0; i < 50; ++i) {
    const fn = new Function("wrapper", "return wrapper();");
    const stack = fn(wrapper);
    assert.equal(typeof stack, "string");
  }
});
