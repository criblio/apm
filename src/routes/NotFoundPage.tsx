import { Button } from '@capra/core';
import { useNavigate } from 'react-router-dom';

export default function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <main style={{ padding: 'var(--cds-space-xl)' }}>
      <h1>Page not found</h1>
      <p>The requested Cribl APM route does not exist or is no longer supported.</p>
      <Button variant="primary" onClick={() => navigate('/', { replace: true })}>
        Return to Overview
      </Button>
    </main>
  );
}
