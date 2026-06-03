import { Widget } from "./widget/widget.js";
import { Checkbox } from "./widget/checkbox.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Select } from "./widget/select.js";
import { NumberInput } from "./widget/number_input.js";
import { Signal } from "../utils/signal.js";

export class TextureViewer extends Div {
  constructor(panel, parent, texture) {
    super(parent);

    this.panel = panel;

    const mipLevel = Math.max(Math.min(texture.display.mipLevel || 0, texture.mipLevelCount), 0);

    const width = (texture.width >> mipLevel) || texture.width;
    const height = (texture.height >> mipLevel) || texture.height;

    const numLayers = texture.depthOrArrayLayers;

    const container = new Div(this, { style: "margin-bottom: 5px; margin-top: 10px;" });
    const displayChanged = new Signal();
    const controls = new Div(container);

    this.layerTitles = [];
    this.layerPixelInfo = [];

    const zoomControl = this._createTextureControls(controls, texture, displayChanged);

    if (!this.panel._tooltip) {
      this._createTooltip();
    }

    for (let layer = 0; layer < numLayers; ++layer) {
      this._createTextureLayer(container, texture, layer, width, height, displayChanged, zoomControl);
    }
  }

  _createTextureControls(controls, texture, displayChanged) {
    const mipLevels = Array.from({length: texture.mipLevelCount}, (_,i)=>i.toString());

    new Span(controls, { text: "Mip Level", style: "margin-right: 3px; font-size: 9pt; color: #bbb;" });

    let zoomControl = null;

    new Select(controls, {
      options: mipLevels,
      index: texture.display.mipLevel,
      style: "color: #fff; margin-left: 10px; font-size: 10pt; width: 100px;",
      onChange: (value) => {
        const index = mipLevels.indexOf(value);
        texture.display.mipLevel = index || 0;
        if (this.panel._tooltip) {
          this.panel._tooltip.style.display = 'none';
          document.body.removeChild(this.panel._tooltip);
          this.panel._tooltip = null;
        }
        if (texture.isMipLevelLoaded(texture.display.mipLevel)) {
          displayChanged.emit(1);
        } else {
          this.panel.database.requestTextureData(texture, texture.display.mipLevel || 0);
        }
      }
    });

    new Checkbox(controls, { text: "Auto Range", checked: texture.display.autoRange, style: "font-size: 9pt; color: #bbb;", onChange: (checked) => {
      texture.display.autoRange = checked;
      displayChanged.emit(1);
    } });

    new Span(controls, { text: "Exposure", style: "margin-left: 10px; margin-right: 3px; font-size: 9pt; color: #bbb;" });
    new NumberInput(controls, { value: texture.display.exposure, step: 0.01, onChange: (value) => {
      texture.display.exposure = value;
      displayChanged.emit(1);
    }, style: "width: 100px; display: inline-block;" });

    const channels = ["RGB", "Red", "Green", "Blue", "Alpha", "Luminance"];
    new Select(controls, {
      options: channels,
      index: 0,
      style: "color: #fff; margin-left: 10px; font-size: 10pt; width: 100px;",
      onChange: (value) => {
        const index = channels.indexOf(value);
        texture.display.channels = index;
        displayChanged.emit(1);
      }
    });

    new Span(controls, { text: "Zoom", tooltip: "Zoom level of the texture, CTRL + mouse-wheel", style: "margin-left: 10px; margin-right: 3px; font-size: 9pt; color: #bbb;" });
    zoomControl = new NumberInput(controls, { tooltip: "Zoom level of the texture, CTRL + mouse-wheel", value: texture.display.zoom, step: 1, min: 0, onChange: (value) => {
      texture.display.zoom = value;
      displayChanged.emit(1);
    }, style: "width: 100px; display: inline-block;" });

    return zoomControl;
  }

  _createTooltip() {
    this.panel._tooltip = document.createElement('pre');
    document.body.appendChild(this.panel._tooltip);
    this.panel._tooltip.classList.add('inspector-tooltip');
    this.panel._tooltip.style.display = 'none';
  }

  _getPixelString(pixel) {
    if (!pixel) {
      return "<unknown pixel value>";
    }
    let str = "";
    if (pixel.r !== undefined) {
      str += `R: ${pixel.r}\n`;
    }
    if (pixel.g !== undefined) {
      str += `G: ${pixel.g}\n`;
    }
    if (pixel.b !== undefined) {
      str += `B: ${pixel.b}\n`;
    }
    if (pixel.a !== undefined) {
      str += `A: ${pixel.a}\n`;
    }
    return str;
  }

  _updateLayerTitle(texture, layer) {
    const layerTitle = this.layerTitles[layer];
    if (layerTitle) {
      let text = `Layer ${layer}`;
      if (texture.layerRanges && texture.layerRanges[layer] && texture.layerRanges[layer].min !== undefined && texture.layerRanges[layer].max !== undefined) {
        const ranges = texture.layerRanges[layer];
        text += ` Min Value: ${ranges.min} Max Value: ${ranges.max}`;
      }
      if (this.layerPixelInfo[layer]) {
        text += ` Pixel: ${this.layerPixelInfo[layer]}`;
      }
      layerTitle.text = text;
    }
  }

  _createTextureLayer(container, texture, layer, width, height, displayChanged, zoomControl) {
    const layerInfo = new Div(container, { class: 'inspect_texture_layer_info' });
    this.layerTitles[layer] = new Span(layerInfo);
    this._updateLayerTitle(texture, layer);

    const canvasContainer = new Div(container, { style: "position: relative; display: inline-block; line-height: 0;" });
    const canvas = new Widget("canvas", canvasContainer, { style: "display: block; box-shadow: 5px 5px 5px rgba(0,0,0,0.5); image-rendering: -moz-crisp-edges; image-rendering: -webkit-crisp-edges; image-rendering: pixelated;" });
    const zoom = Math.max(texture.display.zoom, 1) / 100;
    canvas.style.width = `${width * zoom}px`;
    canvas.style.height = `${height * zoom}px`;

    this._setupCanvasEvents(canvas, texture, layer, displayChanged, zoomControl);
    this._createCopyButton(canvasContainer, canvas);

    canvas.element.width = width;
    canvas.element.height = height;

    this._renderTexture(canvas, texture, layer, false);

    this._setupDisplayChangeListener(displayChanged, canvas, texture, layer);
  }

  _createCopyButton(parent, canvas) {
    const button = new Widget("button", parent, {
      title: "Copy image as PNG",
      style: "position: absolute; top: 4px; left: 4px; width: 24px; height: 24px; padding: 3px; border: 1px solid rgba(255,255,255,0.4); border-radius: 3px; background: rgba(20,20,20,0.72); color: #fff; cursor: pointer; line-height: 0; z-index: 1;"
    });
    button.element.type = "button";
    button.element.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
        <rect x="9" y="9" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"></rect>
        <path d="M5 15V6.5C5 5.7 5.7 5 6.5 5H15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
      </svg>`;
    button.element.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await this._copyCanvasToClipboard(canvas.element, button.element);
    });
  }

  async _copyCanvasToClipboard(canvas, button) {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        throw new Error("PNG clipboard copy is not available in this browser.");
      }

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error("Failed to encode texture preview as PNG."));
          }
        }, "image/png");
      });

      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ]);
      this._setCopyButtonStatus(button, "Copied");
    } catch (error) {
      console.error(error);
      this._setCopyButtonStatus(button, "Copy failed");
    }
  }

  _setCopyButtonStatus(button, message) {
    const previousTitle = button.title;
    button.title = message;
    window.setTimeout(() => {
      button.title = previousTitle || "Copy image as PNG";
    }, 1500);
  }

  _setupCanvasEvents(canvas, texture, layer, displayChanged, zoomControl) {
    canvas.element.addEventListener("mouseenter", (event) => {
      if (this.panel._tooltip) {
        this.panel._tooltip.style.display = 'block';
      }
    });

    canvas.element.addEventListener("mouseleave", (event) => {
      if (this.panel._tooltip) {
        this.panel._tooltip.style.display = 'none';
      }
    });

    canvas.element.addEventListener("mousedown", (event) => {
      const zoom = Math.max(texture.display.zoom, 1) / 100;
      const x = Math.max(Math.floor(event.offsetX / zoom), 0);
      const y = Math.max(Math.floor(event.offsetY / zoom), 0);
      const pixel = texture.getPixel(x, y, layer, texture.display?.mipLevel ?? 0);
      const pixelStr = this._getPixelString(pixel).replaceAll("\n", ", ");
      this.layerPixelInfo[layer] = `X:${x} Y:${y}, ${pixelStr}`;
      this._updateLayerTitle(texture, layer);
    });

    canvas.element.addEventListener("mousemove", (event) => {
      if (this.panel._tooltip) {
        const zoom = Math.max(texture.display.zoom, 1) / 100;
        const x = Math.max(Math.floor(event.offsetX / zoom), 0);
        const y = Math.max(Math.floor(event.offsetY / zoom), 0);
        const pixel = texture.getPixel(x, y, layer, texture.display?.mipLevel ?? 0);

        // Position the (fixed) tooltip relative to the viewport, flipping it to the left/above the
        // cursor when it would extend past the right/bottom edge so it stays fully on screen.
        const tooltip = this.panel._tooltip;
        const margin = 10;
        const tw = tooltip.offsetWidth || 160;
        const th = tooltip.offsetHeight || 110;
        let left = event.clientX + margin;
        let top = event.clientY + margin;
        if (left + tw > window.innerWidth) {
          left = Math.max(0, event.clientX - tw - margin);
        }
        if (top + th > window.innerHeight) {
          top = Math.max(0, event.clientY - th - margin);
        }
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
        const pixelStr = this._getPixelString(pixel);
        this.panel._tooltip.innerHTML = `X:${x} Y:${y}\n${pixelStr}`;

        if (event.buttons === 1) {
          this.layerPixelInfo[layer] = `X:${x} Y:${y}, ${pixelStr.replaceAll("\n", ", ")}`;
          this._updateLayerTitle(texture, layer);
        }
      }
    });

    canvas.element.addEventListener('wheel', (event) => {
      if (event.ctrlKey) {
        event.preventDefault();
        let zoom = texture.display.zoom;
        if (event.deltaY < 0) {
          zoom += 10;
        } else {
          zoom -= 10;
        }
        zoom = Math.max(0, zoom);
        if (zoomControl) {
          zoomControl.setValue(zoom);
        }
        texture.display.zoom = zoom;
        displayChanged.emit(1);
      }
    });
  }

  _renderTexture(canvas, texture, layer, skipMinMax) {
    const layerTitle = this.layerTitles[layer];
    const mipLevel = Math.max(Math.min(texture.display.mipLevel || 0, texture.mipLevelCount), 0);
    const width = (texture.width >> mipLevel) || texture.width;
    const height = (texture.height >> mipLevel) || texture.height;

    canvas.element.width = width;
    canvas.element.height = height;

    const context = canvas.element.getContext("webgpu");
    const format = navigator.gpu.getPreferredCanvasFormat();
    const device = this.panel.window.device;
    context.configure({ device, format });
    const canvasTexture = context.getCurrentTexture();

    const viewDesc = {
      aspect: "all",
      dimension: texture.descriptor.dimension ?? "2d",
      baseArrayLayer: texture.descriptor.dimension == "3d" ? 0 : layer,
      arrayLayerCount: 1,
      baseMipLevel: mipLevel,
      mipLevelCount: 1
    };

    const srcView = texture.gpuTexture.object.createView(viewDesc);

    if (texture.layerRanges) {
      texture.display.minRange = texture.layerRanges[layer]?.min ?? 0;
      texture.display.maxRange = texture.layerRanges[layer]?.max ?? 1;
    }

    const numLayers = texture.depthOrArrayLayers;
    const hl = 0.5 / (numLayers || 1);

    this.panel.textureUtils.blitTexture(srcView, texture.format, 1, canvasTexture.createView(), format,
        texture.display, texture.descriptor.dimension, (layer / texture.depthOrArrayLayers) + hl,
        skipMinMax ? null : (minRange, maxRange) => {
          if (texture.usesGlobalLayerRange) {
            return;
          }
          texture._layerRanges = texture._layerRanges || [];
          texture._layerRanges[layer] = { min: minRange, max: maxRange };
          if (layerTitle) {
            this._updateLayerTitle(texture, layer);
          }
        }
    );

    const zoom = Math.max(texture.display.zoom, 1) / 100;
    canvas.style.width = `${width * zoom}px`;
    canvas.style.height = `${height * zoom}px`;
  }

  _setupDisplayChangeListener(displayChanged, canvas, texture, layer) {
    const self = this;
    displayChanged.addListener((skipMinMax) => {
      self._renderTexture(canvas, texture, layer, !!skipMinMax);
    });
  }
}
