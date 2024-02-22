export const TextureFormatInfo = {
    "r8unorm": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1 },
    "r8snorm": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1 },
    "r8uint": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1 },
    "r8sint": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1 },
    "rg8unorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2 },
    "rg8snorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2 },
    "rg8uint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2 },
    "rg8sint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2 },

    "rgba8unorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rgba8unorm-srgb": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rgba8snorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rgba8uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rgba8sint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "bgra8unorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "bgra8unorm-srgb": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },

    "r16uint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1 },
    "r16sint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1 },
    "r16float": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1 },

    "rg16uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2 },
    "rg16sint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2 },
    "rg16float": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2 },

    "rgba16uint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rgba16sint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rgba16float": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },

    "r32uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1 },
    "r32sint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1 },
    "r32float": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1 },

    "rg32uint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2 },
    "rg32sint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2 },
    "rg32float": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2 },

    "rgba32uint": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rgba32sint": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rgba32float": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rgb10a2uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rgb10a2unorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },
    "rg11b10ufloat": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },

    // Depth Stencil Formats
    "stencil8": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": false, "hasStencil": true, "channels": 1 }, // bytesPerBlock is actually 1-4
    "depth16unorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": false, "channels": 1 },
    "depth24plus": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": false, "depthOnlyFormat": "depth32float", "channels": 1 },
    "depth24plus-stencil8": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": true, "depthOnlyFormat": "depth32float", "channels": 1 }, // bytesPerBlock is actually 4-8
    "depth32float": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": false, "channels": 1 },
    "depth32float-stencil8": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": true, "stencilOnlyFormat": "depth32float", "channels": 1 }, // bytesPerBlock is actually 5-8

    // Packed Formats
    "rgb9e5ufloat": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4 },

    // Compressed Formats
    "bc1-rgba-unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "bc1-rgba-unorm-srgb": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "bc2-rgba-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "bc2-rgba-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "bc3-rgba-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "bc3-rgba-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },

    "bc4-r-unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 1 },
    "bc4-r-snorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 1 },

    "bc5-rg-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 2 },
    "bc5-rg-snorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 2 },

    "bc6h-rgb-ufloat": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "bc6h-rgb-float": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "bc7-rgba-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "bc7-rgba-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    
    "etc2-rgb8unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "etc2-rgb8unorm-srgb": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "etc2-rgb8a1unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "etc2-rgb8a1unorm-srgb": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "etc2-rgba8unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "etc2-rgba8unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    
    "eac-r11unorm": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": true, "channels": 1 },
    "eac-r11snorm": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": true, "channels": 1 },

    "eac-rg11unorm": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": true, "channels": 2 },
    "eac-rg11snorm": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": true, "channels": 2 },

    "astc-4x4-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "astc-4x4-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "astc-5x4-unorm": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "astc-5x4-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 4, "isCompressed": true, "channels": 4 },
    "astc-5x5-unorm": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 5, "isCompressed": true, "channels": 4 },
    "astc-5x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 5, "isCompressed": true, "channels": 4 },
    "astc-6x5-unorm": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 5, "isCompressed": true, "channels": 4 },
    "astc-6x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 5, "isCompressed": true, "channels": 4 },
    "astc-6x6-unorm": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 6, "isCompressed": true, "channels": 4 },
    "astc-6x6-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 6, "isCompressed": true, "channels": 4 },
    "astc-8x5-unorm": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 5, "isCompressed": true, "channels": 4 },
    "astc-8x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 5, "isCompressed": true, "channels": 4 },
    "astc-8x6-unorm": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 6, "isCompressed": true, "channels": 4 },
    "astc-8x6-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 6, "isCompressed": true, "channels": 4 },
    "astc-8x8-unorm": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 8, "isCompressed": true, "channels": 4 },
    "astc-8x8-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 8, "isCompressed": true, "channels": 4 },
    "astc-10x5-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 5, "isCompressed": true, "channels": 4 },
    "astc-10x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 5, "isCompressed": true, "channels": 4 },
    "astc-10x6-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 6, "isCompressed": true, "channels": 4 },
    "astc-10x6-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 6, "isCompressed": true, "channels": 4 },
    "astc-10x8-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 8, "isCompressed": true, "channels": 4 },
    "astc-10x8-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 8, "isCompressed": true, "channels": 4 },
    "astc-10x10-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 10, "isCompressed": true, "channels": 4 },
    "astc-10x10-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 10, "isCompressed": true, "channels": 4 },
    "astc-12x10-unorm": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 10, "isCompressed": true, "channels": 4 },
    "astc-12x10-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 10, "isCompressed": true, "channels": 4 },
    "astc-12x12-unorm": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 12, "isCompressed": true, "channels": 4 },
    "astc-12x12-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 12, "isCompressed": true, "channels": 4 },
};
