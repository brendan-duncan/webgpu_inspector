// From https://stackoverflow.com/questions/5678432/decompressing-half-precision-floats-in-javascript
export function float16ToFloat(h) {
    var s = (h & 0x8000) >> 15;
    var e = (h & 0x7C00) >> 10;
    var f = h & 0x03FF;

    if (e == 0) {
      return (s ? -1:1) * Math.pow(2, -14) * (f / Math.pow(2, 10));
    } else if (e == 0x1F) {
      return f ? NaN : ((s ? -1 : 1) * Infinity);
    }

    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + (f / Math.pow(2, 10)));
}
