/**
 * Synchronous module-scope dataset default, imported FIRST by App.tsx so it
 * runs before any other app module is evaluated.
 *
 * The framework `DatasetProvider` (`defaultDataset="otel"`) sets the default
 * during its own render, which is early enough for components but not for
 * module-scope code: `MetricsBackfillPanel` builds its emitter labels from
 * `getMetricEmitters()` at import time, and those query builders throw
 * `KqlSafetyError` on `dataset=""` — before React renders anything, so no
 * error boundary can catch it and the app shows a blank page. APM's former
 * DatasetProvider module did this same `setCurrentDataset('otel')` at its
 * own module scope; this keeps it now that the provider is the framework's.
 */
import { setCurrentDataset } from '@criblio/app-utils/dataset';

setCurrentDataset('otel');
