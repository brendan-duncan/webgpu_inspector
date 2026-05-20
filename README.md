# WebGPU Inspector

[Inspect](docs/inspect.md) . [Capture](docs/capture.md) . [Record](docs/record.md)

* [Introduction](#introduction)
* [Developer Tools Window](#developer-tools-window)
  * [Extension Problem Solving](#problem-solving)
* [Installation](#installation)
  * [Chrome Web Store](#chrome-web-store)
  * [Firefox Add-Ons Store](#firefox-add-ons-store)
  * [Manual Installation (CDN)](#manual-installation-cdn)
  * [Building From Source](#from-source)
    * [Chrome](#chrome)
    * [Firefox](#firefox-nightly)
    * [Safari](#safari-technology-preview)
* [Claude Code Integration](#claude-code-integration)
* [Development](#development)

## Introduction

Inspection, profiling, and graphics debugging browser extension for WebGPU.

WebGPU Inspector is designed to inspect what's happening with WebGPU on the page, independent of the engine.

WebGPU Inspector includes the following tools:

* **[Inspect](docs/inspect.md)** records all GPU objects live on the page, letting you inspect their details.
* **[Capture](docs/capture.md)** records the GPU commands used to render a frame, letting you inspect details about each command.
* **[Record](docs/record.md)** records all GPU commands and data used to render a set of frames, generating a self-contained HTML file that can play back the render, or be used for bug reports.

WebGPU Inspector provides the following capabilities:
* A live view of all GPU objects and inspect their details.
* Capture all GPU commands used to render a frame, along with render pass output images, textures, buffer data, render state.
* Edit shaders live on the page.
* [Debug shaders](docs/shader_debugger.md)
* Inspect storage and uniform buffers used for draw and dispatch calls.
* Inspect textures, including pixel values.
* Plot frame times and object allocations over time.
* Record all commands and data for a set of frames for playback or bug reports.

<a href="docs/images/webgpu_inspector_screen.png">
<img src="docs/images/webgpu_inspector_screen.png" style="width: 512px; border-radius: 10px; box-shadow: 3px 3px 10px rgba(0,0,0,0.5);">
</a>

### Developer Tools window
Select __More Tools / Developer Tools__, or press __F12__ or __Shit+CTRL+J__ (__Option + ⌘ + J__ on MacOS). You can also right-click on the page and select __Inspect__. When the WebGPU Inspector extension is enabled in the extension manager, there will be a **WebGPU Inspector** tab.

![WebGPU Inspector Panel](docs/images/webgpu_inspector_panel.png)

### Extension Problem Solving

##### [Back to top](#webgpu-inspector)

#### WebGPU Inspector panel missing from Developer Tools

If the WebGPU Inspector tab is not present on the Developer Tools panel, try closing the Developer Tools window and opening it again. Sometimes the browser doesn't load the extension.

#### Inspect Start, Capture, or Record does not work

Sometimes the browser extension script does not get injected into the page properly. Refresh the page and WebGPU Inspector should start working.

#### Inspect is running but Capture does not work

Some pages will not update if they do not have focus. If Capture is not recording anything, try selecting the page to make sure it has focus.


## Installation

##### [Back to top](#webgpu-inspector)

### Chrome Web Store

Install WebGPU Inspector from the [Chrome Web Store](https://chromewebstore.google.com/detail/webgpu-inspector/holcbbnljhkpkjkhgkagjkhhpeochfal).

### Firefox Add-Ons Store

Install WebGPU Inspector from the [Firefox Add-Ons Store](https://addons.mozilla.org/en-US/firefox/addon/webgpu-inspector).

### Manual Injection

##### [Back to top](#webgpu-inspector)

If the WebGPU Inspectors automatic injection isn't working to inspect the page (workers inside of iframes cause trouble), you can include `webgpu_inspector.js` directly in a page.

Add the script tag to your page **before** any code that uses WebGPU, so the inspector can patch the WebGPU API before it's used:

```html
<script src="https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@main/extensions/chrome/webgpu_inspector.js"></script>
```

To pin to a specific release instead of tracking `main`, replace `@main` with a version tag, for example:

```html
<script src="https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@1.0.2/extensions/chrome/webgpu_inspector.js"></script>
```

When loaded this way, the script wraps the page's WebGPU API and exposes the inspector instance as `webgpuInspector` on the global (i.e. `window.webgpuInspector` in a page context, `self.webgpuInspector` in a worker context).

Once the inspector is loaded, you have two ways to view what it records:

1. Open the WebGPU Inspector DevTools panel from the browser extension. The DevTools panel must be open when the page is loaded (refreshing the page may be necessary) in order to receive all of the WebGPU data from the beginning of the page's execution.
2. Drive capture from the page itself with the local capture API described below — no DevTools panel required.

#### Local Capture API

The manually-injected script exposes a small JavaScript API that lets the page record one or more frames of WebGPU activity entirely on the page side and save the result as a JSON file. The JSON file is in the same format as **Save Capture** in the DevTools Capture panel produces, so it can be opened with **Load Capture** in the Capture panel for inspection.

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

`saveCaptureData()` returns a `Promise` that resolves with the JSON object once the download is initiated. The returned object is the parsed JSON, so callers that want to handle the bytes themselves (e.g. send to a server) can stringify it instead of relying on the download.

After `saveCaptureData()` resolves, captured commands are cleared. You can call `beginFrameCapture()` / `endFrameCapture()` again to record more frames and `saveCaptureData()` again to produce another file. Object descriptors that were created earlier remain in the store so they continue to be available in subsequent captures.

#### Loading the script from JavaScript / TypeScript

The snippets above assume `webgpu_inspector.js` was added with a `<script>` tag. If your project is driven from JavaScript or TypeScript rather than hand-edited HTML, you can pull the script from the CDN in code instead.

`webgpu_inspector.js` is not an ES module and exports nothing — it runs as a side effect when loaded and attaches the inspector instance to the global object (`window.webgpuInspector` in a page, `self.webgpuInspector` in a worker). It must finish loading **before the first WebGPU object is created**, so load it ahead of your WebGPU code.

The most portable option — it behaves the same with or without a bundler — is to append a `<script>` tag at runtime and `await` it. `tsc` and most bundlers won't resolve a remote URL handed to a static `import`, so this avoids the module resolver entirely:

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

If you ship native ES modules with no bundler, a static side-effect import at the top of your entry module also works. Imports are evaluated before the rest of the module body, so the inspector is patched in first:

```js
// Keep this as the first import of your entry point.
import "https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@main/extensions/chrome/webgpu_inspector.js";
```

Inside a worker, load it synchronously as the worker's first statement:

```js
importScripts("https://cdn.jsdelivr.net/gh/brendan-duncan/webgpu_inspector@main/extensions/chrome/webgpu_inspector.js");
```

TypeScript doesn't know `webgpuInspector` exists on the global, so declare it once and the local capture calls below will type-check:

```ts
// webgpu_inspector.d.ts
interface WebGPUInspector {
  initialize(): void;
  beginFrameCapture(): void;
  endFrameCapture(): void;
  saveCaptureData(filename?: string): Promise<Record<string, unknown>>;
}

declare global {
  var webgpuInspector: WebGPUInspector;
}

export {};
```

Swap `@main` for a version tag (e.g. `@1.1.0`) to pin a release, as described above.

### Claude Code Integration

##### [Back to top](#webgpu-inspector)

WebGPU Inspector can be integrated with [Claude Code](https://claude.com/claude-code) as a plugin that brings WebGPU frame capture and analysis into a conversation with Claude.

Claude can launch (or attach to) a browser, instrument any page — with no
browser extension and no changes to the page being analyzed — capture one or
more frames, and then analyze the result: command and draw-call counts, the GPU
object graph, shaders, validation errors, and common performance problems. It
builds on the [Local Capture API](#local-capture-api) and produces the same
capture JSON the DevTools Capture panel reads.

The plugin lives in [claude-plugin/](claude-plugin/) — see
[claude-plugin/README.md](claude-plugin/README.md) for installation and usage.

### Building From Source

##### [Back to top](#webgpu-inspector)

To get the most up to date version of WebGPU Inspector, you can install the extension from source.

- Download project from Github.
  - git clone https://github.com/brendan-duncan/webgpu_inspector

Crome and Firefox don't support the same version of extension plug-ins, so you'll need to load the correct version.

#### Chrome
- Open **chrome://extensions**
- Enable Developer Mode (switch in top-right corner)
- Press **Load Unpacked** button
- Browse to **<webgpu_inspector directory>/extensions/chrome** and press **Select Folder**

#### Edge
- Open **edge://extensions**
- Enable Developer Mode (switch on left side of page)
- Press **Load Unpacked** button
- Browse to **<webgpu_inspector directory>/extensions/chrome** and press **Select Folder**

#### Firefox Nightly
- [Firefox Nightly](https://www.mozilla.org/en-US/firefox/channel/desktop/) has work-in-progress WebGPU support, which you can enable from **Settings / Nightly Experiments / Web API: WebGPU**
- Open **about:debugging**
- Select **This Nightly** from the left side of the page, depending on which version of Firefox you're using.
  - Only **Firefox Nightly** has WebGPU support, currently.
- Press **Load Temporary Add-On**.
- Browse to **<webgpu_inspector directory>/extensions/firefox**, select **manifest.json** and press **Open**.
- **Temporary Add-On's will need to be re-loaded every time you start Firefox.**

#### Safari Technology Preview
- **Note**:
  - Safari support is still a work-in-progress and has issues
- [Safari Technology Preview](https://developer.apple.com/safari/technology-preview/) has WebGPU support, which you can enable from **Develop / Feature Flags... / WebGPU**.
- Safari Extension development is done through Xcode
- Open **<webgpu_inspector directory>/extensions/safari/WebGPU_Inspector.xcodeproj** with Xcode
  - Switch the Scheme to **WebGPU Inspector (macOS)**
  - Select **Product / Run**
- From Safari Technology Preview
  - Select **Develop / Developer Settings...**
  - Enable **Allow unsigned extensions**
  - Select the **Extensions** tab in Settings, and make sure WebGPU Inspector is listed as an extension
  - WebGPU Inspector should be a tab in the Web Inspector window (**Develop / Show Web Inspector** or right-click on page and select **Inspect element**)
- If you make changes to the WebGPU Inspector source
  - From Xcode, select **Product / Build** (**cmd-b**)

## Development

##### [Back to top](#webgpu-inspector)

Building the project requires an installation of [Node.js](https://nodejs.org/en/).

- Make sure the dependencies are installed: `npm install`
- Compile the project: `npm run build`.
- Compile on file changes: `npm run watch`.

Update the plugin version from rollup.config.js.

After the project is built:

- If you have the DevTools open, right-click on the WebGPU Inspector DevTools panel, select `Reload frame`.
- Some changes require a full reload. Open **chrome://extensions**, press the refresh button for the WebGPU Inspector extension. With DevTools open for the page, right-click on the refresh button for the page and select "Empty Cache and Hard Reload". Then right-click on the WebGPU Inspector DevTools panel and select "Reload frame". This will make sure Chrome's cache has been fully cleared.

**Notes** 
- Sometimes the terser minimizer can make source map debugging problematic. To simplify debugging, edit **rollup.config.js** and comment out the terser entry in plugins.

## External Dependencies

##### [Back to top](#webgpu-inspector)

* [WGSL Reflect](https://github.com/brendan-duncan/wgsl_reflect)
  * Used for parsing and getting reflection information from WGSL shaders.
* [WebGPU Recorder](https://github.com/brendan-duncan/webgpu_recorder)
  * Used for generating recordings of WebGPU content.



