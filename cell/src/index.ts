/**
 * APM investigator cell — entry point.
 *
 * The generic harness (router, coordinator + session DOs, tickets,
 * pi-agent-core turn runner) lives in @criblio/cell-harness; this
 * entry wires the APM payload into it and exports the DO classes
 * under the exact names wrangler.jsonc binds (CoordinatorDO /
 * InvestigationDO — part of the deployed DO identity, do not rename).
 */
import { cellRouter, makeCoordinatorDO, makeSessionDO } from '@criblio/cell-harness';
import { payload } from './payload.instance';

export const CoordinatorDO = makeCoordinatorDO(payload);
export const InvestigationDO = makeSessionDO(payload);

export default cellRouter;
