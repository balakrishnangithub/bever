import { api } from '../lib/api';
import { useLibraryStore } from '../store/useLibraryStore';
import { emptyFilter } from '../types';

const isEvernoteNoteLink = (href: string) =>
  /^(evernote:\/\/\/view\/|https?:\/\/(www\.)?evernote\.com\/(shard|l)\/)/i.test(href);

/**
 * Follows a link clicked in a note: to another note, to a search for the
 * note an unresolved Evernote link names, or out to the system's browser.
 */
export function followLink(href: string, text: string) {
  const { selectNote, setFilter, showNotice, showError } = useLibraryStore.getState();
  if (href.startsWith('bever://note/')) {
    void selectNote(href.slice('bever://note/'.length));
  } else if (isEvernoteNoteLink(href)) {
    // The note it points to was not in any import, or was renamed since.
    const title = text.trim().replaceAll('"', '');
    showNotice(
      'This link points to an Evernote note that is not in your library under that title. Showing the closest matches.',
    );
    void setFilter({ ...emptyFilter, query: title ? `intitle:"${title}"` : '', sort: 'relevance' });
  } else {
    api.openExternalUrl(href).catch(showError);
  }
}
