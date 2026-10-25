import copy
import io
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))

from reports import ANALYSIS_VERSION, build_visibility_report


STAMP = "2026-10-25T10:00:00Z"
BRAND = {"id": 101, "canonical_id": "brand-101", "canonical_name": "Acme", "aliases": [], "domains": ["acme.test"]}


def answer(provider="openai", mentioned=True, names=None, **changes):
    names = names if names is not None else ["Acme"] if mentioned else ["OtherBrand"]
    return {
        "provider": provider, "analysis_version": ANALYSIS_VERSION, "mentioned": mentioned,
        "raw_answer": ", ".join(names), "sources": [],
        "ordered_mentions": [{"name": name, "position": index + 1} for index, name in enumerate(names)],
        "competitors": [name for name in names if name != "Acme"], **changes,
    }


def check(identifier=1, results=None, **changes):
    results = [answer()] if results is None else results
    value = {"provider": "all", "analysis_version": ANALYSIS_VERSION, "provider_results": results, "provider_errors": []}
    return {"id": identifier, "brand_id": 101, "brand": "Acme", "query": "Сервисы?", "provider": "all", "status": "completed", "created_at": STAMP, "result": value, "error": None, **changes}


class ReportCalculationTests(unittest.TestCase):
    def report(self, checks, **changes):
        return build_visibility_report(copy.deepcopy(BRAND), checks, **changes)

    def test_existing_dashboard_reference_metrics_and_selected_models(self):
        source = {"url": "https://acme.test/article", "cited_in_answer": True}
        records = [check(1, [answer(sources=[source]), answer("yandex", False)]), check(2, [answer(names=["OtherBrand", "Acme"])])]
        report = self.report(records)
        self.assertEqual(report["metrics"], {"sov": 43, "visibility": 67, "citation": 33, "position": 1.5})
        self.assertEqual(report["coverage"]["answers"], 3)
        selected = self.report(records, providers=["openai"])
        self.assertEqual(selected["metrics"], {"sov": 60, "visibility": 100, "citation": 50, "position": 1.5})
        self.assertEqual(selected["models"], [{"provider": "openai", "name": "ChatGPT", "answers": 2, "mentions": 2, "visibility": 100}])

    def test_partial_provider_errors_are_not_negative_answers(self):
        record = check(results=[answer()], status="partial")
        record["result"]["provider_errors"] = [{"provider": "yandex", "error": "timeout"}]
        report = self.report([record], providers=["yandex"])
        self.assertEqual(report["coverage"]["errors"], 1)
        self.assertEqual(report["coverage"]["partial"], 1)
        self.assertEqual(report["coverage"]["answers"], 0)
        self.assertIsNone(report["metrics"]["visibility"])
        self.assertIsNone(report["models"][0]["visibility"])

    def test_failed_running_aggregate_only_and_old_analysis_exclusions(self):
        old = check(4, [answer(analysis_version="old")])
        old["result"]["analysis_version"] = "old"
        mixed = check(5, [answer("openai", False), answer("yandex", True, analysis_version="old")])
        report = self.report([check(1, [answer("openai", False)]), check(2, status="failed"), check(3, status="running"), old, mixed, check(6, [])])
        self.assertEqual(report["coverage"], {"records": 6, "answers": 2, "partial": 0, "errors": 0, "failed": 1, "running": 1, "excluded": 2, "excluded_answers": 1})
        self.assertEqual(report["metrics"]["visibility"], 0)

    def test_moscow_period_uses_inclusive_calendar_days_and_creation_time(self):
        records = [check(1, [answer("openai", False)], created_at="2026-10-24T20:59:59.999Z"), check(2, created_at="2026-10-24T21:00:00Z", completed_at="2026-10-27T00:00:00Z"), check(3, [answer("openai", False)], created_at="2026-10-25T20:59:59.999Z"), check(4, created_at="2026-10-25T21:00:00Z")]
        report = self.report(records, start=date(2026, 10, 25), end=date(2026, 10, 25))
        self.assertEqual(report["coverage"]["records"], 2)
        self.assertEqual(report["metrics"]["visibility"], 50)
        self.assertEqual(report["period"]["start"], "2026-10-25")

    def test_empty_and_zero_visibility_are_distinct(self):
        self.assertEqual(self.report([])["metrics"], dict.fromkeys(["sov", "visibility", "citation", "position"]))
        report = self.report([check(results=[answer("openai", False)])])
        self.assertEqual(report["metrics"]["visibility"], 0)
        self.assertEqual(report["metrics"]["sov"], 0)
        self.assertIsNone(report["metrics"]["position"])

    def test_explicit_mention_outside_ranked_list_has_visibility_but_no_position(self):
        report = self.report([check(results=[answer(names=["OtherBrand"], mentioned=True)])])
        self.assertEqual(report["metrics"], {"sov": 0, "visibility": 100, "citation": 0, "position": None})

    def test_aliases_merge_legacy_rows_but_snapshot_company_ids_stay_separate(self):
        target = {**BRAND, "aliases": ["Alias", "СберБизнес"]}
        legacy = answer(names=["Alias", "OtherBrand", "Acme"])
        snapshot = answer(names=["Acme", "СберБизнес"], identity_normalization_version="company-options-v1", canonical_id="brand-101", canonical_name="Acme")
        snapshot["ordered_mentions"] = [{"name": "Acme", "canonical_name": "Acme", "canonical_id": "brand-101", "position": 1}, {"name": "СберБизнес", "canonical_name": "СберБанк", "canonical_id": "company:sber", "position": 2}]
        record = check(2, [snapshot])
        record["result"].update(identity_normalization_version="company-options-v1", canonical_id="brand-101")
        report = build_visibility_report(target, [check(1, [legacy]), record])
        self.assertEqual(report["metrics"]["visibility"], 100)
        self.assertIn("СберБанк", [row["name"] for row in report["brands"]])
        self.assertEqual(report["metrics"]["position"], 1)

    def test_saved_citation_survives_current_domain_removal(self):
        result = answer(identity_normalization_version="company-options-v1", canonical_id="brand-101", canonical_name="Acme", citation_domains=["acme.test"], brand_cited=True)
        result["ordered_mentions"] = [{"name": "Acme", "canonical_name": "Acme", "canonical_id": "brand-101", "position": 1}]
        record = check(results=[result])
        record["result"]["identity_normalization_version"] = "company-options-v1"
        report = build_visibility_report({**BRAND, "domains": []}, [record])
        self.assertEqual(report["metrics"]["citation"], 100)
        self.assertTrue(report["citation"]["measured"])

    def test_domains_missing_and_explicitly_uncited_sources(self):
        result = answer(sources=[{"url": "https://acme.test/page", "cited_in_answer": False}])
        report = self.report([check(results=[result])])
        self.assertEqual(report["metrics"]["citation"], 0)
        self.assertEqual(report["sources"][0]["answers"], 1)
        report = build_visibility_report({**BRAND, "domains": []}, [check(results=[result])])
        self.assertIsNone(report["metrics"]["citation"])

    def test_source_domains_deduplicate_per_answer_and_keep_top_five(self):
        sources = [{"url": f"https://www.domain{number}.test/a"} for number in range(8)]
        sources += [{"url": "https://domain0.test/b"}, {"url": "javascript:alert(1)"}]
        report = self.report([check(results=[answer(sources=sources), answer("yandex", sources=sources[:1])])])
        self.assertEqual(len(report["sources"]), 5)
        self.assertEqual(report["sources"][0], {"name": "domain0.test", "answers": 2, "share": 100})

    def test_provider_order_and_all_six_models(self):
        report = self.report([check(results=[answer("deepseek")])], providers=["deepseek", "openai", "deepseek"])
        self.assertEqual([item["id"] for item in report["providers"]], ["openai", "deepseek"])
        self.assertEqual(report["models"][1]["answers"], 1)

    def test_revision_is_stable_but_changes_when_saved_inputs_change(self):
        records = [check()]
        first = self.report(records, now=datetime(2026, 1, 1, tzinfo=timezone.utc))
        second = self.report(records, now=datetime(2026, 2, 1, tzinfo=timezone.utc))
        self.assertEqual(first["revision"], second["revision"])
        self.assertNotEqual(first["generated_at"], second["generated_at"])
        records[0]["status"] = "failed"
        self.assertNotEqual(first["revision"], self.report(records)["revision"])

    def test_invalid_filters_rejected(self):
        for filters in [{"providers": []}, {"providers": ["unknown"]}, {"start": date(2026, 1, 1)}, {"start": date(2026, 2, 1), "end": date(2026, 1, 1)}]:
            with self.subTest(filters=filters), self.assertRaises(ValueError):
                self.report([], **filters)

    def test_maximum_calendar_end_does_not_overflow(self):
        report = self.report([check()], start=date(2026, 1, 1), end=date.max)
        self.assertEqual(report["coverage"]["answers"], 1)


class ReportApiTests(unittest.TestCase):
    def setUp(self):
        import main
        from fastapi.testclient import TestClient

        self.main = main
        self.client = TestClient(main.app)
        main.app.dependency_overrides[main._current_user] = lambda: {"id": 7}
        self.data = patch.object(main, "read_report_data", return_value=(copy.deepcopy(BRAND), [copy.deepcopy(BRAND)], [check()]))
        self.read = self.data.start()

    def tearDown(self):
        self.data.stop()
        self.main.app.dependency_overrides.clear()

    def test_preview_scope_cookie_auth_and_no_store(self):
        result = self.client.get("/api/reports/visibility", params={"brand_id": 101})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.headers["cache-control"], "no-store")
        self.assertEqual(result.json()["metrics"]["visibility"], 100)
        self.read.assert_called_once_with(7, 101)
        self.main.app.dependency_overrides.clear()
        for endpoint in ["/api/reports/visibility", "/api/reports/visibility/export"]:
            response = self.client.get(endpoint, params={"brand_id": 101, "format": "pdf", "revision": "a" * 64})
            self.assertEqual(response.status_code, 401)

    def test_foreign_or_missing_brand_returns_404(self):
        self.read.return_value = None
        self.assertEqual(self.client.get("/api/reports/visibility", params={"brand_id": 202}).status_code, 404)

    def test_invalid_filters_and_formats(self):
        for params in [{"providers": "invalid"}, {"start": "2026-10-25"}, {"start": "2026-10-26", "end": "2026-10-25"}, {"start": "invalid", "end": "2026-10-25"}, {"brand_id": 0}, {"brand_id": 9223372036854775808}]:
            self.assertEqual(self.client.get("/api/reports/visibility", params={"brand_id": 101, **params}).status_code, 422)
        self.assertEqual(self.client.get("/api/reports/visibility/export", params={"brand_id": 101, "format": "docx", "revision": "a" * 64}).status_code, 422)

    def test_export_revision_no_answers_and_generation_failure(self):
        import report_documents

        params = {"brand_id": 101, "format": "pdf", "revision": "a" * 64}
        with patch.object(report_documents, "export_report") as generate:
            self.assertEqual(self.client.get("/api/reports/visibility/export", params=params).status_code, 409)
            generate.assert_not_called()
        self.read.return_value = (BRAND, [BRAND], [])
        params["revision"] = self.client.get("/api/reports/visibility", params={"brand_id": 101}).json()["revision"]
        self.assertEqual(self.client.get("/api/reports/visibility/export", params=params).status_code, 422)
        self.read.return_value = (BRAND, [BRAND], [check()])
        params["revision"] = self.client.get("/api/reports/visibility", params={"brand_id": 101}).json()["revision"]
        with patch.object(report_documents, "export_report", side_effect=RuntimeError("internal")):
            result = self.client.get("/api/reports/visibility/export", params=params)
        self.assertEqual(result.status_code, 500)
        self.assertNotIn("internal", result.text)

    def test_both_exports_attachment_and_no_ai_quota_calls(self):
        import report_documents

        revision = self.client.get("/api/reports/visibility", params={"brand_id": 101}).json()["revision"]
        with patch.object(report_documents, "export_report", return_value=b"document") as generate, patch.object(self.main, "start_check") as start:
            for format in ["pdf", "xlsx"]:
                result = self.client.get("/api/reports/visibility/export", params={"brand_id": 101, "format": format, "revision": revision})
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.content, b"document")
                self.assertIn("attachment;", result.headers["content-disposition"])
                self.assertIn("filename*=UTF-8''", result.headers["content-disposition"])
                self.assertEqual(result.headers["cache-control"], "no-store")
            start.assert_not_called()
            self.assertEqual(generate.call_count, 2)

    def test_real_generators_download_through_api_boundary_and_cors(self):
        from openpyxl import load_workbook

        records = [check(1, [answer(sources=[{"url": "https://acme.test/article", "cited_in_answer": True}]), answer("yandex", False)]), check(2, [answer(names=["OtherBrand", "Acme"])])]
        self.read.return_value = (BRAND, [BRAND], records)
        revision = self.client.get("/api/reports/visibility", params={"brand_id": 101}).json()["revision"]
        payloads = {}
        for format, mime in [("pdf", "application/pdf"), ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")]:
            response = self.client.get("/api/reports/visibility/export", params={"brand_id": 101, "format": format, "revision": revision}, headers={"Origin": self.main.cors_origins[0]})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], mime)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertIn("Content-Disposition", response.headers["access-control-expose-headers"])
            self.assertIn(f".{format}", response.headers["content-disposition"])
            self.assertEqual(int(response.headers["content-length"]), len(response.content))
            payloads[format] = response.content
        self.assertTrue(payloads["pdf"].startswith(b"%PDF-"))
        self.assertIn(b"%%EOF", payloads["pdf"][-100:])
        workbook = load_workbook(io.BytesIO(payloads["xlsx"]))
        self.assertEqual(workbook.sheetnames, ["Сводка", "AI-модели", "Конкуренты", "Источники", "Методика"])
        self.assertEqual(workbook["Сводка"]["B9"].value, .43)
        self.assertEqual(workbook["Сводка"]["B10"].value, .67)
        self.assertEqual(workbook["Сводка"]["B11"].value, .33)
        self.assertEqual(workbook["Сводка"]["B12"].value, 1.5)
        self.assertEqual(workbook["Сводка"]["B9"].data_type, "n")
        self.assertEqual(workbook["Сводка"]["B9"].number_format, "0%")


class ReportStorageTests(unittest.TestCase):
    def test_coherent_read_only_snapshot_scopes_both_queries_to_user(self):
        import storage

        database = MagicMock()
        database.execute.return_value.fetchall.side_effect = [[{**BRAND, "created_at": STAMP, "updated_at": STAMP}], [{**check(), "canonical_id": "brand-101", "completed_at": STAMP}]]
        manager = MagicMock()
        manager.__enter__.return_value = database
        with patch.object(storage, "connection", return_value=manager):
            result = storage.read_report_data(7, 101)
        self.assertEqual(result[0]["id"], 101)
        commands = database.execute.call_args_list
        self.assertEqual(commands[0].args, ("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",))
        self.assertEqual(commands[1].args[1], (7,))
        self.assertEqual(commands[2].args[1], (7,))
        self.assertIn("WHERE user_id = %s", commands[1].args[0])
        self.assertIn("WHERE user_id = %s", commands[2].args[0])

    def test_unknown_brand_does_not_load_checks(self):
        import storage

        database = MagicMock()
        database.execute.return_value.fetchall.return_value = [BRAND]
        manager = MagicMock()
        manager.__enter__.return_value = database
        with patch.object(storage, "connection", return_value=manager):
            self.assertIsNone(storage.read_report_data(7, 202))
        self.assertEqual(database.execute.call_count, 2)


if __name__ == "__main__":
    unittest.main()
