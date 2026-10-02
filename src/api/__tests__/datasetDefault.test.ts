/**
 * App.tsx must import `./datasetDefault` before anything else. Module-scope
 * code (MetricsBackfillPanel's emitter labels) builds KQL at import time and
 * throws on `dataset=""`, which blanks the whole app before any error
 * boundary exists. The framework DatasetProvider's render-time default is
 * too late for that; tests/local/resilience-local.spec.ts caught it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getCurrentDataset, setCurrentDataset } from '@criblio/app-utils/dataset';

describe('module-scope dataset default', () => {
  it('is the first import of App.tsx', () => {
    const app = readFileSync(join('src', 'App.tsx'), 'utf8');
    const firstImport = app.split('\n').find((line) => line.startsWith('import '));
    expect(firstImport).toBe("import './datasetDefault';");
  });

  it('puts otel in the store when evaluated', async () => {
    setCurrentDataset('');
    await import('../../datasetDefault');
    expect(getCurrentDataset()).toBe('otel');
  });
});
