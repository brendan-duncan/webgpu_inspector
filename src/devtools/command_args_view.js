// Shared rendering of WebGPU command arguments and lightweight command summaries.
// Used by both the Capture panel (capture_panel.js) and the Recorder panel (recorder_panel.js)
// so the two don't duplicate the argument-formatting logic. The only capture/recorder difference
// is object name resolution, which is injected via a getObject(id) callback.

import { collapsible } from "./widget/collapsible.js";
import { Div } from "./widget/div.js";
import { Widget } from "./widget/widget.js";

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
