import io
import sys
import unittest
from pathlib import Path

from openpyxl import load_workbook

sys.path.insert(0, str(Path(__file__).parent))

from report_documents import export_report


def sample_report():
    return {
        "brand": {"id": 1, "name": "Тестовый бренд"},
        "period": {"start": None, "end": None, "label": "Всё время · даты по Москве"},
        "providers": [{"id": "openai", "name": "ChatGPT"}, {"id": "deepseek", "name": "DeepSeek"}],
        "generated_at": "2026-10-26T10:30:00+03:00",
        "revision": "test-revision",
        "metrics": {"sov": 43, "visibility": 67, "citation": 33, "position": 1.5},
        "coverage": {"records": 2, "answers": 3, "partial": 1, "errors": 1, "failed": 0, "running": 0, "excluded": 0, "excluded_answers": 0},
        "models": [{"provider": "openai", "name": "ChatGPT", "answers": 2, "mentions": 2, "visibility": 100}, {"provider": "deepseek", "name": "DeepSeek", "answers": 1, "mentions": 0, "visibility": 0}],
        "brands": [{"name": "Тестовый бренд", "own": True, "sov": 43, "visibility": 67, "position": 1.5}, {"name": "Конкурент", "own": False, "sov": 57, "visibility": 100, "position": 1}],
        "sources": [{"name": "example.test", "answers": 1, "share": 33}],
        "citation": {"measured": True, "count": 1},
        "own_mentions": 2,
        "methodology": ["Видимость — доля ответов с упоминанием бренда.", "Ошибки моделей не считаются отрицательными ответами."],
    }


class ReportDocumentTests(unittest.TestCase):
    def test_pdf_is_complete_and_has_embedded_font(self):
        document = export_report(sample_report(), "pdf")
        self.assertTrue(document.startswith(b"%PDF-"))
        self.assertIn(b"%%EOF", document[-100:])
        self.assertIn(b"/FontFile2", document)
        self.assertGreater(len(document), 20000)

    def test_xlsx_roundtrip_has_five_summary_sheets_and_typed_values(self):
        workbook = load_workbook(io.BytesIO(export_report(sample_report(), "xlsx")))
        self.assertEqual(workbook.sheetnames, ["Сводка", "AI-модели", "Конкуренты", "Источники", "Методика"])
        self.assertEqual(workbook["Сводка"]["B9"].value, .43)
        self.assertEqual(workbook["Сводка"]["B9"].number_format, "0%")
        self.assertEqual(workbook["Сводка"]["B12"].value, 1.5)
        self.assertEqual(workbook["Сводка"]["B6"].value.year, 2026)
        self.assertEqual(workbook["Сводка"]["B6"].number_format, "yyyy-mm-dd hh:mm")
        self.assertEqual(workbook["AI-модели"]["B4"].value, 2)
        self.assertEqual(workbook["AI-модели"]["D5"].value, 0)
        self.assertEqual(workbook["Конкуренты"].max_row, 7)
        self.assertEqual(workbook["Источники"].max_row, 4)
        self.assertEqual(workbook["Методика"].max_row, 4)
        self.assertFalse(any(cell.data_type == "f" for sheet in workbook for row in sheet for cell in row))

    def test_formula_like_brand_and_sources_are_literal_text(self):
        report = sample_report()
        report["brand"]["name"] = '=HYPERLINK("https://example.test")'
        report["brands"][0]["name"] = "+1+1"
        report["sources"][0]["name"] = "=1+1"
        workbook = load_workbook(io.BytesIO(export_report(report, "xlsx")))
        for sheet, coordinate in [("Сводка", "B3"), ("Конкуренты", "A6"), ("Источники", "A4")]:
            self.assertEqual(workbook[sheet][coordinate].data_type, "s")
        self.assertEqual(workbook["Сводка"]["B3"].value, report["brand"]["name"])

    def test_unmeasured_and_empty_sources_render_without_false_zero(self):
        report = sample_report()
        report["metrics"]["citation"] = None
        report["metrics"]["position"] = None
        report["citation"] = {"measured": False, "count": 0}
        report["sources"] = []
        report["models"][1]["visibility"] = None
        workbook = load_workbook(io.BytesIO(export_report(report, "xlsx")))
        self.assertEqual(workbook["Сводка"]["B11"].value, "—")
        self.assertEqual(workbook["AI-модели"]["D5"].value, "—")
        self.assertIn("нет источников", workbook["Источники"]["A4"].value)
        self.assertTrue(export_report(report, "pdf").startswith(b"%PDF-"))

    def test_long_cyrillic_and_xml_like_labels_can_be_exported(self):
        report = sample_report()
        report["brand"]["name"] = "Длинное название компании <проверка> & партнёры " * 4
        for row in report["brands"]:
            row["name"] = report["brand"]["name"]
        report["methodology"] *= 25
        self.assertTrue(export_report(report, "pdf").startswith(b"%PDF-"))
        self.assertTrue(export_report(report, "xlsx").startswith(b"PK"))


if __name__ == "__main__":
    unittest.main()
