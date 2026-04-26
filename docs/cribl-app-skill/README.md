# cribl-app Claude Skill

A Claude Code skill for building Cribl Search App packs. Loads
platform knowledge, KQL caveats, and patterns when working on a
Cribl pack project.

## Installation

Copy `skill.md` to your Claude Code skills directory or reference
it from your project's CLAUDE.md.

## What it covers

- Cribl App Platform rules (fetch proxy, KV store, React Router)
- KQL language caveats (crashes, unsupported functions)
- Sandboxed iframe constraints (downloads, popups, CSP)
- Scheduled search patterns (provisioning, $vt_results, lookups)
- Alert state machine pattern
- Testing patterns (Playwright auth, KQL assertions)
