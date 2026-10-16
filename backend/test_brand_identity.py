import unittest
import sys
from copy import deepcopy
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from brand_identity import canonicalize_analysis


class CanonicalBrandTests(unittest.TestCase):
    def test_company_options_only_merge_confirmed_products_for_new_results(self):
        names = ["Т-Банк", "Альфа-Банк", "Точка Банк", "ВТБ", "СберБанк", "СберБизнес"]
        raw = "\n".join(f"{index}. {name} — подходит для переводов." for index, name in enumerate(names, 1))
        analysis = {"ordered_mentions": [{"name": name, "role": "рекомендация", "evidence": f"{name} — подходит для переводов."} for name in names], "role": "не упомянут"}
        original = deepcopy(analysis)
        legacy = canonicalize_analysis(analysis, raw, "Другой банк", strict_direct_options=True)
        result = canonicalize_analysis(analysis, raw, "Другой банк", strict_direct_options=True, normalize_companies=True)
        self.assertEqual(analysis, original)
        self.assertEqual(len(legacy["ordered_mentions"]), 6)
        self.assertNotIn("identity_normalization_version", legacy)
        self.assertEqual(len(result["ordered_mentions"]), 5)
        self.assertEqual(result["ordered_mentions"][-1]["observed_names"], ["СберБанк", "СберБизнес"])
        self.assertEqual(len(result["ordered_mentions"][-1]["evidence_spans"]), 2)
        self.assertEqual([item["position"] for item in result["ordered_mentions"]], [1, 2, 3, 4, 5])
        self.assertTrue(all(item["identity_normalization_version"] == "company-options-v1" for item in result["ordered_mentions"]))

    def test_common_prefix_does_not_merge_independent_brands(self):
        names = ["СберМаркет", "СберМегаМаркет", "Яндекс", "Яндекс Банк"]
        analysis = {"ordered_mentions": [{"name": name} for name in names]}
        result = canonicalize_analysis(analysis, ", ".join(names), "Другой бренд", strict_direct_options=True, normalize_companies=True)
        self.assertEqual(result["competitors"], names)

    def test_confirmed_product_is_target_company_only_when_direct_option(self):
        result = canonicalize_analysis({"ordered_mentions": [{"name": "СберБизнес", "evidence": "СберБизнес подходит."}]}, "СберБизнес подходит.", "СберБанк", "target", strict_direct_options=True, normalize_companies=True)
        self.assertTrue(result["mentioned"])
        self.assertEqual(result["ordered_mentions"][0]["canonical_id"], "target")
        incidental = canonicalize_analysis({"ordered_mentions": []}, "Партнёр — СберБизнес.", "СберБанк", "target", strict_direct_options=True, normalize_companies=True)
        self.assertFalse(incidental["mentioned"])

    def test_normalization_returns_a_separate_object(self):
        analysis = {"mentioned": True, "competitors": ["Не было"], "ordered_mentions": [{"name": "Не было"}]}
        original = deepcopy(analysis)
        result = canonicalize_analysis(analysis, "Нет названий.", "Цель", strict_direct_options=True)
        self.assertIsNot(result, analysis)
        self.assertEqual(analysis, original)
        self.assertNotEqual(result["mentioned"], analysis["mentioned"])

    def test_company_text_variants_keep_a_stable_frontend_key(self):
        names = ["Ёлка", "Елка"]
        result = canonicalize_analysis({"ordered_mentions": [{"name": name} for name in names]}, ", ".join(names), "Другой бренд", strict_direct_options=True, normalize_companies=True)
        self.assertEqual(len(result["ordered_mentions"]), 1)
        self.assertEqual(result["ordered_mentions"][0]["canonical_id"], "auto:елка")
        self.assertEqual(result["ordered_mentions"][0]["observed_names"], names)

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

    def test_numeric_and_hallucinated_competitors_are_removed(self):
        result = canonicalize_analysis(
            {
                "ordered_mentions": [
                    {"name": "1", "position": 1, "role": "упоминание в списке"},
                    {"name": "Nike", "position": 2, "role": "рекомендация"},
                    {"name": "Adidas", "position": 3, "role": "сравнение"},
                ],
                "role": "не упомянут",
            },
            "В ответе рекомендован Nike.",
            "Demix",
        )
        self.assertEqual(result["mentioned_brands"], ["Nike"])
        self.assertEqual(result["ordered_mentions"][0]["position"], 1)

    def test_alphanumeric_brand_is_retained(self):
        result = canonicalize_analysis(
            {"ordered_mentions": [{"name": "3M", "position": 1, "role": "рекомендация"}], "role": "не упомянут"},
            "Для этой задачи подходит 3M.",
            "Другой бренд",
        )
        self.assertEqual(result["mentioned_brands"], ["3M"])


if __name__ == "__main__":
    unittest.main()
