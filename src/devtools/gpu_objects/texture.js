import { GPUObject } from "./gpu_object.js";
import { TextureFormatInfo } from "../../utils/texture_format_info.js";

export class Texture extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
    this.imageData = null;
    this.loadedImageDataChunks = [];
    this.isImageDataLoaded = false;
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

  getGpuSize() {
    const format = this.descriptor?.format;
    const formatInfo = TextureFormatInfo[format];
    const width = this.width;
    if (!format || width <= 0 || !formatInfo) {
      return -1;
    }

    const height = this.height;
    const dimension = this.dimension;
    const blockWidth = width / formatInfo.blockWidth;
    const blockHeight = height / formatInfo.blockHeight;
    const bytesPerBlock = formatInfo.bytesPerBlock;

    if (dimension === "2d") {
      return blockWidth * blockHeight * bytesPerBlock;
    }

    // TODO other dimensions

    return -1;
  }
}
Texture.className = "Texture";
