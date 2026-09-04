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


if __name__ == "__main__":
    unittest.main()
