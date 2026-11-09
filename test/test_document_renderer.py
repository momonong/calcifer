import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile
from lxml import etree

spec = importlib.util.spec_from_file_location('renderer', Path(__file__).resolve().parents[1] / 'scripts/document_delivery.py')
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)

class DocumentRendererTests(unittest.TestCase):
    def test_title_has_no_decorative_border_and_public_link_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'draft.docx'
            renderer.create_docx('# 企劃草稿\n\n[官方來源](https://example.com/rules)\n', path)
            with ZipFile(path) as z:
                styles = etree.fromstring(z.read('word/styles.xml'))
                self.assertFalse(styles.xpath('//*[local-name()="pBdr"]'))
                self.assertIn(b'https://example.com/rules', z.read('word/_rels/document.xml.rels'))

    def test_short_table_row_preserves_content_and_pads_missing_cell(self):
        output = io.BytesIO()
        renderer.create_docx('# 企劃草稿\n\n| 項目 | 現況 |\n| --- | --- |\n| 待補 |\n', output)
        output.seek(0)
        table = renderer.Document(output).tables[0]
        self.assertEqual([cell.text for cell in table.rows[0].cells], ['項目', '現況'])
        self.assertEqual([cell.text for cell in table.rows[1].cells], ['待補', ''])

    def test_untrusted_html_images_and_private_links_are_rejected(self):
        for text in ['<script>alert(1)</script>', '[秘密](file:///etc/passwd)', '![圖片](https://example.com/image)', '[來源](https://user:pass@example.com/)']:
            with self.subTest(text=text):
                with self.assertRaises(ValueError): renderer.validate_markdown(text)

if __name__ == '__main__': unittest.main()
