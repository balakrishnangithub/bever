/**
 * Calls `shortened` whenever the window loses height. On a phone that is the
 * on-screen keyboard opening: the Android shell makes the page shorter by
 * the keyboard's height. Returns what stops the watching.
 */
export function onWindowShortened(shortened: () => void): () => void {
  let height = window.innerHeight;
  const resized = () => {
    const shorter = window.innerHeight < height;
    height = window.innerHeight;
    if (shorter) shortened();
  };
  window.addEventListener('resize', resized);
  return () => window.removeEventListener('resize', resized);
}

/**
 * Brings the field being typed into back into view, if it is a plain one.
 * A note's text looks after its own caret.
 */
export function showFocusedField() {
  const field = document.activeElement;
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    field.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

/**
 * Takes the focus from the field that has it, for something that opens over
 * the whole window: an editor of a picture, a preview. On a phone the field
 * would keep its keyboard up under what was opened, over half of it, and
 * the keyboard would take the first Back for itself. Returns what gives the
 * focus back when the thing closes; where the pointer is a finger it is not
 * given back, since that would bring the keyboard up again unasked.
 */
export function leaveField(): () => void {
  const field = document.activeElement;
  if (!(field instanceof HTMLElement) || !field.matches('input, textarea, [contenteditable="true"]')) {
    return () => undefined;
  }
  field.blur();
  return () => {
    if (field.isConnected && !window.matchMedia('(pointer: coarse)').matches) {
      field.focus({ preventScroll: true });
    }
  };
}
