/**
 * Subscribes a React component to the stream-filter toggle.
 *
 * Pages that show trace lists (Home, Search, Service Detail) should
 * include the returned value in their `useEffect` dep list so that
 * when the user flips the setting in Settings, the page re-fetches
 * with the new filter applied. Without this, the toggle wouldn't take
 * effect until the next manual refresh or range change.
 */
import { useStore } from '@criblio/app-utils/store';
import { streamFilterStore } from '../api/streamFilter';

export function useStreamFilterEnabled(): boolean {
  return useStore(streamFilterStore);
}
