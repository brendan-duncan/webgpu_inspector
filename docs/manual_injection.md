# Manual Injection

[Overview](../README.md) . [Inspect](inspect.md) . [Capture](capture.md) . [Record](record.md)

* [Adding the Script](#adding-the-script)
* [Viewing What It Records](#viewing-what-it-records)
* [Local Capture API](#local-capture-api)
* [Loading the Script from JavaScript / TypeScript](#loading-the-script-from-javascript--typescript)
* [Inside a Web Worker](#inside-a-web-worker)
* [TypeScript Types](#typescript-types)

If the WebGPU Inspector's automatic injection isn't working to inspect the page (workers inside of
iframes can cause trouble), you can include `webgpu_inspector.js` directly in a page. This also lets
you drive capture from the page itself, with no DevTools panel and no browser extension.

## Adding the Script

Add the script tag to your page **before** any code that uses WebGPU, so the inspector can patch the
WebGPU API before it's used:

```html
<script src="https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@main/extensions/chrome/webgpu_inspector.js"></script>
```

To pin to a specific release instead of tracking `main`, replace `@main` with a version tag, for
example:

```html
<script src="https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@1.2.0/extensions/chrome/webgpu_inspector.js"></script>
```

When loaded this way, the script wraps the page's WebGPU API and exposes the inspector instance as
`webgpuInspector` on the global (i.e. `window.webgpuInspector` in a page context,
`self.webgpuInspector` in a worker context).

## Viewing What It Records

Once the inspector is loaded, you have two ways to view what it records:

1. Open the WebGPU Inspector DevTools panel from the browser extension. The DevTools panel must be
   open when the page is loaded (refreshing the page may be necessary) in order to receive all of the
   WebGPU data from the beginning of the page's execution.
2. Drive capture from the page itself with the [Local Capture API](#local-capture-api) — no DevTools
   panel required.

## Local Capture API

The manually-injected script exposes a small JavaScript API that lets the page record one or more
frames of WebGPU activity entirely on the page side and save the result as a JSON file. The JSON file
is in the same format as **Save Capture** in the DevTools Capture panel produces, so it can be opened
with **Load Capture** in the [Capture panel](capture.md) for inspection.

```js
// 1. Turn on the local capture store. Must be called BEFORE any WebGPU object
// is created — the inspector does not retroactively replay
// descriptors for objects that existed before this call.
webgpuInspector.initialize();

// 2. Wrap one frame's worth of WebGPU work between
// begin/end. Repeat the pair as many times as you want;
// each pair appends another frame's commands (and the
// textures/buffers they reference) to the export.
webgpuInspector.beginFrameCapture();
renderOneFrame();           // your normal WebGPU rendering code
webgpuInspector.endFrameCapture();

// (optional) capture more frames
webgpuInspector.beginFrameCapture();
renderOneFrame();
webgpuInspector.endFrameCapture();

// 3. Wait for any in-flight texture/buffer readbacks,
// build the JSON, and trigger a browser download.
// The filename argument is optional.
await webgpuInspector.saveCaptureData("my_capture.json");
```

`saveCaptureData()` returns a `Promise` that resolves once the download is initiated. To avoid ever
building one giant string (large captures used to overflow V8's ~512MB string limit), the capture is
split into small metadata plus out-of-band payload byte blobs, and the resolved value is
`{ metadata, payloads }`:

- `metadata` — the capture object (objects, command list, validation errors). Buffer/texture bytes
  appear as lightweight `{ __payloadId, __typedArray, __length, __byteLength }` references instead of
  inline base64.
- `payloads` — an array of `{ id, typedArray, bytes }` (the actual `Uint8Array` byte blobs).

The downloaded file is **NDJSON**: the metadata on the first line, then one payload per line. It is
loadable via DevTools "Load Capture" and the plugin's `load_capture_file` tool, which also still
accept the older single-object `.json` captures. To serialize it yourself, use
`captureStreamToLines({ metadata, payloads })` from `src/utils/local_capture.js`.

After `saveCaptureData()` resolves, captured commands are cleared. You can call `beginFrameCapture()`
/ `endFrameCapture()` again to record more frames and `saveCaptureData()` again to produce another
file. Object descriptors that were created earlier remain in the store so they continue to be
available in subsequent captures.

## Loading the Script from JavaScript / TypeScript

The snippets above assume `webgpu_inspector.js` was added with a `<script>` tag. If your project is
driven from JavaScript or TypeScript rather than hand-edited HTML, you can pull the script from the
CDN in code instead.

`webgpu_inspector.js` is not an ES module and exports nothing — it runs as a side effect when loaded
and attaches the inspector instance to the global object (`window.webgpuInspector` in a page,
`self.webgpuInspector` in a worker). It must finish loading **before the first WebGPU object is
created**, so load it ahead of your WebGPU code.

The most portable option — it behaves the same with or without a bundler — is to append a `<script>`
tag at runtime and `await` it. `tsc` and most bundlers won't resolve a remote URL handed to a static
`import`, so this avoids the module resolver entirely:

```ts
function loadWebGPUInspector(
  src = "https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@main/extensions/chrome/webgpu_inspector.js",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

await loadWebGPUInspector();
// webgpuInspector is now on the global — safe to create WebGPU objects after this.
```

If you ship native ES modules with no bundler, a static side-effect import at the top of your entry
module also works. Imports are evaluated before the rest of the module body, so the inspector is
patched in first:

```js
// Keep this as the first import of your entry point.
import "https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@main/extensions/chrome/webgpu_inspector.js";
```

## Inside a Web Worker

The `<script>` form does not apply to workers — a worker loads its entry script directly and has no
DOM. Use one of these depending on the worker's type:

**Classic worker** (`new Worker(url)`) — `importScripts` runs synchronously, so anything below it sees
the inspector already loaded:

```js
importScripts("https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@main/extensions/chrome/webgpu_inspector.js");
// ...rest of the worker
```

**Module worker** (`new Worker(url, { type: "module" })`) — a static `import` at the top of the
worker's entry module:

```js
import "https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@main/extensions/chrome/webgpu_inspector.js";
// ...rest of the worker
```

Top-level `await` is **not** required. ES module semantics hoist static imports: the inspector module
is fully fetched and evaluated before any code in the importing module's body runs, so the WebGPU API
is already wrapped before the worker's own first statement executes. `await import(...)` would also
work but adds nothing for the manual-injection case.

In both worker forms the inspector exposes itself as `self.webgpuInspector` in the worker's global
scope, the same way the page-context form exposes `window.webgpuInspector`.

## TypeScript Types

TypeScript doesn't know `webgpuInspector` exists on the global, so declare it once and the local
capture calls will type-check:

```ts
// webgpu_inspector.d.ts
interface CaptureStream {
  metadata: Record<string, unknown>;
  payloads: Array<{ id: number; typedArray: string; bytes: Uint8Array }>;
}

interface WebGPUInspector {
  initialize(): void;
  beginFrameCapture(options?: {
    maxBufferSize?: number;
    maxTextureSize?: number;
    passLabel?: string | RegExp;
    passType?: "render" | "compute";
  }): void;
  endFrameCapture(): void;
  saveCaptureData(filename?: string, options?: { download?: boolean }): Promise<CaptureStream>;
  readBuffer(bufferId: number, offset?: number, size?: number): Promise<{
    offset: number; byteLength: number; base64: string;
    truncated?: { byteLength: number; capturedBytes: number } | null;
  }>;
}

declare global {
  var webgpuInspector: WebGPUInspector;
}

export {};
```

Swap `@main` for a version tag (e.g. `@1.2.0`) to pin a release, as described in
[Adding the Script](#adding-the-script).
