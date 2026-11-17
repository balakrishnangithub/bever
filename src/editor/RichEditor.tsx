import { EditorContent, useEditor } from '@tiptap/react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '../lib/api';
import { dialogs } from '../lib/dialogs';
import { onWindowShortened } from '../lib/windowHeight';
import { useBackCloses } from '../lib/useBackCloses';
import { useLibraryStore } from '../store/useLibraryStore';
import { emptyFilter, type Note, type NoteSummary, type Resource } from '../types';
import { EditorToolbar } from './EditorToolbar';
import { createExtensions } from './extensions';
import { faceOf } from './face';
import { followLink } from './followLink';
import { withNaturalSize } from './imageLayout';
import { LinkBubble, type LinkTarget } from './LinkBubble';
import { ANNOTATE_EVENT, THUMBNAIL_EVENT, type AnnotationRequest } from './nodeViews';
import { noteFindState, updateNoteFind, type PictureTexts } from './noteFind';
import { useNoteZoom } from './noteZoom';
import { hasInk, pngSize } from './pngChunks';
import type { FindTerm } from './recognition';
import { noteHtml } from './serialize';

const ImageAnnotator = lazy(() =>
  import('./ImageAnnotator').then((module) => ({ default: module.ImageAnnotator })),
);
const SketchEditor = lazy(() =>
  import('./SketchEditor').then((module) => ({ default: module.SketchEditor })),
);

/** Largest file accepted from the clipboard or a drop; see `attach_bytes`. */
const MAX_INLINE_BYTES = 100 * 1024 * 1024;

interface Props {
  note: Note;
  editable: boolean;
  /** Changes when the editor must show `note.contentHtml` again. */
  contentVersion: number;
  /** The note's page as the library has it, which `note.contentHtml` is not while something is unsaved. */
  storedHtml: string;
  /** What the library was searched for; it is marked in the note. */
  highlight: FindTerm[];
  onChange: (html: string) => void;
  /** Lets the user choose files and returns the stored attachments. */
  onAttachFiles: () => Promise<Resource[]>;
  /** Stores a pasted or dropped file and returns its attachment. */
  onAttachBlob: (file: Blob, fileName: string) => Promise<Resource | null>;
  /** Makes the picture with this MD5 the note's thumbnail; null undoes the choice. */
  onThumbnail: (md5: string | null) => void;
}

export function RichEditor({
  note,
  editable,
  contentVersion,
  storedHtml,
  highlight,
  onChange,
  onAttachFiles,
  onAttachBlob,
  onThumbnail,
}: Props) {
  const showError = useLibraryStore((state) => state.showError);
  const showNotice = useLibraryStore((state) => state.showNotice);
  const [clickedLink, setClickedLink] = useState<LinkTarget | null>(null);
  const [annotating, setAnnotating] = useState<
    (AnnotationRequest & { bytes: Uint8Array; sketch: boolean }) | null
  >(null);
  // A sketch begun from the toolbar: the name its file gets, and what it is
  // known by inside the file.
  const [drawing, setDrawing] = useState<{ fileName: string; id: string; at: number } | null>(null);
  const [, setVersion] = useState(0);
  const [linkDialog, setLinkDialog] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findCount, setFindCount] = useState(0);
  const [findPictures, setFindPictures] = useState(0);
  const [findActive, setFindActive] = useState(0);

  // The page the editor was given to show, and its face: what of it can be
  // seen. While the document has that face, the note is that page, however
  // many times the editor says that something happened to it.
  const shown = useRef<{ html: string; face: string } | null>(null);
  const { frame: zoomFrame, zoom, reset: resetZoom } = useNoteZoom();

  // The editor is created once per note, so its event handlers reach the
  // current callbacks through this object rather than capturing old ones.
  const actions = useRef<{
    attachBlobs: (files: File[], position?: number) => void;
    thumbnail: (md5: string | null) => void;
  }>({ attachBlobs: () => undefined, thumbnail: () => undefined });

  const editor = useEditor(
    {
      extensions: createExtensions(),
      content: note.contentHtml,
      editable,
      immediatelyRender: false,
      editorProps: {
        attributes: { class: 'note-prose', 'aria-label': 'Note content', spellcheck: 'true' },
        handleClick: (view, _pos, event) => {
          const anchor = (event.target as HTMLElement).closest('a');
          const href = anchor?.getAttribute('href');
          if (!anchor || !href) return false;
          // While writing, a click on a link is first of all a click into
          // its text. What to do with the link is offered next to it; Ctrl
          // or Command with the click opens it at once.
          if (view.editable && !event.ctrlKey && !event.metaKey) {
            const box = anchor.getBoundingClientRect();
            setClickedLink({
              href,
              text: anchor.textContent ?? '',
              x: box.left,
              y: box.bottom + 6,
              anchor,
            });
            return false;
          }
          followLink(href, anchor.textContent ?? '');
          return true;
        },
        handlePaste: (_view, event) => {
          const clipboard = event.clipboardData;
          const files = [...(clipboard?.files ?? [])];
          // Office applications put both formatted text and a picture of it
          // on the clipboard; the text is what was meant.
          if (!files.length || clipboard?.getData('text/html') || clipboard?.getData('text/plain')) {
            return false;
          }
          event.preventDefault();
          actions.current.attachBlobs(files);
          return true;
        },
        handleDrop: (view, event, _slice, moved) => {
          const files = [...(event.dataTransfer?.files ?? [])];
          if (moved || !files.length) return false;
          event.preventDefault();
          const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
          actions.current.attachBlobs(files, position);
          return true;
        },
      },
      // The editor changes its document for reasons that are not the
      // writer's: a keyboard takes up a word and puts it back, an empty line
      // is added to write in. Only what changes the note's face is a change
      // of the note; anything else leaves it the page that is stored.
      onUpdate: ({ editor: instance }) => {
        // And a note that is only read is not changed at all, whatever the
        // editor does to its document meanwhile.
        if (!instance.isEditable) return;
        const stored = shown.current;
        onChange(stored && faceOf(instance.state.doc) === stored.face ? stored.html : noteHtml(instance));
      },
      onSelectionUpdate: () => setVersion((value) => value + 1),
      onTransaction: () => setVersion((value) => value + 1),
    },
    [note.id],
  );

  // What the editor was given is taken down as soon as there is an editor,
  // and before anything below asks something of it. The editor's own word
  // that it is ready comes too late for that: marking what a search found
  // comes first, and to a note that ends in a list it adds the empty line
  // the editor wants there. With nothing to measure that against, it was
  // taken for writing, and a note opened from a search was stored anew.
  // This effect stays the first one that touches the editor.
  useEffect(() => {
    if (editor && !shown.current) {
      shown.current = { html: note.contentHtml, face: faceOf(editor.state.doc) };
    }
  }, [editor, note.contentHtml]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // The on-screen keyboard takes the lower part of the window: the place
  // being typed at is brought back into view.
  useEffect(() => {
    if (!editor) return;
    return onWindowShortened(() => {
      if (editor.isFocused) editor.commands.scrollIntoView();
    });
  }, [editor]);

  // A picture asks to be drawn on; its file is read first, because the file
  // says which editor it needs: a sketch has strokes in it, and is changed
  // stroke by stroke; any other picture is annotated.
  useEffect(() => {
    if (!editor || !editable) return;
    const element = editor.view.dom;
    const open = (event: Event) => {
      const request = (event as CustomEvent<AnnotationRequest>).detail;
      fetch(request.url)
        .then((response) => {
          if (!response.ok) throw new Error('The picture could not be read.');
          return response.arrayBuffer();
        })
        .then((buffer) => {
          const bytes = new Uint8Array(buffer);
          setAnnotating({ ...request, bytes, sketch: hasInk(bytes) });
        })
        .catch(showError);
    };
    const thumbnail = (event: Event) =>
      actions.current.thumbnail((event as CustomEvent<string | null>).detail);
    element.addEventListener(ANNOTATE_EVENT, open);
    element.addEventListener(THUMBNAIL_EVENT, thumbnail);
    return () => {
      element.removeEventListener(ANNOTATE_EVENT, open);
      element.removeEventListener(THUMBNAIL_EVENT, thumbnail);
    };
  }, [editor, editable, showError]);

  // A picture that was annotated or sketched on is a new attachment that
  // takes the old one's place in the note; its size and alignment there, a
  // sketch's wider or narrower picture apart, stay as they were.
  const storeDrawn = async (picture: Uint8Array) => {
    if (!annotating || !editor) return;
    const fileName = `${annotating.name.replace(/\.[a-z0-9]+$/i, '')}.png`;
    const resource = await onAttachBlob(new Blob([picture as BlobPart], { type: 'image/png' }), fileName);
    if (!resource) throw new Error('The picture could not be stored.');
    const position = annotating.getPos();
    const node = position === undefined ? null : editor.state.doc.nodeAt(position);
    if (position === undefined || node?.type.name !== 'enMedia') {
      throw new Error('The picture is no longer where it was in the note.');
    }
    const size = annotating.sketch ? pngSize(picture) : null;
    const attributes = size
      ? { ...node.attrs, ...withNaturalSize(node.attrs, size.width, size.height) }
      : node.attrs;
    editor
      .chain()
      .command(({ tr }) => {
        tr.setNodeMarkup(position, undefined, { ...attributes, hash: resource.md5, type: 'image/png' });
        return true;
      })
      .run();
    setAnnotating(null);
  };

  // Show the stored content again after it changed underneath the editor.
  const shownVersion = useRef(contentVersion);
  useEffect(() => {
    if (!editor || shownVersion.current === contentVersion) return;
    shownVersion.current = contentVersion;
    editor.commands.setContent(note.contentHtml, { emitUpdate: false });
    shown.current = { html: note.contentHtml, face: faceOf(editor.state.doc) };
  }, [editor, contentVersion, note.contentHtml]);

  // Once what was written is stored, and is what the editor shows, the
  // next change is measured against that. What is typed and not yet stored
  // is never the measure: a letter taken away again has to come out as no
  // change at all.
  useEffect(() => {
    if (!editor || shown.current?.html === storedHtml) return;
    if (noteHtml(editor) === storedHtml) {
      shown.current = { html: storedHtml, face: faceOf(editor.state.doc) };
    }
  }, [editor, storedHtml]);

  useEffect(() => {
    if (!editor) return;
    const openFind = () => {
      const { from, to } = editor.state.selection;
      const selected = editor.state.doc.textBetween(from, to, ' ').trim();
      if (selected && selected.length < 200) setFindQuery(selected);
      setFindOpen(true);
    };
    window.addEventListener('bever:find', openFind);
    return () => window.removeEventListener('bever:find', openFind);
  }, [editor]);

  // The text recognised in the note's pictures, for finding in it.
  const { resources } = note;
  const pictureTexts = useMemo<PictureTexts>(() => {
    const known = new Map<string, { xml: string | null; text: string | null }>();
    for (const resource of resources) {
      if (!resource.recognitionXml && !resource.recognitionText) continue;
      const texts = { xml: resource.recognitionXml, text: resource.recognitionText };
      known.set(resource.md5, texts);
      known.set(resource.sha256, texts);
    }
    return (hash) => known.get(hash) ?? null;
  }, [resources]);

  // What is looked for with Find is stepped through; while Find is closed,
  // what the library was searched for is marked instead.
  const finding = findOpen && findQuery.trim() !== '';
  useEffect(() => {
    if (!editor) return;
    if (!finding) {
      updateNoteFind(editor, highlight, -1, pictureTexts);
      return;
    }
    const timer = window.setTimeout(() => {
      const state = updateNoteFind(editor, findQuery, 0, pictureTexts);
      setFindCount(state?.matches.length ?? 0);
      setFindPictures(state?.matches.filter((match) => match.picture).length ?? 0);
      setFindActive(state?.active ?? 0);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [editor, finding, findQuery, highlight, pictureTexts]);

  const insertAttachments = useCallback(
    (resources: Resource[], position?: number) => {
      if (!editor || !resources.length) return;
      const nodes = resources.map((resource) => ({
        type: 'enMedia',
        attrs: { hash: resource.md5, type: resource.mime },
      }));
      const chain = editor.chain().focus();
      if (position === undefined) chain.insertContent(nodes).run();
      else chain.insertContentAt(position, nodes).run();
    },
    [editor],
  );

  // Refreshed after every render; see the note on `actions` above.
  useEffect(() => {
    actions.current = {
      thumbnail: onThumbnail,
      attachBlobs: (files, position) => {
        if (!editable) return;
        void (async () => {
          const stored: Resource[] = [];
          for (const file of files) {
            if (file.size > MAX_INLINE_BYTES) {
              showError(`“${file.name}” is too large to paste or drop. Use Attach a file instead.`);
              continue;
            }
            const resource = await onAttachBlob(file, file.name || 'Pasted image.png');
            if (resource) stored.push(resource);
          }
          insertAttachments(stored, position);
        })();
      },
    };
  });

  const closeLinkBubble = useCallback(() => setClickedLink(null), []);

  /** Opens an empty sketch. It is named as Evernote names one: "Sketch" and when. */
  const beginSketch = () => {
    const now = new Date();
    const two = (value: number) => String(value).padStart(2, '0');
    const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
    const time = `${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}`;
    setDrawing({ fileName: `Sketch ${day} ${time}.png`, id: crypto.randomUUID(), at: now.getTime() });
  };
  /** The finished sketch becomes an attachment, placed where the typing was. */
  const storeSketch = async (picture: Uint8Array) => {
    if (!drawing) return;
    const resource = await onAttachBlob(
      new Blob([picture as BlobPart], { type: 'image/png' }),
      drawing.fileName,
    );
    if (!resource) throw new Error('The sketch could not be stored.');
    insertAttachments([resource]);
    setDrawing(null);
  };

  // Going back closes what is open over the note, before the note.
  useBackCloses(findOpen, () => {
    setFindOpen(false);
    editor?.commands.focus();
  });
  useBackCloses(Boolean(clickedLink) && editable, closeLinkBubble);
  useBackCloses(linkDialog, () => setLinkDialog(false));
  if (!editor) return <div className="editor-loading">Loading editor…</div>;

  const closeFind = () => {
    setFindOpen(false);
    editor.commands.focus();
  };
  const moveFind = (direction: number) => {
    const current = noteFindState(editor);
    if (!finding || !current?.matches.length) return;
    const state = updateNoteFind(editor, findQuery, Math.max(current.active, 0) + direction, pictureTexts);
    setFindActive(state?.active ?? 0);
  };
  const editExternalLink = async () => {
    const current = String(editor.getAttributes('link').href ?? '');
    const href = await dialogs.prompt({
      title: current ? 'Edit link' : 'Add link',
      label: 'Web address',
      initialValue: current,
      placeholder: 'https://…',
      confirmLabel: 'Apply',
      validate: (value) =>
        /^(https?:\/\/|mailto:|tel:)\S+$/i.test(value) || /^[\w-]+(\.[\w-]+)+\S*$/.test(value)
          ? null
          : 'Enter a web address such as https://example.com.',
    });
    if (!href) return;
    const address = /^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href: address }).run();
  };

  return (
    <div className={`rich-editor ${editable ? '' : 'read-only'}`}>
      {editable && (
        <EditorToolbar
          editor={editor}
          onAttach={() => void onAttachFiles().then((resources) => insertAttachments(resources))}
          onSketch={beginSketch}
          onInternalLink={() => setLinkDialog(true)}
          onExternalLink={() => void editExternalLink()}
        />
      )}
      {findOpen && (
        <div className="note-find" role="dialog" aria-label="Find in note">
          <input
            autoFocus
            aria-label="Find in note content"
            placeholder="Find in this note…"
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                moveFind(event.shiftKey ? -1 : 1);
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeFind();
              }
            }}
          />
          <span
            aria-live="polite"
            title={
              findPictures && finding
                ? `${findPictures} of them ${findPictures === 1 ? 'is a picture' : 'are pictures'} whose text matches`
                : undefined
            }
          >
            {finding ? (findCount ? `${findActive + 1} / ${findCount}` : 'No matches') : ''}
          </span>
          <button className="icon-button" onClick={() => moveFind(-1)} aria-label="Previous match">
            <ChevronUp />
          </button>
          <button className="icon-button" onClick={() => moveFind(1)} aria-label="Next match">
            <ChevronDown />
          </button>
          <button className="icon-button" onClick={closeFind} aria-label="Close find">
            <X />
          </button>
        </div>
      )}
      <div className="note-zoom" ref={zoomFrame}>
        <EditorContent editor={editor} className="editor-content" />
      </div>
      {zoom > 1 && (
        <button
          className="zoom-chip"
          onClick={resetZoom}
          title="Show the note at its own size again"
          aria-label={`Zoomed to ${Math.round(zoom * 100)}%. Show the note at its own size again`}
        >
          {Math.round(zoom * 100)}%
          <X />
        </button>
      )}
      {annotating && (
        <Suspense fallback={null}>
          {annotating.sketch ? (
            <SketchEditor
              bytes={annotating.bytes}
              name={annotating.name}
              onClose={() => setAnnotating(null)}
              onSave={storeDrawn}
            />
          ) : (
            <ImageAnnotator
              bytes={annotating.bytes}
              mime={annotating.mime}
              name={annotating.name}
              onClose={() => setAnnotating(null)}
              onSave={storeDrawn}
            />
          )}
        </Suspense>
      )}
      {drawing && (
        <Suspense fallback={null}>
          <SketchEditor
            bytes={null}
            blank={drawing}
            name="New sketch"
            onClose={() => setDrawing(null)}
            onSave={storeSketch}
          />
        </Suspense>
      )}
      {clickedLink && editable && (
        <LinkBubble
          link={clickedLink}
          onClose={closeLinkBubble}
          onOpen={() => {
            setClickedLink(null);
            followLink(clickedLink.href, clickedLink.text);
          }}
          onEdit={() => {
            setClickedLink(null);
            if (clickedLink.href.startsWith('bever://note/')) setLinkDialog(true);
            else void editExternalLink();
          }}
          onCopy={() => {
            setClickedLink(null);
            navigator.clipboard
              .writeText(clickedLink.href)
              .then(() => showNotice('Link address copied.'))
              .catch(showError);
          }}
          onRemove={() => {
            setClickedLink(null);
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
          }}
        />
      )}
      {linkDialog && (
        <InternalLinkDialog
          currentNoteId={note.id}
          onClose={() => setLinkDialog(false)}
          onChoose={(target) => {
            const href = `bever://note/${target.id}`;
            const chain = editor.chain().focus();
            if (editor.isActive('link')) {
              // The cursor is in a link: that link is given a new target.
              chain.extendMarkRange('link').setLink({ href }).run();
            } else if (editor.state.selection.empty) {
              chain
                .insertContent({
                  type: 'text',
                  text: target.title || 'Untitled',
                  marks: [{ type: 'link', attrs: { href } }],
                })
                .run();
            } else {
              chain.extendMarkRange('link').setLink({ href }).run();
            }
            setLinkDialog(false);
          }}
        />
      )}
    </div>
  );
}

/** Finds a note anywhere in the library to link to. */
function InternalLinkDialog({
  currentNoteId,
  onChoose,
  onClose,
}: {
  currentNoteId: string;
  onChoose: (note: NoteSummary) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<NoteSummary[] | null>(null);

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      api
        .listNotes({ ...emptyFilter, query, sort: query ? 'relevance' : 'updatedDesc', limit: 13 })
        .then((page) => {
          if (current) setMatches(page.notes.filter((item) => item.id !== currentNoteId).slice(0, 12));
        })
        // A half-typed operator is not worth an error; keep the last results.
        .catch(() => undefined);
    }, 140);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, currentNoteId]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal link-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Link to a note"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header>
          <div>
            <p className="eyebrow">Internal link</p>
            <h2>Link to a note</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X />
          </button>
        </header>
        <input
          autoFocus
          aria-label="Search notes to link"
          placeholder="Search your notes…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="link-results">
          {matches?.map((item) => (
            <button key={item.id} onClick={() => onChoose(item)}>
              <strong>{item.title || 'Untitled'}</strong>
              <span>{item.notebookName}</span>
            </button>
          ))}
          {matches?.length === 0 && <p>No matching notes.</p>}
        </div>
      </section>
    </div>
  );
}
