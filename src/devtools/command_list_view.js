// Shared rendering of a WebGPU command list: pass grouping (render/compute/bundle), debug-group
// nesting, and per-command rows. Used by both the Capture panel and the Recorder panel so the two
// don't duplicate the (large) command-rendering logic. Panel-specific behavior is injected via an
// adapter object; see CommandListAdapter below.

import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";

const _debugGroupColors = [
  ["capture_debugGroup_header1", "capture_debugGroup1"],
  ["capture_debugGroup_header2", "capture_debugGroup2"],
  ["capture_debugGroup_header3", "capture_debugGroup3"],
  ["capture_debugGroup_header4", "capture_debugGroup4"],
  ["capture_debugGroup_header5", "capture_debugGroup5"],
];

/**
 * @typedef {Object} CommandListAdapter
 * @property {function(id, className):string} getDisplayName - Object reference -> display string.
 * @property {function(command, commandIndex, widget):void} onSelectCommand - Row click handler.
 * @property {function(command, commandIndex):void} [onCommandRendered] - Per-command side effects
 *           (capture: object capture + stats). Called once for each rendered command, before the
 *           empty-debug-group skip.
 * @property {boolean} [supportsRenderBundles] - Enables render-bundle passes + executeBundles expansion.
 * @property {function(bundleId):Array|null} [getBundleCommands] - Subcommands for a render bundle.
 * @property {function(kind, passIndex, command, baseText):string} [decoratePassHeaderText] - Append
 *           label/duration to a pass header. kind is "render" | "compute" | "bundle".
 * @property {boolean} [autoSelectFirst] - Click the first rendered command after building.
 * @property {boolean} [multiSelect] - When true, onSelectCommand receives the click event and the
 *           adapter owns selection highlighting (the built-in single-highlight is skipped).
 * @property {function(command):boolean} [getDisabledState] - When provided, each row renders an
 *           enable/disable checkbox reflecting !disabled, and disabled rows get a dimmed style.
 * @property {function(command, commandIndex, enabled):void} [onToggleDisabled] - Checkbox handler.
 * @property {function(command):boolean} [isToggleLocked] - When true, the row's checkbox is shown
 *           disabled (the command can't be enabled/disabled).
 * @property {function(command, commandIndex, widget, event):void} [onCommandContextMenu] - Row
 *           right-click handler.
 */

/**
 * Create an enable/disable checkbox for a command and register it on the command so the panel can
 * keep all of a command's checkboxes (its row and, for a pass, its group header) in sync.
 * @param {CommandListAdapter} adapter
 * @param {Object} command
 * @param {number} commandIndex
 * @param {Widget} parentWidget - Widget to append the checkbox into.
 * @returns {HTMLInputElement}
 */
function _createToggleCheckbox(adapter, command, commandIndex, parentWidget) {
  const toggle = new Span(parentWidget, { class: "capture_command_toggle" });
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = !adapter.getDisabledState(command);
  // Protected commands (device/queue setup) can't be disabled — lock the checkbox.
  const locked = adapter.isToggleLocked && adapter.isToggleLocked(command);
  checkbox.disabled = !!locked;
  checkbox.title = locked ? "This command can't be disabled" : "Enable/disable this command";
  // Don't let the checkbox's own click bubble to the row-select / header-collapse handlers.
  checkbox.addEventListener("click", (e) => { e.stopPropagation(); });
  checkbox.addEventListener("change", (e) => {
    e.stopPropagation();
    adapter.onToggleDisabled(command, commandIndex, checkbox.checked);
  });
  toggle.element.appendChild(checkbox);
  if (!command._toggleCheckboxes) {
    command._toggleCheckboxes = [];
  }
  command._toggleCheckboxes.push(checkbox);
  return checkbox;
}

/**
 * Render a pass-grouped command list into `parent`.
 * @param {Widget} parent - Container to append the command frame into.
 * @param {Array<Object>} commands - The command records.
 * @param {CommandListAdapter} adapter
 * @param {{lastSelectedCommand: ?Widget}} [selectionState] - Mutable selection holder. Capture passes
 *        its per-tab state object so highlight survives tab switches; recorder passes a fresh object.
 * @returns {{frameContents: Widget, passEncoderCommands: Map, firstCommandWidget: ?Widget}}
 */
export function renderCommandList(parent, commands, adapter, selectionState) {
  selectionState = selectionState || { lastSelectedCommand: null };
  const getName = adapter.getDisplayName;
  const supportsRenderBundles = !!adapter.supportsRenderBundles;
  const decoratePassHeaderText = adapter.decoratePassHeaderText || ((kind, passIndex, command, baseText) => baseText);

  const frameContents = new Div(parent, { class: "capture_frame" });

  const debugGroupStack = [frameContents];
  const debugGroupLabelStack = [];
  let debugGroupIndex = 0;

  let currentBlock = new Div(frameContents, { class: "capture_commandBlock" });

  const passEncoderCommands = new Map();
  let nestedDebugGroup = 0;
  let firstCommandWidget = null;

  // Builds a single command row. Declared here so it can capture the adapter/selection and recurse
  // into render-bundle subcommands.
  function createCommandWidget(parentBlock, commandIndex, command, cmdType) {
    const method = command.method;
    const args = command.args;
    const cmd = new Div(parentBlock, { id: `CaptureCommand_${commandIndex}`, class: cmdType });

    if (method === "end") {
      cmd.element.id = `Pass_${parentBlock._passIndex}_end`;
    } else if (method === "beginRenderPass") {
      cmd.element.id = `RenderPass_${parentBlock._passIndex}_begin`;
    }

    command.widget = cmd;

    // Optional per-command enable/disable checkbox (Recorder panel). Absent for the Capture panel,
    // which doesn't provide getDisabledState, so its rows are unchanged.
    if (adapter.getDisabledState) {
      _createToggleCheckbox(adapter, command, commandIndex, cmd);
      if (adapter.getDisabledState(command)) {
        cmd.classList.add("capture_command_disabled");
      }
    }

    let expandButton = null;
    if (supportsRenderBundles && method === "executeBundles") {
      cmd.style.paddingLeft = "0px";
      expandButton = new Span(cmd, { class: "expand_button", text: "+" });
      expandButton.element.onclick = () => {
        if (expandButton.panel) {
          expandButton.panel.element.classList.toggle("collapsed");
          if (expandButton.panel.element.classList.contains("collapsed")) {
            expandButton.text = "+";
          } else {
            expandButton.text = "-";
          }
        }
      };
    }

    new Span(cmd, { class: "capture_callnum", text: `${commandIndex}.` });

    new Span(cmd, { class: "capture_methodName", text: `${method}` });

    if (supportsRenderBundles && method === "executeBundles") {
      const bundleNames = [];
      for (const bundle of args[0]) {
        bundleNames.push(getName(bundle.__id, "GPURenderBundle"));
      }
      new Span(cmd, { class: "capture_method_args", text: `bundles:[${bundleNames.join(", ")}]` });

      expandButton.panel = new Div(parentBlock, { class: ["collapsed"] });
      let ci = 0;
      for (const bundle of args[0]) {
        const name = getName(bundle.__id, "GPURenderBundle");
        const bundleButton = new Div(expandButton.panel, { class: "capture_renderbundle_header", text: `- ${name}`, style: "margin-left: 20px; margin-bottom: 0px; border-radius: 5px 5px 0px 0px; line-height: 20px;" });
        const bundleGrp = new Div(expandButton.panel, { class: ["render_bundle_group"] });
        bundleButton.element.onclick = () => {
          bundleGrp.element.classList.toggle("collapsed");
          if (bundleGrp.element.classList.contains("collapsed")) {
            bundleButton.text = `+ ${name}`;
          } else {
            bundleButton.text = `- ${name}`;
          }
        };

        const bundleCommands = adapter.getBundleCommands ? adapter.getBundleCommands(bundle.__id) : null;
        if (bundleCommands) {
          for (const bndCommand of bundleCommands) {
            createCommandWidget(bundleGrp, ci++, bndCommand, ["capture_command"]);
          }
        }
      }
    } else if (method === "requestAdapter") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUAdapter")}` });
    } else if (method === "requestDevice") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUAdapter")} => ${getName(command.result, "GPUDevice")}` });
    } else if (method === "createRenderPipeline") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.result, "GPURenderPipeline")}` });
    } else if (method === "getBindGroupLayout") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPipeline")} => ${getName(command.result, "GPUBindGroupLayout")}` });
    } else if (method === "createComputePipeline") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUComputePipeline")}` });
    } else if (method === "createBindGroup") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUBindGroup")}` });
    } else if (method === "createBindGroupLayout") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUBindGroupLayout")}` });
    } else if (method === "createPipelineLayout") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUPipelineLayout")}` });
    } else if (method === "createShaderModule") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUShaderModule")}` });
    } else if (method === "createTexture") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUTexture")}` });
    } else if (method === "createSampler") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUSampler")}` });
    } else if (method === "createCommandEncoder") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUCommandEncoder")}` });
    } else if (method === "finish") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)} => ${getName(command.result, "GPUCommandBuffer")}` });
    } if (method === "getMappedRange") {
      new Span(cmd, { class: "capture_method_args", text: getName(command.object, "GPUBuffer") });
    } else if (method === "unmap") {
      new Span(cmd, { class: "capture_method_args", text: getName(command.object, "GPUBuffer") });
    } else if (method === "copyBufferToBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0]?.__id, "GPUBuffer")} srcOffset:${args[1]} dest:${getName(args[2]?.__id, "GPUBuffer")} destOffset:${args[3]} size:${args[4]}` });
    } else if (method === "clearBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0]?.__id, "GPUBuffer")} offset:${args[1]} size:${args[4]}` });
    } else if (method === "copyBufferToTexture") {
      new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0]?.buffer?.__id, "GPUBuffer")} texture:${getName(args[1]?.texture?.__id, "GPUTexture")}` });
    } else if (method === "copyTextureToBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `texture:${getName(args[0]?.texture?.__id, "GPUBuffer")} buffer:${getName(args[1]?.buffer?.__id, "GPUTexture")}` });
    } else if (method === "copyTextureToTexture") {
      new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0]?.texture.__id, "GPUTexture")} dest:${getName(args[1]?.texture.__id, "GPUTexture")}` });
    } else if (method === "setViewport") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]} minZ:${args[4]} maxZ:${args[5]}` });
    } else if (method === "setScissorRect") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]}` });
    } else if (method === "setStencilReference") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} reference:${args[0]}` });
    } else if (method === "setBindGroup") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} index:${args[0]} bindGroup:${getName(args[1]?.__id, "GPUBindGroup")}` });
    } else if (method === "writeBuffer") {
      const data = args[2];
      if (data.constructor === String) {
        const s = data.split(" ")[2];
        new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0]?.__id, "GPUBuffer")} offset:${args[1]} data:${s} Bytes` });
      } else {
        new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0]?.__id, "GPUBuffer")} offset:${args[1]} data:${args[2]?.length} Bytes` });
      }
    } else if (method === "setPipeline") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} renderPipeline:${getName(args[0]?.__id, "GPURenderPipeline")}` });
    } else if (method === "setVertexBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} slot:${args[0]} buffer:${getName(args[1]?.__id, "GPUBuffer")} offset:${args[2] ?? 0}` });
    } else if (method === "setIndexBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} buffer:${getName(args[0]?.__id, "GPUBuffer")} indexFormat:${args[1]} offset:${args[2] ?? 0}` });
    } else if (method === "drawIndexed") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} indexCount:${args[0]} instanceCount:${args[1] ?? 1} firstIndex:${args[2] ?? 0} baseVertex:${args[3] ?? 0} firstInstance:${args[4] ?? 0}` });
    } else if (method === "draw") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} vertexCount:${args[0]} instanceCount:${args[1] ?? 1} firstVertex:${args[2] ?? 0} firstInstance:${args[3] ?? 0}` });
    } else if (method === "drawIndirect") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} indirectBuffer:${getName(args[0]?.__id, "GPUBuffer")} offset:${args[1]}` });
    } else if (method === "drawIndexedIndirect") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} indirectBuffer:${getName(args[0]?.__id, "GPUBuffer")} offset:${args[1]}` });
    } else if (method === "dispatchWorkgroups") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} countX:${args[0]} countY:${args[1] ?? 1} countZ:${args[2] ?? 1}` });
    } else if (method === "dispatchWorkgroupsIndirect") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUPassEncoder")} indirectBuffer:${getName(args[0]?.__id, "GPUBuffer")} offset:${args[1]}` });
    } else if (method === "pushDebugGroup") {
      debugGroupLabelStack.push(args[0]);
      new Span(cmd, { class: "capture_method_args", text: args[0] });
    } else if (method === "popDebugGroup") {
      const label = debugGroupLabelStack.pop();
      new Span(cmd, { class: "capture_method_args", text: label });
    } else if (method === "createView") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, "GPUTexture")} => ${getName(command.result, "GPUTextureView")}` });
    } else if (method === "beginRenderPass") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)} => ${getName(command.result, "GPURenderPassEncoder")}` });
    } else if (method === "beginComputePass") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)} => ${getName(command.result, "GPUComputePassEncoder")}` });
    } else if (method === "end") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)}` });
    } else if (method === "createBuffer") {
      new Span(cmd, { class: "capture_method_args", text: `size:${args[0]?.size} usage:${args[0]?.usage} mappedAtCreation:${args[0]?.mappedAtCreation ?? false} => ${getName(command.result, "GPUBuffer")}` });
    } else if (method === "writeTexture") {
      new Span(cmd, { class: "capture_method_args", text: `dest:${getName(args[0]?.texture.__id, "GPUTexture")}` });
    } else if (method === "destroy") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)}` });
    } else if (method === "mapAsync") {
      new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)} mode:${args[0]}` });
    } else if (method === "getCurrentTexture") {
      new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUTexture")}` });
    } else if (method === "submit") {
      let buffers = "[";
      for (const buffer of args[0]) {
        if (buffers !== "[") {
          buffers += ", ";
        }
        buffers += `${getName(buffer.__id, "GPUCommandBuffer")}`;
      }
      buffers += "]";
      new Span(cmd, { class: "capture_method_args", text: `=> ${buffers}` });
    } else if (method === "configure") {
      new Span(cmd, { class: "capture_method_args", text: `device:${getName(args[0]?.device?.__id, "GPUDevice")} format:${args[0]?.format} usage:${args[0]?.usage}` });
    }

    cmd.element.onclick = (e) => {
      // Multi-select adapters (Recorder) manage selection highlighting themselves, including
      // ctrl/shift modifiers, so the built-in single-highlight is bypassed.
      if (adapter.multiSelect) {
        adapter.onSelectCommand(command, commandIndex, cmd, e);
        return;
      }
      if (selectionState.lastSelectedCommand !== cmd) {
        if (selectionState.lastSelectedCommand) {
          selectionState.lastSelectedCommand.classList.remove("capture_command_selected");
        }
        cmd.classList.add("capture_command_selected");
        selectionState.lastSelectedCommand = cmd;
      }
      adapter.onSelectCommand(command, commandIndex, cmd);
    };

    if (adapter.onCommandContextMenu) {
      cmd.element.oncontextmenu = (e) => {
        e.preventDefault();
        adapter.onCommandContextMenu(command, commandIndex, cmd, e);
      };
    }

    return cmd;
  }

  // Pass index is based on end, not begin, so prepare the pass index map first.
  const passEncoderMap = new Map();
  let renderPassIndex = 0;
  let computePassIndex = 0;
  let renderBundleIndex = 0;
  for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
    const command = commands[commandIndex];
    if (!command) {
      continue;
    }
    command.id = commandIndex;
    const method = command.method;
    if (method === "beginRenderPass") {
      passEncoderMap.set(command.result, -1);
    } else if (method === "beginComputePass") {
      passEncoderMap.set(command.result, -2);
    } else if (method === "end") {
      const type = passEncoderMap.get(command.object);
      if (type === -1) {
        passEncoderMap.set(command.object, renderPassIndex++);
      } else if (type === -2) {
        passEncoderMap.set(command.object, computePassIndex++);
      }
    } else if (supportsRenderBundles && method === "createRenderBundleEncoder") {
      passEncoderMap.set(command.result, -3);
    } else if (supportsRenderBundles && method === "finish") {
      const type = passEncoderMap.get(command.object);
      if (type === -3) {
        passEncoderMap.set(command.object, renderBundleIndex++);
      }
    }
  }

  for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
    const command = commands[commandIndex];
    if (!command) {
      break;
    }
    const method = command.method;
    const args = command.args;

    if (adapter.onCommandRendered) {
      adapter.onCommandRendered(command, commandIndex);
    }

    // skip empty debug groups
    if (method === "pushDebugGroup") {
      let index = commandIndex + 1;
      let nextCommand = commands[index];
      let found = false;
      let nestedGroup = 1;
      while (nextCommand) {
        const nextMethod = nextCommand.method;
        if (nextMethod === "pushDebugGroup") {
          nestedGroup++;
        } else if (nextMethod === "popDebugGroup") {
          nestedGroup--;
          if (nestedGroup === 0) {
            break;
          }
        } else {
          found = true;
          break;
        }
        index++;
        nextCommand = commands[index];
      }

      if (!found) {
        commandIndex = index;
        continue;
      }
    }

    let debugGroup = debugGroupStack[debugGroupStack.length - 1];

    if (method === "beginRenderPass") {
      const passIndex = passEncoderMap.get(command.result);

      passEncoderCommands.set(command.result, [command]);

      command._passIndex = passIndex;
      if (!currentBlock.children.length) {
        currentBlock.remove();
      }
      currentBlock = new Div(debugGroup, { class: "capture_renderpass" });

      const header = new Div(currentBlock, { id: `RenderPass_${passIndex}`, class: "capture_renderpass_header" });
      // Pass-level enable/disable checkbox reflecting the beginRenderPass command (Recorder panel).
      if (adapter.getDisabledState) {
        _createToggleCheckbox(adapter, command, commandIndex, header);
      }
      const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
      const headerText = decoratePassHeaderText("render", passIndex, command, `Render Pass ${passIndex}`);
      command.header = new Span(header, { text: headerText });
      const extra = new Span(header, { style: "margin-left: 10px;" });
      const block = new Div(currentBlock, { class: "capture_renderpass_block" });
      header.element.onclick = () => {
        block.element.classList.toggle("collapsed");
        if (block.element.classList.contains("collapsed")) {
          headerIcon.text = "+";
          extra.text = "...";
        } else {
          headerIcon.text = "-";
          extra.text = "";
        }
      };
      currentBlock = block;
      currentBlock._passIndex = passIndex;
    } else if (method === "beginComputePass") {
      const passIndex = passEncoderMap.get(command.result);

      passEncoderCommands.set(command.result, [command]);

      command._passIndex = passIndex;
      if (!currentBlock.children.length) {
        currentBlock.remove();
      }
      currentBlock = new Div(debugGroup, { class: "capture_computepass" });
      const header = new Div(currentBlock, { id: `ComputePass_${passIndex}`, class: "capture_computepass_header" });
      // Pass-level enable/disable checkbox reflecting the beginComputePass command (Recorder panel).
      if (adapter.getDisabledState) {
        _createToggleCheckbox(adapter, command, commandIndex, header);
      }
      const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
      const computeHeaderText = decoratePassHeaderText("compute", passIndex, command, `Compute Pass ${passIndex}`);
      command.header = new Span(header, { text: computeHeaderText });
      const extra = new Span(header, { style: "margin-left: 10px;" });
      const block = new Div(currentBlock);
      header.element.onclick = () => {
        block.element.classList.toggle("collapsed");
        if (block.element.classList.contains("collapsed")) {
          headerIcon.text = "+";
          extra.text = "...";
        } else {
          headerIcon.text = "-";
          extra.text = "";
        }
      };
      currentBlock = block;
      currentBlock._passIndex = passIndex;
    } else if (supportsRenderBundles && method === "createRenderBundleEncoder") {
      const passIndex = command.result.__id ?? passEncoderMap.get(command.result);

      passEncoderCommands.set(command.result, [command]);

      command._passIndex = passIndex;
      if (!currentBlock.children.length) {
        currentBlock.remove();
      }
      currentBlock = new Div(debugGroup, { class: "capture_renderbundle" });
      const header = new Div(currentBlock, { id: `RenderBundle_${passIndex}`, class: "capture_renderbundle_header" });
      const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
      command.header = new Span(header, { text: decoratePassHeaderText("bundle", passIndex, command, `Render Bundle ${passIndex}`) });
      const extra = new Span(header, { style: "margin-left: 10px;" });
      const block = new Div(currentBlock);
      header.element.onclick = () => {
        block.element.classList.toggle("collapsed");
        if (block.element.classList.contains("collapsed")) {
          headerIcon.text = "+";
          extra.text = "...";
        } else {
          headerIcon.text = "-";
          extra.text = "";
        }
      };
      currentBlock = block;
      currentBlock._passIndex = passIndex;
      currentBlock._object = command.result;
    } else if (method === "popDebugGroup") {
      debugGroupStack.pop();
      debugGroup = debugGroupStack[debugGroupStack.length - 1];
      if (!currentBlock.children.length) {
        currentBlock.remove();
      }
      currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
    } else if (method !== "pushDebugGroup") {
      const object = command.object;
      const commandArray = passEncoderCommands.get(object);
      if (commandArray) {
        commandArray.push(command);
      }

      if (passEncoderMap.has(object)) {
        const passIndex = passEncoderMap.get(object);
        if (currentBlock._passIndex !== passIndex) {
          if (!currentBlock.children.length) {
            currentBlock.remove();
          }
          currentBlock = new Div(debugGroup, { class: "capture_renderpass", style: "margin-top: 5px;" });

          const header = new Div(currentBlock, { id: `RenderPass_${passIndex}`, class: "capture_renderpass_header", style: "display: none;" });
          const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
          new Span(header, { text: `Render Pass ${passIndex}` });
          const extra = new Span(header, { style: "margin-left: 10px;" });
          const block = new Div(currentBlock, { class: "capture_renderpass_block" });
          header.element.onclick = () => {
            block.element.classList.toggle("collapsed");
            if (block.element.classList.contains("collapsed")) {
              headerIcon.text = "+";
              extra.text = "...";
            } else {
              headerIcon.text = "-";
              extra.text = "";
            }
          };
          currentBlock = block;
          currentBlock._passIndex = passIndex;
        }
      }
    }

    const cmdType = ["capture_command"];
    if (method === "draw" || method === "drawIndexed" || method === "drawIndirect" || method === "drawIndexedIndirect" ||
        method === "dispatchWorkgroups" || method == "dispatchWorkgroupsIndirect") {
      cmdType.push("capture_drawcall");
    }

    const skipCommand = method === "pushDebugGroup" || method === "popDebugGroup";

    if (!skipCommand) {
      const cmd = createCommandWidget(currentBlock, commandIndex, command, cmdType);
      if (!firstCommandWidget) {
        firstCommandWidget = cmd;
      }
    }

    if (method === "pushDebugGroup") {
      const grpIndex = _debugGroupColors[nestedDebugGroup % 5];
      const grpClass = ["capture_debugGroup", grpIndex[1]];
      const hdrClass = ["capture_debugGroup_header", grpIndex[0]];

      const header = new Div(debugGroup, { id: `DebugGroup_${debugGroupIndex}`, class: hdrClass });

      const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;" });
      new Span(header, { text: `${args[0]}` });
      const extra = new Span(header, { style: "margin-left: 10px;" });

      const grp = new Div(debugGroup, { class: grpClass });

      nestedDebugGroup++;

      debugGroupStack.push(grp);
      debugGroupIndex++;
      debugGroup = grp;
      header.element.onclick = () => {
        grp.element.classList.toggle("collapsed");
        if (grp.element.classList.contains("collapsed")) {
          headerIcon.text = "+";
          extra.text = "...";
        } else {
          headerIcon.text = "-";
          extra.text = "";
        }
      };
      if (!currentBlock.children.length) {
        currentBlock.remove();
      }
      currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
    }

    if (method == "popDebugGroup") {
      nestedDebugGroup--;
    }

    if (method === "end") {
      if (!currentBlock.children.length) {
        currentBlock.remove();
      }
      currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
    }

    if (supportsRenderBundles && method === "finish" && command.object === currentBlock._object) {
      if (!currentBlock.children.length) {
        currentBlock.remove();
      }
      currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
    }
  }

  if (adapter.autoSelectFirst && firstCommandWidget) {
    firstCommandWidget.element.click();
  }

  return { frameContents, passEncoderCommands, firstCommandWidget };
}
