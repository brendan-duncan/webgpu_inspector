import { GPUObject } from "./gpu_object.js";
import { TextureFormatInfo } from "../../utils/texture_format_info.js";
import { float10ToFloat32, float11ToFloat32, float16ToFloat32 } from "../../utils/float.js";

export class Texture extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, descriptor, stacktrace);
    this.descriptor = descriptor;
    this.imageData = [];
    this.loadedImageDataChunks = [];
    this.imageDataPending = [];
    this.isImageDataLoaded = [];
    this.gpuTexture = null;
    this._layerRanges = null;

    this.display = {
      exposure: 1,
      channels: 0,
      minRnage: 0,
      maxRange: 1,
      mipLevel: 0,
      zoom: 100
    };
  }

  isMipLevelLoaded(mipLevel) {
    return this.imageData.length >= mipLevel && this.imageData[mipLevel] !== undefined;
  }

  get layerRanges() {
    if (this._layerRanges === null) {
      const formatInfo = TextureFormatInfo[this.format];
      if (formatInfo.isDepthStencil) {
        const lr = [];
        const numLayers = this.depthOrArrayLayers;
        const width = this.width;
          const height = this.height;
        for (let layer = 0; layer < numLayers; ++layer) {
          let min = null;
          let max = null;
          for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
              const pixel = this.getPixel(x, y, layer);
              if (min === null || pixel.r < min) {
                min = pixel.r;
              }
              if (max === null || pixel.r > max) {
                max = pixel.r;
              }
            }
          }
          lr.push({ min, max });
        }
        this._layerRanges = lr;
      }
    }
    return this._layerRanges
  }

  getPixel(x, y, z, mipLevel) {
    mipLevel ??= 0;
    mipLevel = Math.max(Math.min(mipLevel, this.mipLevelCount - 1), 0);
    function pixelValue(imageData, offset, format, numChannels) {
      const value = [null, null, null, null];
      for (let i = 0; i < numChannels; ++i) {
        switch (format) {
          case "8unorm":
            value[i] = imageData[offset] / 255;
            offset++;
            break;
          case "8snorm":
            value[i] = (imageData[offset] / 255) * 2 - 1;
            offset++;
            break;
          case "8uint":
            value[i] = imageData[offset];
            offset++;
            break;
          case "8sint":
            value[i] = imageData[offset] - 127;
            offset++;
            break;
          case "16uint":
            value[i] = imageData[offset] | (imageData[offset + 1] << 8);
            offset += 2;
            break;
          case "16sint":
            value[i] = (imageData[offset] | (imageData[offset + 1] << 8)) - 32768;
            offset += 2;
            break;
          case "16float":
            value[i] = float16ToFloat32(imageData[offset] | (imageData[offset + 1] << 8));
            offset += 2;
            break;
          case "32uint":
            value[i] = imageData[offset] | (imageData[offset + 1] << 8) | (imageData[offset + 2] << 16) | (imageData[offset + 3] << 24);
            offset += 4;
            break;
          case "32sint":
            value[i] = (imageData[offset] | (imageData[offset + 1] << 8) | (imageData[offset + 2] << 16) | (imageData[offset + 3] << 24)) | 0;
            offset += 4;
            break;
          case "32float":
            value[i] = new Float32Array(imageData.buffer, offset, 1)[0];
            offset += 4;
            break;
        }
      }
      return value;
    }

    if (this.imageData[mipLevel]) {
      const bytesPerRow = this.bytesPerRow >> mipLevel;
      const height = this.height >> mipLevel;
      const offset = (z * bytesPerRow * height) + y * bytesPerRow + x * this.texelByteSize;
      const imageData = this.imageData[mipLevel];
      switch (this.format) {
        case "r8unorm": {
          const value = pixelValue(imageData, offset, "8unorm", 1);
          return { r: value[0] };
        }
        case "r8snorm": {
          const value = pixelValue(imageData, offset, "8snorm", 1);
          return { r: value[0] };
        }
        case "r8uint": {
          const value = pixelValue(imageData, offset, "8uint", 1);
          return { r: value[0] };
        }
        case "r8sint": {
          const value = pixelValue(imageData, offset, "8sint", 1);
          return { r: value[0] };
        }

        case "rg8unorm": {
          const value = pixelValue(imageData, offset, "8unorm", 2);
          return { r: value[0], g: value[1] };
        }
        case "rg8snorm": {
          const value = pixelValue(imageData, offset, "8snorm", 2);
          return { r: value[0], g: value[1] };
        }
        case "rg8uint": {
          const value = pixelValue(imageData, offset, "8uint", 2);
          return { r: value[0], g: value[1] };
        }
        case "rg8sint": {
          const value = pixelValue(imageData, offset, "8sint", 2);
          return { r: value[0], g: value[1] };
        }

        case "rgba8unorm-srgb":
        case "rgba8unorm": {
          const value = pixelValue(imageData, offset, "8unorm", 4);
          return { r: value[0], g: value[1], b: value[2], a: value[3] };
        }
        case "rgba8snorm": {
          const value = pixelValue(imageData, offset, "8snorm", 4);
          return { r: value[0], g: value[1], b: value[2], a: value[3] };
        }
        case "rgba8uint": {
          const value = pixelValue(imageData, offset, "8uint", 4);
          return { r: value[0], g: value[1], b: value[2], a: value[3] };
        }
        case "rgba8sint": {
          const value = pixelValue(imageData, offset, "8sint", 4);
          return { r: value[0], g: value[1], b: value[2], a: value[3] };
        }

        case "bgra8unorm-srgb":
        case "bgra8unorm": {
          const value = pixelValue(imageData, offset, "8unorm", 4);
          return { r: value[2], g: value[1], b: value[0], a: value[3] };
        }

        case "r16uint": {
          const value = pixelValue(imageData, offset, "16uint", 1);
          return { r: value[0] };
        }
        case "r16sint": {
          const value = pixelValue(imageData, offset, "16sint", 1);
          return { r: value[0] };
        }
        case "r16float": {
          const value = pixelValue(imageData, offset, "16float", 1);
          return { r: value[0] };
        }

        case "rg16uint": {
          const value = pixelValue(imageData, offset, "16uint", 2);
          return { r: value[0], g: value[1] };
        }
        case "rg16sint": {
          const value = pixelValue(imageData, offset, "16sint", 2);
          return { r: value[0], g: value[1] };
        }
        case "rg16float": {
          const value = pixelValue(imageData, offset, "16float", 2);
          return { r: value[0], g: value[1] };
        }

        case "rgba16uint": {
          const value = pixelValue(imageData, offset, "16uint", 4);
          return { r: value[0], g: value[1], b: value[2], a: value[3] };
        }
        case "rgba16sint": {
          const value = pixelValue(imageData, offset, "16sint", 4);
          return { r: value[0], g: value[1], b: value[2], a: value[3] };
        }
        case "rgba16float": {
          const value = pixelValue(imageData, offset, "16float", 4);
          return { r: value[0], g: value[1], b: value[2], a: value[3] };
        }

        case "r32uint": {
          const value = pixelValue(imageData, offset, "32uint", 1);
          return { r: value[0] };
        }
        case "r32sint": {
          const value = pixelValue(imageData, offset, "32sint", 1);
          return { r: value[0] };
        }
        case "depth16unorm": // depth formats get conerted to r32float
        case "depth24plus":
        case "depth24plus-stencil8":
        case "depth32float":
        case "depth32float-stencil8":
        case "r32float": {
          const value = pixelValue(imageData, offset, "32float", 1);
          return { r: value[0] };
        }
        case "rg32uint": {
          const value = pixelValue(imageData, offset, "32uint", 2);
          return { r: value[0], g: value[1] };
        }
        case "rg32sint": {
          const value = pixelValue(imageData, offset, "32sint", 2);
          return { r: value[0], g: value[1] };
        }
        case "rg32float": {
          const value = pixelValue(imageData, offset, "32float", 2);
          return { r: value[0], g: value[1] };
        }
        case "rgba32uint": {
          const value = pixelValue(imageData, offset, "32uint", 4);
          return { r: value[0], g: value[1], b: value[2], a: value[3] };
        }
        case "rgba32sint": {
          const value = pixelValue(imageData, offset, "32sint", 4);
          return { r: value[0], g: value[1], b: value[2], a: value[3] };
        }
        case "rgba32float": {
          const value = pixelValue(imageData, offset, "32float", 4);
          return { r: value[0], g: value[1], b: value[2], a: value[3] };
        }

        case "rg11b10ufloat": {
          const uintValue = new Uint32Array(imageData.buffer, offset, 1)[0];
          const ri = uintValue & 0x7FF;
          const gi = (uintValue & 0x3FF800) >> 11;
          const bi = (uintValue & 0xFFC00000) >> 22;
          const rf = float11ToFloat32(ri);
          const gf = float11ToFloat32(gi);
          const bf = float10ToFloat32(bi);
          return { r: rf, g: gf, b: bf, a: 1.0 };
        }
      }
    }
    return null;
  }

  get format() {
    return this.descriptor?.format ?? "<unknown format>";
  }

  get dimension() {
    return this.descriptor?.dimension ?? "2d";
  }

  get width() {
    const size = this.descriptor?.size;
    if (size instanceof Array && size.length > 0) {
      return size[0] ?? 0;
    } else if (size instanceof Object) {
      return size.width ?? 0;
    }
    return 0;
  }

  get height() {
    const size = this.descriptor?.size;
    if (size instanceof Array && size.length > 1) {
      return size[1] ?? 1;
    } else if (size instanceof Object) {
      return size.height ?? 1;
    }
    return 0;
  }

  get depthOrArrayLayers() {
    const size = this.descriptor?.size;
    if (size instanceof Array && size.length > 2) {
      return size[2] ?? 1;
    } else if (size instanceof Object) {
      return size.depthOrArrayLayers ?? 1;
    }
    return 0;
  }

  get mipLevelCount() {
    return this.descriptor?.mipLevelCount ?? 1;
  }

  getMipSize(level) {
    const mipLevelCount = this.mipLevelCount;
    level = Math.max(Math.min(level, mipLevelCount - 1), 0);
    const mipWidth = this.width >> level;
    const mipHeight = this.height >> level;
    const mipDepthOrArrayLayers = this.dimension === "3d" ? this.depthOrArrayLayers >> level : this.depthOrArrayLayers;
    return [mipWidth, mipHeight, mipDepthOrArrayLayers];
  }

  get resolutionString() {
    const width = this.width;
    const height = this.height;
    const depthOrArrayLayers = this.depthOrArrayLayers;
    const dimension = this.dimension;
    if (dimension === "1d") {
      if (depthOrArrayLayers > 1) {
        return `${width}x${depthOrArrayLayers}`;
      }
      return `${width}`;
    }
    if (depthOrArrayLayers > 1) {
      return `${width}x${height}x${depthOrArrayLayers}`;
    }
    return `${width}x${height}`;
  }

  get texelByteSize() {
    const format = this.descriptor?.format;
    const formatInfo = TextureFormatInfo[format];
    if (!formatInfo) {
      return 0;
    }
    if (formatInfo.isDepthStencil) {
      return 4; // depth textures have r32float imageData
    }
    return formatInfo.bytesPerBlock;
  }

  get bytesPerRow() {
    const width = this.width;
    const texelByteSize = this.texelByteSize;
    return (width * texelByteSize + 255) & ~0xff;
  }

  get isDepthStencil() {
    const format = this.descriptor?.format;
    const formatInfo = TextureFormatInfo[format];
    if (!formatInfo) {
      return false;
    }
    return formatInfo.isDepthStencil;
  }

  getGpuSize() {
    const format = this.descriptor?.format;
    const formatInfo = TextureFormatInfo[format];
    const width = this.width;
    if (!format || width <= 0 || !formatInfo) {
      return -1;
    }

    const height = this.height;
    const depthOrArrayLayers = this.depthOrArrayLayers;
    const dimension = this.dimension;
    const blockWidth = width / formatInfo.blockWidth;
    const blockHeight = dimension === "1d" ? 1 : height / formatInfo.blockHeight;
    const bytesPerBlock = formatInfo.bytesPerBlock;

    return blockWidth * blockHeight * bytesPerBlock * depthOrArrayLayers;
  }
}
Texture.className = "Texture";
