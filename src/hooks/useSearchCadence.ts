import { useSyncExternalStore } from 'react';
import { getSearchCadence, subscribeSearchCadence, type CadenceOption } from '@criblio/app-utils/cadence';

export function useSearchCadence(): CadenceOption {
  return useSyncExternalStore(subscribeSearchCadence, getSearchCadence, getSearchCadence);
}
