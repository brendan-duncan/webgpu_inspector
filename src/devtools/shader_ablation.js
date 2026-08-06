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
 * This module is pure source-to-source; measurement lives in the caller.
 */

import { WgslParser, WgslReflect } from "wgsl_reflect/wgsl_reflect.module.js";

/** Name of the injected uniform struct and variable. */
const ABLATION_STRUCT = "WGPUInspectorAblation";
const ABLATION_VAR = "_wgpuInspectorAblation";

/** WebGPU guarantees at least 4 bind groups. */
const MAX_BIND_GROUPS = 4;

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
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   code?: string,
 *   group?: number,
 *   binding?: number,
 *   cutPoints?: Array<{cut:number, line:number, start:number, end:number, label:string}>,
 *   fullCut?: number,
 * }}
 *   `cutPoints[i].cut` is the uniform value that stops execution *before* that
 *   statement; `fullCut` runs the whole body. Differencing consecutive cut
 *   measurements attributes cost to the statement between them.
 */
export function instrumentForAblation(code, options = {}) {
  const { stage, entryPoint, avoidGroups } = options;
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

  const body = fn.body ?? [];
  // Only top-level statements of the entry point are cut points. A `return` is
  // legal inside a loop or branch too, but cutting there measures a partial
  // first iteration rather than a whole statement, which needs different
  // arithmetic than simple differencing.
  const statements = body.filter((s) => s && s.hasSpan);
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

  // Build the instrumented source by splicing guards in at statement starts,
  // walking back-to-front so earlier offsets stay valid.
  const cutPoints = [];
  const inserts = [];
  statements.forEach((statement, i) => {
    cutPoints.push({
      cut: i,
      line: statement.line,
      start: statement.start,
      end: statement.end,
      label: code.slice(statement.start, statement.end).split("\n")[0].trim().slice(0, 80),
    });
    inserts.push({
      offset: statement.start,
      text: `if (${ABLATION_VAR}.cut == ${i}u) { return${returnExpr}; }\n  `,
    });
  });

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
    cutPoints,
    // Any value past the last cut runs the whole body.
    fullCut: statements.length,
  };
}

/**
 * Turn a set of cut measurements into a per-statement cost.
 *
 * @param {Array<{cut:number, line:number, label:string}>} cutPoints
 * @param {Map<number, number>} measurements - cut value -> measured ms
 * @param {number} fullCut
 * @returns {{statements: Array, baselineMs: number, totalMs: number, notes: string[]}}
 *   Each statement gets `ms` (its own cost) and `negative` when differencing
 *   produced a value below zero — a sign the measurement is at the noise floor,
 *   reported rather than clamped away silently.
 */
export function attributeAblation(cutPoints, measurements, fullCut) {
  const notes = [];
  const baselineMs = measurements.get(0) ?? 0;
  const totalMs = measurements.get(fullCut) ?? 0;

  const statements = [];
  let negatives = 0;
  for (const point of cutPoints) {
    const before = measurements.get(point.cut);
    const nextCut = point.cut + 1 <= fullCut ? point.cut + 1 : null;
    const after = nextCut === null ? undefined : measurements.get(nextCut);
    if (before === undefined || after === undefined) {
      statements.push({ ...point, ms: null, negative: false });
      continue;
    }
    const ms = after - before;
    if (ms < 0) {
      negatives++;
    }
    statements.push({ ...point, ms, negative: ms < 0 });
  }

  if (negatives > 0) {
    notes.push(`${negatives} statement(s) measured as negative cost, which means those differences are below the measurement noise floor. Treat their cost as "too small to measure", not as a saving.`);
  }
  // The prologue is whatever the shader costs before its first statement runs:
  // the branch guards, plus fixed per-invocation setup.
  if (baselineMs > 0 && totalMs > 0 && baselineMs / totalMs > 0.25) {
    notes.push(`The instrumentation baseline is ${((baselineMs / totalMs) * 100).toFixed(0)}% of the shader's total cost, so per-statement figures here are dominated by fixed overhead rather than the statements themselves.`);
  }

  return { statements, baselineMs, totalMs, notes };
}
