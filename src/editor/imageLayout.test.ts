import { describe, expect, it } from 'vitest';

import { readImageLayout, withImageLayout, withNaturalSize } from './imageLayout';

describe('image size and placement as Evernote records them', () => {
  it('reads a width in pixels, the alignment, and the proportions', () => {
    expect(
      readImageLayout({
        width: '400px',
        style: '--en-naturalWidth:643; --en-naturalHeight:150; --en-imageAlignment:center;',
      }),
    ).toEqual({ width: '400px', fill: false, alignment: 'center', ratio: 643 / 150 });
  });

  it('reads widths written with fractions, without a unit, or in percent', () => {
    expect(readImageLayout({ width: '655.7661960767663px' }).width).toBe('656px');
    expect(readImageLayout({ width: '250' }).width).toBe('250px');
    expect(readImageLayout({ width: '100%' })).toMatchObject({ width: '100%', fill: true });
    expect(readImageLayout({ width: '60%' })).toMatchObject({ width: '60%', fill: false });
  });

  it('falls back to the picture’s own size and the left when nothing usable is written', () => {
    for (const attributes of [{}, { width: 'auto' }, { width: '0px' }, { width: null, style: null }]) {
      expect(readImageLayout(attributes)).toEqual({
        width: null,
        fill: false,
        alignment: 'left',
        ratio: null,
      });
    }
    expect(readImageLayout({ style: '--en-imageAlignment:justify;' }).alignment).toBe('left');
  });

  it('takes the proportions from width and height when the picture’s own size is not recorded', () => {
    expect(readImageLayout({ width: '300', height: '150' }).ratio).toBe(2);
    expect(readImageLayout({ width: '50%', height: '150' }).ratio).toBeNull();
  });

  it('writes a new width and drops the height that would distort the picture', () => {
    expect(
      withImageLayout(
        { width: '250px', height: '190', style: '--en-naturalWidth:350; --en-naturalHeight:266;' },
        { width: 311.6 },
      ),
    ).toEqual({ width: '312px', height: null, style: '--en-naturalWidth:350; --en-naturalHeight:266;' });
  });

  it('writes the alignment the way Evernote does and keeps the rest of the style', () => {
    const attributes = { width: '250px', style: '--en-naturalWidth:350; --en-naturalHeight:266;' };
    const centred = withImageLayout(attributes, { alignment: 'center' });
    expect(centred.style).toBe('--en-naturalWidth:350; --en-naturalHeight:266; --en-imageAlignment:center;');
    expect(centred.width).toBe('250px');
    const right = withImageLayout({ ...attributes, style: centred.style }, { alignment: 'right' });
    expect(right.style).toBe('--en-naturalWidth:350; --en-naturalHeight:266; --en-imageAlignment:right;');
    // Left is the absence of an alignment.
    expect(withImageLayout({ style: right.style }, { alignment: 'left' }).style).toBe(
      '--en-naturalWidth:350; --en-naturalHeight:266;',
    );
    expect(withImageLayout({}, { alignment: 'left' }).style).toBeNull();
  });

  it('fills the width of the note, and returns to the picture’s own size', () => {
    expect(withImageLayout({ width: '250px' }, { width: 'fill' }).width).toBe('100%');
    expect(withImageLayout({ width: '100%' }, { width: null }).width).toBeNull();
    expect(withImageLayout({ width: '250px' }, { width: 3 }).width).toBe('16px');
  });

  it('round-trips through reading', () => {
    const written = withImageLayout(
      { style: '--en-naturalWidth:800; --en-naturalHeight:400;' },
      {
        width: 320,
        alignment: 'center',
      },
    );
    expect(readImageLayout(written)).toEqual({ width: '320px', fill: false, alignment: 'center', ratio: 2 });
  });
});

describe('a picture whose own size has changed', () => {
  it('is shown at the scale it was shown at', () => {
    const before = {
      width: '655.7661960767663px',
      style: '--en-naturalWidth:742; --en-naturalHeight:805; --en-imageAlignment:center;',
    };
    const after = withNaturalSize(before, 1113, 805);
    expect(after.width).toBe('984px');
    expect(after.style).toBe('--en-naturalWidth:1113; --en-naturalHeight:805; --en-imageAlignment:center;');
    expect(readImageLayout(after)).toMatchObject({ width: '984px', alignment: 'center' });
  });

  it('keeps a width in percent, and no width at all', () => {
    expect(
      withNaturalSize({ width: '60%', style: '--en-naturalWidth:100; --en-naturalHeight:50;' }, 200, 50),
    ).toEqual({ width: '60%', height: null, style: '--en-naturalWidth:200; --en-naturalHeight:50;' });
    expect(withNaturalSize({}, 300, 120)).toEqual({
      width: null,
      height: null,
      style: '--en-naturalWidth:300; --en-naturalHeight:120;',
    });
  });
});
