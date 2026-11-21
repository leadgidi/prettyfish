#!/usr/bin/env python3
"""Append a diagram (or a whole page) without touching coordinates.

Coordinates are derived, never authored: a diagram persists only x/y/width and
its height depends on the rendered Mermaid SVG. This script appends at a
placeholder position and tells you to run layout-tidy.sh, which measures the
real card heights and re-packs the page.

Usage:
  append-diagram.py <doc.prettyfish.json> --page NAME --name NAME [options]
  append-diagram.py <doc.prettyfish.json> --new-page NAME --name NAME --code-file f.mmd

  --page NAME          append to the page whose name contains NAME
  --new-page NAME      create a new page with this name instead
  --name NAME          diagram name (required)
  --description TEXT   one-line caption
  --code-file PATH     file holding the Mermaid source (default: stdin)
  --width N            card width in px (default 900)
  --theme NAME         mermaid theme (default blueprint)
  --id UUID            diagram id (default: generated)
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path

PLACEHOLDER = 0


def load_doc(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        raise SystemExit(f"Project file not found: {path}")
    except json.JSONDecodeError as error:
        raise SystemExit(f"{path} is not valid JSON: {error}")


def read_code(code_file: str | None) -> str:
    if code_file:
        return Path(code_file).read_text()
    if sys.stdin.isatty():
        raise SystemExit("Provide --code-file PATH or pipe the Mermaid source on stdin")
    return sys.stdin.read()


def find_page(doc: dict, name: str | None, new_page: str | None) -> dict:
    pages = doc.setdefault("pages", [])
    if new_page:
        page = {
            "id": str(uuid.uuid4()),
            "name": new_page,
            "diagrams": [],
            "activeDiagramId": None,
        }
        pages.append(page)
        return page
    if not name:
        raise SystemExit("Provide --page NAME or --new-page NAME")
    matches = [page for page in pages if page.get("name") == name]
    if not matches:
        matches = [page for page in pages if name in str(page.get("name") or "")]
    if len(matches) != 1:
        names = [page.get("name") for page in pages]
        raise SystemExit(f"page match failed for {name!r}; pages={names}")
    return matches[0]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("doc", type=Path)
    parser.add_argument("--page")
    parser.add_argument("--new-page")
    parser.add_argument("--name", required=True)
    parser.add_argument("--description")
    parser.add_argument("--code-file")
    parser.add_argument("--width", type=int, default=900)
    parser.add_argument("--theme", default="blueprint")
    parser.add_argument("--id")
    args = parser.parse_args()

    if args.page and args.new_page:
        raise SystemExit("Use either --page or --new-page, not both")

    code = read_code(args.code_file)
    if not code.strip():
        raise SystemExit("Mermaid source is empty")

    doc = load_doc(args.doc)
    page = find_page(doc, args.page, args.new_page)
    diagram = {
        "id": args.id or str(uuid.uuid4()),
        "name": args.name,
        "code": code if code.endswith("\n") else f"{code}\n",
        "x": PLACEHOLDER,
        "y": PLACEHOLDER,
        "width": args.width,
        "mermaidTheme": args.theme,
        "configOverrides": {},
    }
    if args.description:
        diagram["description"] = args.description

    page.setdefault("diagrams", []).append(diagram)
    if not page.get("activeDiagramId"):
        page["activeDiagramId"] = diagram["id"]
    if not doc.get("activePageId"):
        doc["activePageId"] = page["id"]

    args.doc.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")

    print(f"appended {diagram['id']} to page {page['name']!r} at a placeholder position")
    print(f"next: .agents/skills/prettyfish-docs/scripts/layout-tidy.sh {args.doc}")
    print(f"gate: .agents/skills/prettyfish-docs/scripts/layout-tidy.sh {args.doc} --check")


if __name__ == "__main__":
    main()
