import unittest
from unittest.mock import Mock, patch

import httpx

import openai_client


def response_payload(output=None, output_text=None, status="completed"):
    payload = {"status": status, "output": output or []}
    if output_text is not None:
        payload["output_text"] = output_text
    return payload


def mocked_response(payload, status_code=200):
    request = httpx.Request("POST", openai_client.API_URL)
    response = httpx.Response(status_code, request=request, json=payload)
    return response


class OpenAIClientTests(unittest.TestCase):
    def test_web_search_answer_requires_tool_and_deduplicates_sources(self):
        payload = response_payload([
            {
                "type": "web_search_call",
                "status": "completed",
                "action": {"sources": [
                    {"url": "https://example.com/a", "title": "Источник A"},
                    {"url": "https://example.com/a", "title": "Дубликат"},
                ]},
            },
            {
                "type": "message",
                "content": [{
                    "type": "output_text",
                    "text": "Естественный ответ",
                    "annotations": [
                        {"type": "url_citation", "url": "https://example.com/a", "title": "Источник A"},
                        {"type": "url_citation", "url": "https://example.com/b", "title": "Источник B"},
                    ],
                }],
            },
        ])
        with patch.object(openai_client, "_post_with_retry", return_value=mocked_response(payload)) as post:
            answer, sources = openai_client._call_with_web_search("запрос")
        self.assertEqual(answer, "Естественный ответ")
        self.assertEqual([source["url"] for source in sources], ["https://example.com/a", "https://example.com/b"])
        sent = post.call_args.args[0]
        self.assertEqual(sent["tools"], [{"type": "web_search"}])
        self.assertEqual(sent["tool_choice"], "required")
        self.assertFalse(sent["store"])
        self.assertIn("российском рынке", sent["instructions"])
        self.assertIn("реально доступны российскому пользователю", sent["instructions"])
        self.assertNotIn("Vidno", sent["instructions"])

    def test_web_search_answer_rejects_missing_tool_call(self):
        payload = response_payload([{
            "type": "message",
            "content": [{"type": "output_text", "text": "Ответ", "annotations": [{"type": "url_citation", "url": "https://example.com", "title": "Источник"}]}],
        }])
        with patch.object(openai_client, "_post_with_retry", return_value=mocked_response(payload)):
            with self.assertRaisesRegex(ValueError, "обязательный Web Search"):
                openai_client._call_with_web_search("запрос")

    def test_web_search_answer_rejects_missing_sources(self):
        payload = response_payload([
            {"type": "web_search_call", "status": "completed"},
            {"type": "message", "content": [{"type": "output_text", "text": "Ответ", "annotations": []}]},
        ])
        with patch.object(openai_client, "_post_with_retry", return_value=mocked_response(payload)):
            with self.assertRaisesRegex(ValueError, "источники"):
                openai_client._call_with_web_search("запрос")

    def test_response_text_rejects_incomplete_and_empty_responses(self):
        with self.assertRaisesRegex(ValueError, "incomplete"):
            openai_client._response_text(response_payload(status="incomplete"))
        with self.assertRaisesRegex(ValueError, "пустой ответ"):
            openai_client._response_text(response_payload())

    def test_analysis_call_does_not_enable_web_search(self):
        analysis = {
            "mentioned": False,
            "position": None,
            "weighted_position": None,
            "role": "не упомянут",
            "reasoning": "Бренд не найден",
            "quotes": [],
            "mentioned_brands": [],
            "ordered_mentions": [],
            "source_analysis": [],
            "sources_count": 0,
            "total_sources": 0,
        }
        payload = response_payload(output_text=__import__("json").dumps(analysis, ensure_ascii=False))
        with patch.object(openai_client, "_post_with_retry", return_value=mocked_response(payload)) as post:
            result = openai_client._analyze_answer("Vidno", "запрос", "Ответ без бренда", "vidno", "Vidno", [], [])
        sent = post.call_args.args[0]
        self.assertNotIn("tools", sent)
        self.assertNotIn("tool_choice", sent)
        self.assertFalse(result["mentioned"])

    def test_check_brand_maps_auth_and_rate_limit_errors(self):
        for status, expected in ((401, "авторизации"), (403, "авторизации"), (429, "лимит")):
            with self.subTest(status=status), patch.object(openai_client, "API_KEY", "test-key"), patch.object(openai_client, "_call_with_web_search", side_effect=httpx.HTTPStatusError("error", request=httpx.Request("POST", openai_client.API_URL), response=mocked_response({}, status))):
                result = openai_client.check_brand("Vidno", "запрос")
                self.assertIn(expected, result["error"])

    def test_check_brand_maps_connection_error(self):
        with patch.object(openai_client, "API_KEY", "test-key"), patch.object(openai_client, "_call_with_web_search", side_effect=httpx.ConnectTimeout("timeout")):
            result = openai_client.check_brand("Vidno", "запрос")
        self.assertEqual(result["error"], "Ошибка подключения к ChatGPT")

    def test_retry_handles_temporary_status(self):
        temporary = mocked_response({}, 429)
        success = mocked_response(response_payload(output_text="ok"))
        with patch("openai_client.httpx.post", side_effect=[temporary, success]) as post, patch("openai_client.time.sleep"):
            result = openai_client._post_with_retry({"input": "test"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(post.call_count, 2)


if __name__ == "__main__":
    unittest.main()
