/**
 * Browser Cribl Search client for the app.
 *
 * The signal-aware browser search client — `runQuery` with the
 * navigation-generation abort default, the get/post-carry-signal /
 * del-no-signal nuance, and the search-job runner wiring — now lives in
 * the shared framework (`@criblio/app-utils/search`). It was pushed down so
 * every framework consumer gets nav-scoped KQL cancellation, not just
 * this app. This module re-exports it so existing imports (`./cribl`)
 * keep working.
 *
 * `runQuery(kql, earliest, latest, limit, signal?)` runs one KQL search
 * job; when no `signal` is passed it defaults to the current navigation
 * generation (see queryGeneration.ts) so the job is cancelled on nav —
 * poll loop broken, worker-pool slot released, in-flight fetches aborted.
 *
 * App-specific query builders live in queries.ts and search.ts.
 */
export { runQuery, apiUrl } from '@criblio/app-utils/search';
