import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import main


class UnifiedAnalysisTests(unittest.TestCase):
    def _provider(self):
        return {
            "generate": lambda query: {"raw_answer": "Timeweb Cloud предлагает серверы на Intel.", "sources": [{"url": "https://example.com", "title": "Источник"}]},
            "configured": lambda: True,
            "model": lambda: "Test model",
            "cache_identity": lambda: "test-model",
        }

    def _analysis(self):
        return {
            "mentioned": False,
            "position": None,
            "weighted_position": None,
            "role": "не упомянут",
            "reasoning": "Целевой бренд не предложен.",
            "quotes": [],
            "competitors": ["Timeweb Cloud"],
            "mentioned_brands": ["Timeweb Cloud"],
            "ordered_mentions": [{"name": "Timeweb Cloud", "position": 1, "role": "рекомендация", "canonical_id": "timewebcloud", "canonical_name": "Timeweb Cloud"}],
            "source_analysis": [],
            "sources_count": 0,
            "total_sources": 0,
            "canonical_id": "selectel",
            "canonical_name": "Selectel",
            "observed_name": None,
            "analysis_provider": "perplexity",
            "analysis_version": "perplexity-direct-v1",
        }

    def test_run_check_uses_perplexity_for_provider_answer(self):
        request = main.CheckRequest(brand="Selectel", query="Где арендовать сервер?", provider="yandex", force_refresh=True, canonical_id="selectel", canonical_name="Selectel")
        with patch.dict(main.PROVIDERS, {"yandex": self._provider()}), patch.object(main, "is_perplexity_configured", return_value=True), patch.object(main, "analyze_with_perplexity", return_value=self._analysis()) as analyze:
            result = main._run_check(request, use_result_cache=False)
        self.assertEqual(result["competitors"], ["Timeweb Cloud"])
        self.assertEqual(result["analysis_provider"], "perplexity")
        self.assertEqual(analyze.call_args.args[2], "Timeweb Cloud предлагает серверы на Intel.")

    def test_analysis_failure_returns_no_metrics(self):
        request = main.CheckRequest(brand="Selectel", query="Где арендовать сервер?", provider="yandex", force_refresh=True)
        with patch.dict(main.PROVIDERS, {"yandex": self._provider()}), patch.object(main, "is_perplexity_configured", return_value=True), patch.object(main, "analyze_with_perplexity", side_effect=RuntimeError("invalid")):
            result = main._run_check(request, use_result_cache=False)
        self.assertEqual(result.status_code, 502)
        payload = json.loads(result.body)
        self.assertTrue(payload["analysis_error"])
        self.assertNotIn("competitors", payload)

    def test_brand_citation_requires_cited_official_domain_url(self):
        result = {
            "sources": [
                {"url": "https://shop.brand.test/product", "title": "Официальный сайт", "cited_in_answer": True},
                {"url": "https://brand.test/search-only", "title": "Поисковый материал", "cited_in_answer": False},
                {"url": "https://example.test/?next=https://brand.test", "title": "Brand", "cited_in_answer": True},
                {"url": "https://brand.test.evil.test/page", "title": "Brand", "cited_in_answer": True},
            ]
        }
        main._apply_brand_citations(result, ["https://www.brand.test/about"])
        self.assertTrue(result["brand_cited"])
        self.assertEqual(result["brand_citation_urls"], ["https://shop.brand.test/product"])
        self.assertEqual([source["is_brand_source"] for source in result["sources"]], [True, True, False, False])

    def test_brand_name_or_title_without_official_domain_does_not_count(self):
        result = {"sources": [{"url": "https://brand-review.test/Brand", "title": "Brand", "cited_in_answer": True}]}
        main._apply_brand_citations(result, ["brand.test"])
        self.assertFalse(result["brand_cited"])
        self.assertEqual(result["brand_citation_urls"], [])

    def test_run_check_persists_brand_citation_fields(self):
        provider = self._provider()
        provider["generate"] = lambda query: {
            "raw_answer": "Ответ со ссылкой.",
            "sources": [
                {"url": "https://brand.test/page", "title": "Официальный сайт", "cited_in_answer": True},
                {"url": "https://other.test/Brand", "title": "Brand", "cited_in_answer": True},
            ],
        }
        request = main.CheckRequest(brand="Brand", query="Где выбрать?", provider="yandex", force_refresh=True, domains=["brand.test"])
        with patch.dict(main.PROVIDERS, {"yandex": provider}), patch.object(main, "is_perplexity_configured", return_value=True), patch.object(main, "analyze_with_perplexity", return_value=self._analysis()):
            result = main._run_check(request, use_result_cache=False)
        self.assertTrue(result["brand_cited"])
        self.assertEqual(result["brand_citation_urls"], ["https://brand.test/page"])
        self.assertEqual([source["is_brand_source"] for source in result["sources"]], [True, False])

    def test_aggregate_keeps_provider_citation_provenance(self):
        results = [
            {"provider": "openai", "model": "A", "sources": [{"url": "https://brand.test", "cited_in_answer": True, "is_brand_source": True}], "brand_cited": True, "brand_citation_urls": ["https://brand.test"]},
            {"provider": "gemini", "model": "B", "sources": [{"url": "https://brand.test", "cited_in_answer": False, "is_brand_source": True}], "brand_cited": False, "brand_citation_urls": []},
        ]
        aggregate = main._aggregate_results(results, [], ("openai", "gemini"))
        self.assertTrue(aggregate["brand_cited"])
        self.assertEqual(aggregate["brand_citation_urls"], ["https://brand.test"])
        self.assertTrue(aggregate["sources"][0]["cited_in_answer"])
        self.assertEqual([item["brand_cited"] for item in aggregate["provider_results"]], [True, False])
        self.assertEqual(aggregate["requested_providers"], ["openai", "gemini"])

    def test_check_all_request_rejects_empty_or_unknown_provider_sets(self):
        with self.assertRaises(ValueError):
            main.CheckAllRequest(brand="Brand", query="Query", providers=[])
        with self.assertRaises(ValueError):
            main.CheckAllRequest(brand="Brand", query="Query", providers=["unknown"])


if __name__ == "__main__":
    unittest.main()
