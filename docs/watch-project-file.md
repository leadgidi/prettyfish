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

A diagram persists `x`/`y`/`width` only. Its height comes from the rendered
Mermaid SVG, so a hand-written `y` cannot be checked and will eventually overlap.
Do not guess: measure.

```bash
npm run layout:tidy -- /absolute/path/to/project.prettyfish.json
npm run layout:check -- /absolute/path/to/project.prettyfish.json
```

- `layout:tidy` drives the real app in headless Chromium, reads the measured card
  footprint from `window.__prettyfishLayoutSnapshot`, and re-packs every page
  (default 2 columns, 100/120px gaps) using the same `packCards` code the canvas
  uses. It rewrites `x`/`y` only, and is idempotent: a second run changes nothing.
- `layout:check` writes nothing and exits 1 when any card overlaps or exceeds
  `--max-card-height` (default 1400px). Use it as a gate.
- Without `--base` the script reuses a watch server already watching that file,
  otherwise it starts its own on `--port 5199` and stops it afterwards. A reused
  server gets 10s to answer; if it serves a stale module graph the script starts
  its own from current source.

Flags: `--cols`, `--gap-x`, `--gap-y`, `--dry-run`, `--max-card-height`,
`--base`, `--port`, `--timeout`, `--verbose`.

Authoring rule: order in `pages[].diagrams` is the reading order (row-major), so
append diagrams in narrative order and let the packer assign coordinates.

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
