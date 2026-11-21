# Local project file watch

Start Pretty Fish watching any `.prettyfish.json` on disk:

```bash
npm run seo:generate   # only needed once per pull; `dev:watch` already runs it
npm run dev:watch -- /absolute/path/to/project.prettyfish.json
```

Optional host/port:

```bash
npm run dev:watch -- ./map.prettyfish.json --host 127.0.0.1 --port 5173
```

Env still works:

```bash
PRETTYFISH_WATCH_FILE=/absolute/path/to/project.prettyfish.json npm run dev:app
```

Then open http://127.0.0.1:5173/

The browser loads that file and hot-reloads whenever it changes (SSE from the Vite plugin).

## Control the watched file from the CLI (running server)

```bash
npm run watch:status
npm run watch:set -- /absolute/path/to/other.prettyfish.json
npm run watch:layout
npm run watch:validate
```

Or with curl:

```bash
curl -s http://127.0.0.1:5173/__prettyfish/watch/status
curl -s -X PUT http://127.0.0.1:5173/__prettyfish/watch/file \
  -H 'Content-Type: application/json' \
  -d '{"path":"/absolute/path/to/other.prettyfish.json"}'
curl -s http://127.0.0.1:5173/__prettyfish/watch/layout
```

Default base URL is `http://127.0.0.1:5173`. Override with `--base` or `PRETTYFISH_WATCH_BASE`.

## Layout telemetry (overlap fixing)

With the browser open on the watched project, Mermaid render completion posts a layout snapshot:

- Latest: `.local-run/diagram-layout.json`
- History: `.local-run/diagram-layout.jsonl`
- Also: `GET /__prettyfish/watch/layout` / `npm run watch:layout`

Each snapshot lists every page’s diagrams with `x`, `y`, `width`, `cardHeight`, SVG size, and any AABB overlaps. Agents/scripts read that file and re-pack the `.prettyfish.json` when overlaps are reported.

## Pack pages so cards never overlap

A diagram persists `x`/`y`/`width` only. Its height exists only after Mermaid
renders, so the tool that packs a page asks the app that already has the file
open instead of measuring anything itself. No headless browser is involved.

```bash
# 1. serve the file and open it in any browser
npm run dev:watch -- /absolute/path/to/project.prettyfish.json
open http://127.0.0.1:5174/          # xdg-open on Linux, start on Windows

# 2. pack (writes x/y, then re-asks the app and fails if overlaps remain)
npm run layout:tidy -- /absolute/path/to/project.prettyfish.json

# report only: writes nothing, exits 1 on overlap or an oversize card
npm run layout:check -- /absolute/path/to/project.prettyfish.json
```

### The measurement contract

```
GET /__prettyfish/watch/state[?hash=<sha256>]
{
  "phase": "ready" | "no-tab" | "rendering" | "stale-app" | "error",
  "reason": "...",
  "docHash": "<sha256 of the file on disk>",
  "appliedHash": "<sha256 the tab applied>",
  "watchingTabs": 1,
  "readyDiagrams": 19, "totalDiagrams": 19,
  "pages": [{ "pageId": "...", "pageName": "...",
              "diagrams": [{ "id": "...", "name": "...", "x": 0, "y": 0,
                             "width": 900, "cardHeight": 729,
                             "svgWidth": 1038.6, "svgHeight": 775.7,
                             "renderStatus": "ready" }],
              "overlaps": [] }]
}
```

The watch server stamps `GET /__prettyfish/watch/project` with
`X-PrettyFish-Doc-Hash`, the app echoes that hash in its measurements, and the
state endpoint compares it against the file on disk. That is how `stale-app`
is detected instead of silently packing from an old render.

Anything other than `phase: "ready"` is a hard failure. Without an open tab
there is no measurement, and there is no fallback path.

Flags: `--cols`, `--gap-x`, `--gap-y`, `--dry-run`, `--max-card-height`,
`--base`, `--timeout`, `--verbose`.

Authoring rule: order in `pages[].diagrams` is the reading order (row-major), so
append diagrams in narrative order and let the packer assign coordinates. The
result is stored in the file, so opening the project later needs no tooling.

## Validate a project file

Checks document shape (ids, active pointers, non-empty code) and runs `mermaid.parse()` on every diagram (jsdom-backed, so flowcharts work in Node).

Offline:

```bash
npm run validate:project -- /absolute/path/to/project.prettyfish.json
```

Against the running watch server (loads the currently watched file):

```bash
npm run watch:validate
```
