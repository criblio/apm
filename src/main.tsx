import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Capra design system styles. Order matters: theme first (sets the
// CSS custom properties Capra components read), then core
// (component styles), then icons (icon font + classes). Our own
// base.css comes last so anything we override stays on top.
import '@capra/theme/base.css';
import '@capra/core/styles.css';
import '@capra/icons/styles.css';
import './styles/base.css';
import App from './App.tsx';
import ResilienceBoundary from './components/ResilienceBoundary.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ResilienceBoundary title="Cribl APM could not start">
      <App />
    </ResilienceBoundary>
  </StrictMode>,
);
