/**
 * Re-export of the shared transcript PNG exporter. The renderer
 * moved into the Investigator chat shell package
 * (@criblio/app-utils/investigator); this module preserves the
 * historical `src/utils/exportInvestigation` import surface.
 */
export { exportAsPng } from '@criblio/app-utils/investigator';
