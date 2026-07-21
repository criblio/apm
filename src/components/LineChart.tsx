/**
 * Multi-series line chart — now the shared implementation from
 * @cribl/app-utils/viz (extracted from this app's original component so the
 * Ubiquiti app and future dashboard apps render identically). This file
 * re-exports it to keep existing import sites unchanged.
 */
export { LineChart as default, type LineSeries } from '@cribl/app-utils/viz';
