import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import {
  Download,
  PenLine,
  ExternalLink,
  Eye,
  File,
  FileAudio,
  FileVideo,
  ImageOff,
  ImagePlus,
  LockKeyhole,
  MoreHorizontal,
  Paperclip,
} from 'lucide-react';
import { lazy, Suspense, useState } from 'react';

import { ContextMenu, type MenuItem } from '../components/ContextMenu';
import { api, isNative, resourceUrl } from '../lib/api';
import { formatBytes } from '../lib/syncProgress';
import { message, useLibraryStore } from '../store/useLibraryStore';
import { isPicture, PREVIEW_LABELS, previewKind } from './attachmentKind';
import { ImageAttachment } from './ImageAttachment';
import { chosenThumbnail } from '../types';
import { readImageLayout, withImageLayout } from './imageLayout';
import { pictureFound } from './noteFind';

/**
 * Asks the editor to make a picture, named by its MD5, the one that stands
 * for the note in the list; null gives the choice back to the application.
 */
export const THUMBNAIL_EVENT = 'bever:thumbnail';

/** Asks the editor to open a picture for annotating. */
export const ANNOTATE_EVENT = 'bever:annotate';

export interface AnnotationRequest {
  url: string;
  name: string;
  mime: string;
  /** Where the picture's node is in the note, when the answer comes. */
  getPos: () => number | undefined;
}

const PdfPreview = lazy(() => import('./PdfPreview').then((module) => ({ default: module.PdfPreview })));
const FilePreview = lazy(() => import('./FilePreview').then((module) => ({ default: module.FilePreview })));

export function AttachmentView({ node, editor, selected, getPos, decorations }: NodeViewProps) {
  const selectedNote = useLibraryStore((state) => state.selectedNote);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the picture's file failed to load.
  const [failed, setFailed] = useState(false);
  const hash = String(node.attrs.hash ?? '');
  const mime = String(node.attrs.type ?? 'application/octet-stream');
  const resource = selectedNote?.resources.find((item) => item.md5 === hash || item.sha256 === hash);
  const url = resourceUrl(resource?.sha256 || hash);
  const name = resource?.fileName || String(node.attrs.title ?? '') || 'Attachment';
  const width = node.attrs.width ? Number(node.attrs.width) : undefined;
  const height = node.attrs.height ? Number(node.attrs.height) : undefined;
  // What it can be read in, where it is: a PDF, a book, a text, a table, an archive's list.
  const readable = previewKind(mime, name);
  const isPdf = readable === 'pdf';
  // A picture by what it says it is, or by its name when it says nothing.
  const pictured = isPicture(mime, name);

  const run = (action: (resourceId: string) => Promise<unknown>) => {
    if (!resource) return;
    setError(null);
    action(resource.id).catch((reason: unknown) => setError(message(reason)));
  };
  const showMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY });
  };
  const unavailable = !resource || !isNative;
  // Evernote names a sketch "Sketch" with its date, and newer versions mark
  // it as handwriting. Which editor opens is decided by the file itself;
  // this only names the button.
  const sketch =
    /^sketch\b/i.test(resource?.fileName ?? '') ||
    JSON.stringify(resource?.attributes ?? {}).includes('evernote.handwriting');
  // The editor opens the annotator: it is the one that can store the result.
  const annotate = () =>
    editor.view.dom.dispatchEvent(
      new CustomEvent<AnnotationRequest>(ANNOTATE_EVENT, { detail: { url, name, mime, getPos } }),
    );
  // The picture chosen to stand for the note in the list of notes.
  const isThumbnail = Boolean(resource) && chosenThumbnail(selectedNote?.attributes ?? {}) === resource?.md5;
  const chooseThumbnail = () =>
    editor.view.dom.dispatchEvent(
      new CustomEvent<string | null>(THUMBNAIL_EVENT, {
        detail: isThumbnail ? null : (resource?.md5 ?? null),
      }),
    );
  const items: MenuItem[] = [
    ...(readable ? [{ label: 'Preview', icon: <Eye />, onSelect: () => setPreview(true) }] : []),
    ...(mime.startsWith('image/') && editor.isEditable && resource
      ? [
          { label: sketch ? 'Edit sketch…' : 'Annotate…', icon: <PenLine />, onSelect: annotate },
          {
            label: isThumbnail ? 'Stop using as thumbnail' : 'Use as note thumbnail',
            icon: <ImagePlus />,
            onSelect: chooseThumbnail,
          },
        ]
      : []),
    {
      label: 'Open with system app',
      icon: <ExternalLink />,
      disabled: unavailable,
      onSelect: () => run(api.openAttachment),
    },
    {
      label: 'Save as…',
      icon: <Download />,
      disabled: unavailable,
      onSelect: () => run(api.saveAttachment),
    },
  ];

  // A picture the note names and the library has no file for: the note was
  // imported without it, because it was not there to be had. It is said to
  // be missing, where a broken picture would say nothing.
  const lost = pictured && !resource && (failed || !url);
  let content = (
    <span className="attachment attachment-file">
      {lost ? <ImageOff size={18} /> : isPdf ? <File size={18} /> : <Paperclip size={18} />}
      <span>{lost ? 'Picture missing' : name}</span>
      <small>
        {lost
          ? 'its file was not there when the note was imported'
          : resource
            ? formatBytes(resource.size)
            : mime}
      </small>
    </span>
  );
  const picture = pictured && !lost;
  const layout = picture ? readImageLayout(node.attrs) : null;
  if (picture) {
    content = (
      <ImageAttachment
        url={url}
        name={name}
        alt={String(node.attrs.alt ?? '')}
        attributes={node.attrs}
        editing={editor.isEditable && selected}
        onChange={(change) => {
          const position = getPos();
          if (position === undefined) return;
          // The picture stays selected, so that it can be changed again.
          editor
            .chain()
            .command(({ tr }) => {
              tr.setNodeMarkup(position, undefined, {
                ...node.attrs,
                ...withImageLayout(node.attrs, change),
              });
              return true;
            })
            .setNodeSelection(position)
            .run();
        }}
        sketch={sketch}
        found={pictureFound(decorations)}
        onAnnotate={annotate}
        onMenu={showMenu}
        onMissing={() => setFailed(true)}
      />
    );
  } else if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    content = (
      <span className="attachment attachment-media">
        <span className="attachment-label">
          {mime.startsWith('audio/') ? <FileAudio size={16} /> : <FileVideo size={16} />}
          {name}
        </span>
        {mime.startsWith('audio/') ? (
          <audio src={url} controls preload="metadata" />
        ) : (
          <video src={url} controls preload="metadata" width={width} height={height} />
        )}
      </span>
    );
  }

  return (
    <NodeViewWrapper
      as="span"
      className={
        layout
          ? `attachment-shell image-shell align-${layout.alignment} ${layout.fill ? 'fill' : ''} ${selected ? 'selected' : ''}`
          : 'attachment-shell'
      }
      contentEditable={false}
      onContextMenu={showMenu}
    >
      {content}
      {!picture && (
        <button className="attachment-more icon-button" onClick={showMenu} aria-label={`Actions for ${name}`}>
          <MoreHorizontal />
        </button>
      )}
      {readable && (
        <button className="attachment-preview-button" onClick={() => setPreview(true)}>
          <Eye /> {PREVIEW_LABELS[readable]}
        </button>
      )}
      {menu && (
        <ContextMenu
          position={menu}
          items={items}
          label={`Actions for ${name}`}
          onClose={() => setMenu(null)}
        />
      )}
      {error && (
        <span className="attachment-error" role="alert">
          {error}
        </span>
      )}
      {preview && (
        <Suspense fallback={<span className="attachment-error">Loading preview…</span>}>
          {readable && readable !== 'pdf' ? (
            <FilePreview url={url} name={name} kind={readable} onClose={() => setPreview(false)} />
          ) : (
            <PdfPreview url={url} name={name} onClose={() => setPreview(false)} />
          )}
        </Suspense>
      )}
    </NodeViewWrapper>
  );
}

/**
 * An image written directly into a note. One that lives on the web is shown
 * only when asked for, or when the setting allows it: fetching it would tell
 * a third party that this note was opened, and from where.
 */
export function ImageView({ node, selected }: NodeViewProps) {
  const allowed = useLibraryStore((state) => state.settings.loadRemoteImages);
  const [requested, setRequested] = useState(false);
  const source = String(node.attrs.src ?? '');
  const remote = /^https?:/i.test(source);
  if (remote && !allowed && !requested) {
    let host = 'the web';
    try {
      host = new URL(source).host;
    } catch {
      // Not a valid address; nothing to show.
    }
    return (
      <NodeViewWrapper as="span" className="remote-image" contentEditable={false}>
        <button onClick={() => setRequested(true)} title={`Load this image from ${host}`}>
          <ImageOff />
          Image from {host} · Load
        </button>
      </NodeViewWrapper>
    );
  }
  return (
    <NodeViewWrapper as="span" className={`note-image ${selected ? 'selected' : ''}`} data-drag-handle>
      <img
        src={source}
        alt={String(node.attrs.alt ?? '')}
        title={node.attrs.title ? String(node.attrs.title) : undefined}
        width={node.attrs.width ? Number(node.attrs.width) : undefined}
        height={node.attrs.height ? Number(node.attrs.height) : undefined}
        referrerPolicy="no-referrer"
        loading="lazy"
      />
    </NodeViewWrapper>
  );
}

export function TodoView({ node, updateAttributes, editor }: NodeViewProps) {
  const checked = String(node.attrs.checked) === 'true';
  return (
    <NodeViewWrapper as="span" className="en-todo" contentEditable={false}>
      <input
        type="checkbox"
        checked={checked}
        disabled={!editor.isEditable}
        aria-label={checked ? 'Mark as incomplete' : 'Mark as complete'}
        onChange={(event) => updateAttributes({ checked: String(event.target.checked) })}
      />
    </NodeViewWrapper>
  );
}

export function EncryptedBlockView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper as="span" className="encrypted-block" contentEditable={false}>
      <LockKeyhole size={15} />
      <span>Encrypted Evernote content</span>
      {node.attrs.hint && <small>Hint: {String(node.attrs.hint)}</small>}
    </NodeViewWrapper>
  );
}
