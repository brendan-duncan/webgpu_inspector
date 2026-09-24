/**
 * The render graph of a captured frame: the frame's passes as nodes and the
 * resources they read and write as the edges between them.
 *
 * A capture is a flat list of commands, which says what the frame *did* but
 * not what depends on what. The dependencies are there, spread across three
 * places: a render pass's attachments say what it renders to and whether it
 * loads what was there before, the bind groups bound at each draw and dispatch
 * say what it reads, and the copy commands name a source and a destination.
 * Roll those up per pass and the frame becomes a directed graph, which makes it
 * easy to see that a pass writes something nothing reads, that a result is
 * overwritten before it is used, or where the frame's critical path runs.
 *
 * Two things make it a graph and not just "which passes touched texture 12":
 *
 *   Subresources. Texture edges are keyed on the mip level and array layer a
 *   pass actually touched, not on the texture. A bloom chain writes mip N and
 *   reads mip N-1 of one texture; keyed on the texture alone it would collapse
 *   into a single node with a self-loop.
 *
 *   Versions. A pass that loads an attachment and stores it again both reads
 *   and writes the same resource, so a graph over resources has cycles. Each
 *   write instead starts a new *version* of the resource, and edges run from
 *   the version's producer to its readers. Version 0 is what the resource held
 *   on entry to the capture: reads of it come from a previous frame or a pass
 *   outside the captured range, and are reported as external inputs rather
 *   than as edges. queue.writeBuffer / writeTexture start a host version, which
 *   is likewise an input rather than an edge.
 *
 * Passes are ordered as the GPU runs them — command buffers in submit() order
 * — not as they were recorded, since a frame may encode several command
 * encoders and submit them in a different order.
 *
 * This module is deliberately free of DOM dependencies so it can be unit
 * tested; render_graph_view.js renders what it returns.
 */

const DRAW_METHODS = new Set(["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);
const DISPATCH_METHODS = new Set(["dispatchWorkgroups", "dispatchWorkgroupsIndirect"]);
const TRANSFER_METHODS = new Set(["copyBufferToBuffer", "copyBufferToTexture", "copyTextureToBuffer",
  "copyTextureToTexture", "clearBuffer", "resolveQuerySet"]);
const HOST_WRITE_METHODS = new Set(["writeBuffer", "writeTexture", "copyExternalImageToTexture"]);

// wgsl_reflect ResourceType values.
const RESOURCE_UNIFORM = 0;
const RESOURCE_STORAGE = 1;
const RESOURCE_TEXTURE = 3;
const RESOURCE_STORAGE_TEXTURE = 5;

const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_BUFFER_USAGE_UNIFORM = 0x0040;
const GPU_BUFFER_USAGE_STORAGE = 0x0080;

// A texture view reads every subresource it covers; past this many the edges
// are capped so a huge texture array can't blow up the graph.
const MAX_VIEW_SUBRESOURCES = 256;

/**
 * Walk a capture's command list, in execution order, into one RawPass per
 * render pass, compute pass and encoder-level copy, plus host-write markers.
 *
 * @param {Object[]} commands - the capture's flat command list
 * @param {Object} resolver
 * @param {(id:number)=>Object} resolver.getObject - resolve a captured object id
 * @param {(view:Object)=>Object} [resolver.getTextureFromView] - resolve a TextureView to its Texture
 * @param {(bundleId:number)=>Object[]|null} [resolver.getBundleCommands] - a render bundle's commands
 * @returns {{passes: Object[], warnings: string[]}}
 */
export function collectFramePasses(commands, resolver) {
  const warnings = [];
  const warned = new Set();
  const warn = (message) => {
    if (!warned.has(message)) {
      warned.add(message);
      warnings.push(message);
    }
  };
  const ctx = new _Resolver(resolver, warn);

  const passes = [];
  let current = null;
  let renderIndex = 0;
  let computeIndex = 0;
  // Debug groups pushed on the command encoder name the passes inside them
  // when the pass itself has no label.
  const groupStack = [];

  const finishPass = () => {
    if (current) {
      current.accesses = _mergeAccesses(current.accesses);
      passes.push(current);
      current = null;
    }
  };

  for (const { command, index } of executionOrder(commands, warn)) {
    const method = command.method;
    const args = command.args ?? [];

    if (method === "beginRenderPass" || method === "beginComputePass") {
      finishPass();
      const render = method === "beginRenderPass";
      const passLabel = args[0]?.label;
      const fallback = render ? `Render Pass ${renderIndex}` : `Compute Pass ${computeIndex}`;
      const group = groupStack.length ? groupStack[groupStack.length - 1] : null;
      current = {
        kind: render ? "render" : "compute",
        label: passLabel || (group ? `${group} (${fallback})` : fallback),
        command,
        commandIndex: index,
        durationMs: typeof command.duration === "number" ? command.duration : null,
        draws: 0,
        accesses: [],
        unresolvedReads: 0,
        state: _newPassState(),
      };
      if (render) {
        renderIndex++;
        ctx.addAttachmentAccesses(current, args[0]);
      } else {
        computeIndex++;
      }
      continue;
    }

    if (current) {
      if (method === "end") {
        finishPass();
        continue;
      }
      _applyPassCommand(ctx, current, current.state, command);
      if (method === "executeBundles") {
        for (const ref of args[0] ?? []) {
          const bundleCommands = ctx.getBundleCommands(ref?.__id);
          if (!bundleCommands) {
            warn("A render bundle's commands are not in the capture, so what its draws read is missing from the graph.");
            continue;
          }
          // A bundle starts from empty state and leaves the pass's state cleared.
          const bundleState = _newPassState();
          for (const bundleCommand of bundleCommands) {
            _applyPassCommand(ctx, current, bundleState, bundleCommand);
          }
        }
        current.state = _newPassState();
      }
      continue;
    }

    if (method === "pushDebugGroup" && command.class === "GPUCommandEncoder") {
      groupStack.push(args[0]);
      continue;
    }
    if (method === "popDebugGroup" && command.class === "GPUCommandEncoder") {
      groupStack.pop();
      continue;
    }

    if (TRANSFER_METHODS.has(method)) {
      const pass = {
        kind: "transfer",
        label: method,
        command,
        commandIndex: index,
        durationMs: null,
        draws: 0,
        accesses: [],
        unresolvedReads: 0,
      };
      ctx.addTransferAccesses(pass, command);
      if (pass.accesses.length) {
        const target = pass.accesses.find((a) => a.mode !== "read") ?? pass.accesses[0];
        pass.label = `${method} → ${target.resource.label}`;
        pass.accesses = _mergeAccesses(pass.accesses);
        passes.push(pass);
      }
      continue;
    }

    if (HOST_WRITE_METHODS.has(method)) {
      const accesses = ctx.hostWriteAccesses(command);
      if (accesses.length) {
        passes.push({ kind: "host", label: method, command, commandIndex: index, accesses });
      }
    }
  }
  finishPass();

  for (const pass of passes) {
    delete pass.state;
  }
  return { passes, warnings };
}

/**
 * The frame's commands in the order the GPU executes them: queue writes where
 * they were issued, and each command encoder's commands at the submit() that
 * carries its command buffer. Encoders that were never submitted within the
 * capture follow at the end.
 * @returns {Array<{command:Object, index:number}>}
 */
export function executionOrder(commands, warn) {
  const passToEncoder = new Map();
  const encoderCommands = new Map();
  const commandBufferToEncoder = new Map();
  const submitted = new Set();
  const ordered = [];
  let sawSubmit = false;

  const segment = (encoderId) => {
    let list = encoderCommands.get(encoderId);
    if (!list) {
      list = [];
      encoderCommands.set(encoderId, list);
    }
    return list;
  };

  for (let index = 0; index < commands.length; ++index) {
    const command = commands[index];
    if (!command) {
      continue;
    }
    const method = command.method;
    const cls = command.class;
    const entry = { command, index };

    if (method === "createCommandEncoder") {
      segment(command.result);
    } else if (method === "beginRenderPass" || method === "beginComputePass") {
      passToEncoder.set(command.result, command.object);
      segment(command.object).push(entry);
    } else if (cls === "GPURenderPassEncoder" || cls === "GPUComputePassEncoder") {
      const encoderId = passToEncoder.get(command.object);
      if (encoderId !== undefined) {
        segment(encoderId).push(entry);
      } else {
        ordered.push(entry);
      }
    } else if (cls === "GPUCommandEncoder") {
      if (method === "finish") {
        commandBufferToEncoder.set(command.result, command.object);
      } else {
        segment(command.object).push(entry);
      }
    } else if (cls === "GPUQueue") {
      if (method === "submit") {
        sawSubmit = true;
        for (const ref of command.args?.[0] ?? []) {
          const encoderId = commandBufferToEncoder.get(ref?.__id);
          if (encoderId === undefined || submitted.has(encoderId)) {
            continue;
          }
          submitted.add(encoderId);
          ordered.push(...(encoderCommands.get(encoderId) ?? []));
        }
      } else {
        ordered.push(entry);
      }
    } else if (method === "executeBundles" || DRAW_METHODS.has(method) || DISPATCH_METHODS.has(method) ||
               TRANSFER_METHODS.has(method) || HOST_WRITE_METHODS.has(method)) {
      // A record without a class (an older capture format): keep it in place.
      ordered.push(entry);
    }
  }

  if (!sawSubmit) {
    // Without submits there is no execution order to recover; command order
    // is the best available.
    return commands.map((command, index) => ({ command, index })).filter((e) => e.command);
  }

  let pending = 0;
  for (const [encoderId, list] of encoderCommands) {
    if (!submitted.has(encoderId) && list.length) {
      pending++;
      ordered.push(...list);
    }
  }
  if (pending) {
    warn?.(`${pending} command encoder${pending === 1 ? " was" : "s were"} not submitted within the capture; ${pending === 1 ? "its" : "their"} passes are placed after the submitted ones.`);
  }
  return ordered;
}

function _newPassState() {
  return { pipeline: undefined, bindGroups: [], vertexBuffers: [], indexBuffer: null };
}

function _applyPassCommand(ctx, pass, state, command) {
  const method = command.method;
  const args = command.args ?? [];
  if (method === "setPipeline") {
    state.pipeline = args[0]?.__id;
  } else if (method === "setBindGroup") {
    state.bindGroups[args[0]] = args[1]?.__id;
  } else if (method === "setVertexBuffer") {
    state.vertexBuffers[args[0]] = args[1]?.__id;
  } else if (method === "setIndexBuffer") {
    state.indexBuffer = args[0]?.__id;
  } else if (DRAW_METHODS.has(method) || DISPATCH_METHODS.has(method)) {
    pass.draws++;
    ctx.addPipelineAccesses(pass, state, method);
    if (method.endsWith("Indirect")) {
      ctx.addIndirectAccess(pass, args[0]?.__id);
    }
  }
}

/**
 * Collapse a pass's accesses to one per subresource: the same texture sampled
 * by a hundred draws is one read. Read + write becomes readwrite; a write only
 * counts as replacing the contents if every write to it did and nothing read
 * it first.
 */
function _mergeAccesses(accesses) {
  const byKey = new Map();
  for (const access of accesses) {
    const existing = byKey.get(access.resource.key);
    if (!existing) {
      byKey.set(access.resource.key, { ...access, usages: [access.usage] });
      continue;
    }
    if (existing.mode !== access.mode) {
      existing.mode = "readwrite";
    }
    existing.discards = !!existing.discards && !!access.discards && existing.mode === "write";
    existing.dropped = !!existing.dropped && !!access.dropped;
    existing.resolved = !!existing.resolved || !!access.resolved;
    if (!existing.usages.includes(access.usage)) {
      existing.usages.push(access.usage);
    }
  }
  const merged = [];
  for (const access of byKey.values()) {
    access.usage = access.usages.join(", ");
    delete access.usages;
    merged.push(access);
  }
  return merged;
}

/** Turns object references in command arguments into graph resources. */
class _Resolver {
  constructor(resolver, warn) {
    this._getObject = resolver.getObject;
    this._getTextureFromView = resolver.getTextureFromView ?? ((view) => this._getObject(view?.texture?.__id ?? view?.texture));
    this._getBundleCommands = resolver.getBundleCommands ?? ((id) => this._getObject(id)?.commands ?? null);
    this._warn = warn;
    this._resources = new Map();
    this._pipelineBindings = new Map();
  }

  getObject(id) {
    return id === undefined || id === null ? null : this._getObject(id);
  }

  getBundleCommands(id) {
    return id === undefined ? null : this._getBundleCommands(id);
  }

  // --------------------------------------------------------------- resources

  bufferResource(id) {
    const key = `buffer:${id}`;
    let resource = this._resources.get(key);
    if (resource) {
      return resource;
    }
    const buffer = this.getObject(id);
    const size = buffer?.descriptor?.size ?? 0;
    const usage = buffer?.descriptor?.usage ?? 0;
    resource = {
      key,
      objectId: id,
      object: buffer,
      type: "buffer",
      label: buffer?.label ? `"${buffer.label}"` : `Buffer ${id}`,
      detail: size ? _formatBytes(size) : "",
      bytes: size,
      // A MAP_READ buffer exists to be read back by the host: a write to it
      // is consumed even though no pass reads it.
      sink: (usage & GPU_BUFFER_USAGE_MAP_READ) ? "read back" : null,
      size,
    };
    this._resources.set(key, resource);
    return resource;
  }

  textureResource(texture, mip, layer) {
    const id = texture.id;
    const key = `texture:${id}:m${mip}:l${layer}`;
    let resource = this._resources.get(key);
    if (resource) {
      return resource;
    }
    const name = texture.label ? `"${texture.label}"` : (id < 0 ? "Canvas Texture" : `Texture ${id}`);
    const multiMip = (texture.mipLevelCount ?? 1) > 1;
    const multiLayer = texture.dimension !== "3d" && (texture.depthOrArrayLayers ?? 1) > 1;
    const sub = [multiMip ? `mip ${mip}` : "", multiLayer ? `layer ${layer}` : ""].filter(Boolean).join(" ");
    const [w, h] = texture.getMipSize ? texture.getMipSize(mip) : [texture.width, texture.height];
    const bytes = texture.getGpuSize ? Math.max(0, texture.getGpuSize()) : 0;
    resource = {
      key,
      objectId: id,
      object: texture,
      type: "texture",
      label: sub ? `${name} ${sub}` : name,
      objectLabel: name,
      detail: `${w}x${h} ${texture.format ?? ""}`.trim(),
      bytes,
      // Canvas textures (negative ids) are what the frame is for.
      sink: id < 0 ? "presented" : null,
      mip,
      layer,
      width: w,
      height: h,
    };
    this._resources.set(key, resource);
    return resource;
  }

  /** The texture a view reference in command args points at, with the view's descriptor. */
  resolveView(ref) {
    if (!ref || ref.__id === undefined) {
      return null;
    }
    const view = this.getObject(ref.__id);
    let texture = null;
    if (ref.__texture?.__id !== undefined) {
      texture = this.getObject(ref.__texture.__id);
    }
    if (!texture && view) {
      texture = this._getTextureFromView(view);
    }
    if (!texture) {
      return null;
    }
    return { texture, viewDescriptor: view?.descriptor ?? {} };
  }

  /** Every (mip, layer) subresource a texture view covers. */
  viewSubresources(texture, viewDescriptor, { singleMip = false } = {}) {
    const desc = viewDescriptor ?? {};
    const textureLayers = texture.dimension === "3d" ? 1 : (texture.depthOrArrayLayers ?? 1);
    const textureMips = texture.mipLevelCount ?? 1;
    const baseMip = desc.baseMipLevel ?? 0;
    const mipCount = singleMip ? 1 : (desc.mipLevelCount ?? Math.max(1, textureMips - baseMip));
    const baseLayer = desc.baseArrayLayer ?? 0;
    const viewDimension = desc.dimension ??
      (texture.dimension === "2d" && textureLayers > 1 ? "2d-array" : (texture.dimension ?? "2d"));
    const singleLayerView = viewDimension === "1d" || viewDimension === "2d" || viewDimension === "3d";
    const layerCount = desc.arrayLayerCount ?? (singleLayerView ? 1 : Math.max(1, textureLayers - baseLayer));
    const out = [];
    for (let m = baseMip; m < baseMip + mipCount; ++m) {
      for (let l = baseLayer; l < baseLayer + layerCount; ++l) {
        if (out.length >= MAX_VIEW_SUBRESOURCES) {
          this._warn("A texture view covers more subresources than the graph tracks; some of its mip levels or layers are left out.");
          return out;
        }
        out.push(this.textureResource(texture, m, l));
      }
    }
    return out;
  }

  /** The subresources a copy's texture region ({texture, mipLevel, origin}) touches. */
  copySubresources(copyTexture, copySize) {
    const texture = this.getObject(copyTexture?.texture?.__id);
    if (!texture) {
      return { resources: [], full: false };
    }
    const mip = copyTexture.mipLevel ?? 0;
    const origin = _extent3D(copyTexture.origin, 0);
    const size = _extent3D(copySize, 1);
    const resources = [];
    if (texture.dimension === "3d") {
      resources.push(this.textureResource(texture, mip, 0));
    } else {
      for (let l = origin[2]; l < origin[2] + size[2]; ++l) {
        resources.push(this.textureResource(texture, mip, l));
      }
    }
    const [mw, mh, md] = texture.getMipSize ? texture.getMipSize(mip) : [texture.width, texture.height, 1];
    const full = origin[0] === 0 && origin[1] === 0 && size[0] >= mw && size[1] >= mh &&
      (texture.dimension !== "3d" || (origin[2] === 0 && size[2] >= md));
    return { resources, full };
  }

  // ---------------------------------------------------------------- accesses

  addAttachmentAccesses(pass, descriptor) {
    for (const attachment of descriptor?.colorAttachments ?? []) {
      if (!attachment) {
        continue;
      }
      const target = this.resolveView(attachment.view);
      if (!target) {
        pass.unresolvedReads++;
        continue;
      }
      const resolveTarget = attachment.resolveTarget ? this.resolveView(attachment.resolveTarget) : null;
      const [resource] = this.viewSubresources(target.texture, target.viewDescriptor, { singleMip: true });
      const load = attachment.loadOp === "load";
      pass.accesses.push({
        resource,
        mode: load ? "readwrite" : "write",
        usage: load ? "color attachment (load)" : "color attachment",
        discards: !load,
        dropped: attachment.storeOp === "discard",
        resolved: !!resolveTarget,
        msaa: (target.texture.sampleCount ?? 1) > 1,
      });
      if (resolveTarget) {
        const [resolveResource] = this.viewSubresources(resolveTarget.texture, resolveTarget.viewDescriptor, { singleMip: true });
        pass.accesses.push({ resource: resolveResource, mode: "write", usage: "resolve target", discards: true });
      }
    }

    const ds = descriptor?.depthStencilAttachment;
    if (ds) {
      const target = this.resolveView(ds.view);
      if (!target) {
        pass.unresolvedReads++;
        return;
      }
      const [resource] = this.viewSubresources(target.texture, target.viewDescriptor, { singleMip: true });
      const readOnly = !!ds.depthReadOnly && (ds.stencilReadOnly || !_hasStencil(target.texture.format));
      if (readOnly) {
        pass.accesses.push({ resource, mode: "read", usage: "depth-stencil attachment (read-only)" });
        return;
      }
      // An aspect not in the format has no load op; it neither loads nor clears.
      const aspects = [];
      if (_hasDepth(target.texture.format) && !ds.depthReadOnly) {
        aspects.push({ loadOp: ds.depthLoadOp, storeOp: ds.depthStoreOp });
      }
      if (_hasStencil(target.texture.format) && !ds.stencilReadOnly) {
        aspects.push({ loadOp: ds.stencilLoadOp, storeOp: ds.stencilStoreOp });
      }
      const load = aspects.some((a) => a.loadOp === "load") || aspects.length === 0;
      pass.accesses.push({
        resource,
        mode: load ? "readwrite" : "write",
        usage: load ? "depth-stencil attachment (load)" : "depth-stencil attachment",
        discards: !load,
        dropped: aspects.length > 0 && aspects.every((a) => a.storeOp === "discard"),
        msaa: (target.texture.sampleCount ?? 1) > 1,
      });
    }
  }

  addPipelineAccesses(pass, state, method) {
    const pipelineInfo = this._pipelineInfo(state.pipeline);

    if (DRAW_METHODS.has(method)) {
      const vertexSlots = pipelineInfo?.vertexSlots;
      state.vertexBuffers.forEach((id, slot) => {
        if (id === undefined || (vertexSlots && !vertexSlots.has(slot))) {
          return;
        }
        pass.accesses.push({ resource: this.bufferResource(id), mode: "read", usage: "vertex" });
      });
      if ((method === "drawIndexed" || method === "drawIndexedIndirect") && state.indexBuffer !== null && state.indexBuffer !== undefined) {
        pass.accesses.push({ resource: this.bufferResource(state.indexBuffer), mode: "read", usage: "index" });
      }
    }
    state.bindGroups.forEach((bindGroupId, groupIndex) => {
      if (bindGroupId === undefined) {
        return;
      }
      this._addBindGroupAccesses(pass, groupIndex, bindGroupId, pipelineInfo);
    });
  }

  addIndirectAccess(pass, bufferId) {
    if (bufferId !== undefined) {
      pass.accesses.push({ resource: this.bufferResource(bufferId), mode: "read", usage: "indirect" });
    }
  }

  _addBindGroupAccesses(pass, groupIndex, bindGroupId, pipelineInfo) {
    const bindGroup = this.getObject(bindGroupId);
    const entries = bindGroup?.descriptor?.entries;
    if (!entries) {
      pass.unresolvedReads++;
      return;
    }
    const layoutEntries = this.getObject(bindGroup.descriptor.layout?.__id)?.descriptor?.entries ?? null;
    for (const entry of entries) {
      const reflected = pipelineInfo?.bindings?.get(`${groupIndex}:${entry.binding}`);
      // With the pipeline's shaders reflected, a binding they never touch is
      // not a dependency, even though the bind group carries it.
      if (pipelineInfo?.bindings && !reflected) {
        continue;
      }
      const layoutEntry = layoutEntries?.find((e) => e.binding === entry.binding) ?? null;
      const ref = entry.resource;

      const bufferId = ref?.buffer?.__id ?? (ref?.__class === "GPUBuffer" ? ref.__id : undefined);
      if (bufferId !== undefined) {
        const resource = this.bufferResource(bufferId);
        const { mode, usage } = _bufferBindingAccess(layoutEntry, reflected, resource.object?.descriptor?.usage ?? 0);
        pass.accesses.push({ resource, mode, usage });
        continue;
      }

      const object = this.getObject(ref?.__id);
      const className = object?.constructor?.className ?? ref?.__class;
      if (className === "Sampler" || className === "GPUSampler" || className === "GPUExternalTexture") {
        continue;
      }
      if (className === "TextureView" || className === "GPUTextureView") {
        const target = this.resolveView(ref);
        if (!target) {
          pass.unresolvedReads++;
          continue;
        }
        const { mode, usage } = _textureBindingAccess(layoutEntry, reflected);
        for (const resource of this.viewSubresources(target.texture, target.viewDescriptor)) {
          pass.accesses.push({ resource, mode, usage });
        }
        continue;
      }
      if (ref !== undefined) {
        pass.unresolvedReads++;
      }
    }
  }

  /**
   * What a pipeline's shaders statically use: the (group, binding) pairs with
   * their reflected resource type and access, and the vertex buffer slots.
   * null fields mean "unknown" — every binding is then assumed used.
   */
  _pipelineInfo(pipelineId) {
    if (pipelineId === undefined) {
      return null;
    }
    if (this._pipelineBindings.has(pipelineId)) {
      return this._pipelineBindings.get(pipelineId);
    }
    const descriptor = this.getObject(pipelineId)?.descriptor;
    let info = null;
    if (descriptor) {
      info = { bindings: new Map(), vertexSlots: null };
      const stages = descriptor.compute
        ? [["compute", descriptor.compute]]
        : [["vertex", descriptor.vertex], ["fragment", descriptor.fragment]];
      for (const [stage, stageDesc] of stages) {
        if (!stageDesc) {
          continue;
        }
        const module = this.getObject(stageDesc.module?.__id);
        let reflection = null;
        try {
          reflection = module?.reflection ?? null;
        } catch (e) {
          reflection = null;
        }
        const entries = reflection?.entry?.[stage];
        const entry = entries?.length
          ? (stageDesc.entryPoint ? entries.find((e) => e.name === stageDesc.entryPoint) : null) ?? entries[0]
          : null;
        if (!entry) {
          info.bindings = null;
          break;
        }
        for (const resource of entry.resources ?? []) {
          const key = `${resource.group}:${resource.binding}`;
          const previous = info.bindings.get(key);
          // The same binding seen from two stages: the more permissive access wins.
          if (!previous || (previous.access === "read" && resource.access && resource.access !== "read")) {
            info.bindings.set(key, { resourceType: resource.resourceType, access: resource.access });
          }
        }
      }
      if (descriptor.vertex?.buffers) {
        info.vertexSlots = new Set();
        descriptor.vertex.buffers.forEach((layout, slot) => {
          if (layout) {
            info.vertexSlots.add(slot);
          }
        });
      }
    }
    this._pipelineBindings.set(pipelineId, info);
    return info;
  }

  addTransferAccesses(pass, command) {
    const method = command.method;
    const args = command.args ?? [];
    if (method === "copyBufferToBuffer") {
      // copyBufferToBuffer(src, srcOffset, dst, dstOffset, size) or the
      // shorter copyBufferToBuffer(src, dst, size?).
      const short = args[1]?.__id !== undefined;
      const src = args[0]?.__id;
      const dst = short ? args[1]?.__id : args[2]?.__id;
      const dstOffset = short ? 0 : (args[3] ?? 0);
      const size = short ? args[2] : args[4];
      if (src !== undefined) {
        pass.accesses.push({ resource: this.bufferResource(src), mode: "read", usage: "copy src" });
      }
      if (dst !== undefined) {
        const resource = this.bufferResource(dst);
        const full = dstOffset === 0 && (size === undefined || size >= resource.size);
        pass.accesses.push({ resource, mode: "write", usage: "copy dst", discards: full && resource.size > 0 });
      }
    } else if (method === "clearBuffer") {
      const id = args[0]?.__id;
      if (id !== undefined) {
        const resource = this.bufferResource(id);
        const offset = args[1] ?? 0;
        const size = args[2];
        const full = offset === 0 && (size === undefined || size >= resource.size);
        pass.accesses.push({ resource, mode: "write", usage: "clear dst", discards: full });
      }
    } else if (method === "resolveQuerySet") {
      const id = args[3]?.__id;
      if (id !== undefined) {
        pass.accesses.push({ resource: this.bufferResource(id), mode: "write", usage: "query resolve dst" });
      }
    } else if (method === "copyBufferToTexture") {
      const src = args[0]?.buffer?.__id;
      if (src !== undefined) {
        pass.accesses.push({ resource: this.bufferResource(src), mode: "read", usage: "copy src" });
      }
      const { resources, full } = this.copySubresources(args[1], args[2]);
      for (const resource of resources) {
        pass.accesses.push({ resource, mode: "write", usage: "copy dst", discards: full });
      }
    } else if (method === "copyTextureToBuffer") {
      for (const resource of this.copySubresources(args[0], args[2]).resources) {
        pass.accesses.push({ resource, mode: "read", usage: "copy src" });
      }
      const dst = args[1]?.buffer?.__id;
      if (dst !== undefined) {
        pass.accesses.push({ resource: this.bufferResource(dst), mode: "write", usage: "copy dst" });
      }
    } else if (method === "copyTextureToTexture") {
      for (const resource of this.copySubresources(args[0], args[2]).resources) {
        pass.accesses.push({ resource, mode: "read", usage: "copy src" });
      }
      const { resources, full } = this.copySubresources(args[1], args[2]);
      for (const resource of resources) {
        pass.accesses.push({ resource, mode: "write", usage: "copy dst", discards: full });
      }
    }
  }

  hostWriteAccesses(command) {
    const args = command.args ?? [];
    if (command.method === "writeBuffer") {
      const id = args[0]?.__id;
      return id === undefined ? [] : [{ resource: this.bufferResource(id), mode: "write", usage: "host write" }];
    }
    const destination = command.method === "writeTexture" ? args[0] : args[1];
    const size = command.method === "writeTexture" ? args[3] : args[2];
    return this.copySubresources(destination, size).resources
      .map((resource) => ({ resource, mode: "write", usage: "host write" }));
  }
}

function _bufferBindingAccess(layoutEntry, reflected, bufferUsage) {
  const type = layoutEntry?.buffer ? (layoutEntry.buffer.type ?? "uniform") : null;
  if (type === "uniform" || (!type && reflected?.resourceType === RESOURCE_UNIFORM)) {
    return { mode: "read", usage: "uniform" };
  }
  if (type === "read-only-storage") {
    return { mode: "read", usage: "storage (read-only)" };
  }
  if (reflected?.resourceType === RESOURCE_STORAGE && reflected.access === "read") {
    return { mode: "read", usage: "storage (read-only)" };
  }
  if (!type && !reflected) {
    // Neither the layout nor the shaders say how the binding is used; the
    // buffer's own usage flags are the last hint.
    if ((bufferUsage & GPU_BUFFER_USAGE_STORAGE) === 0) {
      return { mode: "read", usage: (bufferUsage & GPU_BUFFER_USAGE_UNIFORM) ? "uniform" : "buffer" };
    }
  }
  return { mode: "readwrite", usage: "storage" };
}

function _textureBindingAccess(layoutEntry, reflected) {
  const storageAccess = layoutEntry?.storageTexture
    ? (layoutEntry.storageTexture.access ?? "write-only")
    : (reflected?.resourceType === RESOURCE_STORAGE_TEXTURE ? reflected.access : null);
  if (storageAccess === "write-only" || storageAccess === "write") {
    return { mode: "write", usage: "storage texture (write)" };
  }
  if (storageAccess === "read-only" || storageAccess === "read") {
    return { mode: "read", usage: "storage texture (read)" };
  }
  if (storageAccess) {
    return { mode: "readwrite", usage: "storage texture" };
  }
  if (reflected && reflected.resourceType !== RESOURCE_TEXTURE && reflected.resourceType !== RESOURCE_STORAGE_TEXTURE) {
    return { mode: "read", usage: "texture" };
  }
  return { mode: "read", usage: "sampled" };
}

function _hasDepth(format) {
  return !!format && format.includes("depth");
}

function _hasStencil(format) {
  return !!format && format.includes("stencil");
}

function _extent3D(value, fill) {
  if (Array.isArray(value)) {
    return [value[0] ?? fill, value[1] ?? fill, value[2] ?? fill];
  }
  if (value && typeof value === "object") {
    return [value.width ?? value.x ?? fill, value.height ?? value.y ?? fill, value.depthOrArrayLayers ?? value.z ?? fill];
  }
  return [fill, fill, fill];
}

function _formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * Build the graph from a frame's passes in execution order (as returned by
 * collectFramePasses).
 * @param {Object[]} passes
 * @returns {Object} graph - { nodes, resources, edges, externalInputs,
 *   hostInputs, unreadNodes, criticalPath, criticalPathMs, warnings }
 */
export function buildRenderGraph(passes) {
  const resources = new Map();
  const nodes = [];
  const edges = [];
  // The version each resource currently holds, as the walk moves through the frame.
  const current = new Map();

  const resourceOf = (raw) => {
    let r = resources.get(raw.key);
    if (!r) {
      r = { ...raw, versions: [], uses: [], first: Infinity, last: -1, externalInput: false, hostInput: false };
      // Version 0: whatever the resource held when the capture started.
      r.versions.push({ resource: r, index: 0, producer: null, host: false, readers: [], dropped: false });
      resources.set(raw.key, r);
      current.set(raw.key, r.versions[0]);
    }
    return r;
  };

  for (const pass of passes) {
    if (pass.kind === "host") {
      // A queue write replaces what the resource held with host data: later
      // reads depend on the upload, not on whatever pass wrote it before.
      for (const access of pass.accesses) {
        const resource = resourceOf(access.resource);
        const version = { resource, index: resource.versions.length, producer: null, host: true, readers: [], dropped: false };
        resource.versions.push(version);
        current.set(resource.key, version);
      }
      continue;
    }

    const node = {
      ordinal: nodes.length,
      kind: pass.kind,
      label: pass.label,
      command: pass.command,
      commandIndex: pass.commandIndex,
      draws: pass.draws ?? 0,
      reads: [],
      writes: [],
      inputs: [],
      outputs: [],
      durationMs: pass.durationMs ?? null,
      unresolvedReads: pass.unresolvedReads ?? 0,
      unread: false,
      pathMs: 0,
    };
    nodes.push(node);

    // Accesses are applied in two rounds: every read against the versions the
    // pass began with, then every write. A write that keeps what was there (an
    // attachment loaded, a copy into part of a texture) depends on the previous
    // version too: that is the edge an accumulating target hangs on.
    for (const access of pass.accesses) {
      if (access.mode === "write" && access.discards) {
        continue;
      }
      const resource = resourceOf(access.resource);
      const version = current.get(resource.key);
      const isRead = access.mode !== "write";
      if (isRead) {
        const use = _makeUse(node, resource, access, version);
        node.reads.push(use);
        resource.uses.push(use);
        _touch(resource, node);
      }
      if (!version.readers.includes(node)) {
        version.readers.push(node);
      }
      if (version.producer && version.producer !== node) {
        const edge = { from: version.producer, to: node, version, usage: access.usage };
        edges.push(edge);
        version.producer.outputs.push(edge);
        node.inputs.push(edge);
      } else if (!version.producer) {
        if (version.host) {
          resource.hostInput = true;
        } else {
          resource.externalInput = true;
        }
      }
    }

    for (const access of pass.accesses) {
      if (access.mode === "read") {
        continue;
      }
      const resource = resourceOf(access.resource);
      const version = { resource, index: resource.versions.length, producer: node, host: false, readers: [], dropped: !!access.dropped };
      resource.versions.push(version);
      current.set(resource.key, version);
      const use = _makeUse(node, resource, access, version);
      node.writes.push(use);
      resource.uses.push(use);
      _touch(resource, node);
    }
  }

  for (const node of nodes) {
    node.unread = node.writes.length > 0 &&
      node.writes.every((w) => w.version.readers.length === 0 && !w.resource.sink);
  }

  const list = [...resources.values()].filter((r) => r.uses.length > 0);
  const graph = {
    nodes,
    resources: list,
    edges,
    externalInputs: list.filter((r) => r.externalInput),
    hostInputs: list.filter((r) => r.hostInput),
    unreadNodes: nodes.filter((n) => n.unread),
    criticalPath: [],
    criticalPathMs: 0,
    warnings: [],
  };
  _computeCriticalPath(graph);

  if (nodes.some((n) => n.writes.some((u) => u.usage.startsWith("storage") && u.mode === "readwrite"))) {
    graph.warnings.push("Storage bindings declared read_write are counted as written: shader reflection shows what a binding may do, not whether this dispatch or draw actually wrote it, so some write edges may be dependencies that are not really there.");
  }
  const unresolved = nodes.reduce((n, p) => n + p.unresolvedReads, 0);
  if (unresolved) {
    graph.warnings.push(`${unresolved} binding${unresolved === 1 ? "" : "s"} could not be resolved to a resource, so some edges are missing: the graph is a lower bound on the frame's dependencies.`);
  }
  if (nodes.length && !nodes.some((n) => n.durationMs !== null)) {
    graph.warnings.push("The capture has no GPU pass timings, so there is no critical path. Capture with \"Profile Passes\" to get one.");
  }
  return graph;
}

function _makeUse(node, resource, access, version) {
  return {
    node,
    resource,
    mode: access.mode,
    usage: access.usage,
    version,
    discards: !!access.discards,
    dropped: !!access.dropped,
    resolved: !!access.resolved,
    msaa: !!access.msaa,
  };
}

function _touch(resource, node) {
  resource.first = Math.min(resource.first, node.ordinal);
  resource.last = Math.max(resource.last, node.ordinal);
}

/**
 * The longest chain of dependent passes by GPU time. Nodes are in execution
 * order and every edge runs forward, so one backwards sweep is enough: a
 * node's path is its own duration plus the longest path of anything that
 * consumes it.
 */
function _computeCriticalPath(graph) {
  const next = new Map();
  let head = null;
  let best = 0;
  for (let i = graph.nodes.length - 1; i >= 0; i--) {
    const node = graph.nodes[i];
    let bestChild = null;
    let bestChildMs = 0;
    for (const edge of node.outputs) {
      if (edge.to.ordinal <= node.ordinal) {
        continue;
      }
      if (edge.to.pathMs > bestChildMs) {
        bestChildMs = edge.to.pathMs;
        bestChild = edge.to;
      }
    }
    node.pathMs = (node.durationMs ?? 0) + bestChildMs;
    next.set(node, bestChild);
    if (node.pathMs > best) {
      best = node.pathMs;
      head = node;
    }
  }
  if (!head || best <= 0) {
    return;
  }
  const path = [];
  for (let n = head; n; n = next.get(n) ?? null) {
    path.push(n);
  }
  graph.criticalPath = path;
  graph.criticalPathMs = best;
}

/** Classes of usage, for coloring an access in the chart and keying the legend. */
export function usageClass(usage) {
  if (usage.includes("attachment") || usage.startsWith("resolve")) {
    return "attachment";
  }
  if (usage.endsWith(" src") || usage.endsWith(" dst") || usage === "host write") {
    return "transfer";
  }
  if (usage.startsWith("storage")) {
    return "storage";
  }
  if (usage.startsWith("sampled") || usage.startsWith("texture")) {
    return "sampled";
  }
  if (usage.startsWith("vertex") || usage.startsWith("index") || usage.startsWith("indirect") || usage.startsWith("uniform")) {
    return "input";
  }
  return "other";
}

/**
 * The chart's rows: one per texture or buffer object, gathering the uses of
 * all its subresources, so a mip chain or cube map is one row rather than
 * dozens. Ordered by the node that first touched it, then the last, so rows
 * sit next to the pass that created them and the frame reads as a staircase.
 */
export function groupResourceRows(resources) {
  const rows = new Map();
  for (const resource of resources) {
    const key = `${resource.type}:${resource.objectId}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        objectId: resource.objectId,
        object: resource.object,
        type: resource.type,
        label: resource.objectLabel ?? resource.label,
        detail: resource.type === "texture" ? _textureDetail(resource.object) : resource.detail,
        bytes: resource.bytes,
        sink: resource.sink,
        subresources: [],
        uses: [],
        first: Infinity,
        last: -1,
        externalInput: false,
        hostInput: false,
      };
      rows.set(key, row);
    }
    row.subresources.push(resource);
    row.uses.push(...resource.uses);
    row.first = Math.min(row.first, resource.first);
    row.last = Math.max(row.last, resource.last);
    row.externalInput = row.externalInput || resource.externalInput;
    row.hostInput = row.hostInput || resource.hostInput;
  }
  return [...rows.values()].sort((a, b) => a.first - b.first || b.last - a.last || b.bytes - a.bytes || a.label.localeCompare(b.label));
}

function _textureDetail(texture) {
  if (!texture) {
    return "";
  }
  const parts = [`${texture.resolutionString ?? `${texture.width}x${texture.height}`} ${texture.format ?? ""}`.trim()];
  if ((texture.mipLevelCount ?? 1) > 1) {
    parts.push(`${texture.mipLevelCount} mips`);
  }
  if ((texture.sampleCount ?? 1) > 1) {
    parts.push(`${texture.sampleCount}x MSAA`);
  }
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const SEVERITY_RANK = { high: 3, medium: 2, low: 1, info: 0 };
const RULE_ORDER = ["read-after-discard", "overwritten-before-read", "msaa-store", "unread-store", "mergeable-passes"];

/** One finding per rule, naming the first case and counting the rest. */
class _Folded {
  constructor() {
    this.first = null;
    this.count = 0;
    this.nodes = [];
    this.subjects = [];
  }

  add(node, subject) {
    if (!this.first) {
      this.first = node;
    }
    this.count++;
    if (this.nodes.length < 64 && !this.nodes.includes(node)) {
      this.nodes.push(node);
    }
    if (this.subjects.length < 3 && !this.subjects.includes(subject)) {
      this.subjects.push(subject);
    }
  }

  get subjectText() {
    const rest = this.count - this.subjects.length;
    const names = this.subjects.join(", ");
    return rest > 0 ? `${names} and ${rest} more` : names;
  }
}

function _count(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

/**
 * Performance rules over the render graph. The graph knows exactly which
 * version of a subresource nothing reads, so these state it rather than
 * approximate it from usage flags.
 *
 * @returns {{findings: Object[], byNode: Map<Object, Object[]>}} findings are
 *   { rule, severity, confidence, message, node, count, nodes }
 */
export function analyzeRenderGraph(graph) {
  const findings = [];
  const blind = graph.nodes.some((n) => n.unresolvedReads > 0);
  const blindClause = blind ? ", and some of the frame's bindings could not be resolved to a resource at all" : "";

  const add = (rule, severity, confidence, message, folded) => {
    findings.push({ rule, severity, confidence, message, node: folded.first, count: folded.count, nodes: folded.nodes });
  };

  // unread-store: an attachment stored to memory that no later pass reads.
  {
    const folded = new _Folded();
    for (const node of graph.nodes) {
      for (const write of node.writes) {
        if (usageClass(write.usage) !== "attachment" || write.usage === "resolve target") {
          continue;
        }
        if (write.dropped || write.resource.sink || write.resolved) {
          continue;
        }
        if (write.version.readers.length) {
          continue;
        }
        if (node.unresolvedReads && node.writes.length === 1) {
          continue;
        }
        folded.add(node, write.resource.label);
      }
    }
    if (folded.count) {
      add("unread-store", "medium", blind ? "medium" : "high",
        `${_count(folded.count, "attachment write")} in the frame ${folded.count === 1 ? "is" : "are"} stored to memory that no later pass reads: ${folded.subjectText}. ` +
        `storeOp: "discard" skips the write, which on a tiled GPU (most mobile and Apple GPUs) is much of the cost of a pass. ` +
        `The graph only sees this capture, so a result the next frame consumes (a history buffer, for example) will look unread here${blindClause}.`, folded);
    }
  }

  // msaa-store: a multisampled attachment stored although it is resolved.
  {
    const folded = new _Folded();
    for (const node of graph.nodes) {
      for (const write of node.writes) {
        if (!write.resolved || write.dropped || !write.msaa) {
          continue;
        }
        if (write.version.readers.length) {
          continue;
        }
        folded.add(node, write.resource.label);
      }
    }
    if (folded.count) {
      add("msaa-store", "medium", blind ? "medium" : "high",
        `${_count(folded.count, "multisampled attachment")} ${folded.count === 1 ? "is" : "are"} stored as well as resolved, and nothing reads the multisampled contents: ${folded.subjectText}. ` +
        `With a resolveTarget set, storeOp: "discard" on the MSAA attachment keeps only the resolved result and saves writing every sample to memory${blindClause}.`, folded);
    }
  }

  // overwritten-before-read: a result replaced before anything read it.
  {
    const folded = new _Folded();
    for (const resource of graph.resources) {
      for (let i = 0; i < resource.versions.length - 1; i++) {
        const version = resource.versions[i];
        const next = resource.versions[i + 1];
        if (!version.producer || version.readers.length || version.dropped) {
          continue;
        }
        // Only when the next write keeps nothing: a partial write still
        // depends on what was there. A host upload always replaces the range
        // it writes, but not necessarily the whole resource, so it is skipped.
        const replaces = next.producer?.writes.find((w) => w.version === next)?.discards;
        if (!replaces) {
          continue;
        }
        folded.add(version.producer, `${resource.label} (${next.producer.label} replaces it)`);
      }
    }
    if (folded.count) {
      add("overwritten-before-read", "high", blind ? "medium" : "high",
        `${_count(folded.count, "result")} ${folded.count === 1 ? "is" : "are"} replaced before anything reads ${folded.count === 1 ? "it" : "them"}: ${folded.subjectText}. ` +
        `The work is done and thrown away — the first write can be dropped, or the two passes merged${blindClause}.`, folded);
    }
  }

  // read-after-discard: a pass reads contents the producer discarded. WebGPU
  // zeroes a discarded attachment, so the reader sees zeros, not the result.
  {
    const folded = new _Folded();
    for (const node of graph.nodes) {
      for (const read of node.reads) {
        if (read.version.dropped && read.version.producer) {
          folded.add(node, `${read.resource.label} (discarded by ${read.version.producer.label})`);
        }
      }
    }
    if (folded.count) {
      add("read-after-discard", "high", "high",
        `${_count(folded.count, "read")} ${folded.count === 1 ? "uses" : "use"} an attachment that the pass which rendered it ended with storeOp: "discard": ${folded.subjectText}. ` +
        `WebGPU zeroes discarded contents, so the reader sees zeros rather than what was rendered. Use storeOp: "store" on the producing pass.`, folded);
    }
  }

  // mergeable-passes: adjacent render passes, the second loading exactly what the first stored.
  {
    const folded = new _Folded();
    const nodes = graph.nodes;
    for (let i = 1; i < nodes.length; i++) {
      const before = nodes[i - 1];
      const after = nodes[i];
      if (before.kind !== "render" || after.kind !== "render") {
        continue;
      }
      const carried = after.writes.filter((w) =>
        usageClass(w.usage) === "attachment" && !w.discards &&
        w.version.index > 1 && w.resource.versions[w.version.index - 1]?.producer === before);
      if (!carried.length || !_sameTargets(before, after)) {
        continue;
      }
      folded.add(after, carried.map((w) => w.resource.label).join(", "));
    }
    if (folded.count) {
      add("mergeable-passes", "medium", "medium",
        `${_count(folded.count, "render pass", "render passes")} load exactly what the pass immediately before stored, to the same attachments: ${folded.subjectText}. ` +
        `Recorded as one pass (more draws in the first), the attachments stay in tile memory and a store and a load both go away.`, folded);
    }
  }

  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule));

  const byNode = new Map();
  for (const f of findings) {
    for (const node of f.nodes) {
      const list = byNode.get(node);
      if (list) {
        list.push(f);
      } else {
        byNode.set(node, [f]);
      }
    }
  }
  return { findings, byNode };
}

function _targetKey(node) {
  return node.writes.filter((w) => usageClass(w.usage) === "attachment").map((w) => w.resource.key).sort().join("|");
}

function _sameTargets(a, b) {
  const key = _targetKey(a);
  return key.length > 0 && key === _targetKey(b);
}

/**
 * Convenience: collect the passes and build the graph in one call.
 * @returns {Object} graph with the collection warnings prepended
 */
export function buildFrameRenderGraph(commands, resolver) {
  const { passes, warnings } = collectFramePasses(commands, resolver);
  const graph = buildRenderGraph(passes);
  graph.warnings.unshift(...warnings);
  return graph;
}
