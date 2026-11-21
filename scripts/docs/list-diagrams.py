#!/usr/bin/env python3
"""List pages and diagrams in a .prettyfish.json."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path, help="Path to .prettyfish.json")
    parser.add_argument("--json", action="store_true", help="Machine-readable output")
    args = parser.parse_args()

    doc = json.loads(args.file.read_text())
    pages = doc.get("pages") or []
    rows = []
    for pi, page in enumerate(pages):
        for di, diagram in enumerate(page.get("diagrams") or []):
            rows.append(
                {
                    "pageIndex": pi,
                    "diagramIndex": di,
                    "pageId": page.get("id"),
                    "pageName": page.get("name"),
                    "diagramId": diagram.get("id"),
                    "diagramName": diagram.get("name"),
                    "description": diagram.get("description"),
                    "active": page.get("activeDiagramId") == diagram.get("id"),
                }
            )

    if args.json:
        json.dump(rows, sys.stdout, indent=2)
        print()
        return 0

    print(f"{args.file}  pages={len(pages)} diagrams={len(rows)} activePageId={doc.get('activePageId')}")
    for row in rows:
        marker = "*" if row["active"] else " "
        print(
            f"{marker} pages[{row['pageIndex']}].diagrams[{row['diagramIndex']}]  "
            f"[{row['pageName']}] \"{row['diagramName']}\""
        )
        if row.get("description"):
            print(f"    {row['description']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
