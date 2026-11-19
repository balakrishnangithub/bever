import { api } from '../lib/api';
import { isNoteAddress } from '../lib/noteLinks';
import { useLibraryStore } from '../store/useLibraryStore';

const isEvernoteNoteLink = (href: string) =>
  /^(evernote:\/\/\/view\/|https?:\/\/(www\.)?evernote\.com\/(shard|l)\/)/i.test(href);

/**
 * Follows a link clicked in a note: to another note, to a search for the
 * note an unresolved Evernote link names, or out to the system's browser.
 */
export function followLink(href: string, text: string) {
  const { selectNote, openView, showNotice, showError } = useLibraryStore.getState();
  if (href.startsWith('bever://note/')) {
    const id = href.slice('bever://note/'.length);
    // A note that was deleted since the link was made is said to be gone,
    // in words; whether it is there is asked first.
    api.noteTitles([id]).then(
      (titles) => {
        if (id in titles) void selectNote(id);
        else showNotice('The note this link leads to is not in your library any more.');
      },
      () => void selectNote(id),
    );
  } else if (isEvernoteNoteLink(href)) {
    // The note it points to was not in any import, or was renamed since.
    const title = text.trim().replaceAll('"', '');
    // A link that says only its address names nothing to look for.
    if (!title || isNoteAddress(title)) {
      showNotice('This link points to an Evernote note that is not in your library.');
      return;
    }
    showNotice(
      'This link points to an Evernote note that is not in your library under that title. Showing the closest matches.',
    );
    void openView({ query: title ? `intitle:"${title}"` : '', sort: 'relevance' });
  } else {
    api.openExternalUrl(href).catch(showError);
  }
}
