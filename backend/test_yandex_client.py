import unittest
from unittest.mock import patch

import yandex_client


class MockResponse:
    def __init__(self, data):
        self.data = data
        self.status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return self.data


class YandexAnalysisTests(unittest.TestCase):
    def test_structured_analysis_uses_yandex_without_web_search(self):
        data = {
            "status": "completed",
            "output_text": '{"mentioned":true,"position":2,"weighted_position":null,"role":"рекомендация","reasoning":"Бренд рекомендован вторым.","quotes":["Demix подходит для тренировок"],"mentioned_brands":["Nike","Demix"],"ordered_mentions":[{"name":"Nike","position":1,"role":"рекомендация"},{"name":"Demix","position":2,"role":"рекомендация"}],"source_analysis":[],"sources_count":0,"total_sources":0}',
            "output": [],
        }
        with patch.object(yandex_client, "_post_with_retry", return_value=MockResponse(data)) as mocked:
            result = yandex_client._analyze_answer(
                "Demix",
                "Какой бренд кроссовок выбрать?",
                "Nike популярен. Demix подходит для тренировок.",
            )

        payload = mocked.call_args.args[0]
        self.assertEqual(payload["tools"], [])
        self.assertEqual(payload["tool_choice"], "none")
        self.assertEqual(payload["text"]["format"]["type"], "json_schema")
        self.assertTrue(result["mentioned"])
        self.assertEqual(result["position"], 2)
        self.assertEqual(result["role"], "рекомендация")
        self.assertEqual([item["name"] for item in result["ordered_mentions"]], ["Nike", "Demix"])

    def test_rejects_web_search_during_structured_analysis(self):
        data = {
            "status": "completed",
            "output_text": "{}",
            "output": [{"type": "web_search_call", "status": "completed"}],
        }
        with patch.object(yandex_client, "_post_with_retry", return_value=MockResponse(data)):
            with self.assertRaisesRegex(ValueError, "веб-поиск"):
                yandex_client._analyze_answer("Demix", "запрос", "ответ")


if __name__ == "__main__":
    unittest.main()
