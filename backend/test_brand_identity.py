import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from brand_identity import canonicalize_analysis


class CanonicalBrandTests(unittest.TestCase):
    def test_safe_punctuation_variants_are_automatic(self):
        for observed in ("Т-банк", "Т-Банк", "Т банк"):
            with self.subTest(observed=observed):
                result = canonicalize_analysis(
                    {"ordered_mentions": [{"name": observed, "position": 1, "role": "рекомендация"}], "role": "рекомендация"},
                    f"Рекомендую {observed} для ежедневных платежей.",
                    "Т-Банк",
                    "tbank",
                    "Т-Банк",
                )
                self.assertTrue(result["mentioned"])
                self.assertEqual(result["position"], 1)
                self.assertEqual(result["ordered_mentions"][0]["canonical_name"], "Т-Банк")

    def test_domain_suffix_variant_is_automatic(self):
        result = canonicalize_analysis(
            {
                "ordered_mentions": [
                    {"name": "Туту", "position": 1, "role": "рекомендация"},
                    {"name": "Туту.ру", "position": 2, "role": "упоминание"},
                ],
                "role": "рекомендация",
            },
            "Туту и Туту.ру предлагают билеты.",
            "Туту",
            "tutu",
            "Туту",
        )
        self.assertTrue(result["mentioned"])
        self.assertEqual(len(result["ordered_mentions"]), 1)
        self.assertEqual(result["ordered_mentions"][0]["canonical_name"], "Туту")

    def test_historical_alias_is_canonicalized_and_deduplicated(self):
        analysis = {
            "ordered_mentions": [
                {"name": "Тинькофф", "position": 1, "role": "рекомендация"},
                {"name": "Т-Банк", "position": 2, "role": "упоминание"},
                {"name": "Сбер", "position": 3, "role": "сравнение"},
            ],
            "role": "рекомендация",
        }
        result = canonicalize_analysis(
            analysis,
            "Тинькофф, теперь Т-Банк, удобнее Сбера.",
            "Т-Банк",
            "tbank",
            "Т-Банк",
            ["Тинькофф", "Tinkoff"],
            ["tbank.ru"],
        )
        target_mentions = [item for item in result["ordered_mentions"] if item["canonical_id"] == "tbank"]
        self.assertTrue(result["mentioned"])
        self.assertEqual(result["position"], 1)
        self.assertEqual(len(target_mentions), 1)
        self.assertEqual(target_mentions[0]["observed_name"], "Тинькофф")

    def test_source_only_name_is_not_counted(self):
        result = canonicalize_analysis(
            {"ordered_mentions": [{"name": "Островок", "position": 1, "role": "упоминание"}], "role": "упоминание"},
            "В ответе перечислены только другие сервисы.",
            "Островок",
            "ostrovok",
            "Островок",
            ["Ostrovok.ru"],
            [],
        )
        self.assertFalse(result["mentioned"])
        self.assertEqual(result["ordered_mentions"], [])

    def test_confirmed_domain_alias_is_counted(self):
        result = canonicalize_analysis(
            {"ordered_mentions": [{"name": "https://www.ostrovok.ru", "position": 1, "role": "рекомендация"}], "role": "рекомендация"},
            "Для Москвы попробуйте https://www.ostrovok.ru.",
            "Островок",
            "ostrovok",
            "Островок",
            [],
            ["ostrovok.ru"],
        )
        self.assertTrue(result["mentioned"])
        self.assertEqual(result["canonical_name"], "Островок")
        self.assertEqual(result["ordered_mentions"][0]["canonical_id"], "ostrovok")


if __name__ == "__main__":
    unittest.main()
