import unittest
from unittest.mock import patch

import httpx

import perplexity_client


def mocked_response(payload: dict, status: int = 200):
    return httpx.Response(status, json=payload, request=httpx.Request("POST", perplexity_client.API_URL))


def response_payload(answer: str = "Ответ Perplexity", with_search: bool = True):
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
    return {"status": "completed", "output": output}


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
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(response_payload(analysis, with_search=False))) as post:
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
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(response_payload(analysis, with_search=False))) as post:
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
        with patch.object(perplexity_client, "API_KEY", "test-key"), patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(response_payload(analysis, with_search=False))):
            result = perplexity_client.analyze_answer("Selectel", "Где арендовать серверы?", raw_answer, "selectel", "Selectel", [], [])
        self.assertTrue(result["mentioned"])
        self.assertEqual(result["position"], 2)
        self.assertEqual(result["competitors"], ["Timeweb Cloud", "Hostkey"])

    def test_generates_structured_prompt_payload(self):
        data = response_payload('{"prompts":["Какой бренд выбрать?"]}', with_search=False)
        with patch.object(perplexity_client, "_post_with_retry", return_value=mocked_response(data)) as post:
            result = perplexity_client.generate_prompt_payload([{"role": "user", "content": "идеи"}])
        self.assertEqual(result, {"prompts": ["Какой бренд выбрать?"]})
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


if __name__ == "__main__":
    unittest.main()
