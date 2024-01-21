export function toURLFromImageData(data) {
    return new Promise(() => {
      const canvas = document.createElement('canvas');
      canvas.width = data.width;
      canvas.height = data.height;
      const context = canvas.getContext('2d');
      context.putImageData(data, 0, 0);
      canvas.toBlob((blob) => {
        resolve(URL.createObjectURL(blob));
      });
    });
  };
  
  export function toURLFromArrayBuffer(data) {
    const blob = new Blob([data], {type: 'application/octet-stream'});
    return URL.createObjectURL(blob);
  };
