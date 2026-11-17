import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api';
import { tagChoices, type TagChoice } from '../lib/tagChoices';
import { useBackCloses } from '../lib/useBackCloses';
import { useLibraryStore } from '../store/useLibraryStore';

export function FilterPanel({ onClose }: { onClose: () => void }) {
  const filter = useLibraryStore((state) => state.filter);
  const setFilter = useLibraryStore((state) => state.setFilter);
  const tags = useLibraryStore((state) => state.overview.tags);
  const everywhere = useLibraryStore((state) => state.overview.counts.tags);
  const listed = useLibraryStore((state) => state.listed);
  /** How many of the notes listed have each tag; null until that is known. */
  const [onNotes, setOnNotes] = useState<Record<string, number> | null>(null);
  /** The tags of the listed notes could not be had: every tag is offered. */
  const [unknown, setUnknown] = useState(false);
  const [typed, setTyped] = useState('');
  const [showAll, setShowAll] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useBackCloses(true, onClose);
  const tagsGroup = useRef<HTMLDivElement>(null);

  // The tags of the notes listed are those of the whole listing, which only
  // the library knows; they are asked for again with each listing that
  // arrives. Until the answer is there, the last one stays.
  useEffect(() => {
    let stale = false;
    api
      .listingTags(useLibraryStore.getState().filter)
      .then((counts) => {
        if (stale) return;
        setOnNotes(counts);
        setUnknown(false);
      })
      .catch(() => {
        if (!stale) setUnknown(true);
      });
    return () => {
      stale = true;
    };
  }, [listed]);

  const all = showAll || unknown;
  const choices = useMemo(
    () => tagChoices(tags, filter.tagIds, unknown ? everywhere : (onNotes ?? {}), typed, all),
    [tags, filter.tagIds, unknown, everywhere, onNotes, typed, all],
  );
  const finding = typed.trim();
  /** What is said under the tags offered, when something is to be said. */
  const note = (() => {
    if (onNotes === null && !unknown) return null;
    const others = choices.elsewhere === 1 ? '1 other tag does' : `${choices.elsewhere} other tags do`;
    if (choices.offered.length === 0) {
      if (!finding) {
        return choices.chosen.length
          ? 'The notes listed have no other tags.'
          : 'None of the notes listed has a tag.';
      }
      return choices.elsewhere > 0
        ? `No tag of these notes has “${finding}” in its name. ${others}.`
        : `No tag has “${finding}” in its name.`;
    }
    if (choices.elsewhere === 0) return null;
    return choices.elsewhere === 1
      ? `1 more tag with “${finding}” in its name is on none of these notes.`
      : `${choices.elsewhere} more tags with “${finding}” in their names are on none of these notes.`;
  })();

  const dateValue = (timestamp: number | null) => {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  };
  const timestamp = (value: string, end = false) =>
    value ? new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}`).getTime() : null;
  const toggleTag = (tagId: string, selected: boolean) => {
    const tagIds = selected ? [...filter.tagIds, tagId] : filter.tagIds.filter((id) => id !== tagId);
    // What was typed found the tag; the next one is another.
    if (selected) setTyped('');
    void setFilter({ tagIds });
  };
  /** Brings the tags to the top of the panel, where what is typed shows its answers. */
  const showTags = () => {
    if (body.current && tagsGroup.current) body.current.scrollTop = tagsGroup.current.offsetTop;
  };
  const row = ({ tag, count }: TagChoice, checked: boolean) => (
    <label className={`checkbox-label ${count === 0 && !checked ? 'elsewhere' : ''}`} key={tag.id}>
      <input
        type="checkbox"
        aria-label={tag.name}
        checked={checked}
        onChange={(event) => toggleTag(tag.id, event.target.checked)}
      />
      <span>{tag.name}</span>
      <small title={unknown ? 'Notes with this tag' : 'Notes listed that have this tag'}>{count}</small>
    </label>
  );

  return (
    <section className="filter-panel" aria-label="Filter notes">
      <header>
        <strong>Filter notes</strong>
        <button
          className="text-button"
          onClick={() => {
            setTyped('');
            void setFilter({
              contains: null,
              createdFrom: null,
              createdTo: null,
              updatedFrom: null,
              updatedTo: null,
              tagIds: [],
              includeTrash: false,
            });
          }}
        >
          Clear filters
        </button>
        <button className="icon-button" onClick={onClose} aria-label="Close filters">
          <X />
        </button>
      </header>
      {/* The one part of the panel that scrolls. A list of tags that scrolled
          by itself inside it took a finger's swipe for one or the other, and
          at its end for neither. */}
      <div className="filter-body" ref={body}>
        <label>
          Contains
          <select
            value={filter.contains ?? ''}
            onChange={(event) => void setFilter({ contains: event.target.value || null })}
          >
            <option value="">Anything</option>
            <option value="images">Images</option>
            <option value="audio">Audio</option>
            <option value="video">Video</option>
            <option value="pdf">PDF</option>
            <option value="files">Attachments</option>
            <option value="checklist">Checklists</option>
            <option value="table">Tables</option>
            <option value="code">Code blocks</option>
            <option value="links">Links</option>
          </select>
        </label>
        <div className="filter-dates">
          <label>
            Created after
            <input
              type="date"
              value={dateValue(filter.createdFrom)}
              onChange={(event) => void setFilter({ createdFrom: timestamp(event.target.value) })}
            />
          </label>
          <label>
            Created before
            <input
              type="date"
              value={dateValue(filter.createdTo)}
              onChange={(event) => void setFilter({ createdTo: timestamp(event.target.value, true) })}
            />
          </label>
        </div>
        <div className="filter-dates">
          <label>
            Updated after
            <input
              type="date"
              value={dateValue(filter.updatedFrom)}
              onChange={(event) => void setFilter({ updatedFrom: timestamp(event.target.value) })}
            />
          </label>
          <label>
            Updated before
            <input
              type="date"
              value={dateValue(filter.updatedTo)}
              onChange={(event) => void setFilter({ updatedTo: timestamp(event.target.value, true) })}
            />
          </label>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={filter.includeTrash}
            onChange={(event) => void setFilter({ includeTrash: event.target.checked })}
          />
          Include trash
        </label>
        <div className="filter-tags" role="group" aria-label="Tags" ref={tagsGroup}>
          <div className="filter-tags-head">
            <p>
              Tags <span>(all selected tags must match)</span>
            </p>
            {tags.length > 0 && (
              <div className="filter-tags-find">
                <Search aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Find a tag"
                  placeholder={all ? 'Find a tag…' : 'Find a tag of these notes…'}
                  value={typed}
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="search"
                  onChange={(event) => {
                    setTyped(event.target.value);
                    if (event.target.value) showTags();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && typed) {
                      event.stopPropagation();
                      setTyped('');
                    }
                  }}
                />
                {typed && (
                  <button
                    className="icon-button"
                    onClick={() => setTyped('')}
                    aria-label="Clear the tag search"
                  >
                    <X />
                  </button>
                )}
              </div>
            )}
          </div>
          {tags.length === 0 ? (
            <p className="filter-tags-note">No tags yet. Add tags to a note to filter by them.</p>
          ) : (
            <div className="filter-tags-list" aria-busy={onNotes === null && !unknown}>
              {choices.chosen.map((choice) => row(choice, true))}
              {choices.offered.map((choice) => row(choice, false))}
              {note && <p className="filter-tags-note">{note}</p>}
              {!unknown && (
                <button className="text-button" onClick={() => setShowAll((value) => !value)}>
                  {showAll ? 'Show only the tags of these notes' : `Show all ${tags.length} tags`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
