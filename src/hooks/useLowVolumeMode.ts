import { useStore } from '@criblio/app-utils/store';
import { lowVolumeModeStore } from '../api/lowVolumeMode';

/** Subscribe to the low-volume-mode setting. Returns the current
 *  boolean and re-renders the caller when the value changes. */
export function useLowVolumeMode(): boolean {
  return useStore(lowVolumeModeStore);
}
