import json
import unittest
from unittest.mock import patch

import httpx

with patch("dotenv.load_dotenv"), patch("os.getenv", side_effect=lambda key, default=None: default):
    import perplexity_client


def mocked_response(payload: dict, status: int = 200):
    return httpx.Response(status, json=payload, request=httpx.Request("POST", perplexity_client.API_URL))


def response_payload(answer: str = "Ответ Perplexity", with_search: bool = True, model: str = "perplexity/sonar"):
    output = []
    if with_search:
        output.append({
            "type": "web_search_call",
            "queries": ["актуальный запрос"],
            "results": [
                {"title": "Источник", "url": "https://example.com/source"},
                {"title": "Дубликат", "url": "https://example.com/source"},
            ],
        })
    output.append({
        "type": "message",
        "content": [{
            "type": "output_text",
            "text": answer,
            "annotations": [{"type": "url_citation", "title": "Ещё источник", "url": "https://example.org/page"}] if with_search else [],
        }],
    })
    return {"id": "resp-test", "model": model, "status": "completed", "output": output, "usage": {"input_tokens": 12, "output_tokens": 8, "secret": "do-not-copy"}}


def direct_response(analysis: str, raw_answer: str):
    parsed = json.loads(analysis)
    parsed.setdefault("competitors", [])
    for item in parsed["ordered_mentions"]:
        item["evidence"] = next(line for line in raw_answer.splitlines() if item["name"] in line)
    return response_payload(json.dumps(parsed, ensure_ascii=False), with_search=False)


class PerplexityClientTests(unittest.TestCase):
    def test_web_search_returns_answer_sources_and_queries(self):
        with patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(response_payload())) as post:
            answer, sources, queries = perplexity_client._call_with_web_search("запрос")
        self.assertEqual(answer, "Ответ Perplexity")
        self.assertEqual(queries, ["актуальный запрос"])
        self.assertEqual([source["url"] for source in sources], ["https://example.com/source", "https://example.org/page"])
        self.assertEqual([source["cited_in_answer"] for source in sources], [False, True])
        payload = post.call_args.args[0]
        self.assertEqual(payload["tools"], [{"type": "web_search"}])
        self.assertEqual(payload["model"], perplexity_client.MODEL_NAME)
        self.assertIn("MUST perform a web search", payload["instructions"])

    def test_web_search_is_required(self):
        with patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(response_payload(with_search=False))):
            with self.assertRaisesRegex(ValueError, "обязательный Web Search"):
                perplexity_client._call_with_web_search("запрос")

    def test_structured_analysis_does_not_enable_tools(self):
        analysis = """{"mentioned":false,"position":null,"weighted_position":null,"role":"не упомянут","reasoning":"Бренд отсутствует.","quotes":[],"mentioned_brands":[],"ordered_mentions":[],"source_analysis":[],"sources_count":0,"total_sources":0}"""
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(direct_response(analysis, "Ответ без бренда"))) as post:
            result = perplexity_client._analyze_answer("Vidno", "запрос", "Ответ без бренда", "vidno", "Vidno", [], [])
        self.assertFalse(result["mentioned"])
        payload = post.call_args.args[0]
        self.assertNotIn("tools", payload)
        self.assertEqual(payload["response_format"]["type"], "json_schema")

    def test_direct_competitor_analysis_excludes_hardware_brands(self):
        raw_answer = """1. Timeweb Cloud — аренда серверов; оборудование Supermicro, Intel, Gigabyte и ASRock.
2. Hostkey — выделенные серверы на AMD и Intel.
3. Рег.облако — выделенные серверы."""
        analysis = """{"mentioned":false,"position":null,"weighted_position":null,"role":"не упомянут","reasoning":"Целевой бренд не предложен.","quotes":[],"mentioned_brands":["Timeweb Cloud","Hostkey","Рег.облако"],"competitors":["Timeweb Cloud","Hostkey","Рег.облако"],"ordered_mentions":[{"name":"Timeweb Cloud","position":1,"role":"рекомендация"},{"name":"Hostkey","position":2,"role":"рекомендация"},{"name":"Рег.облако","position":3,"role":"рекомендация"}],"source_analysis":[],"sources_count":0,"total_sources":0}"""
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(direct_response(analysis, raw_answer))) as post:
            result = perplexity_client.analyze_answer("Selectel", "Где арендовать серверы?", raw_answer, "selectel", "Selectel", [], [])
        self.assertEqual(result["competitors"], ["Timeweb Cloud", "Hostkey", "Рег.облако"])
        self.assertEqual(result["mentioned_brands"], ["Timeweb Cloud", "Hostkey", "Рег.облако"])
        self.assertNotIn("Intel", result["competitors"])
        self.assertNotIn("tools", post.call_args.args[0])

    def test_direct_position_uses_only_answer_options(self):
        raw_answer = """Timeweb Cloud предлагает серверы на Intel.
Selectel подходит для высоконагруженных проектов.
Hostkey предлагает выделенные серверы на AMD."""
        analysis = """{"mentioned":true,"position":2,"weighted_position":null,"role":"рекомендация","reasoning":"Selectel предложен как самостоятельный вариант.","quotes":[],"mentioned_brands":["Timeweb Cloud","Hostkey"],"competitors":["Timeweb Cloud","Hostkey"],"ordered_mentions":[{"name":"Timeweb Cloud","position":1,"role":"рекомендация"},{"name":"Selectel","position":2,"role":"рекомендация"},{"name":"Hostkey","position":3,"role":"рекомендация"}],"source_analysis":[],"sources_count":0,"total_sources":0}"""
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(direct_response(analysis, raw_answer))):
            result = perplexity_client.analyze_answer("Selectel", "Где арендовать серверы?", raw_answer, "selectel", "Selectel", [], [])
        self.assertTrue(result["mentioned"])
        self.assertEqual(result["position"], 2)
        self.assertEqual(result["competitors"], ["Timeweb Cloud", "Hostkey"])

    def test_generates_structured_prompt_payload(self):
        data = response_payload('{"prompts":["Какой бренд выбрать?"]}', with_search=False)
        with patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(data)) as post:
            result = perplexity_client.generate_prompt_payload([{"role": "user", "content": "идеи"}])
        self.assertEqual(result["prompts"], ["Какой бренд выбрать?"])
        self.assertEqual(result["provider_calls"][0]["stage"], "suggestions")
        payload = post.call_args.args[0]
        self.assertNotIn("tools", payload)
        self.assertEqual(payload["response_format"]["json_schema"]["name"], "prompt_suggestions")

    def test_prompt_generation_can_require_web_search(self):
        data = response_payload('{"prompts":["Какой банк выбрать?"]}')
        with patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(data)) as post:
            result = perplexity_client.generate_prompt_payload([{"role": "user", "content": "идеи"}], require_web_search=True)
        self.assertEqual(result["prompts"], ["Какой банк выбрать?"])
        self.assertEqual(post.call_args.args[0]["tools"], [{"type": "web_search"}])

    def test_provider_errors_are_user_friendly(self):
        for status, expected in ((401, "авторизации"), (429, "лимит"), (500, "API Perplexity")):
            error = httpx.HTTPStatusError("error", request=httpx.Request("POST", perplexity_client.API_URL), response=mocked_response({}, status))
            with self.subTest(status=status), patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_call_with_web_search", side_effect=error):
                self.assertIn(expected, perplexity_client.check_brand("Vidno", "запрос")["error"])

    def test_connection_error_is_user_friendly(self):
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_call_with_web_search", side_effect=httpx.ConnectTimeout("timeout")):
            self.assertEqual(perplexity_client.check_brand("Vidno", "запрос")["error"], "Ошибка подключения к Perplexity")

    def test_temporary_error_is_retried(self):
        temporary = mocked_response({}, 503)
        success = mocked_response(response_payload())
        with patch("perplexity_client.httpx.post", side_effect=[temporary, success]) as post, patch("perplexity_client.time.sleep"):
            result = perplexity_client._post_with_retry({"input": "test"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(post.call_count, 2)

    def test_missing_and_wrong_model_rejected_for_all_stages(self):
        for stage in ("generation", "analysis", "suggestions"):
            for model in (None, "openai/gpt-5.6-luna", "sonar"):
                data = response_payload(model=model)
                if model is None:
                    data.pop("model")
                with self.subTest(stage=stage, model=model), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(data)):
                    with self.assertRaises(perplexity_client.PerplexityModelError) as caught:
                        perplexity_client._call_agent({"model": "perplexity/sonar", "input": "private query"}, stage, "preserved answer")
                error = caught.exception
                self.assertEqual(error.stage, stage)
                self.assertEqual(error.raw_answer, "Ответ Perplexity" if stage == "generation" else "preserved answer")
                self.assertEqual(error.provider_calls[0]["returned_model"], model)

    def test_wrong_config_fails_before_network(self):
        with patch.object(perplexity_client, "_post_with_retry") as post:
            with self.assertRaises(perplexity_client.PerplexityModelError):
                perplexity_client._call_agent({"model": "openai/gpt-5.6-luna"}, "analysis", "original")
        post.assert_not_called()

    def test_generation_metadata_is_whitelisted(self):
        data = response_payload(answer="private answer")
        data["secret"] = "private value"
        with patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(data)):
            result = perplexity_client.generate_answer("private query")
        metadata = result["provider_calls"][0]
        self.assertEqual(metadata["stage"], "generation")
        self.assertEqual(metadata["response_id"], "resp-test")
        self.assertEqual(metadata["usage"], {"input_tokens": 12, "output_tokens": 8})
        self.assertIn("started_at", metadata)
        self.assertNotIn("private", json.dumps(metadata))

    def test_retries_keep_model_and_include_attempt_metadata(self):
        with patch("perplexity_client.httpx.post", side_effect=[mocked_response({}, 503), mocked_response(response_payload())]) as post, patch("perplexity_client.time.sleep"):
            result = perplexity_client.generate_answer("query")
        self.assertEqual([call["retry"] for call in result["provider_calls"]], [0, 1])
        self.assertTrue(all(call.kwargs["json"]["model"] == "perplexity/sonar" for call in post.call_args_list))

    def test_network_failure_preserves_metadata(self):
        with patch("perplexity_client.httpx.post", side_effect=httpx.ConnectTimeout("private timeout")), patch("perplexity_client.time.sleep"):
            with self.assertRaises(httpx.RequestError) as caught:
                perplexity_client._call_agent({"model": "perplexity/sonar"}, "analysis", "answer")
        self.assertEqual(len(caught.exception.provider_calls), 3)
        self.assertEqual(caught.exception.raw_answer, "answer")
        self.assertNotIn("private timeout", json.dumps(caught.exception.provider_calls))

    def test_inconsistent_competitors_are_not_silently_repaired(self):
        raw_answer = "1. Hostkey — серверы.\n2. Selectel — серверы."
        analysis = {"mentioned": False, "position": None, "weighted_position": None, "role": "не упомянут", "reasoning": "Нет", "quotes": [], "mentioned_brands": ["Hostkey"], "competitors": ["Hostkey"], "ordered_mentions": [{"name": "Hostkey", "position": 1, "role": "рекомендация", "evidence": "1. Hostkey — серверы."}, {"name": "Selectel", "position": 2, "role": "рекомендация", "evidence": "2. Selectel — серверы."}], "source_analysis": [], "sources_count": 0, "total_sources": 0}
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(response_payload(json.dumps(analysis), with_search=False))) as post:
            with self.assertRaisesRegex(ValueError, "конкуренты") as caught:
                perplexity_client.analyze_answer("Vidno", "серверы", raw_answer)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(caught.exception.raw_answer, raw_answer)
        self.assertEqual(len(caught.exception.provider_calls), 2)

    def test_validated_company_products_merge_after_extraction(self):
        names = ["Т-Банк", "Альфа-Банк", "Точка Банк", "ВТБ", "СберБанк", "СберБизнес"]
        lines = [f"{index}. {name} — вариант для банковских операций." for index, name in enumerate(names, start=1)]
        raw_answer = "\n".join(lines)
        analysis = {"mentioned": False, "position": None, "weighted_position": None, "role": "не упомянут", "reasoning": "Целевой бренд отсутствует", "quotes": [], "mentioned_brands": names, "competitors": names, "ordered_mentions": [{"name": name, "position": index, "role": "рекомендация", "evidence": line} for index, (name, line) in enumerate(zip(names, lines), start=1)], "source_analysis": [], "sources_count": 0, "total_sources": 0}
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(response_payload(json.dumps(analysis), with_search=False))):
            result = perplexity_client.analyze_answer("Vidno", "Какой банк выбрать?", raw_answer)
        self.assertEqual(result["competitors"], names[:-1])
        self.assertEqual(result["ordered_mentions"][-1]["observed_names"], ["СберБанк", "СберБизнес"])
        self.assertEqual(result["ordered_mentions"][-1]["evidence_spans"], lines[-2:])
        self.assertEqual(result["identity_normalization_version"], "company-options-v1")

    def test_user_bank_answer_counts_final_recommendations_once(self):
        raw_answer = "Некоторые банки предлагают бесплатные переводы, например, Тинькофф Банк, Сбербанк и Газпромбанк.\nЕсли говорить о конкретных рекомендациях, такими банками являются Тинькофф Банк, Сбербанк и Газпромбанк. Они получили высокие оценки и популярны благодаря удобному функционалу."
        names = ["Тинькофф Банк", "Сбербанк", "Газпромбанк"]
        evidence = raw_answer.splitlines()[-1]
        analysis = {"mentioned": True, "position": 2, "weighted_position": None, "role": "рекомендация", "reasoning": "Банк рекомендован в итоговом совете", "quotes": [], "mentioned_brands": [names[0], names[2]], "competitors": [names[0], names[2]], "ordered_mentions": [{"name": name, "position": index, "role": "рекомендация", "evidence": evidence} for index, name in enumerate(names, start=1)], "source_analysis": [], "sources_count": 0, "total_sources": 0}
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(response_payload(json.dumps(analysis), with_search=False))):
            result = perplexity_client.analyze_answer("Сбербанк", "Какой банк выбрать для повседневных переводов и удобного управления деньгами через приложение?", raw_answer)
        self.assertTrue(result["mentioned"])
        self.assertEqual(result["position"], 2)
        self.assertEqual(len(result["ordered_mentions"]), 3)

    def test_provider_error_text_is_not_forwarded_to_logs(self):
        with self.assertRaisesRegex(ValueError, "не завершил") as caught:
            perplexity_client._response_text({"status": "failed", "error": {"message": "private full prompt"}})
        self.assertNotIn("private", str(caught.exception))

    def test_spelling_variants_do_not_fail_before_grouping(self):
        names = ["СберБанк", "Сбер Банк", "Т-Банк"]
        raw_answer = "\n".join(f"{name} — подходящий банк." for name in names)
        analysis = {"mentioned": True, "position": 3, "weighted_position": None, "role": "рекомендация", "reasoning": "Банк рекомендован", "quotes": [], "mentioned_brands": names[:2], "competitors": names[:2], "ordered_mentions": [{"name": name, "position": index, "role": "рекомендация", "evidence": f"{name} — подходящий банк."} for index, name in enumerate(names, start=1)], "source_analysis": [], "sources_count": 0, "total_sources": 0}
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(response_payload(json.dumps(analysis), with_search=False))):
            result = perplexity_client.analyze_answer("Т-Банк", "Какой банк выбрать?", raw_answer)
        self.assertEqual(result["competitors"], ["СберБанк"])
        self.assertEqual(result["position"], 2)


if __name__ == "__main__":
    unittest.main()
