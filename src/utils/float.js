// From https://stackoverflow.com/questions/5678432/decompressing-half-precision-floats-in-javascript
export function float16ToFloat32(float16) {
    var s = (float16 & 0x8000) >> 15;
    var e = (float16 & 0x7C00) >> 10;
    var f = float16 & 0x03FF;

    if (e == 0) {
      return (s ? -1:1) * Math.pow(2, -14) * (f / Math.pow(2, 10));
    } else if (e == 0x1F) {
      return f ? NaN : ((s ? -1 : 1) * Infinity);
    }

    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + (f / Math.pow(2, 10)));
}

const uint32 = new Uint32Array(1);
const uint32ToFloat32 = new Float32Array(uint32.buffer, 0, 1);

export function float11ToFloat32(f11) {
  const u32 = (((((f11) >> 6) & 0x1F) + (127 - 15)) << 23) | (((f11) & 0x3F) << 17);
  uint32[0] = u32;
  return uint32ToFloat32[0];
}

export function float10ToFloat32(f10) {
  const u32 = (((((f10) >> 5) & 0x1F) + (127 - 15)) << 23) | (((f10) & 0x1F) << 18);
  uint32[0] = u32;
  return uint32ToFloat32[0];
}
