import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@capra/core';

interface Props {
  children: ReactNode;
  title?: string;
  description?: string;
}

interface State {
  error: Error | null;
  resetKey: number;
}

/** Contains render failures and remounts only the failed subtree on Retry. */
export default class ResilienceBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ResilienceBoundary] contained render failure', error, info.componentStack);
  }

  private retry = (): void => {
    this.setState((state) => ({ error: null, resetKey: state.resetKey + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <section role="alert" style={{ padding: 'var(--cds-space-lg)' }}>
          <h2>{this.props.title ?? 'This view is temporarily unavailable'}</h2>
          <p>
            {this.props.description ??
              'A rendering failure was contained here. Other app surfaces remain available.'}
          </p>
          <details>
            <summary>Technical detail</summary>
            <code>{this.state.error.message}</code>
          </details>
          <div style={{ marginTop: 'var(--cds-space-md)' }}>
            <Button variant="secondary" onClick={this.retry}>Retry</Button>
          </div>
        </section>
      );
    }
    return <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>;
  }
}
