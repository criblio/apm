/**
 * React hook that exposes the current dataset name and re-renders when it
 * changes. Built on useSyncExternalStore so components participate in React's
 * concurrent rendering correctly.
 */
import { useSyncExternalStore } from 'react';
import { getCurrentDataset, subscribeDataset } from '../api/dataset';

export function useDataset(): string {
  return useSyncExternalStore(subscribeDataset, getCurrentDataset, getCurrentDataset);
}
