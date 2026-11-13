import type { ReactNode } from 'react';
import { create } from 'zustand';

/**
 * In-app replacements for the browser's `prompt()` and `confirm()`, which
 * look foreign in a desktop window and are unreliable in mobile WebViews.
 *
 * ```ts
 * const name = await dialogs.prompt({ title: 'New notebook', label: 'Name' });
 * if (await dialogs.confirm({ title: 'Delete notebook?', message: '…', danger: true })) …
 * ```
 */
export interface PromptOptions {
  title: string;
  /** Shown above the field: what is about to happen. */
  message?: ReactNode;
  label: string;
  /** Styles the confirming button as destructive. */
  danger?: boolean;
  /** Said when nothing was typed; a name is asked for by default. */
  emptyMessage?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Returns a message when the value is not acceptable. */
  validate?: (value: string) => string | null;
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  /** Styles the confirming button as destructive. */
  danger?: boolean;
}

export interface Choice {
  id: string;
  label: string;
  /** Said under the label: where the choice is, for instance. */
  detail?: string;
}

export interface ChooseOptions {
  title: string;
  message?: ReactNode;
  /** Names the field that narrows the list down. */
  label: string;
  choices: Choice[];
}

export type DialogRequest =
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'choose'; options: ChooseOptions; resolve: (value: string | null) => void };

export const useDialogStore = create<{ request: DialogRequest | null }>(() => ({ request: null }));

function open<T>(build: (resolve: (value: T) => void) => DialogRequest, cancelled: T): Promise<T> {
  // A dialog opened over another replaces it; the first one counts as cancelled.
  const previous = useDialogStore.getState().request;
  if (previous?.kind === 'prompt' || previous?.kind === 'choose') previous.resolve(null);
  if (previous?.kind === 'confirm') previous.resolve(false);
  return new Promise<T>((resolve) => {
    useDialogStore.setState({
      request: build((value) => {
        useDialogStore.setState({ request: null });
        resolve(value);
      }),
    });
  }).catch(() => cancelled);
}

export const dialogs = {
  /** Resolves to the trimmed text, or null when cancelled. */
  prompt: (options: PromptOptions) =>
    open<string | null>((resolve) => ({ kind: 'prompt', options, resolve }), null),
  confirm: (options: ConfirmOptions) =>
    open<boolean>((resolve) => ({ kind: 'confirm', options, resolve }), false),
  /** Resolves to the id of the choice taken, or null when cancelled. */
  choose: (options: ChooseOptions) =>
    open<string | null>((resolve) => ({ kind: 'choose', options, resolve }), null),
};
