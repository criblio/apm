# Faceted navigation for the Search page (2026-05-28)

Three-PR thread closing out the v0.9.0 release: build a Honeycomb-BubbleUp-equivalent (named **Spotlight**) plus the wider faceted-nav stack (typed filter builder, per-attribute value autocomplete, facet panel, raw-KQL escape hatch) on top of the Search page.

## PR thread

- **PR D — data layer** (#46, merged). `SPOTLIGHT_ATTRIBUTES`, `attrValueDistribution`, `spotlightAttrDiff`, `getFacetDistribution`, `getSpotlightDiff`, `AttrValueBucket`/`SpotlightBucket`. Plus an `agentContext.ts` gotcha for the `countif(not <bool>)` Cribl-KQL parser bug surfaced during MCP validation.
- **PR E — engine + UI primitives** (#47, merged). `computeSpotlight()` ranking, `filterModel.ts` (FilterRow + serializers), `<FilterBuilder>`, `<FacetPanel>`, `<SpotlightPanel>`, `<KqlEditor>`. Pure-TS modules unit-tested; React components rendered standalone, validated end-to-end in PR F.
- **PR F — Search page integration** (this PR, #48). Wires everything together.

## Design choices

**Live queries, no pre-compute.** Pre-computing a value catalog via scheduled search was tempting, but Cribl KQL's dynamic-indexing rules (`attributes[col]` where `col` is a variable doesn't resolve) block it. Single-scan `countif` over the live span set works fine and avoids the provisioner refactor that ROADMAP item #10 calls out as deferred.

**Naming.** Honeycomb's BubbleUp is the recognizable label for the feature. Copying the feature is fine; copying the trademark is not. We went with **Spotlight** for the panel and the API surface.

**Hard gate on "has signal".** The facet/Spotlight rail fans out 22 parallel queries — one per attribute in `SPOTLIGHT_ATTRIBUTES`. Without a service, operation, or filter to scope down, that's 22 queries against an unbounded span set, which both wastes cluster resources and gives the user a meaningless "everything is everything" panel. The rail renders an instructional placeholder until there's a real signal to differentiate against.

**Streaming results.** Even with a real predicate, 22 KQL queries take 20s+ to settle on staging. Waiting for all to resolve before painting the panel produced a stuck "Loading…" state. `getFacetDistribution` and `getSpotlightDiff` now accept an `onAttr(attr, rows)` callback that fires per-attribute as each query resolves, and SearchPage drops `facetLoading` on the first non-empty result. Attributes appear one by one — first useful one visible at ~3s, full panel populated by ~25s.

## Validation

The deployed pack on staging walked through via Playwright. Screenshots in `docs/sessions/screenshots/2026-05-28-faceted-nav/`:

- `00-search-initial.png` — empty state, placeholder hint
- `01-search-with-facets.png` — Facets tab populated with `http.route` (6 values, bars, counts)
- `02-spotlight-with-selection.png` — Spotlight ranking with `http.response.status_code == 200` selection
- `03-filter-builder-row.png` — FilterBuilder with `http.re = 500` row
- `04-spotlight-errors-selection.png` — Spotlight ranks `http.status_code` (score 11.23), `http.request.method` (10.14), `http.method` (7.14) with per-value diff% and sel/base bars

Smoke spec `tests/faceted-nav.spec.ts` (kept lean, 5s on a warm session): asserts all four primitives mount + tabs toggle + filter row is editable.

## Known limitations

- The 22 parallel queries can pressure the cluster on cold cache. The streaming UX hides the worst of it, but a follow-up should reduce the default attribute list to ~10 hand-picked facets and let users opt into a "scan more attributes" toggle.
- The empty-Spotlight differential when the user's predicate matches zero spans shows "everything is base" (sel_n=0 across the board). This is technically correct but visually confusing. A future improvement: detect `sel_total == 0` and render a one-line callout instead.
- The Investigator and the rest of the app don't yet know about Spotlight. PR after 0.9.0 should expose a "show Spotlight for this error" link from Errors page and Service Detail.

## Next

After PR #48 lands and CI is green, cut v0.9.0.
