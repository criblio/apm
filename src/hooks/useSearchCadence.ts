import { useSyncExternalStore } from 'react';
import { getSearchCadence, subscribeSearchCadence, type CadenceOption } from '@cribl/app-utils/cadence';

export function useSearchCadence(): CadenceOption {
  return useSyncExternalStore(subscribeSearchCadence, getSearchCadence, getSearchCadence);
}
