// Shared rendering of WebGPU command arguments and lightweight command summaries.
// Used by both the Capture panel (capture_panel.js) and the Recorder panel (recorder_panel.js)
// so the two don't duplicate the argument-formatting logic. The only capture/recorder difference
// is object name resolution, which is injected via a getObject(id) callback.

import { collapsible } from "./widget/collapsible.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Widget } from "./widget/widget.js";
import { Input } from "./widget/input.js";

// Argument name labels per method, used to annotate the formatted Arguments list.
// Moved verbatim from CapturePanel._commandArgs.
export const commandArgs = {
  "beginComputePass": ["descriptor"],
  "beginOcclusionQuery": ["queryIndex"],
  "beginRenderPass": ["descriptor"],
  "configure": ["configuration"],
  "clearBuffer": ["buffer", "offset", "size"],
  "copyBufferToBuffer": ["source", "sourceOffset", "destination", "destinationOffset", "size"],
  "copyBufferToTexture": ["source", "destination", "copySize"],
  "copyTextureToBuffer": ["source", "destination", "copySize"],
  "copyTextureToTexture": ["source", "destination", "copySize"],
  "createBindGroup": ["descriptor"],
  "createBindGroupLayout": ["descriptor"],
  "createBuffer": ["descriptor"],
  "createCommandEncoder": ["descriptor"],
  "createComputePipeline": ["descriptor"],
  "createComputePipelineAsync": ["descriptor"],
  "createPipelineLayout": ["descriptor"],
  "createQuerySet": ["descriptor"],
  "createRenderBundleEncoder": ["descriptor"],
  "createRenderPipeline": ["descriptor"],
  "createRenderPipelineAsync": ["descriptor"],
  "createSampler": ["descriptor"],
  "createShaderModule": ["descriptor"],
  "createTexture": ["descriptor"],
  "createView": ["descriptor"],
  "destroy": [],
  "dispatchWorkgroups": ["workgroupCountX", "workgroupCountY", "workgroupCountZ"],
  "dispatchWorkgroupsIndirect": ["indirectBuffer", "indirectOffset"],
  "draw": ["vertexCount", "instanceCount", "firstVertex", "firstInstance"],
  "drawIndexed": ["indexCount", "instanceCount", "firstIndex", "baseVertex", "firstInstance"],
  "drawIndirect": ["indirectBuffer", "indirectOffset"],
  "drawIndexedIndirect": ["indirectBuffer", "indirectOffset"],
  "end": [],
  "endOcclusionQuery": [],
  "executeBundles": ["bundles"],
  "finish": ["descriptor"],
  "getCompilationInfo": [],
  "getCurrentTexture": [],
  "getMappedRange": ["offset", "size"],
  "importExternalTexture": ["descriptor"],
  "insertDebugMarker": ["markerLabel"],
  "mapAsync": ["mode", "offset", "size"],
  "onSubmittedWorkDone": ["workDonePromise", "callback"],
  "pushDebugGroup": ["groupLabel"],
  "popDebugGroup": [],
  "resolveQuerySet": ["querySet", "firstQuery", "queryCount", "destination", "destinationOffset"],
  "setBindGroup": ["index", "bindGroup", "dynamicOffsets"],
  "setBlendColor": ["color"],
  "setIndexBuffer": ["buffer", "indexFormat", "offset", "size"],
  "setVertexBuffer": ["slot", "buffer", "offset", "size"],
  "setPipeline": ["pipeline"],
  "setScissorRect": ["x", "y", "width", "height"],
  "setStencilReference": ["reference"],
  "setViewport": ["x", "y", "width", "height", "minDepth", "maxDepth"],
  "submit": ["commandBuffers"],
  "unmap": [],
  "writeBuffer": ["buffer", "bufferOffset", "data", "dataOffset", "size"],
  "writeTexture": ["destination", "data", "dataLayout", "size", "bytesPerRow"],
  "copyExternalImageToTexture": ["source", "destination", "copySize"],
};

/**
 * Recursively replace object references (`{__id}`) in a command's arguments with a readable string,
 * so the arguments can be JSON-stringified for display.
 * @param {*} object - The argument value (may be an array/object tree).
 * @param {function(id):Object|null} getObject - Resolves an id to its tracked object (or null).
 * @returns {*} A display-safe copy with object references stringified.
 */
export function processCommandArgs(object, getObject) {
  if (!object) {
    return object;
  }
  if (object.__id !== undefined) {
    const obj = getObject ? getObject(object.__id) : null;
    if (obj) {
      return `${obj.constructor.className} ID:${object.__id}`;
    }
    return `${object.__class || "Object"}.${object.__id}`;
  }
  if (object instanceof Array) {
    const newArray = [];
    for (const i in object) {
      newArray[i] = processCommandArgs(object[i], getObject);
    }
    return newArray;
  }
  if (object instanceof Object) {
    const newObject = {};
    for (const key in object) {
      newObject[key] = processCommandArgs(object[key], getObject);
    }
    return newObject;
  }
  return object;
}

/**
 * Render the collapsible "Arguments" section for a command into the given container.
 * @param {Widget} commandInfo - Parent widget to append into.
 * @param {*} args - The command's raw arguments.
 * @param {string} method - The command method name (selects argument labels).
 * @param {function(id):Object|null} getObject - Object resolver for processCommandArgs.
 */
export function renderArgumentsSection(commandInfo, args, method, getObject) {
  const argsGroup = new collapsible(commandInfo, { label: "Arguments" });
  const newArgs = processCommandArgs(args, getObject);
  const names = commandArgs[method];
  if (names && Array.isArray(newArgs)) {
    for (let i = 0, l = newArgs.length; i < l; ++i) {
      const arg = names[i];
      const value = newArgs[i];
      const valueStr = value instanceof Array ? `[${value.length}]: ${value}` : JSON.stringify(value, undefined, 4);
      if (arg !== undefined) {
        new Widget("pre", argsGroup.body, { text: `${arg}: ${valueStr}`, style: "margin-left: 10px; font-size: 10pt;" });
      } else {
        new Widget("pre", argsGroup.body, { text: `[${i}]: ${valueStr}`, style: "margin-left: 10px; font-size: 10pt;" });
      }
    }
  } else {
    new Widget("pre", argsGroup.body, { text: JSON.stringify(newArgs, undefined, 4), style: "font-size: 10pt;" });
  }
}

/**
 * Render an editable field for a single top-level argument and commit changes via `commit`.
 * Scalars (number/string/boolean) edit inline; objects/arrays edit as a small JSON box (so object
 * references like {__id} and data markers like {__data} round-trip). `commit(newValue)` is only
 * called when the value actually changes.
 */
function _renderEditableArg(parent, label, value, commit) {
  const row = new Div(parent, { class: "recorder_arg_row" });
  new Span(row, { class: "recorder_arg_label", text: `${label}:` });
  const type = typeof value;

  if (type === "boolean") {
    const input = new Input(row, { type: "checkbox", class: "recorder_arg_checkbox" });
    input.checked = value;
    input.element.addEventListener("change", () => {
      if (input.checked !== value) {
        commit(input.checked);
      }
    });
    return;
  }

  if (type === "number" || type === "string") {
    const input = new Input(row, { type: "text", class: "recorder_arg_input" });
    input.value = String(value);
    const commitValue = () => {
      let v = input.value;
      if (type === "number") {
        const n = Number(v);
        if (v.trim() === "" || Number.isNaN(n)) {
          // Reject a non-numeric edit and restore the previous value.
          input.value = String(value);
          input.element.classList.remove("recorder_arg_error");
          return;
        }
        v = n;
      }
      input.element.classList.remove("recorder_arg_error");
      if (v !== value) {
        commit(v);
      }
    };
    input.element.addEventListener("blur", commitValue);
    input.element.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.element.blur();
      }
    });
    return;
  }

  // Objects, arrays, null: edit as JSON.
  const textarea = new Widget("textarea", row, { class: "recorder_arg_json" });
  const original = JSON.stringify(value, undefined, 2);
  textarea.element.value = original;
  textarea.element.spellcheck = false;
  textarea.element.addEventListener("blur", () => {
    const text = textarea.element.value;
    if (text === original) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      textarea.element.classList.add("recorder_arg_error");
      return;
    }
    textarea.element.classList.remove("recorder_arg_error");
    commit(parsed);
  });
}

/**
 * Render an editable "Arguments" section for a command (Recorder panel). Each top-level argument
 * gets an inline editor; committing a change calls `onEdit(argIndex, newValue)`. Raw argument
 * values are shown (object/data references preserved) so edits round-trip back into the recording.
 * @param {Widget} commandInfo - Parent widget to append into.
 * @param {Object} command - The command record (uses command.method and command.args).
 * @param {function(argIndex, newValue):void} onEdit - Commit handler for a changed argument.
 */
export function renderEditableArgumentsSection(commandInfo, command, onEdit) {
  const argsGroup = new collapsible(commandInfo, { label: "Arguments" });
  const method = command.method;
  const rawArgs = command.args;
  const names = commandArgs[method];

  if (!Array.isArray(rawArgs)) {
    // Non-array args are rare; show them read-only rather than risk a lossy edit.
    new Widget("pre", argsGroup.body, { text: JSON.stringify(rawArgs, undefined, 4), style: "font-size: 10pt;" });
    return;
  }

  if (rawArgs.length === 0) {
    new Div(argsGroup.body, { text: "(none)", style: "margin-left: 10px; font-size: 10pt; opacity: 0.6;" });
    return;
  }

  for (let i = 0; i < rawArgs.length; ++i) {
    const label = (names && names[i] !== undefined) ? names[i] : `[${i}]`;
    _renderEditableArg(argsGroup.body, label, rawArgs[i], (newValue) => onEdit(i, newValue));
  }
}

/**
 * Render lightweight per-command summaries (render-pass attachment formats, draw primitive counts).
 * The capture-database-dependent lookups are injected so this works for both panels.
 * @param {Widget} commandInfo - Parent widget to append into.
 * @param {Object} command - The command record.
 * @param {Object} hooks
 * @param {function(attachment):string|null} [hooks.getAttachmentFormat] - "format resolution" string, or null.
 * @param {function(command):string|null} [hooks.getDrawTopology] - Primitive topology, or null to skip.
 */
export function renderCommandSummary(commandInfo, command, hooks) {
  const method = command.method;
  const args = command.args;
  const getAttachmentFormat = hooks?.getAttachmentFormat;
  const getDrawTopology = hooks?.getDrawTopology;

  if (method === "beginRenderPass") {
    if (!getAttachmentFormat) {
      return;
    }
    const desc = args?.[0];
    if (!desc) {
      return;
    }
    const attachments = new Div(commandInfo, { style: "margin-top: 10px; margin-bottom: 10px; font-size: 10pt;" });
    const colorAttachments = desc.colorAttachments || [];
    for (const i in colorAttachments) {
      const info = getAttachmentFormat(colorAttachments[i]);
      if (info) {
        new Div(attachments, { text: `Color ${i}: ${info}`, class: "bg-info pl-xl lh-md" });
      }
    }
    if (desc.depthStencilAttachment) {
      const info = getAttachmentFormat(desc.depthStencilAttachment);
      if (info) {
        new Div(attachments, { text: `Depth-Stencil: ${info}`, class: "bg-info pl-xl lh-md" });
      }
    }
  } else if (method === "draw" || method === "drawIndexed" || method === "drawIndirect" || method === "drawIndexedIndirect") {
    if (!getDrawTopology) {
      return;
    }
    const topology = getDrawTopology(command);
    if (!topology) {
      return;
    }

    let vertexCount;
    if (method === "drawIndirect" || method === "drawIndexedIndirect") {
      // Indirect counts live in the (capture-only) read-back indirect buffer data.
      if (command.isBufferDataLoaded && command.bufferData) {
        const bufferData = command.bufferData[0];
        if (bufferData) {
          vertexCount = new Uint32Array(bufferData.buffer)[0];
        }
      }
    } else {
      vertexCount = args?.[0] ?? 0;
    }

    if (vertexCount === undefined || isNaN(vertexCount)) {
      return;
    }

    let text = null;
    if (topology === "triangle-list") {
      text = `Triangles: ${(vertexCount / 3).toLocaleString("en-US")}`;
    } else if (topology === "triangle-strip") {
      text = `Triangles: ${(vertexCount - 2).toLocaleString("en-US")}`;
    } else if (topology === "point-list") {
      text = `Points: ${(vertexCount).toLocaleString("en-US")}`;
    } else if (topology === "line-list") {
      text = `Lines: ${(vertexCount / 2).toLocaleString("en-US")}`;
    } else if (topology === "line-strip") {
      text = `Lines: ${(vertexCount - 1).toLocaleString("en-US")}`;
    }
    if (text) {
      new Div(commandInfo, { text, class: "bg-info pl-xl lh-md" });
    }
  }
}
