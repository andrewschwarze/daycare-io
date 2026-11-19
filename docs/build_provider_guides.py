"""Build downloadable Word guides from the Markdown source files."""

from pathlib import Path
import re

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
OUTPUT = ROOT / "public" / "downloads"
GUIDES = (
    ("provider-guide.md", "provider-guide.docx", "Provider Guide", "Everyday provider tasks"),
    ("technical-provider-guide.md", "technical-provider-guide.docx", "Technical Provider Guide", "Technical operations and handoff"),
)


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9 -]", "", text.lower())
    return re.sub(r"[\s-]+", "-", slug).strip("-")


def set_font(style, name: str, size: float, bold: bool = False) -> None:
    style.font.name = name
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor(0, 0, 0)
    r_pr = style.element.get_or_add_rPr()
    r_fonts = r_pr.rFonts
    if r_fonts is None:
        r_fonts = OxmlElement("w:rFonts")
        r_pr.insert(0, r_fonts)
    for key in ("ascii", "hAnsi", "eastAsia", "cs"):
        r_fonts.set(qn(f"w:{key}"), name)


def add_hyperlink(paragraph, label: str, target: str, bookmarks: dict[str, str]) -> None:
    hyperlink = OxmlElement("w:hyperlink")
    if target.startswith("#"):
        bookmark = bookmarks.get(target[1:])
        if bookmark:
            hyperlink.set(qn("w:anchor"), bookmark)
        else:
            paragraph.add_run(label)
            return
    else:
        relationship_id = paragraph.part.relate_to(
            target,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
            is_external=True,
        )
        hyperlink.set(qn("r:id"), relationship_id)

    run = OxmlElement("w:r")
    properties = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "286B54")
    properties.append(color)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    properties.append(underline)
    run.append(properties)
    text = OxmlElement("w:t")
    text.text = label
    run.append(text)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


def add_inline(paragraph, text: str, bookmarks: dict[str, str]) -> None:
    pattern = re.compile(r"\[([^\]]+)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`")
    cursor = 0
    for match in pattern.finditer(text):
        if match.start() > cursor:
            paragraph.add_run(text[cursor : match.start()])
        if match.group(1) is not None:
            add_hyperlink(paragraph, match.group(1), match.group(2), bookmarks)
        elif match.group(3) is not None:
            paragraph.add_run(match.group(3)).bold = True
        else:
            run = paragraph.add_run(match.group(4))
            run.font.name = "Consolas"
            run.font.size = Pt(9)
        cursor = match.end()
    if cursor < len(text):
        paragraph.add_run(text[cursor:])


def collect_bookmarks(lines: list[str]) -> tuple[list[tuple[str, str, int]], dict[str, str]]:
    headings: list[tuple[str, str, int]] = []
    bookmarks: dict[str, str] = {}
    used: dict[str, int] = {}
    for line in lines:
        match = re.match(r"^#{1,3}\s+(.+)$", line.rstrip())
        if not match:
            continue
        title = match.group(1)
        base = slugify(title)
        suffix = used.get(base, 0)
        used[base] = suffix + 1
        slug = base if suffix == 0 else f"{base}-{suffix}"
        name = f"guide_{len(headings) + 1}"
        headings.append((title, name, len(headings) + 1))
        bookmarks[slug] = name
    return headings, bookmarks


def add_bookmark(paragraph, name: str, bookmark_id: int) -> None:
    start = OxmlElement("w:bookmarkStart")
    start.set(qn("w:id"), str(bookmark_id))
    start.set(qn("w:name"), name)
    end = OxmlElement("w:bookmarkEnd")
    end.set(qn("w:id"), str(bookmark_id))
    paragraph._p.insert(0, start)
    paragraph._p.append(end)


def configure_styles(document: Document) -> None:
    section = document.sections[0]
    section.top_margin = Inches(0.72)
    section.bottom_margin = Inches(0.72)
    section.left_margin = Inches(0.82)
    section.right_margin = Inches(0.82)

    styles = document.styles
    normal = styles["Normal"]
    set_font(normal, "Aptos", 10.5)
    normal.paragraph_format.space_after = Pt(7)
    normal.paragraph_format.line_spacing = 1.12

    title = styles["Title"]
    set_font(title, "Aptos Display", 25, True)
    title.paragraph_format.space_after = Pt(10)
    title.paragraph_format.keep_with_next = True

    subtitle = styles["Subtitle"]
    set_font(subtitle, "Aptos", 13)
    subtitle.paragraph_format.space_after = Pt(3)
    subtitle.paragraph_format.keep_with_next = True

    for name, size in (("Heading 1", 17), ("Heading 2", 13)):
        heading = styles[name]
        set_font(heading, "Aptos Display", size, True)
        heading.paragraph_format.space_before = Pt(13 if name == "Heading 1" else 9)
        heading.paragraph_format.space_after = Pt(5)
        heading.paragraph_format.keep_with_next = True

    code_style = styles.add_style("Guide Code", WD_STYLE_TYPE.PARAGRAPH)
    set_font(code_style, "Consolas", 8.5)
    code_style.paragraph_format.left_indent = Inches(0.18)
    code_style.paragraph_format.space_after = Pt(2)
    code_style.paragraph_format.line_spacing = 1.0


def build_one(source: Path, output: Path, subject: str) -> None:
    lines = source.read_text(encoding="utf-8").splitlines()
    headings, bookmarks = collect_bookmarks(lines)
    document = Document()
    configure_styles(document)

    in_code = False
    code_lines: list[str] = []
    heading_index = 0
    for raw_line in lines:
        line = raw_line.rstrip()
        if line.startswith("```"):
            if in_code:
                for code_line in code_lines:
                    document.add_paragraph(code_line or " ", style="Guide Code")
                code_lines.clear()
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code_lines.append(line)
            continue
        if not line.strip():
            continue

        heading = re.match(r"^(#{1,3})\s+(.+)$", line)
        if heading:
            level = len(heading.group(1))
            style_name = "Title" if level == 1 else f"Heading {level - 1}"
            paragraph = document.add_paragraph(style=style_name)
            add_inline(paragraph, heading.group(2), bookmarks)
            _, bookmark_name, bookmark_id = headings[heading_index]
            add_bookmark(paragraph, bookmark_name, bookmark_id)
            heading_index += 1
            continue

        bullet = re.match(r"^[-*]\s+(.+)$", line)
        number = re.match(r"^\d+\.\s+(.+)$", line)
        if bullet or number:
            paragraph = document.add_paragraph(style="List Bullet" if bullet else "List Number")
            add_inline(paragraph, (bullet or number).group(1), bookmarks)
            paragraph.paragraph_format.space_after = Pt(3)
            continue

        paragraph = document.add_paragraph()
        add_inline(paragraph, line.replace("  ", " "), bookmarks)

    document.core_properties.title = headings[0][0] if headings else source.stem
    document.core_properties.subject = subject
    document.core_properties.author = "Megan's Childcare"
    output.parent.mkdir(parents=True, exist_ok=True)
    document.save(output)


def main() -> None:
    for source_name, output_name, _, subject in GUIDES:
        build_one(DOCS / source_name, OUTPUT / output_name, subject)


if __name__ == "__main__":
    main()
