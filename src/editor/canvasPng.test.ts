import { describe, expect, it } from 'vitest';

import { bytesOfBase64, canvasPng, canvasPngSoon } from './canvasPng';

// The smallest of pictures: one pixel.
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('a picture written out of its canvas', () => {
  it('turns base64 into the bytes it stands for', () => {
    expect([...bytesOfBase64('AAEC/w==')]).toEqual([0, 1, 2, 255]);
    expect(bytesOfBase64('')).toHaveLength(0);
  });

  it('is the PNG file the canvas gives as text', () => {
    const bytes = canvasPng({ toDataURL: () => `data:image/png;base64,${PIXEL}` });
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes).toHaveLength(atob(PIXEL).length);
  });

  it('asks for a PNG', () => {
    const asked: (string | undefined)[] = [];
    canvasPng({
      toDataURL: (type?: string) => {
        asked.push(type);
        return `data:image/png;base64,${PIXEL}`;
      },
    });
    expect(asked).toEqual(['image/png']);
  });

  it('says so when the canvas gives no picture', () => {
    // What a canvas without a size answers, and one that could not be written as PNG.
    expect(() => canvasPng({ toDataURL: () => 'data:,' })).toThrow('could not be written');
    expect(() => canvasPng({ toDataURL: () => 'data:image/png;base64,' })).toThrow('could not be written');
    expect(() => canvasPng({ toDataURL: () => 'data:image/jpeg;base64,AAAA' })).toThrow(
      'could not be written',
    );
  });

  it('is written a moment later when asked so, and says then when it cannot be', async () => {
    let asked = false;
    const soon = canvasPngSoon({
      toDataURL: () => {
        asked = true;
        return `data:image/png;base64,${PIXEL}`;
      },
    });
    // Not in the middle of what the caller is doing.
    expect(asked).toBe(false);
    expect(await soon).toHaveLength(atob(PIXEL).length);
    await expect(canvasPngSoon({ toDataURL: () => 'data:,' })).rejects.toThrow('could not be written');
  });
});
