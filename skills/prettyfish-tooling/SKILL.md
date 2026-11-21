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

## Edit the file

Write changes to the JSON. Changes made in the browser do not save to disk. Use these commands as needed:

```bash
"$PF" docs list "$DOC"
"$PF" docs set "$DOC" --page "$PAGE" --diagram "$CARD" --code-file "$MERMAID_FILE"
"$PF" docs append "$DOC" --page "$PAGE" --name "$CARD" --code-file "$MERMAID_FILE"
"$PF" docs replace-page "$DOC" --page "$PAGE" --payload-file "$PAGE_FILE"
```

Use `--new-page` instead of `--page` to append to a new page. Put cards in reading order in `pages[].diagrams`. Do not set `x` or `y` by hand.

## Validate and pack

1. Run `"$PF" validate "$DOC"`. Fix document shape and Mermaid errors before packing. Validation does not need a browser.
2. Run `"$PF" watch start "$DOC"`. Keep its browser tab open. Run `"$PF" open` if needed. The tab shows “Preparing layout…” while the map has overlaps.
3. Run `"$PF" tidy "$DOC"`. Let it wait for measurements, write positions, and verify them in the same tab. Add `--dry-run` to preview moves without writing. Pass the server URL as `--base` if more than one server is running.
4. Run `"$PF" check "$DOC"` to check for overlaps and cards taller than 1400 px without changing the file. Split oversized cards and repeat the checks.

## Fix missing measurements

- `no-tab`: Open the watched map and leave the tab open.
- `rendering`: Wait and check state again.
- `stale-app`: Wait for the open tab to apply the new file revision. Do not open another tab to verify a write.
- `error`: Read `reason`, fix the failing diagram, and validate again.

Use `"$PF" watch status` to confirm which file the server is watching. Run `"$PF" watch set "$DOC"` if it is watching the wrong file. Do not report a clean layout without a passing `check` from the open tab.
