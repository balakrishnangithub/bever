import { Copy, FolderInput, Tag, Tags, X } from 'lucide-react';
import { useState } from 'react';

import { message, useLibraryStore } from '../store/useLibraryStore';
import type { NoteOrganizationAction } from '../types';

interface Props {
  action: NoteOrganizationAction;
  noteIds: string[];
  onClose: () => void;
  onComplete: (message: string) => void;
}

const TITLES: Record<NoteOrganizationAction, string> = {
  move: 'Move notes',
  copy: 'Copy notes',
  addTags: 'Add tags',
  removeTags: 'Remove tags',
};

function splitTags(value: string) {
  return value
    .split(',')
    .map((name) => name.trim().replace(/^#/, ''))
    .filter(Boolean);
}

/** Moves, copies, or changes the tags of the notes selected in the list. */
export function OrganizationDialog({ action, noteIds, onClose, onComplete }: Props) {
  const overview = useLibraryStore((state) => state.overview);
  const organizeNotes = useLibraryStore((state) => state.organizeNotes);
  const [notebookId, setNotebookId] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tagging = action === 'addTags' || action === 'removeTags';
  const removing = action === 'removeTags';
  const title = TITLES[action];
  const ActionIcon = action === 'move' ? FolderInput : action === 'copy' ? Copy : Tags;
  const tagQuery = tagInput.split(',').at(-1)?.trim().replace(/^#/, '').toLowerCase() ?? '';
  const suggestions = overview.tags
    .filter((tag) => !selectedTags.some((name) => name.toLowerCase() === tag.name.toLowerCase()))
    .filter((tag) => !tagQuery || tag.name.toLowerCase().includes(tagQuery));

  const canonicalTag = (name: string) =>
    overview.tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase())?.name ?? name;
  const addTags = (names: string[]) => {
    setSelectedTags((current) => {
      const merged = [...current];
      for (const name of names.map(canonicalTag)) {
        if (name && !merged.some((tag) => tag.toLowerCase() === name.toLowerCase())) merged.push(name);
      }
      return merged;
    });
    setTagInput('');
    setError(null);
  };

  const submit = async () => {
    const typed = splitTags(tagInput).map(canonicalTag);
    const names = tagging
      ? [...new Map([...selectedTags, ...typed].map((name) => [name.toLowerCase(), name])).values()]
      : [];
    if (!tagging && !notebookId) {
      setError('Choose a destination notebook.');
      return;
    }
    if (tagging && names.length === 0) {
      setError(removing ? 'Choose at least one tag to remove.' : 'Choose or enter at least one tag.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const changed = await organizeNotes(noteIds, action, tagging ? null : notebookId, names);
      const noun = changed === 1 ? 'note' : 'notes';
      const outcome: Record<NoteOrganizationAction, string> = {
        move: `${changed} ${noun} moved.`,
        copy: `${changed} ${noun} copied.`,
        addTags: changed
          ? `Tags added to ${changed} ${noun}.`
          : 'No changes; the selected notes already have those tags.',
        removeTags: changed
          ? `Tags removed from ${changed} ${noun}.`
          : 'No changes; none of the selected notes has those tags.',
      };
      onComplete(outcome[action]);
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="modal organization-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-describedby="organization-description"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header>
          <div>
            <p className="eyebrow">Organize library</p>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
            <X />
          </button>
        </header>
        <p id="organization-description">
          {noteIds.length} {noteIds.length === 1 ? 'note' : 'notes'} selected.
          {action === 'copy' ? ' Copies keep their content, tags, metadata, and attachments.' : ''}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {tagging ? (
            <div className="organization-tag-field">
              <label htmlFor="organization-tags">Tags</label>
              {selectedTags.length > 0 && (
                <div
                  className="organization-selected-tags"
                  role="group"
                  aria-label={removing ? 'Tags to remove' : 'Tags to add'}
                >
                  {selectedTags.map((tag) => (
                    <button
                      type="button"
                      key={tag}
                      aria-label={`Unselect tag ${tag}`}
                      onClick={() => setSelectedTags((current) => current.filter((name) => name !== tag))}
                    >
                      <Tag aria-hidden="true" />
                      {tag}
                      <X />
                    </button>
                  ))}
                </div>
              )}
              <input
                id="organization-tags"
                autoFocus
                value={tagInput}
                onChange={(event) => setTagInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ',') {
                    event.preventDefault();
                    addTags(splitTags(tagInput));
                  } else if (event.key === 'Backspace' && !tagInput && selectedTags.length) {
                    setSelectedTags((current) => current.slice(0, -1));
                  }
                }}
                placeholder={removing ? 'Search existing tags' : 'Type a new tag or search existing tags'}
                aria-label="Tags"
                aria-describedby="organization-tags-hint"
              />
              <span id="organization-tags-hint">
                {removing
                  ? 'Click the tags to remove from the selected notes.'
                  : 'Click an existing tag or type a new one. Press Enter or comma to add several.'}
              </span>
              <div className="organization-tag-suggestions" role="group" aria-label="Existing tags">
                <span>Existing tags</span>
                <div>
                  {suggestions.map((tag) => (
                    <button
                      type="button"
                      key={tag.id}
                      aria-label={`${removing ? 'Remove' : 'Add'} existing tag ${tag.name}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => addTags([tag.name])}
                    >
                      <Tag aria-hidden="true" />
                      {tag.name}
                    </button>
                  ))}
                  {suggestions.length === 0 && <p>No matching existing tags.</p>}
                </div>
              </div>
            </div>
          ) : (
            <label>
              Destination notebook
              <select
                autoFocus
                required
                value={notebookId}
                onChange={(event) => setNotebookId(event.target.value)}
              >
                <option value="">Choose a notebook…</option>
                {overview.notebooks.map((notebook) => (
                  <option key={notebook.id} value={notebook.id}>
                    {notebook.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error && (
            <p className="organization-error" role="alert">
              {error}
            </p>
          )}
          <div className="organization-actions">
            <button type="button" className="secondary-action" disabled={saving} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary-action"
              disabled={
                saving || noteIds.length === 0 || (tagging && selectedTags.length === 0 && !tagInput.trim())
              }
            >
              <ActionIcon />
              {saving ? 'Applying…' : title}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
