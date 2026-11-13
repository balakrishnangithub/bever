import type { Editor } from '@tiptap/core';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BetweenHorizontalStart,
  BetweenVerticalStart,
  Bold,
  CheckSquare,
  Code,
  Code2,
  Indent,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Outdent,
  Paperclip,
  Signature,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Subscript,
  Superscript,
  TextQuote,
  Trash2,
  Underline,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { ColorPalette } from './ColorPalette';
import { InsertTableButton, TableMenuButton } from './TableControls';

interface Props {
  editor: Editor;
  onAttach: () => void;
  /** Begins a sketch that is placed in the note when it is done. */
  onSketch: () => void;
  onInternalLink: () => void;
  onExternalLink: () => void;
}

export function EditorToolbar({ editor, onAttach, onSketch, onInternalLink, onExternalLink }: Props) {
  const heading = [1, 2, 3, 4].find((level) => editor.isActive('heading', { level })) ?? 0;
  const textStyle = editor.getAttributes('textStyle');
  const inTable = editor.isActive('table');
  const toolbar = useRef<HTMLDivElement>(null);

  // In a narrow window the toolbar is one scrolling row with the table tools
  // at its far end, where nobody would look for them. Bring them into view
  // when the cursor enters a table.
  useEffect(() => {
    const row = toolbar.current;
    if (inTable && row && row.scrollWidth > row.clientWidth) {
      row.scrollTo({ left: row.scrollWidth, behavior: 'smooth' });
    }
  }, [inTable]);

  return (
    <div ref={toolbar} className="editor-toolbar" role="toolbar" aria-label="Note formatting">
      <div className="toolbar-group">
        <Button
          label="Undo"
          disabled={!editor.can().undo()}
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Undo2 />
        </Button>
        <Button
          label="Redo"
          disabled={!editor.can().redo()}
          onClick={() => editor.chain().focus().redo().run()}
        >
          <Redo2 />
        </Button>
      </div>
      <div className="toolbar-group">
        <select
          aria-label="Text style"
          value={heading}
          onChange={(event) => {
            const level = Number(event.target.value);
            const chain = editor.chain().focus();
            if (level === 0) chain.setParagraph().run();
            else chain.setHeading({ level: level as 1 | 2 | 3 | 4 }).run();
          }}
        >
          <option value={0}>Normal</option>
          <option value={1}>Heading 1</option>
          <option value={2}>Heading 2</option>
          <option value={3}>Heading 3</option>
          <option value={4}>Heading 4</option>
        </select>
        <select
          aria-label="Font family"
          value={String(textStyle.fontFamily ?? '')}
          onChange={(event) =>
            event.target.value
              ? editor.chain().focus().setFontFamily(event.target.value).run()
              : editor.chain().focus().unsetFontFamily().run()
          }
        >
          <option value="">Default font</option>
          <option value="Arial">Arial</option>
          <option value="Georgia">Georgia</option>
          <option value="Times New Roman">Times New Roman</option>
          <option value="Courier New">Courier New</option>
          <option value="Verdana">Verdana</option>
          <option value="Trebuchet MS">Trebuchet MS</option>
        </select>
        <select
          aria-label="Font size"
          className="font-size-select"
          value={String(textStyle.fontSize ?? '')}
          onChange={(event) =>
            editor
              .chain()
              .focus()
              .setMark('textStyle', { fontSize: event.target.value || null })
              .removeEmptyTextStyle()
              .run()
          }
        >
          <option value="">Size</option>
          {[10, 12, 14, 16, 18, 20, 24, 30, 36, 48].map((size) => (
            <option key={size} value={`${size}px`}>
              {size}
            </option>
          ))}
        </select>
      </div>
      <div className="toolbar-group">
        <Button
          label="Bold"
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold />
        </Button>
        <Button
          label="Italic"
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic />
        </Button>
        <Button
          label="Underline"
          active={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <Underline />
        </Button>
        <Button
          label="Strikethrough"
          active={editor.isActive('strike')}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough />
        </Button>
        <ColorPalette editor={editor} kind="text" />
        <ColorPalette editor={editor} kind="highlight" />
        <Button
          label="Superscript"
          active={editor.isActive('superscript')}
          onClick={() => editor.chain().focus().toggleSuperscript().run()}
        >
          <Superscript />
        </Button>
        <Button
          label="Subscript"
          active={editor.isActive('subscript')}
          onClick={() => editor.chain().focus().toggleSubscript().run()}
        >
          <Subscript />
        </Button>
        <Button
          label="Inline code"
          active={editor.isActive('code')}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code />
        </Button>
        <Button
          label="Clear formatting"
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          <RemoveFormatting />
        </Button>
      </div>
      <div className="toolbar-group">
        <Button
          label="Bulleted list"
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List />
        </Button>
        <Button
          label="Numbered list"
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered />
        </Button>
        <Button
          label="Checklist"
          active={editor.isActive('taskList')}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >
          <CheckSquare />
        </Button>
        <Button
          label="Quote"
          active={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <TextQuote />
        </Button>
        <Button
          label="Code block"
          active={editor.isActive('codeBlock')}
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        >
          <Code2 />
        </Button>
      </div>
      <div className="toolbar-group">
        <Button
          label="Align left"
          active={editor.isActive({ textAlign: 'left' })}
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
        >
          <AlignLeft />
        </Button>
        <Button
          label="Align center"
          active={editor.isActive({ textAlign: 'center' })}
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
        >
          <AlignCenter />
        </Button>
        <Button
          label="Align right"
          active={editor.isActive({ textAlign: 'right' })}
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
        >
          <AlignRight />
        </Button>
        <Button label="Outdent" onClick={() => changeIndent(editor, -1)}>
          <Outdent />
        </Button>
        <Button label="Indent" onClick={() => changeIndent(editor, 1)}>
          <Indent />
        </Button>
      </div>
      <div className="toolbar-group">
        <InsertTableButton editor={editor} disabled={inTable} />
        <Button label="Horizontal line" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          <Minus />
        </Button>
        <Button
          label={editor.isActive('link') ? 'Edit link' : 'Add link'}
          active={editor.isActive('link')}
          onClick={onExternalLink}
        >
          <Link2 />
        </Button>
        <Button label="Link to a note" onClick={onInternalLink}>
          <span className="internal-link-icon">@</span>
        </Button>
        <Button label="Attach files" onClick={onAttach}>
          <Paperclip />
        </Button>
        <Button label="New sketch" onClick={onSketch}>
          <Signature />
        </Button>
      </div>
      {editor.isActive('link') && (
        <div className="toolbar-group toolbar-context" aria-label="Link">
          <Button label="Remove link" onClick={() => editor.chain().focus().unsetLink().run()}>
            <Trash2 />
          </Button>
        </div>
      )}
      {inTable && (
        <div className="toolbar-group toolbar-context" aria-label="Table">
          <TableMenuButton editor={editor} />
          <Button label="Insert row below" onClick={() => editor.chain().focus().addRowAfter().run()}>
            <BetweenHorizontalStart />
          </Button>
          <Button label="Insert column right" onClick={() => editor.chain().focus().addColumnAfter().run()}>
            <BetweenVerticalStart />
          </Button>
        </div>
      )}
    </div>
  );
}

function Button({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`toolbar-button ${active ? 'active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function changeIndent(editor: Editor, delta: number) {
  if (editor.isActive('listItem')) {
    const command = delta > 0 ? 'sinkListItem' : 'liftListItem';
    editor.chain().focus()[command]('listItem').run();
    return;
  }
  if (editor.isActive('taskItem')) {
    const command = delta > 0 ? 'sinkListItem' : 'liftListItem';
    editor.chain().focus()[command]('taskItem').run();
    return;
  }
  const type = editor.isActive('heading') ? 'heading' : 'paragraph';
  const current = Number(editor.getAttributes(type).indent ?? 0);
  editor
    .chain()
    .focus()
    .updateAttributes(type, { indent: Math.max(0, Math.min(8, current + delta)) })
    .run();
}
