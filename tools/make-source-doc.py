#!/usr/bin/env python3
"""Build the 60-page source-code document for Fixpoint (软著式：前 30 页 + 后 30 页).

Rules implemented:
  * front 30 pages  <- the FIRST 30 pages of keil-ide/public/app.js (frontend core)
  * back  30 pages  <- the LAST 30 pages of keil-ide/server.mjs  (backend core)
  * blank lines removed, comment-only lines removed (inline comments are kept)
  * 58 effective code lines per page (>= 50 required), long lines wrapped so that
    NOTHING auto-wraps (which would silently change the pagination)
  * every page is its own section, with a static header:
        <软件全称>                       第 N 页，共 60 页
"""
from __future__ import annotations

import unicodedata
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.text import WD_LINE_SPACING, WD_TAB_ALIGNMENT
from docx.oxml.ns import qn
from docx.shared import Cm, Pt

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "Fixpoint嵌入式智能辅助开发软件V1.0_源代码.docx"

SOFTWARE_NAME = "Fixpoint嵌入式智能辅助开发软件 V1.0"
TOTAL_PAGES = 60
PAGES_PER_HALF = 30
LINES_PER_PAGE = 58
# Usable width at A4 with 1.5 cm side margins, 8.5 pt Consolas: ~109 half-width
# characters. Wrap at 104 so a glyph-width rounding never pushes a line over.
MAX_DISPLAY_WIDTH = 104

FRONT_FILES = [ROOT / "keil-ide" / "public" / "app.js"]
BACK_FILES = [ROOT / "keil-ide" / "server.mjs"]


def display_width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def effective_code_lines(path: Path) -> list[str]:
    """Non-empty lines that are not comment-only. Block comments are tracked."""
    lines: list[str] = []
    in_block = False
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.replace("\t", "  ").rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        if in_block:
            if "*/" in stripped:
                in_block = False
            continue
        if stripped.startswith("/*"):
            if "*/" not in stripped:
                in_block = True
            continue
        if stripped.startswith("*") and stripped.endswith("*/"):
            continue
        if stripped.startswith("//"):
            continue
        lines.append(line)
    return lines


def wrap_line(line: str) -> list[str]:
    """Hard-wrap by DISPLAY width (CJK counts as 2) so Word never wraps by itself."""
    if display_width(line) <= MAX_DISPLAY_WIDTH:
        return [line]
    indent = len(line) - len(line.lstrip(" "))
    prefix = " " * min(indent + 4, 40) + "  "
    parts: list[str] = []
    remaining = line
    first = True
    while remaining:
        limit = MAX_DISPLAY_WIDTH - (0 if first else display_width(prefix))
        taken = 0
        width = 0
        for ch in remaining:
            w = 2 if unicodedata.east_asian_width(ch) in "WF" else 1
            if width + w > limit:
                break
            width += w
            taken += 1
        if taken == 0:  # a single CJK char wider than the limit (cannot happen here)
            taken = 1
        chunk = ("" if first else prefix) + remaining[:taken]
        parts.append(chunk.rstrip())
        remaining = remaining[taken:]
        first = False
    return parts


def collect(files: list[Path], tail: bool, wanted: int) -> list[str]:
    lines: list[str] = []
    for path in files:
        for line in effective_code_lines(path):
            lines.extend(wrap_line(line))
    return lines[-wanted:] if tail else lines[:wanted]


def set_run_font(run, size: float, name: str = "Consolas", east_asia: str = "宋体") -> None:
    run.font.name = name
    run.font.size = Pt(size)
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), east_asia)


def setup_section(section) -> None:
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.0)
    section.bottom_margin = Cm(1.8)
    section.left_margin = Cm(1.5)
    section.right_margin = Cm(1.5)
    section.header_distance = Cm(0.9)
    section.footer_distance = Cm(0.8)


def write_header(section, page: int) -> None:
    section.header.is_linked_to_previous = False
    paragraph = section.header.paragraphs[0]
    paragraph.text = ""
    paragraph.paragraph_format.space_before = Pt(0)
    paragraph.paragraph_format.space_after = Pt(0)
    paragraph.paragraph_format.tab_stops.add_tab_stop(Cm(18.0), WD_TAB_ALIGNMENT.RIGHT)
    name_run = paragraph.add_run(SOFTWARE_NAME)
    set_run_font(name_run, 9, "宋体", "宋体")
    paragraph.add_run("\t")
    page_run = paragraph.add_run(f"第 {page} 页，共 {TOTAL_PAGES} 页")
    set_run_font(page_run, 9, "宋体", "宋体")


def main() -> None:
    front = collect(FRONT_FILES, tail=False, wanted=PAGES_PER_HALF * LINES_PER_PAGE)
    back = collect(BACK_FILES, tail=True, wanted=PAGES_PER_HALF * LINES_PER_PAGE)
    per_half = PAGES_PER_HALF * LINES_PER_PAGE
    if len(front) < per_half or len(back) < per_half:
        raise SystemExit(f"not enough code lines: front={len(front)} back={len(back)} need {per_half}")
    pages = [front[i * LINES_PER_PAGE:(i + 1) * LINES_PER_PAGE] for i in range(PAGES_PER_HALF)]
    pages += [back[i * LINES_PER_PAGE:(i + 1) * LINES_PER_PAGE] for i in range(PAGES_PER_HALF)]
    assert len(pages) == TOTAL_PAGES
    assert all(len(page) == LINES_PER_PAGE for page in pages)

    document = Document()
    style = document.styles.add_style("SourceCode", WD_STYLE_TYPE.PARAGRAPH)
    style.font.name = "Consolas"
    style.font.size = Pt(8.5)
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "宋体")
    fmt = style.paragraph_format
    fmt.space_before = Pt(0)
    fmt.space_after = Pt(0)
    fmt.line_spacing_rule = WD_LINE_SPACING.EXACTLY
    fmt.line_spacing = Pt(10.5)
    fmt.widow_control = False

    first = True
    for page_index, lines in enumerate(pages, start=1):
        if first:
            section = document.sections[0]
            first = False
            # Reuse the template's single empty paragraph instead of adding an extra line.
            paragraph = document.paragraphs[0] if document.paragraphs else document.add_paragraph()
        else:
            section = document.add_section(WD_SECTION.NEW_PAGE)
            paragraph = document.add_paragraph()
        setup_section(section)
        write_header(section, page_index)

        for line_index, line in enumerate(lines):
            if line_index:
                paragraph = document.add_paragraph()
            paragraph.style = style
            paragraph.paragraph_format.space_before = Pt(0)
            paragraph.paragraph_format.space_after = Pt(0)
            paragraph.paragraph_format.widow_control = False
            paragraph.add_run(line)

    document.save(OUT)
    print(f"saved {OUT}")
    print(f"pages={len(pages)} lines/page={LINES_PER_PAGE} front={len(front)} back={len(back)}")
    print(f"longest line (display width)={max(display_width(line) for page in pages for line in page)}")


if __name__ == "__main__":
    main()
