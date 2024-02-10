# WebGPU Inspector Debugging Tool

**Version: 0.0.2**

Inspection and graphics debugging browser extension tool for WebGPU.

## Installation

### Chrome Web Store

**WebGPU Inspector is still in active development, expect many frequent changes and the published version will lag behind the source version.**

Install WebGPU Inspector from the [Chrome Web Store](https://chromewebstore.google.com/detail/webgpu-inspector/holcbbnljhkpkjkhgkagjkhhpeochfal).

### From Source

To get the most up to date version of WebGPU Inspector, you can install the extension from source.

- Download project from Github.
  - git clone https://github.com/brendan-duncan/webgpu_inspector
- In Chrome, open **chrome://extensions**
- Enable Developer Mode (switch in top-right corner)
- Press **Load Unpacked** button
- Browse to **<webgpu_inspector directory>/extensions** and press **Select Folder**
- Make sure the extension is enabled.

![Enable Extension](docs/images/enable_extension.png "Enable Extension")

## [Documentation](docs/overview.md)

## Usage

The WebGPU Inspector extension is available from the Developer Tools window.

From a page that has WebGPU content, press **F12** to open the Chrome Developer Tools window. When the WebGPU Inspector extension is enabled in the extension manager, there will be a **WebGPU Inspector** tab.

The **WebGPU Inspector** tab contains several tools: [Inspect](docs/inspect.md), [Capture](docs/capture.md), and [Record](docs/record.md).

![WebGPU Inspector GUI](docs/images/webgpu_inspector_gui.png)

## Development

Building the project requires an installation of [Node.js](https://nodejs.org/en/).

- Make sure the dependencies are installed: `npm install`
- Compile the project: `npm run build`.
- Compile on file changes: `npm run watch`.
- To use source maps, edit `rollup.config.js` and change `sourcemap: false` to `sourcemap: true`.

After the project is built:

- If you have the DevTools open, right-click on the WebGPU Inspector DevTools panel, select `Reload frame`.