import {
  CornerLeftUp,
  Download,
  FolderPlus,
  FolderTree,
  Pencil,
  Plus,
  Star,
  StarOff,
  Trash2,
} from 'lucide-react';

import { isNative } from '../lib/api';
import { dialogs } from '../lib/dialogs';
import { tagChildren, tagPath, tagWithDescendants } from '../lib/tagTree';
import { useLibraryStore } from '../store/useLibraryStore';
import type { Notebook, ShortcutTarget, Stack, Tag } from '../types';
import type { MenuItem } from './ContextMenu';

/** A tag's name as typed: a leading `#`, which some write, is not part of it. */
const tagName = (typed: string) => typed.replace(/^#/, '').trim();

/**
 * What can be done with a notebook, a stack, or a tag, as the items of a
 * menu. The sidebar and the screens that list notebooks and tags offer the
 * same things in the same words.
 */
export function useOrganizeMenus() {
  const overview = useLibraryStore((state) => state.overview);
  const {
    createNotebook,
    renameNotebook,
    deleteNotebook,
    setNotebookStack,
    createStack,
    renameStack,
    deleteStack,
    createTag,
    renameTag,
    setTagParent,
    deleteTag,
    toggleShortcut,
    exportNotes,
  } = useLibraryStore.getState();
  const { counts, shortcuts } = overview;

  const isShortcut = (type: ShortcutTarget, id: string) =>
    shortcuts.some((item) => item.targetType === type && item.targetId === id);
  const shortcutItem = (type: ShortcutTarget, id: string, label: string): MenuItem =>
    isShortcut(type, id)
      ? { label: 'Remove shortcut', icon: <StarOff />, onSelect: () => void toggleShortcut(type, id, label) }
      : { label: 'Add shortcut', icon: <Star />, onSelect: () => void toggleShortcut(type, id, label) };

  const askNotebookName = (title: string, initialValue = '') =>
    dialogs.prompt({
      title,
      label: 'Notebook name',
      initialValue,
      confirmLabel: initialValue ? 'Rename' : 'Create',
    });

  const newNotebook = async (stackId: string | null = null) => {
    const name = await askNotebookName('New notebook');
    if (name) void createNotebook(name, stackId);
  };
  const newStack = async () => {
    const name = await dialogs.prompt({ title: 'New stack', label: 'Stack name', confirmLabel: 'Create' });
    if (name) void createStack(name);
  };
  const newTag = async (parent: Tag | null = null) => {
    const name = await dialogs.prompt({
      title: parent ? `New tag in “${parent.name}”` : 'New tag',
      label: 'Tag name',
      confirmLabel: 'Create',
    });
    if (name && tagName(name)) void createTag(tagName(name), parent?.id ?? null);
  };

  const notebookMenu = (notebook: Notebook): MenuItem[] => {
    const count = counts.notebooks[notebook.id] ?? 0;
    return [
      {
        label: 'Rename…',
        icon: <Pencil />,
        onSelect: async () => {
          const name = await askNotebookName('Rename notebook', notebook.name);
          if (name && name !== notebook.name) void renameNotebook(notebook.id, name);
        },
      },
      shortcutItem('notebook', notebook.id, notebook.name),
      ...(isNative
        ? [
            {
              label: 'Export as ENEX…',
              icon: <Download />,
              disabled: count === 0,
              onSelect: () => void exportNotes({ kind: 'notebook', notebookId: notebook.id }, notebook.name),
            },
          ]
        : []),
      { label: 'Move to stack', heading: true, separated: true },
      {
        label: 'No stack',
        checked: notebook.stackId === null,
        onSelect: () => void setNotebookStack(notebook.id, null),
      },
      ...overview.stacks.map((stack) => ({
        label: stack.name,
        checked: notebook.stackId === stack.id,
        onSelect: () => void setNotebookStack(notebook.id, stack.id),
      })),
      {
        label: 'Delete…',
        icon: <Trash2 />,
        danger: true,
        separated: true,
        disabled: overview.notebooks.length <= 1,
        onSelect: async () => {
          const confirmed = await dialogs.confirm({
            title: `Delete “${notebook.name}”?`,
            message:
              count > 0
                ? `Its ${count.toLocaleString()} ${count === 1 ? 'note moves' : 'notes move'} to Trash, where you can restore ${count === 1 ? 'it' : 'them'}. The notebook itself cannot be restored.`
                : 'The notebook is empty. It cannot be restored.',
            confirmLabel: 'Delete notebook',
            danger: true,
          });
          if (confirmed) void deleteNotebook(notebook.id);
        },
      },
    ];
  };

  const stackMenu = (stack: Stack): MenuItem[] => [
    {
      label: 'Rename…',
      icon: <Pencil />,
      onSelect: async () => {
        const name = await dialogs.prompt({
          title: 'Rename stack',
          label: 'Stack name',
          initialValue: stack.name,
          confirmLabel: 'Rename',
        });
        if (name && name !== stack.name) void renameStack(stack.id, name);
      },
    },
    {
      label: 'New notebook in this stack…',
      icon: <FolderPlus />,
      onSelect: () => void newNotebook(stack.id),
    },
    shortcutItem('stack', stack.id, stack.name),
    {
      label: 'Delete stack…',
      icon: <Trash2 />,
      danger: true,
      separated: true,
      onSelect: async () => {
        const confirmed = await dialogs.confirm({
          title: `Delete the stack “${stack.name}”?`,
          message: 'Its notebooks and their notes are kept; they are simply no longer grouped.',
          confirmLabel: 'Delete stack',
          danger: true,
        });
        if (confirmed) void deleteStack(stack.id);
      },
    },
  ];

  const tagMenu = (tag: Tag): MenuItem[] => {
    const count = counts.tags[tag.id] ?? 0;
    const inside = (tagChildren(overview.tags).get(tag.id) ?? []).length;
    return [
      {
        label: 'Rename…',
        icon: <Pencil />,
        onSelect: async () => {
          const name = await dialogs.prompt({
            title: 'Rename tag',
            label: 'Tag name',
            initialValue: tag.name,
            confirmLabel: 'Rename',
          });
          if (name && tagName(name) && tagName(name) !== tag.name) void renameTag(tag.id, tagName(name));
        },
      },
      { label: 'New tag inside…', icon: <Plus />, onSelect: () => void newTag(tag) },
      {
        label: 'Move under…',
        icon: <FolderTree />,
        onSelect: async () => {
          // A tag cannot go under itself or under what it holds.
          const excluded = tagWithDescendants(tag, overview.tags);
          const parent = await dialogs.choose({
            title: `Move “${tag.name}” under`,
            label: 'Find a tag',
            choices: overview.tags
              .filter((item) => !excluded.has(item.id) && item.id !== tag.parentId)
              .map((item) => ({
                id: item.id,
                label: item.name,
                detail: tagPath(item, overview.tags).join(' › ') || undefined,
              })),
          });
          if (parent) void setTagParent(tag.id, parent);
        },
      },
      ...(tag.parentId
        ? [
            {
              label: 'Move to the top level',
              icon: <CornerLeftUp />,
              onSelect: () => void setTagParent(tag.id, null),
            },
          ]
        : []),
      shortcutItem('tag', tag.id, tag.name),
      {
        label: 'Delete…',
        icon: <Trash2 />,
        danger: true,
        separated: true,
        onSelect: async () => {
          const onNotes =
            count > 0
              ? `It is removed from ${count.toLocaleString()} ${count === 1 ? 'note' : 'notes'}. The notes themselves are kept.`
              : 'No note uses this tag.';
          const confirmed = await dialogs.confirm({
            title: `Delete the tag “${tag.name}”?`,
            message:
              inside > 0
                ? `${onNotes} The ${inside === 1 ? 'tag' : `${inside.toLocaleString()} tags`} inside it ${inside === 1 ? 'is' : 'are'} kept and ${inside === 1 ? 'moves' : 'move'} up one level.`
                : onNotes,
            confirmLabel: 'Delete tag',
            danger: true,
          });
          if (confirmed) void deleteTag(tag.id);
        },
      },
    ];
  };

  return { notebookMenu, stackMenu, tagMenu, shortcutItem, newNotebook, newStack, newTag };
}
