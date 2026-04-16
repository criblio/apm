> **Stale** — this plan was superseded first by plan v2, then by ROADMAP.md §1d. Kept for historical context.

# Session: Next-PR plan after flatten (2026-04-14)

Context handoff doc. PR #1 (`chore/flatten-to-apm`,
https://github.com/criblio/apm/pull/1) is open and validated — flattens
`oteldemo/` to repo root, drops k8s plumbing, merges browser-automation
devDeps, rewrites `CLAUDE.md`, retitles `index.html`. Validated:
`npm install` clean, `npm run lint` clean, `npm run build` → 506 kB
bundle, `npm run dev` boots Vite v8.0.8 in 166 ms, `/` + `/src/main.tsx`
both HTTP 200.

Two follow-up PRs queued. **Start PR #2 after PR #1 merges (or stack on
`chore/flatten-to-apm`).** PR #3 needs scoping answers before coding.

---

## PR #2 — `scripts/flagd-api` — rewrite `flagd-set.sh` against flagd-ui HTTP API

### Why

Today `scripts/flagd-set.sh` SSHes to `clintdev`, execs into the
`otel-demo-cribl-control-plane` container, fetches the `flagd-config`
ConfigMap JSON, patches `defaultVariant` with inline Python, applies via
`kubectl create configmap --dry-run=client | kubectl apply -f -`, then
`kubectl rollout restart deployment/flagd`.

That's clintdev-specific and unusable for anyone else. The flagd-ui
Phoenix app running in the demo cluster exposes an HTTP API that
hot-reloads via file-watch with **no pod bounce**. Switching to that
makes the script portable.

### Research already done

Confirmed via flagd-ui source read:

- `GET  {FLAGD_UI_URL}/feature/api/read` — returns current flag config
- `POST {FLAGD_UI_URL}/feature/api/write` — replaces config, triggers
  file-watch reload
- Body format:
  ```json
  {
    "data": {
      "$schema": "https://flagd.dev/schema/v0/flags.json",
      "flags": { … }
    }
  }
  ```
- **No auth.** Relies on network reachability to the flagd-ui service.
- File-watch reloads flagd immediately; no deployment restart.

### Scope

1. New branch `scripts/flagd-api` off `chore/flatten-to-apm` (stacked)
   or off `master` after PR #1 merges.
2. Rewrite `scripts/flagd-set.sh`:
   - Keep the bash + inline Python shape (user likes it)
   - Replace `fetch_config` → `curl -s "$FLAGD_UI_URL/feature/api/read"`
   - Replace `apply_config` → `curl -X POST -H 'content-type: application/json' --data @- "$FLAGD_UI_URL/feature/api/write"`
     with the `{"data": {"$schema": …, "flags": …}}` wrapper
   - Drop SSH, kubectl, ConfigMap, rollout-restart logic entirely
   - Keep commands: `list`, `status`, `set`, `all-off`
3. Add `FLAGD_UI_URL` as the only required env var for this script.
4. Update `FAILURE-SCENARIOS.md` preface — drop the SSH/kubectl
   explanation, replace with "point `FLAGD_UI_URL` at the flagd-ui
   service (port-forward or ingress) and run `./scripts/flagd-set.sh …`".
5. Update `CLAUDE.md` "Triggering failure scenarios" section to match.
6. Consider recreating a minimal `.env.example` with `FLAGD_UI_URL` +
   `CRIBL_BASE_URL` / `CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET`.
7. Commit, push, PR.

### Acceptance

- `./scripts/flagd-set.sh list` hits the HTTP API and shows flags
- `./scripts/flagd-set.sh set paymentFailure 50` flips `defaultVariant`
  and verify flag-driven failure reappears end-to-end
- Script has no SSH / kubectl / Python-heredoc dependencies beyond what
  the current version already uses (`curl`, `python3 -c` for JSON patch)

---

## PR #3 — `test/playwright-framework` — real Playwright + Cribl Cloud login automation

### Why

Current browser scripts use `playwright-core` (no bundled browsers) and
attach to an already-running VNC Chromium at CDP `127.0.0.1:9222`. That
works on clintdev but not on a fresh machine, and requires a
pre-authenticated Cribl Cloud session in the attached browser. Goal: a
Playwright setup that runs reliably on any machine with automated Cribl
Cloud login.

### Open scoping questions (awaiting user answers)

1. **Package**: switch to `@playwright/test` (test runner + fixtures)
   or just `playwright` (library, keep our custom runner)?
   **Recommendation:** `@playwright/test`.
2. **Browsers**: chromium-only, or also firefox/webkit?
   **Recommendation:** chromium-only for now.
3. **Cribl Cloud login flow**: UI login automation + `storageState`
   caching, or reuse existing OAuth client credentials
   (`CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET`) somehow?
   **Recommendation:** UI login + `storageState` — client creds don't
   give you the app-shell cookies the SPA needs.
4. **Credentials source**: new `.env` vars `CRIBL_TEST_EMAIL` +
   `CRIBL_TEST_PASSWORD`, or something else?
5. **Keep CDP-attach workflow**: retain `scripts/browser.js` + VNC
   Chromium for interactive dev, alongside headless Playwright for
   tests?
   **Recommendation:** keep both.
6. **PR scope**: infra only (install, config, login fixture, one
   smoke test), with existing `scripts/*-smoke.js` / `*-spike.js`
   migrated in follow-ups — or migrate everything in one PR?
   **Recommendation:** infra only.
7. **CI**: wire into CI now, or defer?
   **Recommendation:** defer.

### Likely scope (once answers land)

- Add `@playwright/test` + chromium browser install
- `playwright.config.ts` with `baseURL`, `storageState`, chromium
  project
- `tests/fixtures/criblCloudAuth.ts` — global-setup fixture that:
  1. Checks for cached `.auth/cribl-cloud.json`
  2. If missing/expired: launches chromium, navigates to login page,
     fills `CRIBL_TEST_EMAIL` / `CRIBL_TEST_PASSWORD`, waits for app
     shell, saves `storageState`
  3. Returns the authenticated context to tests
- One smoke test that loads `/apps/apm/` and asserts the nav is
  rendered (proof the login + shell + app all work)
- README / CLAUDE.md updates describing the test workflow
- Keep `scripts/browser.js` (CDP attach) for interactive dev — do not
  delete

### Dependencies

- Needs the user's answers to the 7 questions above before coding
- Can land independently of PR #2 (no file overlap)

---

## Resume checklist

When picking this back up from `/home/clint/local/src/apm`:

- [ ] Confirm PR #1 state — merged? still open on `chore/flatten-to-apm`?
- [ ] If merged: branch PR #2 off `master`. Else: stack on `chore/flatten-to-apm`.
- [ ] Start PR #2 — no further user input needed, scope is locked.
- [ ] Ping user for PR #3 scoping answers (questions 1–7 above).
- [ ] After PR #2 lands, start PR #3 with confirmed scope.
