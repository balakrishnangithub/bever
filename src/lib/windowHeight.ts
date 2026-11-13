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
