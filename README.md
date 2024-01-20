# WebGPU Inspector

Inspection debugger for WebGPU

## Installation

- Download project from Github.
- In Chrome, open **chrome://extensions**
- Enable Developer Mode (switch in top-right corner)
- Press **Load Unpacked** button
- Browse to **<webgpu_inspector directory>/extensions** and press **Select Folder**
- Make sure the extension is enabled
![Enable Extension](images/enable_extension.png "Enable Extension")

## Usage

The WebGPU Inspector extension is available from the Developer Tools window.

From a page that has WebGPU content, press **F12** to open the Chrome Developer Tools window. When the WebGPU Inspector extension is enabled in the extension manager, there will be a **WebGPU Inspector** tab.

![WebGPU Inspector Panel](images/webgpu_inspector_panel.png)

### Inspect

The Inspect button will reload the page and inject the WebGPU Inspector into it, reporting information about the state of WebGPU to the tool.

### Record

The Record button will reload the page and inject the WebGPU Recorder into it. This will record all WebGPU commands and data for the given number of **Frames** and then download it to a file called **Filename**.html.
