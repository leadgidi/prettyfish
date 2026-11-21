---
name: prettyfish-tooling
description: Open, edit, validate, and pack Pretty Fish project files.
---

# Work on a Pretty Fish map

Run the commands yourself. Use the CLI path printed by the installer. To find it in a new shell, set:

```bash
PF="${PRETTYFISH_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/leadgidi/prettyfish}/pf"
```

Set `DOC` to the absolute path of the `.prettyfish.json` file. Quote both paths in commands.

## Create and show a map

For a new map, send a draft to `"$PF" present "$DOC" --create` on stdin. Use a heredoc to avoid a separate draft file:

```bash
"$PF" present "$DOC" --create <<'JSON'
{"pages":[{"name":"Overview","diagrams":[{"name":"Request path","code":"flowchart LR\n  Request --> Response"}]}]}
JSON
```

Put pages and cards in reading order. Add a `description` to a card when it needs context. Supply names and Mermaid code; omit IDs, selections, and positions. `--create` refuses to overwrite an existing map.

For an existing map, run `"$PF" present "$DOC"` after editing. Both forms validate the file, open the browser, pack the cards in the open tab, and check for overlaps and oversized cards. Leave the tab open. Report the map path and the check result.

## Edit an existing file

Write changes to the JSON. Changes made in the browser do not save to disk. Use these commands as needed:

```bash
"$PF" docs list "$DOC"
"$PF" docs set "$DOC" --page "$PAGE" --diagram "$CARD" --code-file "$MERMAID_FILE"
"$PF" docs append "$DOC" --page "$PAGE" --name "$CARD" --code-file "$MERMAID_FILE"
"$PF" docs replace-page "$DOC" --page "$PAGE" --payload-file "$PAGE_FILE"
```

Use `--new-page` instead of `--page` to append to a new page. Put cards in reading order in `pages[].diagrams`. Do not set `x` or `y` by hand.

## Fix a failed check

Fix validation errors in the file before opening it. Split cards taller than 1400 px. If the tab is already open, run `"$PF" validate "$DOC" && "$PF" tidy "$DOC" && "$PF" check "$DOC"` without opening another tab.

Run `"$PF" state` when measurements are missing:

- `no-tab`: Open the watched map and leave the tab open.
- `rendering`: Wait and check state again.
- `stale-app`: Wait for the open tab to apply the new file revision. Do not open another tab to verify a write.
- `error`: Read `reason`, fix the failing diagram, and validate again.

Use `"$PF" watch status` to confirm which file the server is watching. Run `"$PF" watch set "$DOC"` if it is watching the wrong file. Do not report a clean layout without a passing `check` from the open tab.
