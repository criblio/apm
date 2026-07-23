/**
 * Canonical in-app route paths that are referenced from more than one
 * place, so a rename can't leave a dangling link behind.
 *
 * CONFIGURATION_PATH is the settings/provisioning page. It is
 * deliberately `/configuration`, NOT `/settings`: the Cribl host shell
 * intercepts any pack route whose path contains "settings", so the page
 * was renamed in v0.11.2. The App route, the sidebar item, and the
 * provisioning banner's "Open settings" link all resolve to this one
 * constant — v0.11.2 renamed the route but missed the banner, which
 * sent users to a dead `/settings` (a 404) with no way to reach or
 * clear provisioning.
 */
export const CONFIGURATION_PATH = '/configuration';
