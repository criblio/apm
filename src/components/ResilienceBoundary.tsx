import type { ReactNode } from 'react';
import { Button } from '@capra/core';
import { ResilienceBoundary as SharedResilienceBoundary } from '@cribl/app-utils/resilience-boundary';

interface Props {
  children: ReactNode;
  title?: string;
  description?: string;
}

/** APM presentation for the framework-owned render-failure boundary. */
export default function ResilienceBoundary({ children, title, description }: Props) {
  return (
    <SharedResilienceBoundary
      title={title}
      description={description}
      onError={(error, info) => {
        console.error('[ResilienceBoundary] contained render failure', error, info.componentStack);
      }}
      fallback={({ error, retry }) => (
        <section role="alert" style={{ padding: 'var(--cds-space-lg)' }}>
          <h2>{title ?? 'This view is temporarily unavailable'}</h2>
          <p>
            {description ??
              'A rendering failure was contained here. Other app surfaces remain available.'}
          </p>
          <details>
            <summary>Technical detail</summary>
            <code>{error.message}</code>
          </details>
          <div style={{ marginTop: 'var(--cds-space-md)' }}>
            <Button variant="secondary" onClick={retry}>Retry</Button>
          </div>
        </section>
      )}
    >
      {children}
    </SharedResilienceBoundary>
  );
}
