#!/usr/bin/env python3
"""Extract {heading: page} from a LibreOffice-exported PDF (outline + page order).

Usage: python tools/manual-outline.py <pdf> [out.json]

LibreOffice writes every Heading 1/2 into the PDF outline; each item carries a
`/Dest[<page object> 0 R ...]`. The page order comes from the Pages `/Kids[]`
array, so this maps headings to the SAME page numbers Word shows.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path


def decode_pdf_text(raw: bytes) -> str:
    """Titles are UTF-16BE hex strings (<FEFF...>) or literal strings."""
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be", "replace")
    return raw.decode("latin1", "replace")


def main() -> None:
    pdf = Path(sys.argv[1])
    text = pdf.read_bytes().decode("latin1")

    kids = re.search(r"/Kids\s*\[([^\]]*)\]", text)
    if not kids:
        raise SystemExit("no /Kids found — is this a LibreOffice PDF?")
    page_refs = [int(value) for value in re.findall(r"(\d+)\s+0\s+R", kids.group(1))]
    page_of = {ref: index + 1 for index, ref in enumerate(page_refs)}

    items = []
    for match in re.finditer(r"/Title\s*(?:<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\)])*)\))(.{0,220}?)(?=/Title|/Outlines|endobj)", text, re.S):
        hex_title, literal, tail = match.group(1), match.group(2), match.group(3)
        title = decode_pdf_text(bytes.fromhex(hex_title)) if hex_title else decode_pdf_text((literal or "").encode("latin1"))
        dest = re.search(r"/Dest\s*\[\s*(\d+)\s+0\s+R", tail)
        if not dest:
            action = re.search(r"/D\s*\[\s*(\d+)\s+0\s+R", tail)
            dest = action
        if not dest:
            continue
        ref = int(dest.group(1))
        if ref not in page_of:
            continue
        items.append((title.strip("\x00 "), page_of[ref]))

    result = {}
    for title, page in items:
        if title and title not in result:
            result[title] = page
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
