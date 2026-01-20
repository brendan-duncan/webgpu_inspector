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
      if (texture.layerRanges && texture.layerRanges[layer]) {
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

    const canvas = new Widget("canvas", container, { style: "box-shadow: 5px 5px 5px rgba(0,0,0,0.5); image-rendering: -moz-crisp-edges; image-rendering: -webkit-crisp-edges; image-rendering: pixelated;" });
    const zoom = Math.max(texture.display.zoom, 1) / 100;
    canvas.style.width = `${width * zoom}px`;
    canvas.style.height = `${height * zoom}px`;

    this._setupCanvasEvents(canvas, texture, layer, displayChanged, zoomControl);

    canvas.element.width = width;
    canvas.element.height = height;

    this._renderTexture(canvas, texture, layer, false);

    this._setupDisplayChangeListener(displayChanged, canvas, texture, layer);
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
        this.panel._tooltip.style.left = `${event.pageX + 10}px`;
        this.panel._tooltip.style.top = `${event.pageY + 10}px`;
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
      layerArrayCount: 1,
      baseMipLevel: mipLevel,
      mipLevelCount: 1
    };

    const srcView = texture.gpuTexture.object.createView(viewDesc);

    if (texture.layerRanges) {
      texture.display.minRange = texture.layerRanges[layer].min;
      texture.display.maxRange = texture.layerRanges[layer].max;
    }

    const numLayers = texture.depthOrArrayLayers;
    const hl = 0.5 / (numLayers || 1);

    this.panel.textureUtils.blitTexture(srcView, texture.format, 1, canvasTexture.createView(), format,
        texture.display, texture.descriptor.dimension, (layer / texture.depthOrArrayLayers) + hl,
        skipMinMax ? null : (minRange, maxRange) => {
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
