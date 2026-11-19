#!/usr/bin/env python3
"""Build the Fixpoint user manual (Word) with real screenshots.

Usage:
  python tools/make-manual.py [--pages pages.json] [--out path.docx]

`--pages` maps heading text -> page number, produced by tools/manual-outline.py
from a first-pass PDF. Without it the TOC shows "—" (same line count, so the
pagination of the second pass is unchanged).
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

ROOT = Path(__file__).resolve().parents[1]
IMG = ROOT / "docs" / "manual" / "img"
DEFAULT_OUT = ROOT / "docs" / "manual" / "Fixpoint嵌入式智能辅助开发软件V1.0_使用说明书.docx"

SOFTWARE = "Fixpoint嵌入式智能辅助开发软件"
VERSION = "V1.0"
AUTHOR = "王晨旭"
DATE = "2026 年 10 月"

PAGE_W, PAGE_H = 21.0, 29.7
MARGIN_TB, MARGIN_LR = 2.5, 2.5
TEXT_WIDTH_CM = PAGE_W - MARGIN_LR * 2

BODY_FONT = "宋体"
HEAD_FONT = "黑体"
BODY_SIZE = 10.5


# ---------------------------------------------------------------- helpers


def set_style_font(style, name: str, size: float, *, bold: bool = False, color=None) -> None:
    style.font.name = name
    style.font.size = Pt(size)
    style.font.bold = bold
    if color is not None:
        style.font.color.rgb = color
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), name)


def add_field(paragraph, instruction: str, placeholder: str = "1", *, size: float = 9, color=None) -> None:
    """Insert a Word field (PAGE / NUMPAGES) with a cached placeholder value."""
    def make_run():
        run = paragraph.add_run()
        run.font.size = Pt(size)
        run.font.name = BODY_FONT
        run._element.get_or_add_rPr()
        return run

    begin_run = make_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    begin_run._r.append(begin)

    instr_run = make_run()
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = f" {instruction} "
    instr_run._r.append(instr)

    sep_run = make_run()
    sep = OxmlElement("w:fldChar")
    sep.set(qn("w:fldCharType"), "separate")
    sep_run._r.append(sep)

    text_run = make_run()
    text = OxmlElement("w:t")
    text.text = placeholder
    text_run._r.append(text)
    if color is not None:
        text_run.font.color.rgb = color

    end_run = make_run()
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    end_run._r.append(end)


def add_bottom_border(paragraph, color: str = "BFBFBF", size: int = 4) -> None:
    ppr = paragraph._p.get_or_add_pPr()
    border = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(size))
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), color)
    border.append(bottom)
    ppr.append(border)


def setup_document() -> tuple[Document, object]:
    document = Document()
    section = document.sections[0]
    section.page_width = Cm(PAGE_W)
    section.page_height = Cm(PAGE_H)
    section.top_margin = Cm(MARGIN_TB)
    section.bottom_margin = Cm(MARGIN_TB - 0.2)
    section.left_margin = Cm(MARGIN_LR)
    section.right_margin = Cm(MARGIN_LR)
    section.header_distance = Cm(1.3)
    section.footer_distance = Cm(1.0)

    normal = document.styles["Normal"]
    set_style_font(normal, BODY_FONT, BODY_SIZE)
    normal.paragraph_format.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIVE
    normal.paragraph_format.space_after = Pt(3)
    normal.paragraph_format.space_before = Pt(3)

    h1 = document.styles["Heading 1"]
    set_style_font(h1, HEAD_FONT, 18, bold=True, color=RGBColor(0x1F, 0x2A, 0x44))
    h1.paragraph_format.space_before = Pt(6)
    h1.paragraph_format.space_after = Pt(10)
    h1.paragraph_format.page_break_before = True
    h1.paragraph_format.line_spacing = 1.2

    h2 = document.styles["Heading 2"]
    set_style_font(h2, HEAD_FONT, 13.5, bold=True, color=RGBColor(0x2A, 0x3C, 0x5E))
    h2.paragraph_format.space_before = Pt(10)
    h2.paragraph_format.space_after = Pt(5)
    h2.paragraph_format.line_spacing = 1.2

    # Header: name + version on the left, page numbers on the right.
    header = section.header
    header.is_linked_to_previous = False
    paragraph = header.paragraphs[0]
    paragraph.text = ""
    paragraph.paragraph_format.space_after = Pt(2)
    paragraph.paragraph_format.tab_stops.add_tab_stop(Cm(TEXT_WIDTH_CM), WD_TAB_ALIGNMENT.RIGHT)
    left = paragraph.add_run(f"{SOFTWARE} {VERSION}")
    left.font.size = Pt(9)
    left.font.name = BODY_FONT
    left.font.color.rgb = RGBColor(0x59, 0x59, 0x59)
    paragraph.add_run("\t")
    page_run = paragraph.add_run("第 ")
    page_run.font.size = Pt(9)
    page_run.font.color.rgb = RGBColor(0x59, 0x59, 0x59)
    add_field(paragraph, "PAGE", "1")
    mid = paragraph.add_run(" 页 / 共 ")
    mid.font.size = Pt(9)
    mid.font.color.rgb = RGBColor(0x59, 0x59, 0x59)
    add_field(paragraph, "NUMPAGES", "1")
    tail = paragraph.add_run(" 页")
    tail.font.size = Pt(9)
    tail.font.color.rgb = RGBColor(0x59, 0x59, 0x59)
    add_bottom_border(paragraph)

    footer = section.footer
    footer.is_linked_to_previous = False
    fpara = footer.paragraphs[0]
    fpara.alignment = WD_ALIGN_PARAGRAPH.CENTER
    frun = fpara.add_run(f"Fixpoint 开发团队 · {AUTHOR}")
    frun.font.size = Pt(9)
    frun.font.name = BODY_FONT
    frun.font.color.rgb = RGBColor(0x80, 0x80, 0x80)
    return document, section


def para(document, text: str, *, indent: bool = True, size: float | None = None, bold: bool = False):
    paragraph = document.add_paragraph()
    if indent:
        paragraph.paragraph_format.first_line_indent = Cm(0.74)
    run = paragraph.add_run(text)
    if size:
        run.font.size = Pt(size)
    run.bold = bold
    return paragraph


def bullet(document, text: str):
    paragraph = document.add_paragraph(style="List Bullet")
    paragraph.paragraph_format.space_after = Pt(2)
    paragraph.add_run(text)
    return paragraph


def caption(document, text: str):
    paragraph = document.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    paragraph.paragraph_format.space_before = Pt(2)
    paragraph.paragraph_format.space_after = Pt(10)
    run = paragraph.add_run(text)
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
    return paragraph


def picture(document, name: str, width_cm: float, cap: str):
    document.add_picture(str(IMG / name), width=Cm(width_cm))
    document.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
    document.paragraphs[-1].paragraph_format.keep_with_next = True
    caption(document, cap)


def note(document, title: str, text: str):
    table = document.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True
    cell = table.cell(0, 0)
    cell.text = ""
    paragraph = cell.paragraphs[0]
    run = paragraph.add_run(f"{title}：")
    run.bold = True
    run.font.size = Pt(9.5)
    run2 = paragraph.add_run(text)
    run2.font.size = Pt(9.5)
    shading = OxmlElement("w:shd")
    shading.set(qn("w:fill"), "F2F5FA")
    cell._tc.get_or_add_tcPr().append(shading)
    document.add_paragraph().paragraph_format.space_after = Pt(2)


# ---------------------------------------------------------------- content


def build_content(document):
    # ---------------- cover ----------------
    for _ in range(5):
        document.add_paragraph()
    title = document.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = title.add_run(SOFTWARE)
    run.font.name = HEAD_FONT
    run.font.size = Pt(26)
    run.bold = True
    run.font.color.rgb = RGBColor(0x1F, 0x2A, 0x44)

    subtitle = document.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = subtitle.add_run("使用说明书")
    run.font.name = HEAD_FONT
    run.font.size = Pt(22)
    run.font.color.rgb = RGBColor(0x1F, 0x2A, 0x44)

    for _ in range(2):
        document.add_paragraph()
    line = document.add_paragraph()
    line.alignment = WD_ALIGN_PARAGRAPH.CENTER
    line_run = line.add_run(f"版本 {VERSION}")
    line_run.font.size = Pt(14)
    line_run.font.color.rgb = RGBColor(0x44, 0x44, 0x44)

    for _ in range(8):
        document.add_paragraph()
    for text in (f"编制：{AUTHOR}", DATE):
        info = document.add_paragraph()
        info.alignment = WD_ALIGN_PARAGRAPH.CENTER
        info_run = info.add_run(text)
        info_run.font.size = Pt(12)
        info_run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
        info.paragraph_format.space_after = Pt(4)

    # ---------------- TOC ----------------
    toc_title = document.add_paragraph()
    toc_title.paragraph_format.page_break_before = True
    toc_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    toc_run = toc_title.add_run("目　　录")
    toc_run.font.name = HEAD_FONT
    toc_run.font.size = Pt(20)
    toc_run.bold = True
    toc_run.font.color.rgb = RGBColor(0x1F, 0x2A, 0x44)
    toc_title.paragraph_format.space_after = Pt(14)

    for title_text, level in TOC_ENTRIES:
        entry = document.add_paragraph()
        entry.paragraph_format.space_after = Pt(4)
        entry.paragraph_format.tab_stops.add_tab_stop(Cm(TEXT_WIDTH_CM), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS)
        if level == 2:
            entry.paragraph_format.left_indent = Cm(0.9)
        run = entry.add_run(title_text)
        run.font.size = Pt(11 if level == 1 else 10.5)
        run.bold = level == 1
        run.font.color.rgb = RGBColor(0x22, 0x22, 0x22)
        entry.add_run("\t")
        page_run = entry.add_run(str(PAGES.get(title_text, "—")))
        page_run.font.size = Pt(10.5)

    # ---------------- 1 ----------------
    document.add_heading("第一章 软件概述", level=1)
    document.add_heading("1.1 产品定位", level=2)
    para(
        document,
        "Fixpoint 是一款面向 8051 单片机的 PC 端集成开发工具。它把工程管理、代码编辑、"
        "真实编译器诊断与 AI 辅助集中在同一个窗口里：左边是工程树，中间是代码编辑器，"
        "右边是 AI 助手，底部是问题面板。写完代码按 F7 就能调用本机安装的 Keil C51 编译，"
        "错误直接以可点击的形式列出；遇到看不懂的编译错误或想重构代码，可以直接在右侧对话框里问 AI。",
    )
    para(
        document,
        "软件本身不捆绑任何编译器，也不替用户安装工具链，而是调用你电脑上已经装好的 Keil C51"
        "（BYOK，Bring Your Own Kit）。这样既避免了版权与版本问题，也保证编译结果和你平时在"
        "µVision 里看到的完全一致。AI 功能是可选的：不配置模型时，编辑器、编译、补全中的"
        "符号索引等本地能力仍然可以正常使用。",
    )
    para(
        document,
        "与“把代码贴到网页对话框里”的用法相比，Fixpoint 的关键区别是上下文：提问时会自动带上"
        "当前文件的全文、工程器件与片上资源、以及最近一次编译的错误列表。AI 拿到的不是一段孤立代码，"
        "而是这个工程此刻真实的样子，因此回答更贴近你正在做的事。",
    )
    para(
        document,
        "软件的设计原则是“本地优先、可解释、可回退”：编译在你的机器上完成；每个诊断都对应真实"
        "编译器输出；写文件前自动备份；AI 的修改必须由你点“应用修改”才落盘。任何一步出问题，"
        "都可以从 .backups 里找回上一版。",
    )
    document.add_heading("1.2 主要功能", level=2)
    for text in (
        "工程管理：新建工程（自动生成 .uvproj、main.c、STARTUP.A51）、打开已有工程、最近工程、"
        "工程树（Project / Target / Group / 文件 / 头文件）、多工程工作区（.uvmpw）。",
        "代码编辑：C51 语法高亮、括号匹配、代码折叠、行内补全（Ghost text）、关键字与 SFR 补全、"
        "成员补全、悬停提示、参数签名、F12 跳转定义。",
        "编译与诊断：一键编译 / 重建，调用 UV4 命令行；解析 C51 编译错误与链接错误，点击问题跳转；"
        "显示 hex 产物状态与所在目录。",
        "AI 辅助：流式对话、Markdown 渲染、附带当前文件与编译错误、代码块自动并排对比、"
        "应用修改前自动备份；支持多模型、推理强度、发送图片。",
        "技能（Skills）：把常用的排查步骤写成 Markdown 技能，安装后可随时调用，默认与其他"
        "AI 工具的技能目录隔离。",
        "可观测性：Token 用量与花费估算、编译耗时、外部改动自动同步、写文件自动备份。",
    ):
        bullet(document, text)
    para(
        document,
        "所有功能都围绕“一个窗口”组织：不需要在 Keil、编辑器和浏览器之间来回切换。编译结果、"
        "AI 回答和问题列表都在同一个界面里，出错时点一下就能回到对应的代码行。",
    )
    para(
        document,
        "多人协作或换电脑时，只要拷贝工程目录即可；软件不向工程里写入任何私有格式文件"
        "（备份目录 .backups 与技能目录 .keil-ide 都是可选的），Keil 依然可以正常打开同一个工程。",
    )

    document.add_heading("1.3 界面总览", level=2)
    para(
        document,
        "主界面由四个区域组成：左侧工程树、中间编辑器、右侧 AI 面板、底部问题面板。"
        "三栏之间的分隔条可以拖动调宽，AI 回复区与问题面板可以上下拖动调高；双击分隔条恢复默认，"
        "尺寸与最小化状态会被记住。",
    )
    picture(document, "overview.png", 15.4, "图 1-1 主界面：左工程树、中编辑器、右 AI 面板、底部问题面板")
    para(
        document,
        "顶部工具栏从左到右依次是：工程选择、编译（F7）、重建、hex 状态、当前器件与目标、"
        "编译器版本、符号统计、补全状态、用量、同步状态，以及新建工程、打开工程、AI 设置、"
        "打开 hex 目录等入口。",
    )
    para(
        document,
        "三栏宽度与上下高度都可以拖动调整：分隔条双击恢复默认；AI 面板可以最小化为右侧竖条，"
        "点竖条恢复。尺寸与最小化状态保存在本机，下次启动沿用。窗口变窄时编辑器会优先保留"
        "可用宽度，避免代码被挤成一列。",
    )
    para(
        document,
        "状态提示条会实时反映当前状态：编译器路径是否找到、当前器件与目标、符号索引数量、"
        "行内补全是否就绪、Token 用量、文件是否已同步。把鼠标停在任意状态项上可以看到详细说明，"
        "排查环境问题时先看这一行通常最快。",
    )

    # ---------------- 2 ----------------
    document.add_heading("第二章 运行环境", level=1)
    document.add_heading("2.1 硬件与系统要求", level=2)
    para(document, "Fixpoint 为 Windows 桌面应用，推荐配置如下：")
    for text in (
        "操作系统：Windows 10 / Windows 11（64 位）。",
        "处理器与内存：双核及以上；建议 4 GB 以上内存（Monaco 编辑器与 AI 面板常驻）。",
        "磁盘空间：安装包约 111 MB，安装后约 250 MB；工程与备份另计。",
        "显示分辨率：建议 1280×800 及以上，窗口最小尺寸 1024×640。",
        "网络：纯本地功能不需要联网；使用在线 AI 模型时需要能访问对应的 API 地址。",
    ):
        bullet(document, text)

    document.add_heading("2.2 开发环境（Keil C51）", level=2)
    para(
        document,
        "编译能力来自本机安装的 Keil C51。开发与验证环境为：Keil C51 V9.57、µVision 5.24.2.86，"
        "安装于 E:\\qrs\\software（包含 C51、UV4、器件库等目录）。Fixpoint 通过以下顺序定位 UV4.exe："
        "配置文件中的路径 → 环境变量 KEIL_UV4_PATH → 注册表 HKLM\\SOFTWARE\\WOW6432Node\\Keil\\Products\\C51 "
        "→ 常见安装目录。找到后会在工具栏显示编译器版本，找不到时提示“编译器: 没找到”。",
    )
    para(
        document,
        "器件的片上资源与头文件来自本机器件库 UV4.cdb（实测 1703 个 C51 器件、77 个厂商）。"
        "新建工程时可以搜索器件（例如 AT89C51、AT89C52、P89V51），软件会自动写入厂商、"
        "片上 ROM/RAM 与头文件；本机库停在 2017 年，STC 等较新的型号可以用兼容的 AT89C52 代替。",
    )
    note(
        document,
        "提示",
        "Fixpoint 不自带编译器，也不做代码签名以外的任何安装动作；卸载本软件不会影响你的 Keil 安装。",
    )
    para(
        document,
        "头文件查找顺序为：工程目录、工程自身的 Include Paths、Keil 的 C51\\INC。"
        "编辑器里 <reg51.h>、<reg52.h> 这类尖括号引用会被解析到真实文件，因此可以跳转、"
        "悬停查看 SFR 定义；如果某个头文件解析不到，工程树会把它标灰并提示“未找到该头文件”。",
    )

    document.add_heading("2.3 安装与首次启动", level=2)
    para(
        document,
        "双击 Fixpoint-Setup-<版本>.exe，按向导选择安装目录（默认安装到当前用户目录，"
        "不需要管理员权限），完成后会创建开始菜单项与桌面快捷方式。首次启动时软件不会自动"
        "打开任何工程，右侧 AI 面板会显示欢迎引导：点“新建工程…”选择空文件夹，或点“打开工程…”"
        "打开已有的 .uvproj。",
    )
    para(
        document,
        "设置文件保存在 %APPDATA%\\Fixpoint\\settings.json，包含工程路径、AI 后端配置、编辑器偏好、"
        "技能目录等；首次运行会自动创建。程序只监听 127.0.0.1，不对外提供网络服务。",
    )
    para(
        document,
        "第一次启动时没有工程属于正常状态：工程下拉框显示“（还没有打开工程）”，右侧面板给出"
        "新建与打开两个入口。软件不会自动打开任何示例工程，也不会因为没有工程而报错；"
        "此时编译按钮会提示先打开工程。",
    )
    document.add_heading("2.4 卸载", level=2)
    para(
        document,
        "在 Windows 设置 → 应用中找到 Fixpoint 卸载，或运行安装目录下的 Uninstall Fixpoint.exe。"
        "卸载只删除程序文件，不会删除你的工程、Keil 安装与 .backups 备份。",
    )

    # ---------------- 3 ----------------
    document.add_heading("第三章 功能操作指南", level=1)
    document.add_heading("3.1 工程管理", level=2)
    para(
        document,
        "工程树按 µVision 的层级显示：Project → Target → Source Group → 文件 → 头文件。"
        "点击文件名即可打开；文件前的标记表示它是否已经加入工程，未加入工程的文件会在"
        "“未加入工程”分组里提示——这类文件不会参与编译。",
    )
    picture(document, "tree.png", 7.2, "图 3-1 工程树：工程 / 目标 / 分组 / 文件 / 头文件")
    para(
        document,
        "新建工程：点工具栏“新建工程…”，选择文件夹、填写工程名并搜索器件。软件会生成 <工程名>.uvproj、"
        "一个 main.c 骨架，并从你本机的 Keil 安装里拷贝一份 STARTUP.A51；工程会自动加入最近列表。"
        "器件列表来自本机 UV4.cdb，选中后下方会显示厂商、片上 ROM/RAM、头文件与简要说明。",
    )
    for text in (
        "文件夹：工程会建在这个目录下，建议每个工程一个独立文件夹。",
        "工程名：同时作为 .uvproj 文件名与输出名（默认生成 <工程名>.hex）。",
        "器件：支持输入型号过滤；库里没有的型号（如 STC 系列）请直接使用兼容型号，例如 AT89C52。",
    ):
        bullet(document, text)
    picture(document, "new-project.png", 15.4, "图 3-2 新建工程：文件夹、工程名与器件搜索")
    para(
        document,
        "打开工程：选择已有的 .uvproj（Keil 新建的也可以），软件读取 Target、Group、源文件与 Include "
        "Paths，并在后台建立符号索引。多个相关联的工程可以放进一个工作区（.uvmpw），支持成员增删与"
        "“全部编译”；工作区文件同样由软件生成，µVision 可以直接打开。",
    )
    for text in (
        "顶部的工程下拉框保留最近打开过的工程，切换时自动保存当前状态。",
        "工程文件被其他工具修改后，列表会自动刷新；有未保存修改时只提示冲突，不覆盖。",
        "每写一次文件都会在工程目录的 .backups 下生成带时间戳的备份。",
    ):
        bullet(document, text)

    document.add_heading("3.2 代码编辑", level=2)
    para(
        document,
        "编辑器基于 Monaco，注册了 C51 语言：关键字、SFR、位定义、注释与字符串都有对应的高亮；"
        "支持括号匹配与代码折叠。打开工程时会在后台建立符号索引（工程源码 + include 头文件 + "
        "Keil 的 C51\\INC），因此补全、悬停和跳转都基于真实符号。",
    )
    picture(document, "editor.png", 14.2, "图 3-3 代码编辑：C51 语法高亮与符号信息")
    for text in (
        "行内补全（Ghost text）：按前缀与后缀请求补全，停顿约 300 毫秒后出现灰字，按 Tab 接受，"
        "继续输入会自动取消。",
        "补全与悬停：关键字、SFR、函数、结构体成员；悬停显示类型、地址与定义位置。",
        "F12 跳转定义；参数签名帮助在输入函数调用时显示参数列表。",
        "保存时自动备份到 .backups；文件统一写成无 BOM 的 UTF-8，避免 C51 把 BOM 当成语法错误。",
    ):
        bullet(document, text)
    para(
        document,
        "符号索引是编辑体验的基础：启动时扫描工程源码与头文件，解析函数、变量、宏、结构体与 SFR，"
        "编译成功后再合并 .m51 链接映射里的地址信息。因此补全项后面会显示真实地址，F12 能跳到源文件"
        "的具体行列，悬停卡片里也能看到空间（data/idata/xdata/code）。索引失败不会影响编辑与编译，"
        "只是失去这些智能提示。",
    )
    para(
        document,
        "编辑器会跟随磁盘变化：另一个编辑器或 git 改动了当前文件时，窗口会自动重新读取；如果你本窗口"
        "也有未保存的修改，软件只提示冲突，绝不覆盖。所有写操作都先备份，备份目录可以在设置里改成"
        "任意文件夹。",
    )

    document.add_heading("3.3 AI 辅助", level=2)
    para(
        document,
        "右侧 AI 面板是一个完整的对话界面：输入问题后回答以流式方式逐字出现，支持 Markdown 渲染；"
        "勾选“附带当前文件”“附带编译错误”后，提问会自动带上编辑器内容与最近一次编译的诊断，"
        "因此可以直接问“这个错误怎么改”。也可以在输入框用 /技能名 调用已安装的技能。",
    )
    para(
        document,
        "当回答里包含完整代码块时，编辑器会自动打开并排对比：左侧是当前文件，右侧是 AI 建议，"
        "新增为绿色、删除为红色，顶部显示 +N −M。点“应用修改”才会写回文件，写回前自动备份；"
        "点“放弃”则保持原样。",
    )
    picture(document, "ai.png", 15.4, "图 3-4 AI 对话与并排修改对比")
    para(
        document,
        "模型可以在“设置 → AI 后端”里添加多条（名称、Base URL、模型名、各自的 API Key），"
        "聊天输入区右下角的按钮可以直接切换模型与推理等级，切换立即生效。每条模型还可以标注"
        "上下文窗口、输出上限、推理强度、thinking 与是否支持图片。",
    )
    picture(document, "model-menu.png", 15.4, "图 3-5 聊天输入区的模型与推理等级选择器")
    for text in (
        "推理强度：off 不发送 reasoning_effort；low / high 原样发送；max 按 high 发送"
        "（OpenAI 兼容接口没有 max）。",
        "输出上限：留空或 0 表示不发送 max_tokens，由提供方决定；另外有“输出字符上限”"
        "（默认 20000，0 表示不限），思考与正文合计超过就立即断开并结束本轮，防止跑飞。",
        "图片：点“图片”按钮、Ctrl+V 粘贴或拖进面板，最多 4 张；发送前自动压缩（长边 1600、"
        "单张不超过 2 MB）。图片按 OpenAI 兼容的 image_url 发送。",
        "思考模型：思维链会以“思考过程”折叠块显示；如果上游只回思考、没有正文，界面会说明原因，"
        "不再出现空白回复。",
    ):
        bullet(document, text)
    para(
        document,
        "用量与花费：每次对话和补全都会记录发出与生成的词元数，并按模型价格表估算费用。"
        "上游返回真实 usage 时以真实值为准，否则显示本地估算；这些数字只用于了解消耗，"
        "不会上传到任何第三方。",
    )
    note(
        document,
        "关于烧录",
        "本软件只负责生成 hex，不包含烧录与串口监控功能；请使用你习惯的 ISP 工具（如 stcgal、"
        "STC-ISP）把 hex 写入芯片。",
    )

    document.add_heading("3.4 编译与输出", level=2)
    para(
        document,
        "按 F7 或工具栏“编译”调用本机 UV4 进行增量编译，“重建”则先清理再完整编译。编译完成后，"
        "工具栏的 hex 状态会显示产物大小与时间，问题面板列出错误与警告；点击问题会跳到对应文件与行。"
        "编译器返回的 ERRORLEVEL 会显示在结果里：0 表示无错误无警告，1 仅警告，2 错误，3 致命。",
    )
    picture(document, "build.png", 15.4, "图 3-6 一键编译：真实编译器输出与结果")
    para(
        document,
        "问题面板常驻底部，显示“0 错误 / 0 警告 · ERRORLEVEL 0 · ok”这类摘要；有错误时按文件与行号"
        "分组，双击即可定位。hex 状态旁可以直接打开产物所在目录。",
    )
    picture(document, "problems.png", 15.4, "图 3-7 底部问题面板与编译摘要")
    note(
        document,
        "说明",
        "编译使用你本机的 Keil，版本差异会直接影响诊断文本；软件只做解析与展示，不修改编译器行为。",
    )

    document.add_heading("3.5 设置与诊断", level=2)
    para(
        document,
        "设置对话框分为 AI 后端、代码补全、编辑器、预设提示词、文件、技能、诊断/关于几个页签。"
        "AI 后端里可以添加多条模型并单独设置密钥；代码补全可以指定单独的模型（例如聊天用大模型、"
        "补全用小模型）；文件页可以关闭自动备份或指定备份目录。",
    )
    picture(document, "settings.png", 15.4, "图 3-8 设置：模型配置与输出限制")
    para(
        document,
        "“诊断/关于”页显示编译器路径与版本、设置文件位置、Token 用量与花费估算，并提供"
        "“打开设置文件”“复制诊断信息”按钮，排查环境问题时会用到。",
    )
    para(
        document,
        "设置页签的划分对应不同的使用节奏：AI 后端与代码补全改的是模型连接；编辑器改的是字号、"
        "自动换行、缩略图与缩进；文件页管理备份开关、备份目录与外部改动的同步间隔；"
        "预设提示词与技能属于“内容”，可以外挂、可以随工程走。",
    )

    document.add_heading("3.6 技能与预设提示词", level=2)
    para(
        document,
        "技能是一段 Markdown 写成的操作说明，用来把重复的排查步骤固定下来。软件默认只扫描自己的"
        "技能目录（工程的 .keil-ide\\skills、用户级 .keil-ai\\skills 与随包内置目录），"
        "不会读取其他 AI 工具的 .dsh/skills、.agents/skills；需要共享时可以在设置里显式打开。",
    )
    picture(document, "skills.png", 15.4, "图 3-9 技能：安装、目录优先级与重新扫描")
    for text in (
        "安装：点“选择文件…”挑 .md/.prompt/.zip，或点“选择文件夹…”挑包含 SKILL.md 的目录；"
        "装到用户级对所有工程生效，装到工程级只对当前工程生效。",
        "调用：在聊天输入框用 /技能名 开头，或在下拉框中选择；技能正文会在使用时重新读取，"
        "修改后立即生效。",
        "预设提示词：把常用的提问模板放进 JSON 文件，在输入框上方的“预设”里选择即可填入；"
        "内置模板只在没有自定义模板时兜底。",
    ):
        bullet(document, text)
    para(
        document,
        "技能与预设都存放在普通文件中，可以直接用编辑器修改、用 git 管理；软件不会把它们写进"
        "数据库或二进制配置里。",
    )

    # ---------------- 4 ----------------
    document.add_heading("第四章 常见问题", level=1)
    for question, answer in (
        (
            "首次启动提示找不到工程？",
            "0.2.4 之前的版本把开发者的本机路径写进了默认配置，其他电脑首次启动会去找一个不存在的工程。"
            "升级到 0.2.4 及以上即可；旧配置里失效的工程路径会被自动忽略，不需要手动删除。",
        ),
        (
            "编译提示找不到编译器？",
            "确认本机已安装 Keil C51，并在“设置 → 诊断/关于”里查看检测结果。仍找不到时可以设置环境变量 "
            "KEIL_UV4_PATH 指向 UV4.exe，或在配置文件中写入路径。",
        ),
        (
            "AI 没有回复或回复为空？",
            "先点“测试 AI 连接”确认地址与密钥；再确认模型支持 /chat/completions。使用思考模型时，"
            "0.2.5 起默认不限制 max_tokens，并改用“输出字符上限”防跑飞；如果仍为空，界面会写明原因。",
        ),
        (
            "图片发送失败？",
            "图片走 OpenAI 兼容的 image_url，需要模型支持视觉输入（如 GPT-4o、Gemini、llava 等）。"
            "DeepSeek 官方的图片走另一套 Messages 协议，当前版本尚未支持。",
        ),
        (
            "端口 4870 被占用？",
            "说明已经有一个 Fixpoint 在运行。关闭另一个实例即可；需要同时运行时可以设置环境变量 "
            "KEIL_IDE_PORT 换一个端口。",
        ),
        (
            "设置保存在哪里？如何备份？",
            "设置文件在 %APPDATA%\\Fixpoint\\settings.json；工程文件的备份在工程目录的 .backups 下，"
            "两者都可以直接复制备份。",
        ),
        (
            "换一台电脑后怎么迁移？",
            "拷贝工程目录（含 .uvproj 与源码）即可；AI 配置可以复制 settings.json，或在设置里重新填写。"
            "新电脑需要自行安装 Keil C51，软件不捆绑工具链。",
        ),
        (
            "为什么默认不限制 max_tokens？",
            "小上限会让思考模型把预算全部花在思维链上，正文为空。现在默认不发送 max_tokens，"
            "改由“输出字符上限”控制长度：超过就立即断开上游并结束本轮，界面会写明停在哪。",
        ),
        (
            "AI 会不会把我的代码传到别处？",
            "只有在你点击“发送”时，才会把当前问题（以及你勾选的当前文件、编译错误）发给你配置的"
            "AI 接口。软件自身不上传任何数据；不配置模型时，AI 功能完全不联网。",
        ),
        (
            "支持哪些芯片？",
            "编译器是 Keil C51，因此覆盖 8051 及其兼容内核。器件下拉来自本机 UV4.cdb（1703 个型号）；"
            "STC 等不在库里的型号可以按兼容型号（如 AT89C52）建工程，再按实际型号烧录。",
        ),
        (
            "能直接烧录芯片吗？",
            "不能。软件负责生成 hex，烧录与串口监控请用外部 ISP 工具（如 STC-ISP、stcgal 等）；"
            "这样可以避免把厂商烧录协议硬编码进工具，也能兼容更多开发板。",
        ),
    ):
        heading = document.add_paragraph()
        heading.paragraph_format.space_before = Pt(8)
        heading.paragraph_format.space_after = Pt(2)
        run = heading.add_run(question)
        run.bold = True
        run.font.size = Pt(11)
        para(document, answer)

    # ---------------- appendix ----------------
    document.add_heading("附录 快捷键与目录说明", level=1)
    document.add_heading("A.1 常用快捷键", level=2)
    table = document.add_table(rows=1, cols=2)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    header_cells = table.rows[0].cells
    header_cells[0].text = "快捷键"
    header_cells[1].text = "功能"
    for key, action in (
        ("F7", "编译当前工程"),
        ("Ctrl + S", "保存当前文件（自动备份）"),
        ("Ctrl + Space", "触发补全"),
        ("F12", "跳转到符号定义"),
        ("Ctrl + Z / Ctrl + Y", "撤销 / 重做"),
        ("Ctrl + F", "在当前文件中查找"),
        ("Alt + ↑ / ↓", "上下移动当前行"),
    ):
        cells = table.add_row().cells
        cells[0].text = key
        cells[1].text = action
    for row in table.rows:
        for cell in row.cells:
            for paragraph in cell.paragraphs:
                for run in paragraph.runs:
                    run.font.size = Pt(10)

    document.add_heading("A.2 文件与目录", level=2)
    for text in (
        "安装目录：默认位于当前用户的 AppData\\Local\\Programs 下，包含 Fixpoint.exe 与 resources\\app.asar。",
        "%APPDATA%\\Fixpoint\\settings.json：界面与 AI 配置，可手工编辑。",
        "<工程目录>\\.backups\\：每次写文件的自动备份，按时间戳命名。",
        "<工程目录>\\.keil-ide\\skills\\：当前工程的技能目录（安装技能时可选）。",
        "%USERPROFILE%\\.keil-ai\\skills\\：用户级技能目录，对所有工程生效。",
    ):
        bullet(document, text)

    document.add_heading("A.3 兼容性说明", level=2)
    for text in (
        "工程文件：.uvproj 是 µVision 的 XML 格式，本软件只修改文件列表与包含路径，并在写入前备份；"
        "同一个工程可以继续在 µVision 中打开。",
        "编译产物：hex 由你本机的 UV4 生成，格式与直接用 µVision 编译完全一致。",
        "设置文件：JSON 文本，可手工编辑；版本升级时会自动补齐新增字段，缺失的字段按默认值处理。",
        "共存：本软件与 µVision 可以同时打开同一个工程；注意不要在两处同时保存同一个文件。",
    ):
        bullet(document, text)
    para(
        document,
        "本说明书中出现的界面截图来自 Fixpoint v0.2.6（Windows 11，Keil C51 V9.57）。"
        "不同版本在细节上可能略有差异，以实际界面为准。",
    )


TOC_ENTRIES = [
    ("第一章 软件概述", 1),
    ("1.1 产品定位", 2),
    ("1.2 主要功能", 2),
    ("1.3 界面总览", 2),
    ("第二章 运行环境", 1),
    ("2.1 硬件与系统要求", 2),
    ("2.2 开发环境（Keil C51）", 2),
    ("2.3 安装与首次启动", 2),
    ("2.4 卸载", 2),
    ("第三章 功能操作指南", 1),
    ("3.1 工程管理", 2),
    ("3.2 代码编辑", 2),
    ("3.3 AI 辅助", 2),
    ("3.4 编译与输出", 2),
    ("3.5 设置与诊断", 2),
    ("3.6 技能与预设提示词", 2),
    ("第四章 常见问题", 1),
    ("附录 快捷键与目录说明", 1),
    ("A.1 常用快捷键", 2),
    ("A.2 文件与目录", 2),
    ("A.3 兼容性说明", 2),
]

PAGES: dict[str, int] = {}


def main() -> None:
    global PAGES
    parser = argparse.ArgumentParser()
    parser.add_argument("--pages", help="JSON map heading -> page number")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()
    if args.pages:
        PAGES = json.loads(Path(args.pages).read_text(encoding="utf-8"))

    document, _ = setup_document()
    build_content(document)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    document.save(out)
    print(f"saved {out}")


if __name__ == "__main__":
    main()
