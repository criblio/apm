import { useStore } from '@criblio/app-utils/store';
import { serverInvestigationsStore } from '../api/serverInvestigations';

/** Subscribe to the server-investigations flag. Returns the current
 *  boolean and re-renders the caller when the value changes. */
export function useServerInvestigations(): boolean {
  return useStore(serverInvestigationsStore);
}
