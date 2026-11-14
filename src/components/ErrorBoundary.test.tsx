import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

function Broken({ broken }: { broken: boolean }) {
  if (broken) throw new Error('this part cannot be drawn');
  return <p>Drawn</p>;
}

describe('error boundary', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('shows what is given in place of a part that fails, and the rest stays', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let broken = true;
    const draw = () =>
      act(() =>
        root.render(
          <div>
            <p>Beside it</p>
            <ErrorBoundary
              fallback={(error, retry) => <button onClick={retry}>Failed: {error.message}</button>}
            >
              <Broken broken={broken} />
            </ErrorBoundary>
          </div>,
        ),
      );
    draw();
    expect(host.textContent).toBe('Beside itFailed: this part cannot be drawn');

    // Asked to try again once the cause is gone, it draws the part.
    broken = false;
    draw();
    act(() => host.querySelector('button')?.click());
    expect(host.textContent).toBe('Beside itDrawn');
    act(() => root.unmount());
  });
});
