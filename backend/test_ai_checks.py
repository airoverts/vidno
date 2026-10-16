import json
import sys
import unittest
from contextlib import ExitStack
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent))

with patch("dotenv.load_dotenv"), patch("os.getenv", side_effect=lambda key, default=None: default):
    import main

from fastapi.testclient import TestClient
from perplexity_client import PerplexityModelError


class AiCheckApiTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(main.app.dependency_overrides.clear)
        self.addCleanup(main._check_times.clear)
        main.app.dependency_overrides[main._current_user] = lambda: {"id": 7}
        self.client = TestClient(main.app)
        self.records = {}
        self.generated = {}
        self.providers = {}
        for provider in ("gigachat", "yandex", "openai", "gemini", "perplexity"):
            generate = Mock(side_effect=lambda query, *args, name=provider: self.generated_answer(name, query))
            self.generated[provider] = generate
            self.providers[provider] = {"generate": generate, "configured": lambda: True, "model": lambda name=provider: f"model:{name}"}
        self.stack.enter_context(patch.object(main, "PROVIDERS", self.providers))
        self.start = self.stack.enter_context(patch.object(main, "start_check", side_effect=self.start_check))
        self.finish = self.stack.enter_context(patch.object(main, "finish_check", side_effect=self.finish_check))
        self.stack.enter_context(patch.object(main, "is_perplexity_configured", return_value=True))
        self.stack.enter_context(patch.object(main, "require_workspace_access", return_value={"status": "active"}))
        self.cache_get = self.stack.enter_context(patch.object(main, "get_result_cache", return_value=None))
        self.cache_set = self.stack.enter_context(patch.object(main, "set_result_cache"))
        self.stack.enter_context(patch.object(main, "get_search_cache", return_value=("local test context", [])))
        self.stack.enter_context(patch.object(main, "collect_and_format", side_effect=AssertionError("unexpected external search")))
        self.analyze = self.stack.enter_context(patch.object(main, "analyze_with_perplexity", side_effect=self.analyzed_answer))
        self.query = "Какой банк выбрать для повседневных переводов? Назови конкретные варианты и кратко объясни выбор."

    def start_check(self, user_id, brand, canonical_id, query, provider, aliases, domains):
        check_id = 41 + len(self.records)
        record = {"id": check_id, "brand_id": 9, "brand": "СберБанк", "canonical_id": "bank-owned-17", "query": query, "provider": provider, "status": "running", "created_at": "2026-10-16T10:00:00Z", "completed_at": None, "result": None, "error": None}
        self.records[check_id] = deepcopy(record)
        return deepcopy(record)

    def finish_check(self, user_id, check_id, status, result=None, error=None):
        record = self.records[check_id]
        record.update(status=status, result=deepcopy(result), error=deepcopy(error), completed_at="2026-10-16T10:00:01Z")
        return deepcopy(record)

    def metadata(self, provider, stage="generation"):
        return {"stage": stage, "requested_model": "perplexity/sonar", "returned_model": "perplexity/sonar", "endpoint": "https://api.perplexity.ai/v1/agent", "response_id": f"{provider}-{stage}", "attempt": 1, "retry": 0}

    def generated_answer(self, provider, query):
        return {"raw_answer": f"{provider}: Т-Банк и СберБанк подходят для переводов.", "sources": [], "provider_calls": [self.metadata(provider)]}

    def analyzed_answer(self, brand, query, raw_answer, canonical_id, canonical_name, aliases, domains):
        return {"mentioned": True, "position": 2, "weighted_position": None, "role": "рекомендация", "reasoning": "Банк предложен отдельным вариантом", "quotes": [], "mentioned_brands": ["Т-Банк"], "competitors": ["Т-Банк"], "ordered_mentions": [{"name": "Т-Банк", "canonical_name": "Т-Банк", "canonical_id": "auto:тбанк", "position": 1, "role": "рекомендация"}, {"name": canonical_name, "canonical_name": canonical_name, "canonical_id": canonical_id, "position": 2, "role": "рекомендация"}], "source_analysis": [], "sources_count": 0, "total_sources": 0, "canonical_id": canonical_id, "canonical_name": canonical_name, "analysis_provider": "perplexity", "analysis_version": "perplexity-direct-v1", "identity_normalization_version": "company-options-v1", "provider_calls": [self.metadata(raw_answer.split(":", 1)[0], "analysis")]}

    def post(self, route="/api/check", **overrides):
        payload = {"brand": "Сбербанк", "query": self.query}
        payload.update(overrides)
        return self.client.post(route, json=payload)

    def assert_tagged_calls(self, artifacts, check_id):
        self.assertTrue(artifacts)
        for artifact in artifacts:
            self.assertTrue(artifact["provider_calls"])
            self.assertTrue(all(call["check_id"] == check_id for call in artifact["provider_calls"]))

    def test_check_hydrates_saved_identity_when_request_omits_id(self):
        response = self.post(provider="openai")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.start.call_args.args[2], "")
        self.assertEqual(self.analyze.call_args.args[3:5], ("bank-owned-17", "СберБанк"))
        self.assertEqual(response.json()["canonical_id"], "bank-owned-17")
        self.assertEqual(self.records[41]["result"]["canonical_name"], "СберБанк")
        self.assertEqual(self.records[41]["status"], "completed")
        self.assert_tagged_calls([self.records[41]["result"]], 41)

    def test_check_all_uses_owned_identity_and_identical_common_query(self):
        response = self.post("/api/check-all", providers=["gigachat", "openai", "perplexity"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.analyze.call_count, 3)
        for provider in ("gigachat", "openai", "perplexity"):
            self.assertEqual(self.generated[provider].call_args.args[0], self.query)
        for call in self.analyze.call_args_list:
            self.assertEqual(call.args[1], self.query)
            self.assertEqual(call.args[3:5], ("bank-owned-17", "СберБанк"))
        saved = self.records[41]["result"]
        self.assertEqual(saved["canonical_id"], "bank-owned-17")
        self.assertEqual(saved["canonical_name"], "СберБанк")
        self.assert_tagged_calls(saved["provider_results"], 41)

    def test_generation_model_mismatch_saves_raw_answer_without_metrics(self):
        call = self.metadata("perplexity")
        call["returned_model"] = "openai/gpt-5.6-luna"
        self.generated["perplexity"].side_effect = PerplexityModelError("generation", "perplexity/sonar", call["returned_model"], [call], "original unexpected-model answer")
        response = self.post(provider="perplexity")
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["check_id"], 41)
        self.assertEqual(self.records[41]["status"], "failed")
        saved = self.records[41]["result"]
        self.assertNotIn("mentioned", saved)
        self.assertNotIn("position", saved)
        self.assertEqual(saved["provider_errors"][0]["raw_answer"], "original unexpected-model answer")
        self.assert_tagged_calls(saved["provider_errors"], 41)
        self.analyze.assert_not_called()
        self.cache_set.assert_not_called()

    def test_analysis_model_mismatch_saves_generation_and_analysis_calls(self):
        call = self.metadata("openai", "analysis")
        call["returned_model"] = None
        self.analyze.side_effect = PerplexityModelError("analysis", "perplexity/sonar", None, [call])
        response = self.post(provider="openai")
        self.assertEqual(response.status_code, 502)
        saved = self.records[41]["result"]
        artifact = saved["provider_errors"][0]
        self.assertEqual(artifact["raw_answer"], self.generated_answer("openai", self.query)["raw_answer"])
        self.assertEqual([item["stage"] for item in artifact["provider_calls"]], ["generation", "analysis"])
        self.assert_tagged_calls(saved["provider_errors"], 41)
        self.assertNotIn("mentioned", saved)
        self.cache_set.assert_not_called()

    def test_analysis_structure_failure_preserves_original_answer(self):
        failure = ValueError("invalid extracted options")
        failure.provider_calls = [self.metadata("gemini", "analysis")]
        self.analyze.side_effect = failure
        response = self.post(provider="gemini")
        self.assertEqual(response.status_code, 502)
        self.assertTrue(response.json()["analysis_error"])
        saved = self.records[41]["result"]
        self.assertEqual(saved["provider_errors"][0]["raw_answer"], self.generated_answer("gemini", self.query)["raw_answer"])
        self.assert_tagged_calls(saved["provider_errors"], 41)
        self.assertNotIn("position", saved)

    def test_all_check_analysis_failure_keeps_all_answers_without_success_metrics(self):
        def analyze(*args):
            if args[2].startswith("gemini:"):
                raise PerplexityModelError("analysis", "perplexity/sonar", "wrong-model", [self.metadata("gemini", "analysis")], args[2])
            return self.analyzed_answer(*args)

        self.analyze.side_effect = analyze
        response = self.post("/api/check-all", providers=["openai", "gemini", "perplexity"])
        self.assertEqual(response.status_code, 502)
        self.assertEqual(self.records[41]["status"], "failed")
        saved = self.records[41]["result"]
        artifacts = saved["provider_errors"]
        self.assertEqual({item["provider"] for item in artifacts}, {"openai", "gemini", "perplexity"})
        self.assertEqual({item["raw_answer"] for item in artifacts}, {self.generated_answer(provider, self.query)["raw_answer"] for provider in ("openai", "gemini", "perplexity")})
        self.assertNotIn("mentioned", saved)
        self.assertNotIn("provider_results", saved)
        self.assertTrue(all("mentioned" not in item and "position" not in item for item in artifacts))
        self.assert_tagged_calls(artifacts, 41)
        self.cache_set.assert_not_called()

    def test_partial_generation_failure_counts_successful_providers_only(self):
        self.generated["gemini"].side_effect = RuntimeError("unavailable")
        response = self.post("/api/check-all", providers=["openai", "gemini"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.records[41]["status"], "partial")
        saved = self.records[41]["result"]
        self.assertEqual([item["provider"] for item in saved["provider_results"]], ["openai"])
        self.assertEqual([item["provider"] for item in saved["provider_errors"]], ["gemini"])
        self.assertTrue(saved["mentioned"])
        self.assertEqual(saved["position"], 2)
        self.assertEqual(saved["requested_providers"], ["openai", "gemini"])
        self.assertEqual(self.analyze.call_count, 1)
        self.assert_tagged_calls(saved["provider_results"], 41)

    def test_new_cache_identity_excludes_legacy_results(self):
        legacy_identity = "model:openai|perplexity/sonar|perplexity-direct-v1|canonical-brands-v1:legacy"
        legacy = {"mentioned": False, "sources": [], "raw_answer": "legacy untouched"}
        cache = {legacy_identity: deepcopy(legacy)}
        self.cache_get.side_effect = lambda *args: deepcopy(cache.get(args[-1]))
        response = self.post(provider="openai")
        self.assertEqual(response.status_code, 200)
        current_identity = self.cache_get.call_args.args[-1]
        self.assertIn("company-options-v1", current_identity)
        self.assertIn("confirmed-sonar-v1", current_identity)
        self.assertNotEqual(current_identity, legacy_identity)
        self.generated["openai"].assert_called_once()
        self.assertEqual(cache[legacy_identity], legacy)
        self.assertEqual(self.cache_set.call_args.args[-1], current_identity)

    def test_prompt_suggestions_clarify_shared_queries_and_return_metadata(self):
        prompts = ["Какой банк выбрать для повседневных переводов?", "Где открыть вклад с удобным пополнением?", "Какие банки подходят для расчётного счёта бизнеса?"]
        metadata = [self.metadata("perplexity", "suggestions")]
        with patch.object(main, "generate_perplexity_prompt_payload", return_value={"prompts": prompts, "provider_calls": metadata}) as generate:
            response = self.client.post("/api/prompt-suggestions", json={"brand": "СберБанк", "aliases": ["СберБизнес"], "domains": ["sberbank.ru"], "existing_queries": [self.query]})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["provider_calls"], metadata)
        self.assertEqual(len(payload["prompts"]), 3)
        self.assertTrue(all("Назови 3–5 конкретных вариантов" in prompt and "кратко объясни" in prompt for prompt in payload["prompts"]))
        self.assertTrue(all("Сбер" not in prompt for prompt in payload["prompts"]))
        self.assertTrue(generate.call_args.kwargs["require_web_search"])
        research = json.loads(generate.call_args.args[0][1]["content"])
        self.assertEqual(research["other_company_names_to_exclude"], ["СберБизнес"])
        self.assertEqual(research["previous_user_queries"], [self.query])

    def test_prompt_suggestions_reject_aliases_without_forcing_brand(self):
        prompts = ["Какой сервис СберБизнес выбрать для бизнеса?", "Какой банк выбрать для переводов?", "Где открыть выгодный вклад?"]
        with patch.object(main, "generate_perplexity_prompt_payload", return_value={"prompts": prompts, "provider_calls": []}):
            response = self.client.post("/api/prompt-suggestions", json={"brand": "СберБанк", "aliases": ["СберБизнес"]})
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("prompts", response.json())


if __name__ == "__main__":
    unittest.main()
