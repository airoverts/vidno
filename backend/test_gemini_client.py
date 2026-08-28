import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
from google.genai import errors

import gemini_client


def grounded_response(text="Ответ Gemini", queries=None, chunks=None):
    metadata = SimpleNamespace(
        web_search_queries=queries if queries is not None else ["поисковый запрос"],
        grounding_chunks=chunks if chunks is not None else [SimpleNamespace(web=SimpleNamespace(uri="https://example.com/a", title="Источник A"))],
    )
    return SimpleNamespace(text=text, candidates=[SimpleNamespace(grounding_metadata=metadata, finish_reason="STOP")])


class GeminiClientTests(unittest.TestCase):
    def test_grounded_answer_uses_google_search_and_deduplicates_sources(self):
        response = grounded_response(
            queries=["запрос", "запрос", "другой запрос"],
            chunks=[
                SimpleNamespace(web=SimpleNamespace(uri="https://example.com/a", title="Источник A")),
                SimpleNamespace(web=SimpleNamespace(uri="https://example.com/a", title="Дубликат")),
                SimpleNamespace(web=SimpleNamespace(uri="https://example.com/b", title="Источник B")),
            ],
        )
        client = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(return_value=response)))
        with patch.object(gemini_client, "_get_client", return_value=client):
            answer, sources, queries = gemini_client._call_with_google_search("запрос пользователя")
        self.assertEqual(answer, "Ответ Gemini")
        self.assertEqual(queries, ["запрос", "другой запрос"])
        self.assertEqual([source["url"] for source in sources], ["https://example.com/a", "https://example.com/b"])
        call = client.models.generate_content.call_args.kwargs
        self.assertEqual(call["contents"], "запрос пользователя")
        self.assertIsNotNone(call["config"].tools[0].google_search)

    def test_grounded_answer_rejects_missing_search_queries(self):
        client = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(return_value=grounded_response(queries=[]))))
        with patch.object(gemini_client, "_get_client", return_value=client):
            with self.assertRaisesRegex(ValueError, "обязательный Google Search"):
                gemini_client._call_with_google_search("запрос")

    def test_grounded_answer_rejects_missing_sources(self):
        client = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(return_value=grounded_response(chunks=[]))))
        with patch.object(gemini_client, "_get_client", return_value=client):
            with self.assertRaisesRegex(ValueError, "источники"):
                gemini_client._call_with_google_search("запрос")

    def test_response_text_reports_safety_or_empty_response(self):
        blocked = SimpleNamespace(text="", candidates=[SimpleNamespace(finish_reason="SAFETY")])
        with self.assertRaisesRegex(ValueError, "SAFETY"):
            gemini_client._response_text(blocked)
        with self.assertRaisesRegex(ValueError, "пустой ответ"):
            gemini_client._response_text(SimpleNamespace(text="", candidates=[]))

    def test_analysis_call_has_structured_output_without_search_tool(self):
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
        response = SimpleNamespace(text=json.dumps(analysis, ensure_ascii=False), candidates=[])
        client = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(return_value=response)))
        with patch.object(gemini_client, "_get_client", return_value=client):
            result = gemini_client._analyze_answer("Vidno", "запрос", "Ответ без бренда", "vidno", "Vidno", [], [])
        config = client.models.generate_content.call_args.kwargs["config"]
        self.assertIsInstance(client.models.generate_content.call_args.kwargs["contents"], str)
        self.assertIn("извлекаешь измеримые данные", config.system_instruction)
        self.assertFalse(config.tools)
        self.assertEqual(config.response_mime_type, "application/json")
        self.assertFalse(result["mentioned"])

    def test_analysis_retries_temporary_server_error_without_search_tool(self):
        analysis = {
            "mentioned": False, "position": None, "weighted_position": None, "role": "не упомянут",
            "reasoning": "Нет", "quotes": [], "mentioned_brands": [], "ordered_mentions": [],
            "source_analysis": [], "sources_count": 0, "total_sources": 0,
        }
        response = SimpleNamespace(text=json.dumps(analysis, ensure_ascii=False), candidates=[])
        client = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(side_effect=[errors.ServerError(503, {"error": {"message": "temporary"}}), response])))
        with patch.object(gemini_client, "_get_client", return_value=client), patch("gemini_client.time.sleep"):
            gemini_client._analyze_answer("Vidno", "запрос", "Ответ", "vidno", "Vidno", [], [])
        self.assertEqual(client.models.generate_content.call_count, 2)
        for call in client.models.generate_content.call_args_list:
            self.assertFalse(call.kwargs["config"].tools)

    def test_check_brand_maps_api_errors(self):
        for status, expected in ((401, "авторизации"), (403, "авторизации"), (429, "лимит"), (500, "500")):
            error = errors.ClientError(status, {"error": {"message": "test"}}) if status < 500 else errors.ServerError(status, {"error": {"message": "test"}})
            with self.subTest(status=status), patch.object(gemini_client, "API_KEY", "test-key"), patch.object(gemini_client, "_call_with_google_search", side_effect=error):
                result = gemini_client.check_brand("Vidno", "запрос")
                self.assertIn(expected, result["error"])

    def test_location_error_is_reported_clearly(self):
        error = errors.ClientError(400, {"error": {"message": "User location is not supported for the API use.", "status": "FAILED_PRECONDITION"}})
        with patch.object(gemini_client, "API_KEY", "test-key"), patch.object(gemini_client, "_call_with_google_search", side_effect=error):
            result = gemini_client.check_brand("Vidno", "запрос")
        self.assertEqual(result["error"], "Gemini недоступен из текущего региона сервера")

    def test_check_brand_maps_connection_error(self):
        with patch.object(gemini_client, "API_KEY", "test-key"), patch.object(gemini_client, "_call_with_google_search", side_effect=httpx.ConnectTimeout("timeout")):
            result = gemini_client.check_brand("Vidno", "запрос")
        self.assertEqual(result["error"], "Ошибка подключения к Gemini")


if __name__ == "__main__":
    unittest.main()
