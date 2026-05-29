# Settings page cleanup (2026-05-29)

ROADMAP item #13. Pure UX rearrangement — no new features, no schema
or query changes.

## Problem (per ROADMAP)

The Settings page had grown to 8 sections in chronological-by-landing
order rather than mental-model order. Symptoms:

- Setup actions (provisioning, dataset acceleration) buried at the
  bottom; new users wouldn't scroll there.
- No section nav. Single long scroll.
- Diagnostic content (Trace originators, an audit table) mixed with
  configuration.
- Related sections separated (Noise filters + Error filtering shape
  what shows up as an error but had Dataset between them).

## What changed

1. **Setup status card at the top.** Two checkmark rows
   (`Scheduled searches`, `Dataset acceleration`) with their current
   provisioning state. Green-left-border + checkmark when both are
   OK. If either fails, the card prompts the user with a "Jump to X"
   button. Reuses the same `planOnly()` + `getDatasetStatus()`
   checks the global `ProvisioningBanners` uses.

2. **Two-column layout.** Sticky left-rail section nav listing the
   four groups; right column holds the cards. Collapses to single
   column below 960px (nav hides).

3. **Sections grouped by purpose** with group headings:
   - **Setup** — Provisioning, Dataset acceleration (TOP).
   - **Workspace** — Dataset, Detection cadence, Notification targets.
   - **Filtering & heuristics** — Noise filters, Error filtering.
   - **Diagnostics** — Trace originators (collapsed by default).

4. **Setup panels moved to the top.** The original page had them at
   the very bottom; first-time installers had to scroll past 5
   tuning sections to find them.

5. **Trace originators collapsed by default.** Operators rarely look
   at the classification audit; an explicit toggle button on the
   section title expands it on demand.

6. **IntersectionObserver-driven nav highlight.** Scrolling the
   content auto-syncs which nav link is highlighted, without a
   click.

## Files added

- `src/routes/SettingsSetupStatus.tsx` + `.module.css` — the
  checkmark card at the top.
- `src/routes/SettingsNav.tsx` + `.module.css` — the sticky
  section nav.

## Files modified

- `src/routes/SettingsPage.tsx` — restructured the JSX into the
  two-column layout with grouped sections. Each card got an `id`
  attribute for anchor-scrolling. The bottom-of-page
  `<ProvisioningPanel>` and `<DatasetProvisioningPanel>` were
  moved into the Setup group at the top (no more duplicates).
- `src/routes/SettingsPage.module.css` — added `.layout`,
  `.navCol`, `.contentCol`, `.groupHeading`, `.groupHelp`,
  `.diagnosticToggle`, `.diagnosticChevron`.

## Validation

Deployed to staging, captured via Playwright. Screenshot in
`docs/sessions/screenshots/2026-05-29-settings-cleanup/`.

Setup status card shows green checkmarks (the staging workspace is
fully provisioned). Nav highlights "Provisioning" as the in-view
section. Both Setup cards render their full content (Preview plan +
Danger zone for the saved-search panel; green checkmarks for the
dataset ruleset + accelerated fields).

## Pre-merge

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors.
- `npm test` — 107/107 passing.
- `npm run build` — production build succeeds.
