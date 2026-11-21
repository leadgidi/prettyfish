---
name: prettyfish-tooling
description: >-
  Operate the Pretty Fish diagram editor: install the pinned build, serve a
  .prettyfish.json project, measure it through the open browser tab, and pack
  pages so diagram cards never overlap. Use when running or repairing Pretty
  Fish tooling, watching a project file, checking a project for overlapping
  cards, or editing diagram JSON (list/set/append/replace-page).
---

# Pretty Fish tooling

This skill is the manual for the tool. It knows nothing about how a particular
team structures its documentation — for that, use the repo's own docs skill.

Everything is one CLI:

```bash
PF="${PRETTYFISH_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/leadgidi/prettyfish}/pf"
```

`$PF root` prints the install directory, `$PF skill-path` this file.

## Install

Pretty Fish is a Vite web app, not an npm CLI: it has no `bin`, and its tooling
(vite, mermaid) is in `devDependencies`, so `npx` cannot run it. Install the
pinned archive instead:

```bash
git clone --depth 1 --branch <ref> https://github.com/leadgidi/prettyfish.git /tmp/pf-build
/tmp/pf-build/scripts/pf install --ref <ref> --sha <40-char-sha>
```

`install` downloads `leadgidi/prettyfish` at `--ref`, refuses to continue unless
the ref resolves to `--sha`, extracts to `$PRETTYFISH_HOME/<ref>`, runs `npm ci`,
points `$PRETTYFISH_HOME/pf` at the new build, removes older builds, and copies
this skill to `~/.agents/skills/prettyfish-tooling/` so agents see it.

Requirements: Node >= 22.6 (24 recommended), `npm`, `curl`, `tar`. No browser is
downloaded. Flags: `--home DIR`, `--skills-dir DIR`, `--no-skill`, `--force`.

## Measure layout

A diagram persists `x`/`y`/`width`; its height exists only once Mermaid renders,
and Mermaid needs a real layout engine (it calls `getBBox` and
`getComputedTextLength`). So the measurement comes from **the tab that has the
file open**. There is no headless renderer and no fallback: no tab, no numbers.

```bash
$PF watch start /abs/path/to/project.prettyfish.json   # serves it, prints the URL
$PF open                                              # opens it in the default browser
$PF state                                             # what the tab currently reports
```

`$PF state` is the contract:

```json
{
  "phase": "ready | no-tab | rendering | stale-app | error",
  "reason": "…",
  "docHash":     "<sha256 of the file on disk>",
  "appliedHash": "<sha256 the tab applied>",
  "watchingTabs": 1,
  "readyDiagrams": 19, "totalDiagrams": 19, "overlapCount": 0,
  "tabs": [{ "tabId": "…", "current": true, "overlapCount": 0 }],
  "pages": [{ "pageName": "…", "overlaps": [],
              "diagrams": [{ "id": "…", "name": "…", "x": 0, "y": 0, "width": 900,
                             "cardHeight": 729, "svgWidth": 1038.6,
                             "svgHeight": 775.7, "renderStatus": "ready" }] }]
}
```

`phase` is never optimistic: `no-tab` (nothing connected), `rendering` (still
drawing), `stale-app` (the connected tab applied a different version of the
file), `error` (a diagram failed to render), else `ready`.

## Pack pages

```bash
$PF tidy  /abs/path/to/project.prettyfish.json          # write x/y, verify with the tab
$PF check /abs/path/to/project.prettyfish.json          # report only, exit 1 on problems
```

- `tidy` packs rows of `--cols` (default 2) with `--gap-x`/`--gap-y`, writes
  `x`/`y` only, then re-asks the tab and fails if it still reports overlaps.
  Idempotent: a second run reports `no position changes needed`.
- `check` writes nothing; exits 1 when a card overlaps or exceeds
  `--max-card-height` (default 1400 px — a taller card means split the diagram).
- `--dry-run` prints the moves without writing. `--base URL` picks a specific
  server.

Both require a watch server serving **that exact file** plus an open tab; they
fail with the phase and the remedy otherwise. Because there is no headless
renderer, `check` cannot run in CI.

## Validate

```bash
$PF validate /abs/path/to/project.prettyfish.json
```

Document shape plus `mermaid.parse()` on every diagram — syntax only, no layout,
no browser needed.

## Edit project files

```bash
$PF docs list <doc>
$PF docs set <doc> --page L3 --diagram "GET /credits" --description "…"
$PF docs append <doc> --page L3 --name "Retry path" --code-file /tmp/retry.mmd
$PF docs append <doc> --new-page "L1 — Stages" --name "Actors" --code-file /tmp/actors.mmd
$PF docs replace-page <doc> --page L2 --payload-file /tmp/page.json
```

`append` writes a placeholder position; run `tidy` afterwards. Never hand-pick
`x`/`y`: order in `pages[].diagrams` is the reading order and the packer owns
the coordinates.

## Watch mode is one-way

The server serves the file; the app renders it; nothing is written back. A
diagram created in the editor is not saved to disk and is discarded on the next
file change. Author diagrams through the JSON (or `$PF docs …`).

## Processes

`$PF watch start` backgrounds `vite` and records `pid`/log under
`<install>/.local-run/`. `$PF watch stop` stops the pid and any listener on 5174,
5173, 5199. `$PF watch status` prints the server JSON. `$PF watch set <doc>`
retargets a running server. Ports/host: `--port`, `--host`, or
`PRETTYFISH_WATCH_PORT`, `PRETTYFISH_WATCH_HOST`, `PRETTYFISH_WATCH_BASE`.
