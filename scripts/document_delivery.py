"""Render a constrained Markdown proposal with no network or embedded HTML/images."""
import argparse
import re
from pathlib import Path
from urllib.parse import urlsplit

from docx import Document
from docx.shared import Cm, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE


def validate_markdown(text):
    if not text.strip() or len(text.encode('utf-8')) > 131072:
        raise ValueError('DOCUMENT_INPUT_LIMIT')
    if re.search(r'<[A-Za-z/!]', text.replace('<!-- pagebreak -->', '')):
        raise ValueError('DOCUMENT_HTML_UNSUPPORTED')
    if re.search(r'!\[[^\]]*\]\(', text):
        raise ValueError('DOCUMENT_IMAGES_UNSUPPORTED')
    for url in re.findall(r'\[[^\]]+\]\(([^\s)]+)\)', text):
        parsed = urlsplit(url)
        if parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('DOCUMENT_LINK_UNSAFE')
    if any(ord(c) < 32 and c not in '\n\r\t' for c in text):
        raise ValueError('DOCUMENT_CONTROL_CHARACTER')


def inline(paragraph, text):
    for part in re.split(r'(\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`)', text):
        match = re.fullmatch(r'\[([^\]]+)\]\(([^\s)]+)\)', part)
        if match:
            label, url = match.groups()
            link = OxmlElement('w:hyperlink')
            link.set(qn('r:id'), paragraph.part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True))
            run = OxmlElement('w:r')
            prop = OxmlElement('w:rPr')
            color = OxmlElement('w:color'); color.set(qn('w:val'), '174B70'); prop.append(color)
            run.append(prop)
            content = OxmlElement('w:t'); content.text = label; run.append(content); link.append(run)
            paragraph._p.append(link)
        else:
            run = paragraph.add_run(part[2:-2] if part.startswith('**') and part.endswith('**') else part.strip('`') if part.startswith('`') else part)
            if part.startswith('**'): run.bold = True


def create_docx(text, destination):
    validate_markdown(text)
    doc = Document()
    for border in doc.styles.element.xpath('.//w:pBdr'):
        border.getparent().remove(border)
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.top_margin = sec.bottom_margin = Cm(1.9)
    sec.left_margin = sec.right_margin = Cm(2)
    for name, size in [('Normal', 10.5), ('Title', 22), ('Heading 1', 15), ('Heading 2', 12), ('Heading 3', 11)]:
        style = doc.styles[name]
        style.font.name = 'Noto Sans CJK TC'; style.font.size = Pt(size); style.font.color.rgb = RGBColor(0, 0, 0)
        style.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'), 'Noto Sans CJK TC')
        style.paragraph_format.line_spacing = 1.2
        style.paragraph_format.space_after = Pt(5)
        if name.startswith('Heading'): style.paragraph_format.keep_with_next = True
    doc.core_properties.author = 'Thor team'
    doc.core_properties.title = 'Thor 競賽企劃草稿'
    lines = text.splitlines(); i = 0; title_seen = False
    while i < len(lines):
        line = lines[i].strip()
        if not line: i += 1; continue
        if line == '<!-- pagebreak -->':
            doc.add_page_break(); i += 1; continue
        heading = re.match(r'^(#{1,4})\s+(.+)$', line)
        if heading:
            level, content = len(heading[1]), heading[2]
            p = doc.add_paragraph(style='Title' if level == 1 and not title_seen else f'Heading {min(3,max(1,level-1))}')
            inline(p, content); title_seen = True; i += 1; continue
        if line.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                row = [x.strip() for x in lines[i].strip().strip('|').split('|')]
                if not all(re.fullmatch(r':?-+:?', c) for c in row): rows.append(row)
                i += 1
            if not rows or not 1 <= len(rows[0]) <= 5 or any(len(r) > len(rows[0]) or any(len(c) > 1200 for c in r) for r in rows):
                raise ValueError('DOCUMENT_TABLE_INVALID')
            rows = [row + [''] * (len(rows[0]) - len(row)) for row in rows]
            table = doc.add_table(rows=0, cols=len(rows[0])); table.style = 'Table Grid'; table.autofit = False
            for col in table.columns: col.width = Cm(17 / len(rows[0]))
            for n, cells in enumerate(rows):
                row = table.add_row()
                props = row._tr.get_or_add_trPr(); props.append(OxmlElement('w:cantSplit'))
                if n == 0: props.append(OxmlElement('w:tblHeader'))
                for cell, content in zip(row.cells, cells):
                    cell.width = Cm(17 / len(cells)); p = cell.paragraphs[0]; inline(p, content)
                    if n == 0:
                        shade = OxmlElement('w:shd'); shade.set(qn('w:fill'), 'E8EEF3'); cell._tc.get_or_add_tcPr().append(shade)
                        for run in p.runs: run.bold = True
            doc.add_paragraph(); continue
        if line.startswith('```'):
            i += 1
            while i < len(lines) and not lines[i].strip().startswith('```'):
                p = doc.add_paragraph(lines[i]); p.paragraph_format.space_after = Pt(0)
                for run in p.runs: run.font.size = Pt(9)
                i += 1
            i += 1; continue
        bullet = re.match(r'^(?:[-*]|\d+\.)\s+(.+)$', line)
        p = doc.add_paragraph(style='List Bullet' if bullet else 'Normal')
        inline(p, bullet[1] if bullet else line.removeprefix('> ')); i += 1
    doc.save(destination)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('source', type=Path); p.add_argument('output', type=Path)
    args = p.parse_args()
    if args.output.exists(): raise SystemExit('DOCUMENT_OUTPUT_EXISTS')
    create_docx(args.source.read_text(encoding='utf-8'), args.output)
