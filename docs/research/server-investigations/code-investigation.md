# Source-code investigation (agent checks out repos)

Lets the server-side investigator read a service's source when telemetry
has narrowed to it — point it at GitHub repos, and it grabs the code into
an in-DO filesystem and inspects it with read-only tools.

Status: **design + decisions** (not built). This is the design's PR 12 /
Phase 8, whose viability was resolved by spike **S3** (see `design.md`
"S3 live test, 2026-08-10"). Decisions confirmed with Clint 2026-08-15.

## Architecture — celld-native, no remote container

S3's key finding: `@cloudflare/computer` is an **npm package instantiated
inside the Durable Object**, not a remote service. Its container backend
needs the Cloudflare Containers binding (absent on self-hosted celld),
but the **SQLite-backed virtual filesystem and `just-bash` run fully
self-hosted in the DO** — proven in the overnight spike. So:

- Instantiate a `Workspace` (or just its vfs + `just-bash`) inside the
  `InvestigationDO`, filesystem stored in the DO's SQLite.
- **No** Containers, **no** dynamic workers — the celld-primary path.
  `@cloudflare/computer`'s container/worker-shell backends stay as a
  Cloudflare-portability upgrade if ever hosted there.

## Decisions (2026-08-15)

1. **Tarball, not git clone.** Checkout fetches the GitHub tarball
   (`https://codeload.github.com/<owner>/<repo>/tar.gz/<ref>`) and
   untars it into the vfs — no isomorphic-git. **Plus** fetch recent
   commit history via the GitHub API and write it into the filesystem as
   a markdown file (e.g. `/repos/<name>/RECENT_COMMITS.md`), so the agent
   gets "what changed lately" without git history in the tarball.
2. **Lazy checkout — a tool the agent calls.** A `checkout_repo` tool the
   agent invokes on demand (after telemetry points at a service), not an
   upfront checkout. Investigations that don't touch code pay nothing.
3. **Service→repo mapping with a wildcard.** Settings hold a list of
   repos, each optionally mapped to a `service`. A `*` (or `service`
   omitted) is a **monorepo / catch-all** — matches any service, for the
   common case where all services live in one repo (the OTel Demo).

## Cell changes

New `cell/src/workspace/` (or similar):
- **`checkout_repo(ref)` tool** — resolve the repo for the target service
  (exact match, else the `*` catch-all), fetch its tarball via the DO's
  outbound fetch, stream-untar into `/repos/<name>` in the vfs (idempotent
  + cached per DO so re-checkout is cheap). Fetch the last N commits from
  `GET /repos/<owner>/<repo>/commits` and write `RECENT_COMMITS.md`.
  Optional GitHub token (private repos) from cell env / KV.
- **Read-only code tools**: `list_dir(path)`, `read_file(path[, range])`,
  `grep_code(pattern[, path])` (and optionally a read-only `bash` over
  `just-bash`, command-allowlisted). All scoped under `/repos`.
- Wire the tool defs + executors into the agent, **server-only** (the
  browser client Investigator does not get code tools).
- Prompt addendum (server-only): "Consult source only after telemetry
  narrows to a specific service/operation. Call `checkout_repo`, then
  `read_file`/`grep_code`. Cite exact file paths (and line ranges) in
  findings; read `RECENT_COMMITS.md` for recent changes."
- Size/time caps: cap tarball size, files extracted, and per-tool output
  (the vfs is DO SQLite — same in-memory-read cap as transcript events).

## App changes

- **Settings → Source repositories**: a KV-backed list of
  `{ url, name, service? }` (service `*`/omitted ⇒ monorepo catch-all),
  plus an optional GitHub token field for private repos.
- **Seed/state**: the repo list + mapping rides in the investigation
  context for both triggers — the Investigate button (interactive) and
  the alert webhook (autonomous) — so the cell knows what it may check
  out and which repo maps to the implicated service.

## Rollout

- **PR 1 (cell)**: workspace vfs + `checkout_repo` (tarball + RECENT_COMMITS)
  + `list_dir`/`read_file`/`grep_code`, wired server-only. Unit/smoke:
  check out a small public repo, read a known file, grep a known symbol.
- **PR 2 (app)**: Settings repo list + token; thread the mapping into the
  seed for both triggers.
- **PR 3**: optional read-only `bash`, service→repo resolution niceties,
  caching across investigations.

Cell redeploy required (new tools live in the cell). Off the critical
path — gated by `serverInvestigations` like the rest.
