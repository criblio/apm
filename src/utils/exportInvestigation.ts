/**
 * Re-export of the shared transcript PNG exporter. The renderer
 * moved into the Investigator chat shell package
 * (@cribl/app-utils/investigator); this module preserves the
 * historical `src/utils/exportInvestigation` import surface.
 */
export { exportAsPng } from '@cribl/app-utils/investigator';
