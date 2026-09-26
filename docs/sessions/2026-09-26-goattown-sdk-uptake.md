# GoatTown SDK uptake, 0.8.6 → 0.9.1

Covers the arc from reviewing the shared session contract through three merged
PRs. Released v0.14.13 on the way. Written up because several findings are the
kind that cost a debugging session to rediscover.

Shipped: **#171** (migrate onto the released SDK), **#172** (unblock the audit
gate, release 0.14.13), **#174** (app-utils 0.9.1 + KV absence), **#175**
(GoatTown token guidance). Plus `criblio/otel-demo-criblcloud#20` for the flagd
port-forward.

Final pins: `@criblio/app-utils ^0.9.1`, `@criblio/agent-protocol ^0.4.2`,
`@criblio/app-tooling ^0.2.4`.

## `idle` is not completion — the change that mattered most

The old `subscribeInvestigation` ended observation on a terminal session status,
or on `idle` when `stopOnIdle` was set. `idle` means *between turns*, and a
session is idle **before its first answer as well as after its last**. So
observation could stop before the response was written, which surfaced
downstream as an empty conclusion while the session looked perfect in GoatTown.

Completion is now: a terminal request receipt **and** a local cursor that has
reached its `finalSeq`. `sendMessage` returns its receipt and the session hook
follows that specific one, because several queued messages can be consumed by a
single response and each carries its own receipt.

Anything reading a conclusion needs the same care. `fetchInvestigationReportHeadline`
previously scanned raw frames for a report/summary tool result and returned `''`
for anything else — so an investigation that concluded in assistant prose
reported no conclusion at all. It now folds frames through `applyLoopEvent` and
asks the shared `conclusionFromEntries`, which reads tool results first and
prose second rather than one instead of the other.

## The `report_findings` rename is load-bearing, for a non-obvious reason

`wireEventToLoopEvent` renames GoatTown's `report_findings` to
`present_investigation_summary`. The framework agent twice suggested dropping it,
reasoning that the transcript's redundant-dump guard now keys on payload kind
rather than tool name. That reasoning is correct and the conclusion is still
wrong.

The *finished* card does dispatch on `ui.kind === 'report'`
(`InvestigatorTranscript.js:244`), checked before any tool-name branch, and
APM's own `renderApmToolCard` keys purely on `ui.kind`. But before the **result**
arrives `ui` is undefined, so `:244` does not match and the tool-name branch at
`:250` is the only thing that does — rendering
`SummaryCard({ui: undefined})`, i.e. "📋 Investigation summary — Preparing…".

Drop the rename and a concluding call renders *nothing* until its result lands
(the fallthrough is `return null`, the "agent plumbing" path), then the summary
appears abruptly. Re-verified at 0.9.1. Keep it.

## `kvGet` treated every 404 as absence, which was destructive

`saveAppSettings` merges onto `(await loadAppSettings()) ?? {}` and writes the
result. A 404 read as absence therefore makes `existing` `{}` and the next save
**replaces every persisted setting** — dataset, cadence, filter rules, source
repos, every toggle — with whatever partial was in flight. The function's own
comment promised the opposite: *"Merges with whatever else is stored so we don't
clobber future fields."*

Two different things answer 404, confirmed against Cribl staging:

| Case | Status | Content type | Body |
| --- | --- | --- | --- |
| key genuinely absent | 404 | `application/json` | `{"message":"Key not found"}` |
| unmatched route / rejected credential | 404 | `text/html` | web-shell error page |

Absence is now only the first. Anything else throws `KvStoreError`, which carries
`isRoutingFailure` for the HTML case, so the save fails rather than destroying
the record. Error messages deliberately omit response bodies — a KV value can be
a credential — and `src/api/__tests__/kvstore.test.ts` pins both that and the
absence/misroute distinction.

We narrowed our own client rather than adopting `@criblio/app-utils/kv`: its
`KvResult` union changes the absence signal at all 7 call sites, while the bug
was one branch. Worth revisiting if we want to converge.

## `npm run verify` was type-checking nothing

It ran `tsc --noEmit` against a solution-style `tsconfig.json` whose `files` is
`[]` with only `references`. Without `-b`, that checks **zero files**. It
silently passed a real error during the migration (a `stopOnIdle` left dangling
after the option was removed); `tsc -b` caught it immediately.

`verify` now runs `tsc -b --force`, matching what `build` already did. Any local
gate result from before this change should be treated as lint + tests only.

Related: vitest now inlines `@criblio/app-utils` (`server.deps.inline`). The
`/investigator` subpath imports a stylesheet, and as an externalised dep it
reached node's resolver, which has no `.css` loader — that is what previously
made the transcript reducer, and therefore `conclusionFromEntries`, untestable.

## The shared validation workspace's version floor

CI's "upgrade the shared validation workspace" step installs the candidate, and
the workspace then refuses anything not strictly newer. So **any** open PR that
bumps the version and runs CI raises the floor for every other branch, and
master silently falls behind it.

This bit us twice. v0.14.11 could not be released at all because #171's CI had
installed 0.14.12; then #174 and #175 each needed their own bump. The practical
rule: before tagging or pushing a candidate, check the installed version and bump
past it rather than assuming `package.json` is ahead.

Releases also run the same `release-build` action as CI, so a red audit gate on
master means a *tagged release fails* rather than merely a CI run. v0.14.13
existed to clear that.

## GoatTown has two token kinds and only one is retrievable

An operator could not configure GoatTown because Settings asked for two tokens
while the console issues one. Nothing was broken — the credential was already
delivered to `kv.goattownEmbedToken` and worked — but the guidance was wrong.

| Token | Issued by | Re-readable | Purpose | Reaches |
| --- | --- | --- | --- | --- |
| `gt_a1_` app credential | Connections → Connected apps | **yes** ("Copy token") | `ui` | 30 of 31 routes, all sessions |
| `gt_i1_` installation UI | installation enrolment, once | no | `ui` | legacy installation UI |
| `gt_w1_` installation webhook | installation enrolment, once | **no** | `webhook` | `/alerts/fire` only |

Verified against GoatTown `master` at `fa19e3d`: `/alerts/fire` is the only route
declaring `auth: "webhook"`; an app credential resolves with `purpose` hardcoded
to `'ui'` (`cell/src/appConnectionStore.ts`), and `installations.ts` refuses any
`appConnectionId` token that is not ui-purpose. Probed live with a non-trigger
body so nothing fired: the stored `gt_w1_` gets `202 {"accepted":0}`, the stored
`gt_a1_` gets `401`.

`gt_w1_` now appears in exactly one file repo-wide (an installations test) and
the `console/` tree has none. The token did not change; its visibility did,
because it is a one-shot enrolment secret with `cache-control: no-store`.

**Consequence worth remembering:** the `gt_w1_` in `kv.goatTownWebhookToken` is
the only copy in existence. Losing it means re-enrolling the installation. Do not
clear that field. A connected app therefore has no supported path to alert-fired
investigations at all — written up for the GoatTown agent and sent.

## Reaching flagd, and the eval harness

The eval harness drives the flagd failure scenarios through flagd-ui's
`/api/read` and `/api/write`, and defaulted to `FLAGD_UI_URL=http://localhost:4000`
— where nothing ever listened, because `deploy-demo.sh` forwarded five services
and flagd was not one of them. Fixed in `otel-demo-criblcloud#20`.

On the private AWS deployment the security group admits only **8080 and 22**, so
port 4000 is unreachable across the network even with the forward running.
Envoy in `frontend-proxy` routes `/feature` to `flagd-ui:4000`, so the working
value over Tailscale is:

```
FLAGD_UI_URL=http://10.0.37.40:8080/feature
```

Confirmed 200 with the unwrapped `{"flags":{…}}` shape `tests/helpers/flagd.ts`
expects, 15 flags.

Two gotchas about flag state, both easy to misread. flagd reads its config from
an **emptyDir** that an init container copies from the `flagd-config` ConfigMap,
and flagd-ui writes to that same emptyDir — never back to the ConfigMap. So UI
toggles are ephemeral and a pod restart resets everything to the ConfigMap, while
`flagd-set.sh` patches the ConfigMap *and* restarts the pod, discarding UI
changes. Checking only one of the two tells you nothing.

Also: `flagd-set.sh` and `docs/failure-scenarios.md` both name a flag
`recommendationCache` that does not exist — the real one is
`recommendationCacheFailure`, so the documented command is rejected. Four flags
are undocumented: `llmInaccurateResponse`, `llmRateLimitError`,
`failedReadinessProbe`, `emailMemoryLeak`.

## Status and open items

Master is at 0.14.16, CI green. Repo tidied from 59 remote branches to 11; a
recovery manifest of the 48 deleted tips is at `~/apm-branch-recovery.tsv`
(restore with `git push origin <sha>:refs/heads/<branch>`). #155 and #156 closed
as obsoleted by #163 removing `cell/`.

Still open:

- **`imageReadiness` and `SessionDiagnostics`** are wired into the transport but
  no UI renders them. Recommendation: wire `SessionDiagnostics` into the Settings
  diagnostics disclosure — "the answer was empty but GoatTown looks fine" was a
  recurring failure mode this session and raw frames are what settle it. Leave
  `imageReadiness` until there is an image-send affordance in Investigate;
  advertising readiness with no way to send an image is not useful on its own.
- **Three branches hold unmerged work** and were deliberately not deleted:
  `feat/pi-agent-core-turn` (6 commits), `feat/cell-terraform` (4),
  `feat/spotlight-readable-results` (2). The first two are `cell/`-related and
  probably obsolete.
- **The demo instance cannot fast-forward.** Its bootstrap `sed`s
  `--server-side=true` and `--force-conflicts` out of `deploy-demo.sh` in place,
  so `git pull` refuses. Worth fixing in `user-data.sh.tftpl` — patching a
  tracked file at boot means that host can never take an update cleanly.
