import { useSyncExternalStore } from 'react';
import { getLowVolumeMode, subscribeLowVolumeMode } from '../api/lowVolumeMode';

/** Subscribe to the low-volume-mode setting. Returns the current
 *  boolean and re-renders the caller when the value changes. */
export function useLowVolumeMode(): boolean {
  return useSyncExternalStore(subscribeLowVolumeMode, getLowVolumeMode, getLowVolumeMode);
}
