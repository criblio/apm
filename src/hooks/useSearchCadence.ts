import { useSyncExternalStore } from 'react';
import { getSearchCadence, subscribeSearchCadence, type CadenceOption } from '../api/searchCadence';

export function useSearchCadence(): CadenceOption {
  return useSyncExternalStore(subscribeSearchCadence, getSearchCadence, getSearchCadence);
}
