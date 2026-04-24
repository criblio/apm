# @cribl/app-utils

Shared utilities for building Cribl Search App packs. Extracted from
the Cribl APM app.

## Modules

### `kvstore` — Pack-scoped KV store client
```typescript
import { kvGet, kvPut } from '@cribl/app-utils/kvstore';
await kvPut('settings/app', { dataset: 'otel' });
const settings = await kvGet('settings/app');
```

### `query` — KQL query runner
```typescript
import { runQuery } from '@cribl/app-utils/query';
const rows = await runQuery('dataset="otel" | limit 10', '-1h', 'now');
```

### `settings` — App settings pattern
```typescript
import { loadSettings, saveSettings, createPubSub } from '@cribl/app-utils/settings';
const pubsub = createPubSub('default');
pubsub.subscribe(() => console.log('changed:', pubsub.get()));
pubsub.set('new-value');
```

### `alert-state` — Alert state machine
```typescript
import { newAlertState, evaluateTransition } from '@cribl/app-utils/alert-state';
const state = newAlertState('auto:error_rate:payment');
const transition = evaluateTransition(state, true); // bad evaluation
// state.status === 'pending' after first bad
```

## Status

Currently co-located in the APM repo (`packages/app-utils/`).
Will be published as a standalone npm package once validated by a
second app consumer.
