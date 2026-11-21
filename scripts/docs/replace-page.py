#!/usr/bin/env python3
"""Replace an entire page's diagrams (or rename the page) in a .prettyfish.json.

Reads a page payload JSON from --from-file:

{
  "name": "L2 — Promises & boundaries (what)",
  "diagrams": [ { "name": "...", "description": "...", "code": "...", "x": 0, "y": 0, "width": 900 } ]
}

Ids are preserved when diagram names match; new diagrams get new UUIDs.
"""

from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--page", required=True, help="Exact or unique substring of existing page name")
    parser.add_argument("--from-file", type=Path, required=True, help="JSON page payload")
    args = parser.parse_args()

    doc = json.loads(args.file.read_text())
    pages = doc.get("pages") or []
    matches = [p for p in pages if p.get("name") == args.page]
    if not matches:
        matches = [p for p in pages if args.page in str(p.get("name") or "")]
    if len(matches) != 1:
        raise SystemExit(f"page match failed for {args.page!r}; pages={[p.get('name') for p in pages]}")
    page = matches[0]

    payload = json.loads(args.from_file.read_text())
    if "name" in payload and isinstance(payload["name"], str) and payload["name"].strip():
        page["name"] = payload["name"]

    incoming = payload.get("diagrams")
    if not isinstance(incoming, list) or not incoming:
        raise SystemExit("payload.diagrams must be a non-empty list")

    by_name = {d.get("name"): d for d in (page.get("diagrams") or []) if d.get("name")}
    rebuilt = []
    for index, raw in enumerate(incoming):
        if not isinstance(raw, dict):
            raise SystemExit(f"diagrams[{index}] must be an object")
        name = raw.get("name")
        if not isinstance(name, str) or not name.strip():
            raise SystemExit(f"diagrams[{index}].name required")
        code = raw.get("code")
        if not isinstance(code, str) or not code.strip():
            raise SystemExit(f"diagrams[{index}].code required")
        existing = by_name.get(name)
        diagram = {
            "id": existing.get("id") if existing else str(uuid.uuid4()),
            "name": name,
            "description": raw.get("description") if isinstance(raw.get("description"), str) else existing.get("description") if existing else "",
            "code": code if code.endswith("\n") else code + "\n",
            "x": float(raw.get("x", existing.get("x", 0) if existing else 0)),
            "y": float(raw.get("y", existing.get("y", 0) if existing else 0)),
            "width": float(raw.get("width", existing.get("width", 900) if existing else 900)),
            "mermaidTheme": raw.get("mermaidTheme")
            or (existing.get("mermaidTheme") if existing else "blueprint"),
            "configOverrides": raw.get("configOverrides")
            if isinstance(raw.get("configOverrides"), dict)
            else (existing.get("configOverrides") if existing else {}),
        }
        rebuilt.append(diagram)

    page["diagrams"] = rebuilt
    active = page.get("activeDiagramId")
    if not any(d["id"] == active for d in rebuilt):
        page["activeDiagramId"] = rebuilt[0]["id"]

    args.file.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"replaced page {page.get('name')!r} with {len(rebuilt)} diagrams")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
