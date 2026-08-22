/**
 * The payload this cell runs — the single wiring point the entry
 * (index.ts) hands to @criblio/cell-harness's DO/router factories.
 * Swapping what a cell does means swapping this line.
 */
import { apmPayload } from './payloads/apm';
import type { FiringAlert } from './protocol';

export const payload = apmPayload;

/** The active payload's trigger type. */
export type CellTrigger = FiringAlert;
