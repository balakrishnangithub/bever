import { describe, expect, it } from 'vitest';

import { clipInfo, sanitizeClip, sanitizeStyle } from './clipSanitizer';

const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAEAAAUAAQ0KLbQAAAAASUVORK5CYII=';

function render(html: string, allowRemote = false) {
  const clip = sanitizeClip(html, {
    allowRemote,
    resource: (hash) =>
      hash === 'cafe'
        ? { url: 'bever://localhost/sha-of-cafe', mime: 'image/png', name: 'photo.png' }
        : hash === 'd0c'
          ? { url: 'bever://localhost/sha-of-doc', mime: 'application/pdf', name: 'paper.pdf' }
          : null,
  });
  const holder = document.createElement('div');
  holder.appendChild(clip.content);
  return { holder, html: holder.innerHTML, blocked: clip.blockedRemote };
}

describe('web clip sanitizer', () => {
  it('keeps the layout a page was clipped with', () => {
    const { holder } = render(
      '<div style="--en-clipped-content:fullPage;"><ul style="display:flex;list-style:none;gap:10px"><li style="margin-left:10px;padding:7px 0px"><a href="https://example.com/a" style="font-weight:700;color:rgb(20, 30, 40)">Section</a></li></ul><table bgcolor="#eee" cellpadding="4"><tr><td colspan="2" style="float:left;width:50%">Cell</td></tr></table></div>',
    );
    const list = holder.querySelector('ul');
    expect(list?.getAttribute('style')).toBe('display:flex;list-style:none;gap:10px');
    const link = holder.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a');
    expect(link?.getAttribute('style')).toContain('font-weight:700');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(holder.querySelector('table')?.getAttribute('bgcolor')).toBe('#eee');
    expect(holder.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(holder.querySelector('td')?.getAttribute('style')).toBe('float:left;width:50%');
  });

  it('removes everything that could run code or submit data', () => {
    const { holder, html } = render(
      '<div onclick="steal()" id="x" class="y"><script>steal()</script><style>*{display:none}</style>' +
        '<iframe src="https://evil.example"></iframe><object data="x"></object><form action="https://evil.example"><input name="q"><button>Go</button></form>' +
        '<a href="javascript:steal()" onmouseover="steal()">link</a><a href="data:text/html,<script>1</script>">data</a>' +
        '<svg><script>steal()</script></svg><img src="x" onerror="steal()"><p>Kept text</p></div>',
    );
    expect(html).not.toMatch(
      /script|onclick|onerror|onmouseover|javascript:|iframe|object|form|input|button|svg/i,
    );
    expect(html).not.toContain('steal');
    expect(html).not.toMatch(/\sid=|\sclass=/);
    expect(holder.querySelectorAll('a')).toHaveLength(2);
    expect([...holder.querySelectorAll('a')].every((link) => !link.hasAttribute('href'))).toBe(true);
    expect(holder.querySelector('img')).toBeNull();
    expect(holder.textContent).toContain('Kept text');
  });

  it('shows the text of elements it does not know', () => {
    const { holder, html } = render('<div><custom-card><p>Inside a custom element</p></custom-card></div>');
    expect(html).not.toContain('custom-card');
    expect(holder.querySelector('p')?.textContent).toBe('Inside a custom element');
  });

  it('shows attachments of the note and names the ones that are not images', () => {
    const { holder } = render(
      '<div><en-media hash="cafe" type="image/png" width="320" height="200" style="float:right"></en-media><en-media hash="d0c" type="application/pdf"></en-media><en-media hash="gone" type="image/png"></en-media></div>',
    );
    const image = holder.querySelector('img');
    expect(image?.getAttribute('src')).toBe('bever://localhost/sha-of-cafe');
    expect(image?.getAttribute('width')).toBe('320');
    expect(image?.getAttribute('style')).toBe('float:right');
    expect([...holder.querySelectorAll('.clip-attachment')].map((item) => item.textContent)).toEqual([
      'paper.pdf',
      'Attachment',
    ]);
  });

  it('requests nothing from the web until it is allowed to', () => {
    const page =
      `<div><img src="https://tracker.example/pixel.gif"><img src="${pixel}">` +
      '<div style="color:red;background-image:url(https://cdn.example/bg.png)">Text</div>' +
      '<div style="background:url(\'//cdn.example/protocol-relative.png\')">Text</div>' +
      '<div style="background-image:image-set(&quot;https://cdn.example/a.png&quot; 1x)">Text</div></div>';
    const blocked = render(page);
    expect(blocked.html).not.toContain('example');
    expect(blocked.holder.querySelectorAll('img')).toHaveLength(1);
    expect(blocked.holder.querySelector('img')?.getAttribute('src')).toBe(pixel);
    expect(blocked.html).toContain('color:red');
    expect(blocked.blocked).toBe(2);

    const allowed = render(page, true);
    expect(allowed.holder.querySelectorAll('img')).toHaveLength(2);
    expect(allowed.holder.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(allowed.html).toContain('url(https://cdn.example/bg.png)');
    // Never understood well enough to allow, whatever the setting.
    expect(allowed.html).not.toContain('protocol-relative');
    expect(allowed.html).not.toContain('image-set');
    expect(allowed.blocked).toBe(0);
  });
});

describe('web clip styles', () => {
  it('keeps declarations whose value contains a semicolon', () => {
    const style = `background-image:url(${pixel});color:blue`;
    expect(sanitizeStyle(style, false)).toBe(style);
  });

  it('drops what would escape the clipping or size it by the window', () => {
    expect(
      sanitizeStyle(
        'position:fixed;top:0;position: sticky;min-height: 100vh;width:50vw;z-index:9;position:relative',
        true,
      ),
    ).toBe('top:0;z-index:9;position:relative');
  });

  it('drops script-bearing and malformed declarations', () => {
    expect(
      sanitizeStyle(
        'width:expression(alert(1));background:url(javascript:alert(1));behavior:url(x.htc);color:re\\64;filter:url(#f);b@d:1;margin:4px',
        true,
      ),
    ).toBe('margin:4px');
  });
});

describe('web clip details', () => {
  it('reads what Evernote recorded on the wrapper', () => {
    const info = clipInfo(
      '<div style="--en-clipped-content:fullPage; --en-clipped-source-url:https://example.com/story?a=1&amp;b=2; --en-clipped-source-title:A story;"><p>Body</p></div>',
    );
    expect(info).toEqual({
      kind: 'fullPage',
      sourceUrl: 'https://example.com/story?a=1&b=2',
      sourceTitle: 'A story',
    });
  });

  it('does not offer an address that is not a web address', () => {
    const info = clipInfo(
      '<div style="--en-clipped-content:article; --en-clipped-source-url:javascript:alert(1);"></div>',
    );
    expect(info.kind).toBe('article');
    expect(info.sourceUrl).toBeNull();
  });
});

describe('kept markup without a clipping mark', () => {
  it('is called HTML content', () => {
    expect(clipInfo('<div><span style="display:inline-block">a</span></div>')).toEqual({
      kind: 'html',
      sourceUrl: null,
      sourceTitle: null,
    });
    expect(clipInfo('<p>plain</p>').kind).toBe('html');
  });

  it('keeps the styles that lay it out when it is drawn', () => {
    const { holder } = render(
      '<div><span style="display: inline-table; table-layout: fixed;"><span style="display: table-row;"><span style="display: table-cell; vertical-align: bottom; position: relative; top: -3.363em;">½</span></span></span></div>',
    );
    const cell = holder.querySelector('span span span');
    expect(cell?.getAttribute('style')).toBe(
      'display:table-cell;vertical-align:bottom;position:relative;top:-3.363em',
    );
  });
});

describe('markup that is not a clipping', () => {
  const shown = (html: string, options: Partial<Parameters<typeof sanitizeClip>[1]> = {}) => {
    const holder = document.createElement('div');
    holder.appendChild(sanitizeClip(html, { resource: () => null, allowRemote: false, ...options }).content);
    return holder.innerHTML;
  };

  it('shows the pictures a book names by their place in it, where that place is known', () => {
    const html =
      '<p><img src="../images/map.png" alt="A map"><img src="missing.png"><img src="javascript:alert(1)"></p>';
    expect(shown(html)).toBe('<p></p>');
    expect(
      shown(html, { image: (source) => (source === '../images/map.png' ? 'blob:picture-1' : null) }),
    ).toBe('<p><img alt="A map" src="blob:picture-1" referrerpolicy="no-referrer" loading="lazy"></p>');
  });

  it('keeps a link between chapters as what the reader makes of it, and no other address', () => {
    const html =
      '<a href="chapter2.xhtml#top">Next</a> <a href="javascript:alert(1)">No</a> <a href="https://example.com/">Web</a>';
    expect(shown(html)).toBe(
      '<a rel="noopener noreferrer">Next</a> <a rel="noopener noreferrer">No</a> <a href="https://example.com/" rel="noopener noreferrer">Web</a>',
    );
    const link = (address: string) => (address.startsWith('chapter2') ? '#chapter-1' : null);
    expect(shown(html, { link })).toBe(
      '<a href="#chapter-1" rel="noopener noreferrer">Next</a> <a rel="noopener noreferrer">No</a> <a href="https://example.com/" rel="noopener noreferrer">Web</a>',
    );
  });
});
