# Human-team resourcing estimate

**Question asked:** if this repo had been built by humans, how many PM, UX,
and Engineering resources would it have taken to reach its current state?

**Scope:** everything in the repo — shipped app + `eval/` + `cell/` + docs.
Benched against a real product team at Cribl (enterprise SaaS bar: design
review, a11y, QA, on-call-ready), not a startup MVP bar.

**Deliverable:** published artifact —
https://claude.ai/code/artifact/4ed471a3-00ed-47b1-af6c-e5dd782b0251

No code changed this session. Measured at `a0f896f` on
`feat/cell-agent-loop`, 2026-08-12.

## Answer

**~6 FTE for ~10 months — 55–60 person-months, ~$1.1M–$1.4M fully loaded.**

| Role | FTE | Notes |
| --- | --- | --- |
| Engineering | 4–5 | tech lead (KQL/data), frontend, viz, AI/eval, ½ platform |
| Product | 0.8 | one PM, most of their time |
| Design | 0.5 | half a designer, full duration |
| QA / SDET | 0.5 | or absorbed by engineering, as actually happened |

Engineering needs **four specialisms, not four generalists**: the query layer
is a data-engineering job, the isometric renderer is a viz job, and the
prompt corpus + eval harness is an AI-engineering job. Four interchangeable
React developers do not build this.

## Method

Sized 15 areas in **ideal engineer-months** (focused work, no overhead) from
the working tree, then converted at 60% enterprise throughput plus 2–3 months
of Cribl Search platform ramp.

| Area | Ideal months |
| --- | --- |
| Pages & components | 4.5 |
| KQL query layer | 3.0 |
| Provisioning & caching | 2.0 |
| Investigator | 2.0 |
| Test suites | 1.75 |
| Metrics subsystem | 1.5 |
| Visualization | 1.5 |
| Shell, routing, settings | 1.5 |
| Server-side cell | 1.0 |
| Eval harness | 0.9 |
| Docs & design specs | 0.75 |
| Scripts & tooling | 0.6 |
| Spotlight engine | 0.5 |
| CI/CD & release | 0.5 |
| Package extraction | 0.3 |
| **Total ideal** | **22.3** |

22.3 ideal ÷ 0.6 ≈ 37 loaded, + ramp → **38–45 engineer-months**.

Ramp is not padding: the repo logs eight Cribl platform defects with
discovery dates and the days they cost, plus a register of KQL constructs
that crash or silently corrupt output (`(?i)` upstream of `export to lookup`
being the expensive one).

## Measured facts the estimate rests on

All verified directly against the tree, not estimated:

- 421 commits, ~138 PRs (103 squash + 35 merge), 20 release tags, v0.13.28
- 46 days with any commits; 410 of 421 commits fall in Apr–Aug 2026
- ~124k lines added lifetime (excl. lockfiles), 823 files touched
- `src/`: 29k LOC TS/TSX + 5.9k LOC across 42 CSS modules
- 16 route files / 23 `<Route>` entries; 37 components
- `src/api/queries.ts`: 2,471 lines, 58 exports
- `src/api/provisionedSearches.ts`: 26 provisioned scheduled searches
- `src/api/agentContext.ts`: 1,708 lines / 81KB hand-authored system prompt
- 27 vitest files, 22 Playwright specs, 14 eval scenarios
- **32 ARIA attributes total in `src/`; 0 hits for axe/pa11y/Lighthouse/WCAG**
- **0 design-tool references** (the 3 grep hits for "figma" are `ConFIGMAp`)

## The three findings worth acting on

### 1. PM output is real; design output mostly isn't

`ROADMAP.md` (657 lines) is genuine staff-level product work — 36 sized
items, argued sequencing, a release gate with 19 numbered exit criteria that
blocks feature work, an upstream-defect register, and a documented reversal
where detection thresholds were tuned up on precision after our own eval
proved them over-sensitive. `HEURISTICS.md` is arguably the deeper artifact:
it defines what the product *considers a problem*, which in observability is
the core product decision.

The gap: this is a PM with **zero customer inputs** — no interviews, no
win/loss, no usage analytics, no support themes, no pricing. Prioritization
is reasoned from first principles and from the eval benchmark. A real Cribl
PM spends ~a third of their time on discovery: 3–4 months not represented
here, which would likely have changed the roadmap.

On design, exactly one true artifact exists —
`docs/research/ux-competitive-analysis.md`, a competitive IA teardown of
Datadog / New Relic / Dynatrace / Grafana with seven self-critiques, a
wireframe, and five view-composition principles. That's ~1.5 designer-months.
Everything after it is engineer-executed and validated by deploying to
staging and screenshotting, never by prototype or by a user.

### 2. Accessibility is unpaid debt, not completed work

32 ARIA attributes across a dense data product built on force-directed
graphs, sortable tables, trace waterfalls and color-coded health states. No
`:focus-visible`, no `prefers-reduced-motion`, no skip links, no a11y tooling
anywhere in the tree.

Nineteen release-gate items were written and burned down and **not one of
them is accessibility**. Closing this to an enterprise bar is ~1.5
engineer-months plus a designer's audit. This is the single largest thing a
real team would have had to add, and it belongs on ROADMAP.md.

### 3. The over/under-delivery pattern is diagnostic

Against ~55–60 person-months, the actual build was one author + Claude over
46 active days — roughly a tenfold compression. Where it holds and where it
doesn't is the interesting part:

- **Over-delivers on what teams usually skip.** Regression tests citing
  specific outages by version. A CI gate whose comment explains the four
  Dependabot PRs that sat open a month. Build-provenance attestation. An eval
  harness re-run and acted on eleven times. Most six-person teams ship none
  of this.
- **Under-delivers exactly where a function wasn't staffed.** No research, no
  a11y, no pattern library across 42 ad-hoc CSS modules, no copy deck. The
  gaps map cleanly onto the two empty chairs.
- **Judgment work didn't compress.** The roadmap, the heuristics doc, and the
  server-investigations bet read as one person's thinking — written down
  rather than left in someone's head.

## Caveats on the number

- Excludes the sibling `cribl-search-app-framework` (~7.9k LOC, 25 commits),
  from which the chart primitives, investigator chat shell, and agent tool
  loop are consumed. Building those in-house would add to the estimate.
- "46 active days" counts days with commits. It is a floor on effort, not a
  measure of it.
- Loaded cost assumes $220k–$280k per senior IC, US.
