/**
 * The payload this cell runs — the single wiring point between the
 * generic harness modules and a domain payload. The harness (DOs,
 * router, turn runner) imports `payload` from here and nothing from
 * ./payloads/*; swapping what a cell does means swapping this line.
 *
 * At extraction (design.md step 4) this file becomes the app's cell
 * entry: the harness moves to @criblio/cell-harness and exports DO
 * factories that take the payload as an argument instead of an
 * import.
 */
import { apmPayload } from './payloads/apm';
import type { FiringAlert } from './protocol';

export const payload = apmPayload;

/** The active payload's trigger type. Harness modules use this alias
 *  so they stay generic over the trigger's shape. */
export type CellTrigger = FiringAlert;
