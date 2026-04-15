#!/usr/bin/env bash
# flagd-set.sh — flip an OTel demo feature flag via the flagd-ui HTTP API.
#
# Usage:
#   scripts/flagd-set.sh <flagName> <variant>     # turn a flag on/to a variant
#   scripts/flagd-set.sh <flagName> off           # turn it off
#   scripts/flagd-set.sh --list                   # list all flags + variants
#   scripts/flagd-set.sh --status                 # show currently-active flags
#   scripts/flagd-set.sh --all-off                # revert every flag to its off variant
#
# Examples:
#   scripts/flagd-set.sh paymentFailure 50%
#   scripts/flagd-set.sh kafkaQueueProblems on
#   scripts/flagd-set.sh emailMemoryLeak 100x
#   scripts/flagd-set.sh paymentFailure off
#
# How it works: the upstream OpenTelemetry Demo ships a `flagd-ui` Phoenix
# app as a sidecar in the flagd pod. It exposes two unauthenticated
# endpoints on port 4000:
#
#   GET  $FLAGD_UI_URL/api/read   - returns {"flags": {...}}
#   POST $FLAGD_UI_URL/api/write  - takes  {"data": {"flags": {...}}}
#                                   and triggers flagd's file-watch reload
#                                   (no pod bounce required)
#
# The read response is raw and the write body is wrapped — that asymmetry
# is intentional on flagd-ui's side, not a bug here. This script wraps on
# write and tolerates either shape on read in case flagd-ui evolves.
#
# Requires:
#   - FLAGD_UI_URL pointing at a reachable flagd-ui service. The cluster
#     ships flagd as a ClusterIP service so you'll need a port-forward
#     (or NodePort/ingress) to reach it from outside the cluster:
#       kubectl -n otel-demo port-forward --address 0.0.0.0 svc/flagd 4000:4000 &
#       FLAGD_UI_URL=http://localhost:4000 scripts/flagd-set.sh --list
#   - curl
#   - python3 (for JSON patching — flagd configs are small so python is
#     cheaper than taking a jq dependency)

set -euo pipefail
# Without inherit_errexit, `set -e` is not propagated into `$( ... )`
# command substitutions — so a failing curl inside fetch_config() would
# leak a Python traceback from the downstream `python3 -c` before this
# script exited non-zero. Enable it so failures surface cleanly at the
# first broken step.
shopt -s inherit_errexit

die() { echo "error: $*" >&2; exit 1; }

: "${FLAGD_UI_URL:?FLAGD_UI_URL must be set (see .env.example)}"
FLAGD_UI_URL="${FLAGD_UI_URL%/}"

command -v curl >/dev/null || die "curl not found on PATH"
command -v python3 >/dev/null || die "python3 not found on PATH"

fetch_config() {
  # Returns the unwrapped flag JSON ({"flags": {...}}) on stdout. The
  # flagd-ui /api/read endpoint already returns this shape unwrapped, but
  # we still tolerate a {"data": {...}} envelope in case it evolves.
  # Capture curl's output first so `set -e` bails before python runs on
  # an empty stdin — otherwise a failing curl leaks a JSONDecodeError
  # traceback into the user's terminal.
  local resp
  resp="$(curl -sSf "$FLAGD_UI_URL/api/read")"
  printf '%s' "$resp" | python3 -c '
import json, sys
payload = json.load(sys.stdin)
inner = payload["data"] if isinstance(payload, dict) and "data" in payload else payload
json.dump(inner, sys.stdout)
'
}

apply_config() {
  # Takes a path to the unwrapped flag JSON and POSTs it (wrapped in
  # {"data": ...}) to flagd-ui, which writes it to disk and triggers
  # flagd's file-watch.
  local json_file="$1"
  local body
  body="$(python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    inner = json.load(f)
print(json.dumps({"data": inner}))
' "$json_file")"
  curl -sSf \
    -X POST \
    -H 'content-type: application/json' \
    --data "$body" \
    "$FLAGD_UI_URL/api/write" >/dev/null \
    || die "POST $FLAGD_UI_URL/api/write failed"
  echo "applied"
}

cmd_list() {
  # Capture fetch_config first so a failed curl surfaces cleanly via
  # `set -e` instead of as a JSONDecodeError traceback from python.
  local json
  json="$(fetch_config)"
  printf '%s' "$json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for name, flag in d["flags"].items():
    variants = list(flag.get("variants", {}).keys())
    default = flag.get("defaultVariant", "?")
    desc = flag.get("description", "")
    print(f"{name}  [{default}]  variants: {variants}")
    if desc:
        print(f"    {desc}")
'
}

cmd_status() {
  local json
  json="$(fetch_config)"
  printf '%s' "$json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
active = [(n, f["defaultVariant"]) for n, f in d["flags"].items() if f.get("defaultVariant") != "off"]
if not active:
    print("all flags off")
else:
    for name, variant in active:
        print(f"ACTIVE: {name} = {variant}")
'
}

cmd_set() {
  local flag="$1" variant="$2"
  # Script-scoped paths so the EXIT trap can still see them after the
  # function returns — `set -u` + local vars would otherwise fire
  # "unbound variable" when the trap runs.
  tmpfile="/tmp/flagd-$$.json"
  patched="/tmp/flagd-$$.patched.json"
  trap 'rm -f "$tmpfile" "$patched"' EXIT

  fetch_config > "$tmpfile"
  python3 - "$tmpfile" "$patched" "$flag" "$variant" <<'PY'
import json, sys
src, dst, flag, variant = sys.argv[1:5]
with open(src) as f:
    d = json.load(f)
if flag not in d["flags"]:
    print(f"flag not found: {flag}", file=sys.stderr)
    sys.exit(3)
variants = d["flags"][flag].get("variants", {})
if variant not in variants:
    print(f"variant {variant!r} not in {list(variants.keys())}", file=sys.stderr)
    sys.exit(4)
d["flags"][flag]["defaultVariant"] = variant
with open(dst, "w") as f:
    json.dump(d, f, indent=2)
print(f"patched: {flag} -> {variant}")
PY
  apply_config "$patched"
}

cmd_all_off() {
  # Script-scoped paths so the EXIT trap can still see them after the
  # function returns — `set -u` + local vars would otherwise fire
  # "unbound variable" when the trap runs.
  tmpfile="/tmp/flagd-$$.json"
  patched="/tmp/flagd-$$.patched.json"
  trap 'rm -f "$tmpfile" "$patched"' EXIT

  fetch_config > "$tmpfile"
  python3 - "$tmpfile" "$patched" <<'PY'
import json, sys
src, dst = sys.argv[1:3]
with open(src) as f:
    d = json.load(f)
changed = []
for name, flag in d["flags"].items():
    if flag.get("defaultVariant") != "off":
        flag["defaultVariant"] = "off"
        changed.append(name)
with open(dst, "w") as f:
    json.dump(d, f, indent=2)
print(f"reset: {len(changed)} flag(s) -> off {changed}")
PY
  apply_config "$patched"
}

case "${1:-}" in
  --list|-l)   cmd_list ;;
  --status|-s) cmd_status ;;
  --all-off)   cmd_all_off ;;
  -h|--help|'') sed -n '1,36p' "$0"; exit 0 ;;
  *)
    [[ $# -eq 2 ]] || die "usage: $0 <flagName> <variant> (or --list / --status / --all-off)"
    cmd_set "$1" "$2"
    ;;
esac
