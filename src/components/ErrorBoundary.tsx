import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** What stands in place of the part that failed; `retry` draws it again. */
  fallback: (error: Error, retry: () => void) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Keeps a failure while drawing one part of the interface from taking the
 * rest with it. Without one, a note that cannot be drawn leaves an empty
 * window, and with it no way to open another note.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    return error ? this.props.fallback(error, () => this.setState({ error: null })) : this.props.children;
  }
}
