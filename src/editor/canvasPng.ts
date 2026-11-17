/**
 * The picture on a canvas, as the bytes of a PNG file.
 *
 * It is asked for as text (`toDataURL`) and the text turned into bytes, and
 * not as a file (`toBlob`, or `convertToBlob` of a canvas off the screen),
 * which is what one would reach for. Android's web view makes the file when
 * it finds the time, and finds it late: measured on a phone, a picture of
 * six million pixels took 4 seconds by itself and 13 while its editor was
 * open, whatever its size, and 0.2 seconds as text. Saving a marked picture
 * took 14 seconds for that.
 */
export function canvasPng(canvas: Pick<HTMLCanvasElement, 'toDataURL'>): Uint8Array {
  const address = canvas.toDataURL('image/png');
  const lead = 'data:image/png;base64,';
  // A canvas without a size, or one too large to be written, gives no picture.
  if (!address.startsWith(lead) || address.length === lead.length) {
    throw new Error('The picture could not be written.');
  }
  return bytesOfBase64(address.slice(lead.length));
}

/**
 * The same, a moment later: once what is going on now is done and the
 * screen has had its turn. Writing a large picture takes some tenths of a
 * second in which nothing else happens.
 */
export function canvasPngSoon(canvas: Pick<HTMLCanvasElement, 'toDataURL'>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      try {
        resolve(canvasPng(canvas));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('The picture could not be written.'));
      }
    }, 0);
  });
}

/** The bytes that a base64 text stands for. */
export function bytesOfBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
