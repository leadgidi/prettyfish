#!/usr/bin/env python3
"""Update one diagram in a .prettyfish.json by page + diagram name (or indexes)."""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path


def find_diagram(doc: dict, *, page: str | None, diagram: str | None, page_index: int | None, diagram_index: int | None):
    pages = doc.get("pages") or []
    if page_index is not None:
        if page_index < 0 or page_index >= len(pages):
            raise SystemExit(f"page index out of range: {page_index}")
        page_obj = pages[page_index]
    else:
        if not page:
            raise SystemExit("Provide --page NAME or --page-index N")
        matches = [p for p in pages if p.get("name") == page]
        if not matches:
            # prefix / contains match
            matches = [p for p in pages if page in str(p.get("name") or "")]
        if len(matches) != 1:
            names = [p.get("name") for p in pages]
            raise SystemExit(f"page match failed for {page!r}; pages={names}")
        page_obj = matches[0]

    diagrams = page_obj.get("diagrams") or []
    if diagram_index is not None:
        if diagram_index < 0 or diagram_index >= len(diagrams):
            raise SystemExit(f"diagram index out of range: {diagram_index}")
        return page_obj, diagrams[diagram_index]

    if not diagram:
        raise SystemExit("Provide --diagram NAME or --diagram-index N")
    matches = [d for d in diagrams if d.get("name") == diagram]
    if not matches:
        matches = [d for d in diagrams if diagram in str(d.get("name") or "")]
    if len(matches) != 1:
        names = [d.get("name") for d in diagrams]
        raise SystemExit(f"diagram match failed for {diagram!r}; diagrams={names}")
    return page_obj, matches[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--page", help="Exact or unique substring page name")
    parser.add_argument("--diagram", help="Exact or unique substring diagram name")
    parser.add_argument("--page-index", type=int)
    parser.add_argument("--diagram-index", type=int)
    parser.add_argument("--name", help="Rename diagram")
    parser.add_argument("--description", help="Set diagram description")
    parser.add_argument("--code", help="Mermaid source string")
    parser.add_argument("--code-file", type=Path, help="Read Mermaid source from file")
    parser.add_argument("--x", type=float)
    parser.add_argument("--y", type=float)
    parser.add_argument("--width", type=float)
    parser.add_argument("--theme", help="mermaidTheme value")
    parser.add_argument(
        "--add",
        action="store_true",
        help="Create diagram on the page if missing (requires --page/--page-index and --diagram/--name)",
    )
    args = parser.parse_args()

    if args.code is not None and args.code_file is not None:
        raise SystemExit("Pass only one of --code / --code-file")

    doc = json.loads(args.file.read_text())
    try:
        page_obj, diagram = find_diagram(
            doc,
            page=args.page,
            diagram=args.diagram,
            page_index=args.page_index,
            diagram_index=args.diagram_index,
        )
    except SystemExit as exc:
        if not args.add:
            raise
        # add path
        pages = doc.get("pages") or []
        if args.page_index is not None:
            page_obj = pages[args.page_index]
        else:
            matches = [p for p in pages if p.get("name") == args.page or args.page in str(p.get("name") or "")]
            if len(matches) != 1:
                raise SystemExit(str(exc))
            page_obj = matches[0]
        diagram_name = args.name or args.diagram
        if not diagram_name:
            raise SystemExit("--add requires --diagram or --name")
        diagram = {
            "id": str(uuid.uuid4()),
            "name": diagram_name,
            "description": args.description or "",
            "code": "flowchart TD\n  A[TODO] --> B[TODO]\n",
            "x": 0,
            "y": 0,
            "width": 900,
            "mermaidTheme": "blueprint",
            "configOverrides": {},
        }
        page_obj.setdefault("diagrams", []).append(diagram)
        if not page_obj.get("activeDiagramId"):
            page_obj["activeDiagramId"] = diagram["id"]

    if args.name is not None:
        diagram["name"] = args.name
    if args.description is not None:
        diagram["description"] = args.description
    if args.code is not None:
        diagram["code"] = args.code if args.code.endswith("\n") else args.code + "\n"
    if args.code_file is not None:
        text = args.code_file.read_text()
        diagram["code"] = text if text.endswith("\n") else text + "\n"
    if args.x is not None:
        diagram["x"] = args.x
    if args.y is not None:
        diagram["y"] = args.y
    if args.width is not None:
        diagram["width"] = args.width
    if args.theme is not None:
        diagram["mermaidTheme"] = args.theme

    args.file.write_text(json.dumps(doc, indent=2) + "\n")
    print(
        f"updated pages[{(doc.get('pages') or []).index(page_obj)}]"
        f" diagram id={diagram.get('id')} name={diagram.get('name')!r}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
