/**
 * Ablation instrumentation for WGSL shaders (tier 3b).
 *
 * Per-draw timing says which draw is expensive. Ablation says which *line* is,
 * by measuring the shader with progressively more of its body executed and
 * differencing: cost(cut=k+1) - cost(cut=k) is the cost of statement k.
 *
 * The naive way to do this — compile a separate shader truncated at each cut
 * point — does not work. Truncating removes the consumers of everything above,
 * so the driver's dead-code elimination deletes the very work being measured,
 * and the cost curve comes out flat. This module avoids that entirely:
 *
 *   The shader is instrumented ONCE, with an early `return` before every
 *   statement, guarded by a value read from a uniform at run time:
 *
 *       if (_abl.cut == 3u) { return vec4f(); }
 *
 *   Because the cut point is a uniform rather than a compile-time constant, the
 *   compiler cannot prove any statement unreachable — for a large `cut` the
 *   whole body runs — so nothing may be eliminated. One pipeline is built, and
 *   the cut is varied by writing the uniform between measurements.
 *
 * The early return needs a value of the entry point's return type. WGSL's
 * zero-value expression `T()` is valid for any constructible type, including
 * structs, so the return type only has to be renderable as a type name.
 *
 * Cut points cover the entry point's top-level statements and the bodies of its
 * loops; the two levels measure different things, which collectCutPoints
 * explains.
 *
 * This module is pure source-to-source; measurement lives in the caller.
 */

import { WgslParser, WgslReflect, For, While, Loop } from "wgsl_reflect/wgsl_reflect.module.js";

/** Name of the injected uniform struct and variable. */
const ABLATION_STRUCT = "WGPUInspectorAblation";
const ABLATION_VAR = "_wgpuInspectorAblation";

/** WebGPU guarantees at least 4 bind groups. */
const MAX_BIND_GROUPS = 4;

/**
 * Cut points past this many make the sweep take longer than it is worth (each
 * one is four timed submissions). Loop bodies are dropped before top-level
 * statements when the budget is blown.
 */
const MAX_CUT_POINTS = 64;

/**
 * A loop body is only safe to break down if control cannot leave it by any
 * route other than falling off the end — see collectCutPoints.
 *
 * This is a source-text test rather than an AST walk on purpose: it cannot miss
 * a node type, and over-excluding (a loop whose comment says "return") costs
 * nothing but a coarser breakdown for that loop.
 */
const ESCAPE_RE = /\b(break|continue|return|discard)\b/;

function isLoop(node) {
    return node instanceof For || node instanceof While || node instanceof Loop;
}

/**
 * Render an AST type node back to WGSL source text. Only needs to handle what
 * can appear as an entry point's return type: scalars, vectors, matrices, and
 * struct names — all of which support the `T()` zero-value form.
 * @returns {string|null} null when the type can't be rendered safely
 */
export function typeToWgsl(type) {
  if (!type?.name) {
    return null;
  }
  // A templated type (vec4<f32>, mat3x3<f32>) carries its parameter in `format`.
  if (type.format) {
    const inner = typeToWgsl(type.format);
    if (!inner) {
      return null;
    }
    return `${type.name}<${inner}>`;
  }
  // Bare identifiers: f32/u32/i32, the vecNf shorthands, and struct names.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(type.name)) {
    return null;
  }
  return type.name;
}

/** The bind group indices a shader already uses, via reflection. */
function usedGroups(reflection) {
  const groups = new Set();
  for (const list of [reflection?.uniforms, reflection?.storage, reflection?.textures, reflection?.samplers]) {
    for (const resource of list ?? []) {
      if (typeof resource.group === "number") {
        groups.add(resource.group);
      }
    }
  }
  return groups;
}

/**
 * Find the entry point function node for a stage.
 * @returns {Object|null}
 */
function findEntryFunction(ast, stage, entryPoint) {
  const candidates = [];
  for (const statement of ast) {
    if (!statement?.attributes || !Array.isArray(statement.body)) {
      continue;
    }
    if (statement.attributes.some((a) => a.name === stage)) {
      candidates.push(statement);
    }
  }
  if (!candidates.length) {
    return null;
  }
  if (entryPoint) {
    return candidates.find((f) => f.name === entryPoint) ?? null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Assign cut points to a block's statements, in source order, descending into
 * loop bodies.
 *
 * Nesting works because of what a cut *means*. A cut inside a loop body stops
 * during the first iteration, so differencing two cuts in the same body gives
 * the cost of one statement for **one execution** — not its total. A cut
 * anywhere outside the loop, on the other hand, lets every iteration run,
 * because the guards inside the body never match. So the two levels measure
 * different things and neither disturbs the other: top-level differencing still
 * yields the loop's whole cost, and the body's differencing yields a
 * per-iteration breakdown of it.
 *
 * Two structural requirements fall out of that:
 *
 *  * The last statement in a body has no following sibling to difference
 *    against — the next cut in source order sits *after* the loop, and
 *    measuring against it would compare one partial iteration with all of them.
 *    A synthetic cut is injected at the end of every body to give it a partner.
 *  * `break`, `continue` and `return` can skip that terminator, which would let
 *    the loop keep running and destroy the arithmetic. Bodies containing any of
 *    them are left whole.
 *
 * Only loop bodies are descended into. An `if` body would be sound to cut the
 * same way, but the invocations that don't take the branch run the *entire*
 * shader in every one of those measurements, so the statement's cost is a small
 * difference between two large numbers and drowns.
 */
function collectCutPoints(statements, ctx, depth, parent) {
  const siblings = [];

  for (const statement of statements) {
    if (!statement?.hasSpan) {
      continue;
    }
    const point = {
      cut: ctx.next++,
      line: statement.line,
      start: statement.start,
      end: statement.end,
      label: ctx.code.slice(statement.start, statement.end).split("\n")[0].trim().slice(0, 80),
      depth,
      parentCut: parent ? parent.cut : null,
      // Filled in below, once the following sibling's index is known.
      nextCut: null,
    };
    ctx.points.push(point);
    ctx.inserts.push({ offset: statement.start, text: `${ctx.guard(point.cut)}\n  ` });
    siblings.push(point);

    if (!ctx.nested || !isLoop(statement)) {
      continue;
    }
    const body = (statement.body ?? []).filter((s) => s?.hasSpan);
    if (!body.length) {
      continue;
    }
    if (ESCAPE_RE.test(ctx.code.slice(statement.start, statement.end))) {
      ctx.skippedLoops++;
      continue;
    }
    const inner = collectCutPoints(body, ctx, depth + 1, point);
    if (!inner.length) {
      continue;
    }
    // The synthetic block terminator: with this cut the first iteration runs to
    // completion and then returns, so the body's last statement has a partner.
    const endCut = ctx.next++;
    ctx.inserts.push({ offset: body[body.length - 1].end, text: `\n  ${ctx.guard(endCut)}` });
    inner[inner.length - 1].nextCut = endCut;
  }

  for (let i = 0; i < siblings.length - 1; ++i) {
    siblings[i].nextCut = siblings[i + 1].cut;
  }
  return siblings;
}

/**
 * Instrument a shader so its entry point can be cut short at run time.
 *
 * @param {string} code - the original WGSL
 * @param {Object} options
 * @param {"vertex"|"fragment"|"compute"} options.stage
 * @param {string} [options.entryPoint] - required when the stage has several
 * @param {number[]} [options.avoidGroups] - additional bind group indices that
 *   are already taken. Reflection only sees the groups the *shader* reads; an
 *   explicit pipeline layout can declare more, and the ablation uniform must
 *   not collide with those either.
 * @param {boolean} [options.nested=true] - also cut inside loop bodies. Callers
 *   retry with this off when the nested shader fails to compile.
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   code?: string,
 *   group?: number,
 *   binding?: number,
 *   cutPoints?: Array<{cut:number, nextCut:number, line:number, start:number,
 *                      end:number, label:string, depth:number,
 *                      parentCut:number|null}>,
 *   fullCut?: number,
 *   nested?: boolean,
 *   notes?: string[],
 * }}
 *   `cutPoints[i].cut` is the uniform value that stops execution *before* that
 *   statement, and `nextCut` the one that stops after it; `fullCut` runs the
 *   whole body. Differencing that pair attributes cost to the statement — its
 *   total cost at depth 0, the cost of one execution deeper in.
 */
export function instrumentForAblation(code, options = {}) {
  const { stage, entryPoint, avoidGroups, nested = true } = options;
  if (!stage) {
    return { ok: false, reason: "No shader stage was given." };
  }

  let ast;
  let reflection;
  try {
    ast = new WgslParser().parse(code);
    reflection = new WgslReflect(code);
  } catch (e) {
    return { ok: false, reason: `The shader could not be parsed: ${e.message ?? e}` };
  }

  const fn = findEntryFunction(ast, stage, entryPoint);
  if (!fn) {
    return {
      ok: false,
      reason: entryPoint
        ? `No ${stage} entry point named "${entryPoint}" was found.`
        : `The shader has no single ${stage} entry point; name one explicitly.`,
    };
  }

  // A void entry point (a compute shader) returns bare; anything else needs a
  // zero value of its return type.
  let returnExpr = "";
  if (fn.returnType) {
    const typeName = typeToWgsl(fn.returnType);
    if (!typeName) {
      return { ok: false, reason: "The entry point's return type could not be rendered, so an early return can't be synthesized." };
    }
    returnExpr = ` ${typeName}()`;
  }

  const statements = (fn.body ?? []).filter((s) => s && s.hasSpan);
  if (!statements.length) {
    return { ok: false, reason: "The entry point has no statements with source spans to cut at." };
  }

  const used = usedGroups(reflection);
  for (const g of avoidGroups ?? []) {
    used.add(g);
  }
  let group = -1;
  for (let g = 0; g < MAX_BIND_GROUPS; ++g) {
    if (!used.has(g)) {
      group = g;
      break;
    }
  }
  if (group < 0) {
    return { ok: false, reason: `The shader already uses all ${MAX_BIND_GROUPS} bind groups, leaving nowhere to put the ablation uniform.` };
  }

  // Collect the cut points, retrying without loop bodies if nesting produces
  // more of them than a sweep can afford.
  const guard = (cut) => `if (${ABLATION_VAR}.cut == ${cut}u) { return${returnExpr}; }`;
  const notes = [];
  const walk = (withNesting) => {
    const ctx = { next: 0, points: [], inserts: [], code, guard, nested: withNesting, skippedLoops: 0 };
    const top = collectCutPoints(statements, ctx, 0, null);
    if (top.length) {
      // Any cut past the last one runs the whole body.
      top[top.length - 1].nextCut = ctx.next;
    }
    return ctx;
  };

  let ctx = walk(nested);
  if (nested && ctx.points.length > MAX_CUT_POINTS) {
    notes.push(`Breaking the loops down would have taken ${ctx.points.length} measurements, past the ${MAX_CUT_POINTS} this sweep allows, so only top-level statements were measured.`);
    ctx = walk(false);
  } else if (ctx.skippedLoops > 0) {
    notes.push(`${ctx.skippedLoops} loop(s) were not broken down statement by statement, because their bodies can break, continue or return — control could then skip the injected end-of-body marker and the differencing would be measuring the wrong thing.`);
  }

  // Splice the guards in back-to-front so earlier offsets stay valid.
  const inserts = ctx.inserts.slice().sort((a, b) => a.offset - b.offset);
  let out = code;
  for (let i = inserts.length - 1; i >= 0; --i) {
    const { offset, text } = inserts[i];
    out = out.slice(0, offset) + text + out.slice(offset);
  }

  const binding = 0;
  const prelude =
    `struct ${ABLATION_STRUCT} { cut : u32 }\n` +
    `@group(${group}) @binding(${binding}) var<uniform> ${ABLATION_VAR} : ${ABLATION_STRUCT};\n\n`;

  return {
    ok: true,
    code: prelude + out,
    group,
    binding,
    cutPoints: ctx.points,
    // Any value past the last cut runs the whole body.
    fullCut: ctx.next,
    nested: ctx.points.some((p) => p.depth > 0),
    notes,
  };
}

/**
 * Turn a set of cut measurements into a per-statement cost.
 *
 * @param {Array<{cut:number, nextCut:number, line:number, label:string,
 *                depth:number, parentCut:number|null}>} cutPoints
 * @param {Map<number, number>} measurements - cut value -> measured ms
 * @param {number} fullCut
 * @returns {{statements: Array, baselineMs: number, totalMs: number, notes: string[]}}
 *   Each statement gets `ms` (its own cost) and `negative` when differencing
 *   produced a value below zero — a sign the measurement is at the noise floor,
 *   reported rather than clamped away silently.
 *
 *   Statements inside a loop body (`depth > 0`) additionally get
 *   `perExecutionMs`: what one execution of that statement costs, which is what
 *   the raw difference measures there. Their `ms` is that scaled up to a share
 *   of the loop's own measured total, so a body's statements sum to their loop.
 */
export function attributeAblation(cutPoints, measurements, fullCut) {
  const notes = [];
  const baselineMs = measurements.get(0) ?? 0;
  const totalMs = measurements.get(fullCut) ?? 0;

  const statements = [];
  const byCut = new Map();
  let negatives = 0;
  for (const point of cutPoints) {
    const before = measurements.get(point.cut);
    const after = point.nextCut === null || point.nextCut === undefined
      ? undefined
      : measurements.get(point.nextCut);
    const entry = { ...point };
    if (before === undefined || after === undefined) {
      entry.ms = null;
      entry.negative = false;
    } else {
      const ms = after - before;
      if (ms < 0) {
        negatives++;
      }
      entry.ms = ms;
      entry.negative = ms < 0;
    }
    if (point.depth > 0) {
      // At depth the difference is one execution of the statement, because the
      // cut stops the loop during its first iteration.
      entry.perExecutionMs = entry.ms;
    }
    statements.push(entry);
    byCut.set(entry.cut, entry);
  }

  // Scale each loop body's per-execution costs into a share of the loop's own
  // measured cost. Shallowest first, so a nested loop's total is already
  // resolved before its body is distributed across it.
  const children = new Map();
  for (const entry of statements) {
    if (entry.depth > 0) {
      const list = children.get(entry.parentCut) ?? [];
      list.push(entry);
      children.set(entry.parentCut, list);
    }
  }
  for (const entry of statements.slice().sort((a, b) => a.depth - b.depth)) {
    const list = children.get(entry.cut);
    if (!list?.length) {
      continue;
    }
    // Negative differences are noise, not savings; they get no share rather
    // than eating into their siblings'.
    const weights = list.map((c) => Math.max(c.perExecutionMs ?? 0, 0));
    const sum = weights.reduce((a, w) => a + w, 0);
    const loopMs = entry.ms;
    list.forEach((child, i) => {
      child.share = sum > 0 ? weights[i] / sum : null;
      child.ms = (sum > 0 && loopMs !== null && loopMs > 0) ? loopMs * weights[i] / sum : null;
    });
  }

  if (negatives > 0) {
    notes.push(`${negatives} statement(s) measured as negative cost, which means those differences are below the measurement noise floor. Treat their cost as "too small to measure", not as a saving.`);
  }
  if (statements.some((s) => s.depth > 0)) {
    notes.push("Statements inside a loop are measured one execution at a time — a cut there stops the loop during its first iteration — and then scaled to their share of the loop's own measured cost. The share is what the loop's time is spent on; it does not account for the loop's own condition and increment.");
  }
  // The prologue is whatever the shader costs before its first statement runs:
  // the branch guards, plus fixed per-invocation setup.
  if (baselineMs > 0 && totalMs > 0 && baselineMs / totalMs > 0.25) {
    notes.push(`The instrumentation baseline is ${((baselineMs / totalMs) * 100).toFixed(0)}% of the shader's total cost, so per-statement figures here are dominated by fixed overhead rather than the statements themselves.`);
  }

  return { statements, baselineMs, totalMs, notes };
}
