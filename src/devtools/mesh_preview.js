/**
 * A small WebGPU mesh renderer for the Mesh view: solid (flat-lit),
 * wireframe, solid + wireframe, or points, with an orbit camera and vertex
 * picking. It draws with the DevTools panel's own device.
 *
 * Mouse: left-drag orbits, right-drag (or shift + left-drag) pans, the wheel
 * zooms, and a click without dragging picks the nearest vertex.
 */

export const MESH_MODES = ["Solid", "Wireframe", "Solid + Wireframe", "Points"];

const BUFFER_VERTEX = 0x0020;
const BUFFER_INDEX = 0x0010;
const BUFFER_UNIFORM = 0x0040;
const BUFFER_COPY_DST = 0x0008;
const TEXTURE_RENDER_ATTACHMENT = 0x10;

const DEPTH_FORMAT = "depth24plus";
const PICK_RADIUS = 12;

const SHADER = `
struct U {
    mvp : mat4x4f,
    viewport : vec2f,
    pointSize : f32,
    markerSize : f32,
    lineColor : vec4f,
};
@group(0) @binding(0) var<uniform> u : U;

struct VO {
    @builtin(position) pos : vec4f,
    @location(0) color : vec3f,
    @location(1) world : vec3f,
};

@vertex fn vsMesh(@location(0) p : vec3f, @location(1) c : vec3f) -> VO {
    var o : VO;
    o.pos = u.mvp * vec4f(p, 1.0);
    o.color = c;
    o.world = p;
    return o;
}

@fragment fn fsSolid(i : VO) -> @location(0) vec4f {
    // Flat shading from screen-space derivatives: no normals needed, and both
    // sides of a triangle are lit.
    let n = normalize(cross(dpdx(i.world), dpdy(i.world)));
    let light = 0.35 + 0.65 * abs(dot(n, normalize(vec3f(0.3, 0.8, 0.5))));
    return vec4f(i.color * light, 1.0);
}

@fragment fn fsLine(i : VO) -> @location(0) vec4f {
    return u.lineColor;
}

fn corner(vi : u32) -> vec2f {
    return vec2f(f32(vi & 1u), f32((vi >> 1u) & 1u)) * 2.0 - 1.0;
}

fn billboard(p : vec3f, vi : u32, size : f32) -> vec4f {
    let clip = u.mvp * vec4f(p, 1.0);
    return vec4f(clip.xy + corner(vi) * size / u.viewport * clip.w, clip.zw);
}

@vertex fn vsPoint(@builtin(vertex_index) vi : u32, @location(0) p : vec3f, @location(1) c : vec3f) -> VO {
    var o : VO;
    o.pos = billboard(p, vi, u.pointSize);
    o.color = c;
    o.world = p;
    return o;
}

@fragment fn fsPoint(i : VO) -> @location(0) vec4f {
    return vec4f(i.color, 1.0);
}

@vertex fn vsMarker(@builtin(vertex_index) vi : u32, @location(0) p : vec3f) -> VO {
    var o : VO;
    let clip = billboard(p, vi, u.markerSize);
    // Always on top of the mesh.
    o.pos = vec4f(clip.xy, 0.0, clip.w);
    o.color = vec3f(1.0, 0.55, 0.0);
    o.world = p;
    return o;
}
`;

// --- Small column-major matrix helpers. -------------------------------------

function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = far / (near - far);
    m[11] = -1;
    m[14] = (near * far) / (near - far);
    return m;
}

function sub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(a) {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
}

function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function lookAt(eye, target, up) {
    const z = normalize(sub(eye, target));
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([
        x[0], y[0], z[0], 0,
        x[1], y[1], z[1], 0,
        x[2], y[2], z[2], 0,
        -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ]);
}

function multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; ++c) {
        for (let r = 0; r < 4; ++r) {
            let sum = 0;
            for (let k = 0; k < 4; ++k) {
                sum += a[k * 4 + r] * b[c * 4 + k];
            }
            out[c * 4 + r] = sum;
        }
    }
    return out;
}

export class MeshPreview {
    /**
     * @param {HTMLElement} container - the element the canvas fills
     * @param {GPUDevice} device
     */
    constructor(container, device) {
        this.device = device;
        this.container = container;
        this.canvas = document.createElement("canvas");
        this.canvas.style.cssText = "width: 100%; height: 100%; display: block; cursor: grab;";
        container.appendChild(this.canvas);
        this.context = this.canvas.getContext("webgpu");
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({ device, format: this.format, alphaMode: "opaque" });

        this.mode = MESH_MODES[0];
        this.onPick = null;
        this._highlight = -1;
        this._geometry = null;
        this._buffers = [];
        this._depth = null;
        this._camera = { target: [0, 0, 0], radius: 1, distance: 3, yaw: 0.6, pitch: 0.4 };
        this._mvp = null;

        this._uniform = device.createBuffer({ size: 96, usage: BUFFER_UNIFORM | BUFFER_COPY_DST });
        this._createPipelines();
        this._setupEvents();

        this._resizeObserver = new ResizeObserver(() => this.render());
        this._resizeObserver.observe(container);
    }

    destroy() {
        this._resizeObserver?.disconnect();
        this._destroyGeometry();
        this._uniform?.destroy();
        this._depth?.destroy();
        this._uniform = null;
        this._depth = null;
    }

    _createPipelines() {
        const device = this.device;
        const module = device.createShaderModule({ code: SHADER });
        const layout = device.createBindGroupLayout({
            entries: [{ binding: 0, visibility: 1 | 2, buffer: { type: "uniform" } }],
        });
        this._bindGroup = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this._uniform } }] });
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
        const meshBuffers = (stepMode) => [
            { arrayStride: 12, stepMode, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] },
            { arrayStride: 12, stepMode, attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] },
        ];
        const target = [{ format: this.format }];
        const make = (vertexEntry, fragmentEntry, topology, buffers, depthStencil) => device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: { module, entryPoint: vertexEntry, buffers },
            fragment: { module, entryPoint: fragmentEntry, targets: target },
            primitive: { topology, cullMode: "none" },
            depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less", ...depthStencil },
        });
        // The solid pass is pushed back a little so wireframe edges drawn over it win the depth test.
        this._solidPipeline = make("vsMesh", "fsSolid", "triangle-list", meshBuffers("vertex"), { depthBias: 2, depthBiasSlopeScale: 2 });
        this._linePipeline = make("vsMesh", "fsLine", "line-list", meshBuffers("vertex"), { depthCompare: "less-equal" });
        this._pointPipeline = make("vsPoint", "fsPoint", "triangle-strip", meshBuffers("instance"), {});
        this._markerPipeline = make("vsMarker", "fsPoint", "triangle-strip",
            [{ arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }],
            { depthCompare: "always", depthWriteEnabled: false });
    }

    _destroyGeometry() {
        for (const buffer of this._buffers) {
            buffer.destroy();
        }
        this._buffers = [];
        this._geometry = null;
    }

    _buffer(data, usage) {
        const buffer = this.device.createBuffer({ size: Math.max(16, Math.ceil(data.byteLength / 4) * 4), usage: usage | BUFFER_COPY_DST });
        if (data.byteLength) {
            this.device.queue.writeBuffer(buffer, 0, data);
        }
        this._buffers.push(buffer);
        return buffer;
    }

    /**
     * @param {Object} geometry
     * @param {Float32Array} geometry.positions - count * 3
     * @param {Float32Array} geometry.colors - count * 3
     * @param {Uint8Array} geometry.valid - count; 0 excludes an element from points and picking
     * @param {Uint32Array} geometry.triangles - element indices, triangle list
     * @param {Uint32Array} geometry.lines - element indices, line list
     * @param {number[]} geometry.min
     * @param {number[]} geometry.max
     * @param {boolean} [keepCamera]
     */
    setGeometry(geometry, keepCamera) {
        this._destroyGeometry();
        const count = geometry.positions.length / 3;
        this._geometry = {
            ...geometry,
            count,
            positionBuffer: this._buffer(geometry.positions, BUFFER_VERTEX),
            colorBuffer: this._buffer(geometry.colors, BUFFER_VERTEX),
            triangleBuffer: this._buffer(geometry.triangles, BUFFER_INDEX),
            lineBuffer: this._buffer(geometry.lines, BUFFER_INDEX),
            markerBuffer: this._buffer(new Float32Array(3), BUFFER_VERTEX),
        };
        if (!keepCamera) {
            this.resetCamera();
        } else {
            this.render();
        }
    }

    setColors(colors) {
        if (!this._geometry) {
            return;
        }
        this.device.queue.writeBuffer(this._geometry.colorBuffer, 0, colors);
        this.render();
    }

    setMode(mode) {
        this.mode = mode;
        this.render();
    }

    setHighlight(index) {
        this._highlight = index;
        if (this._geometry && index >= 0 && index < this._geometry.count) {
            const p = this._geometry.positions.subarray(index * 3, index * 3 + 3);
            this.device.queue.writeBuffer(this._geometry.markerBuffer, 0, new Float32Array(p));
        }
        this.render();
    }

    resetCamera() {
        const g = this._geometry;
        const min = g?.min ?? [-1, -1, -1];
        const max = g?.max ?? [1, 1, 1];
        const cam = this._camera;
        cam.target = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        cam.radius = Math.max(1e-6, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
        cam.distance = cam.radius * 2.8;
        cam.yaw = 0.6;
        cam.pitch = 0.4;
        this.render();
    }

    _eye() {
        const cam = this._camera;
        const cp = Math.cos(cam.pitch);
        return [
            cam.target[0] + cam.distance * cp * Math.sin(cam.yaw),
            cam.target[1] + cam.distance * Math.sin(cam.pitch),
            cam.target[2] + cam.distance * cp * Math.cos(cam.yaw),
        ];
    }

    _matrices(width, height) {
        const cam = this._camera;
        const near = Math.max(cam.distance - cam.radius * 4, cam.distance * 0.001, 1e-6);
        const far = cam.distance + cam.radius * 4;
        const projection = perspective(Math.PI / 4, width / Math.max(1, height), near, far);
        const view = lookAt(this._eye(), cam.target, [0, 1, 0]);
        return multiply(projection, view);
    }

    render() {
        if (!this._uniform) {
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.floor(this.container.clientWidth * dpr));
        const height = Math.max(1, Math.floor(this.container.clientHeight * dpr));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        if (!this._depth || this._depth.width !== width || this._depth.height !== height) {
            this._depth?.destroy();
            this._depth = this.device.createTexture({ size: [width, height], format: DEPTH_FORMAT, usage: TEXTURE_RENDER_ATTACHMENT });
        }

        const mvp = this._matrices(width, height);
        this._mvp = mvp;
        const uniforms = new Float32Array(24);
        uniforms.set(mvp, 0);
        uniforms[16] = width;
        uniforms[17] = height;
        uniforms[18] = 3 * dpr;
        uniforms[19] = 7 * dpr;
        const wireOnly = this.mode === "Wireframe";
        uniforms.set(wireOnly ? [0.85, 0.85, 0.85, 1] : [0.05, 0.05, 0.05, 1], 20);
        this.device.queue.writeBuffer(this._uniform, 0, uniforms);

        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: [0.13, 0.13, 0.15, 1] }],
            depthStencilAttachment: { view: this._depth.createView(), depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "discard" },
        });
        const g = this._geometry;
        if (g) {
            pass.setBindGroup(0, this._bindGroup);
            pass.setVertexBuffer(0, g.positionBuffer);
            pass.setVertexBuffer(1, g.colorBuffer);
            if ((this.mode === "Solid" || this.mode === "Solid + Wireframe") && g.triangles.length) {
                pass.setPipeline(this._solidPipeline);
                pass.setIndexBuffer(g.triangleBuffer, "uint32");
                pass.drawIndexed(g.triangles.length);
            }
            if ((this.mode === "Wireframe" || this.mode === "Solid + Wireframe" ||
                 (this.mode === "Solid" && !g.triangles.length)) && g.lines.length) {
                pass.setPipeline(this._linePipeline);
                pass.setIndexBuffer(g.lineBuffer, "uint32");
                pass.drawIndexed(g.lines.length);
            }
            if (this.mode === "Points" || (!g.triangles.length && !g.lines.length)) {
                pass.setPipeline(this._pointPipeline);
                pass.draw(4, g.count);
            }
            if (this._highlight >= 0 && this._highlight < g.count && g.valid[this._highlight]) {
                pass.setPipeline(this._markerPipeline);
                pass.setVertexBuffer(0, g.markerBuffer);
                pass.draw(4, 1);
            }
        }
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    /** The element nearest to a canvas-relative CSS pixel, or -1. */
    pick(x, y) {
        const g = this._geometry;
        if (!g || !this._mvp) {
            return -1;
        }
        const width = this.container.clientWidth;
        const height = this.container.clientHeight;
        const m = this._mvp;
        let best = -1;
        let bestDistance = PICK_RADIUS * PICK_RADIUS;
        let bestDepth = Infinity;
        for (let i = 0; i < g.count; ++i) {
            if (!g.valid[i]) {
                continue;
            }
            const px = g.positions[i * 3];
            const py = g.positions[i * 3 + 1];
            const pz = g.positions[i * 3 + 2];
            const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
            if (w <= 0) {
                continue;
            }
            const sx = ((m[0] * px + m[4] * py + m[8] * pz + m[12]) / w * 0.5 + 0.5) * width;
            const sy = (0.5 - (m[1] * px + m[5] * py + m[9] * pz + m[13]) / w * 0.5) * height;
            const d = (sx - x) * (sx - x) + (sy - y) * (sy - y);
            const depth = (m[2] * px + m[6] * py + m[10] * pz + m[14]) / w;
            // Prefer the nearest to the cursor; among vertices at the same spot
            // (shared by several triangles), the one closest to the camera.
            if (d < bestDistance - 1e-3 || (Math.abs(d - bestDistance) <= 1e-3 && depth < bestDepth)) {
                best = i;
                bestDistance = d;
                bestDepth = depth;
            }
        }
        return best;
    }

    _setupEvents() {
        const canvas = this.canvas;
        let drag = null;
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        canvas.addEventListener("pointerdown", (e) => {
            drag = { x: e.clientX, y: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey };
            canvas.setPointerCapture(e.pointerId);
            canvas.style.cursor = "grabbing";
        });
        canvas.addEventListener("pointermove", (e) => {
            if (!drag) {
                return;
            }
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) < 3) {
                return;
            }
            drag.moved = true;
            drag.x = e.clientX;
            drag.y = e.clientY;
            const cam = this._camera;
            if (drag.pan) {
                // Move the target in the camera's view plane.
                const eye = this._eye();
                const forward = normalize(sub(cam.target, eye));
                const right = normalize(cross(forward, [0, 1, 0]));
                const up = cross(right, forward);
                const scale = cam.distance * 0.0015;
                for (let c = 0; c < 3; ++c) {
                    cam.target[c] += (-dx * right[c] + dy * up[c]) * scale;
                }
            } else {
                cam.yaw -= dx * 0.01;
                cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch + dy * 0.01));
            }
            this.render();
        });
        const end = (e) => {
            if (!drag) {
                return;
            }
            const click = !drag.moved && e.type === "pointerup" && e.button === 0 && !e.shiftKey;
            drag = null;
            canvas.style.cursor = "grab";
            if (click) {
                const rect = canvas.getBoundingClientRect();
                const index = this.pick(e.clientX - rect.left, e.clientY - rect.top);
                this.setHighlight(index);
                this.onPick?.(index);
            }
        };
        canvas.addEventListener("pointerup", end);
        canvas.addEventListener("pointercancel", end);
        canvas.addEventListener("wheel", (e) => {
            e.preventDefault();
            const cam = this._camera;
            cam.distance = Math.max(cam.radius * 0.01, cam.distance * Math.exp(e.deltaY * 0.001));
            this.render();
        }, { passive: false });
    }
}
