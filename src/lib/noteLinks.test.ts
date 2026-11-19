import { beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';
import {
  addressedNotes,
  forgetLinkTitles,
  isNoteAddress,
  learnLinkTitles,
  withLinkAddresses,
  withLinkTitles,
} from './noteLinks';

const ADDRESS =
  'evernote:///view/123456/s12/0a1b2c3d-0000-4000-8000-00000000000a/0a1b2c3d-0000-4000-8000-00000000000a';
/** A link as the import leaves it: Evernote's attributes, the note it was pointed at, its own address for text. */
const link = (id: string, text: string) =>
  `<a href="bever://note/${id}" rev="{&quot;isCached&quot;:false}" rel="noopener noreferrer">${text}</a>`;
const PAGE = `<div>See ${link('one', ADDRESS)} and ${link('two', 'the second note')}.</div><div>${link('gone', ADDRESS)}</div>`;

/** What is stored of a page that the editor wrote the elements of. */
function stored(html: string): string {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  withLinkAddresses(holder);
  return holder.innerHTML;
}

describe('links that say only the address of a note', () => {
  beforeEach(() => {
    forgetLinkTitles();
    vi.restoreAllMocks();
  });

  it('knows an address of a note from words, and from other addresses', () => {
    expect(isNoteAddress(ADDRESS)).toBe(true);
    expect(isNoteAddress(` ${ADDRESS}/ `)).toBe(true);
    expect(
      isNoteAddress('https://www.evernote.com/shard/s12/nl/123456/0a1b2c3d-0000-4000-8000-00000000000a'),
    ).toBe(true);
    expect(
      isNoteAddress('https://www.evernote.com/shard/s12/sh/0a1b2c3d-0000-4000-8000-00000000000a/abc'),
    ).toBe(true);
    expect(isNoteAddress('https://www.evernote.com/l/AbCdEf')).toBe(true);
    expect(isNoteAddress('bever://note/one')).toBe(true);
    expect(isNoteAddress('The second note')).toBe(false);
    expect(isNoteAddress(`${ADDRESS} and more`)).toBe(false);
    expect(isNoteAddress('https://example.com/shard/s1/nl/1/2')).toBe(false);
    expect(isNoteAddress('https://help.evernote.com/hc/en-us')).toBe(false);
  });

  it('asks for the titles of the notes such links lead to, and of no others', async () => {
    expect(addressedNotes(PAGE)).toEqual(['one', 'gone']);
    expect(addressedNotes('<p>No links here.</p>')).toEqual([]);
    const asked = vi.spyOn(api, 'noteTitles').mockResolvedValue({ one: 'Runny nose' });
    await learnLinkTitles('<p>No links here.</p>');
    expect(asked).not.toHaveBeenCalled();
    await learnLinkTitles(PAGE);
    expect(asked).toHaveBeenCalledWith(['one', 'gone']);
  });

  it('shows such a link by the title of its note, and leaves the others as they are', async () => {
    vi.spyOn(api, 'noteTitles').mockResolvedValue({ one: 'Tea & <b>toast</b>' });
    // Until the titles are known the page is as it is stored.
    expect(withLinkTitles(PAGE)).toBe(PAGE);
    await learnLinkTitles(PAGE);
    const shown = document.createElement('div');
    shown.innerHTML = withLinkTitles(PAGE);
    const [one, two, gone] = [...shown.querySelectorAll('a')];
    // The title is text, whatever is in it.
    expect(one?.textContent).toBe('Tea & <b>toast</b>');
    expect(one?.getAttribute('href')).toBe('bever://note/one');
    expect(one?.getAttribute('rev')).toBe('{"isCached":false}');
    expect(two?.textContent).toBe('the second note');
    // A note that is not there has no title to show.
    expect(gone?.textContent).toBe(ADDRESS);
    // And what is stored of the page as it is shown is the page.
    expect(stored(shown.innerHTML)).toBe(stored(PAGE));
    expect(stored(shown.innerHTML)).not.toContain('data-note');
  });

  it('shows a note with no title as Untitled, and a renamed note by its new name', async () => {
    const titles = vi.spyOn(api, 'noteTitles').mockResolvedValue({ one: '  ' });
    await learnLinkTitles(PAGE);
    expect(withLinkTitles(PAGE)).toContain('>Untitled</a>');
    titles.mockResolvedValue({ one: 'Renamed' });
    await learnLinkTitles(PAGE);
    expect(withLinkTitles(PAGE)).toContain('>Renamed</a>');
    // A note deleted since says its address again.
    titles.mockResolvedValue({});
    await learnLinkTitles(PAGE);
    expect(withLinkTitles(PAGE)).toBe(PAGE);
  });

  it('leaves a link that could not be asked about saying its address', async () => {
    vi.spyOn(api, 'noteTitles').mockRejectedValue(new Error('no answer'));
    await learnLinkTitles(PAGE);
    expect(withLinkTitles(PAGE)).toBe(PAGE);
  });

  it('stores the text of a link that was changed by hand', async () => {
    vi.spyOn(api, 'noteTitles').mockResolvedValue({ one: 'Runny nose' });
    await learnLinkTitles(PAGE);
    const shown = withLinkTitles(PAGE);
    // Its text was typed over.
    const typed = stored(shown.replace('>Runny nose</a>', '>My cold</a>'));
    expect(typed).toContain('>My cold</a>');
    expect(typed).not.toContain(ADDRESS + '</a> and');
    expect(typed).not.toContain('data-note');
    // Part of the title was made bold: it is the writer's text now.
    const bold = stored(shown.replace('>Runny nose</a>', '>Runny <strong>nose</strong></a>'));
    expect(bold).toContain('>Runny <strong>nose</strong></a>');
    // All of it made bold is still the title it was given, and is the address again.
    const whole = stored(shown.replace('>Runny nose</a>', '><strong>Runny nose</strong></a>'));
    expect(whole).toContain(`<strong>${ADDRESS}</strong></a>`);
  });

  it('does not take a link with words for one that says an address, though the words are a title', async () => {
    vi.spyOn(api, 'noteTitles').mockResolvedValue({ one: 'the second note' });
    await learnLinkTitles(PAGE);
    // The link to "two" says the same words as the title given to "one":
    // it is stored as it is.
    expect(stored(withLinkTitles(PAGE))).toBe(stored(PAGE));
  });
});
