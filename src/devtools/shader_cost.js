import { buildShaderCostTree, DefaultCostWeights } from "wgsl_reflect/wgsl_reflect.module.js";

/**
 * Build (and cache on the module) the modeled cost tree for a shader.
 *
 * Cached keyed on the current code, so editing a shader's replacementCode
 * invalidates it — the same contract getShaderAnalysis() uses.
 *
 * @param {Object} shaderModule
 * @returns {{entries: Array, warnings: string[], weights: Object}}
 */
export function getShaderCostTree(shaderModule) {
  const code = shaderModule?.code ?? "";
  if (shaderModule._costTree && shaderModule._costTreeCode === code) {
    return shaderModule._costTree;
  }
  let result;
  try {
    result = buildShaderCostTree(code);
  } catch (e) {
    result = { entries: [], warnings: [`Cost model failed: ${e}`], weights: DefaultCostWeights };
  }
  shaderModule._costTree = result;
  shaderModule._costTreeCode = code;
  return result;
}

/**
 * Pick the cost-model entry matching a pipeline stage's entry point. WebGPU
 * allows omitting entryPoint when the stage has exactly one candidate, so an
 * unnamed entry point only resolves in that case.
 * @returns {Object|null}
 */
export function findCostEntry(costTree, stage, entryPoint) {
  const candidates = costTree.entries.filter((e) => e.stage === stage);
  if (!candidates.length) {
    return null;
  }
  if (entryPoint) {
    return candidates.find((e) => e.name === entryPoint) ?? null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}
