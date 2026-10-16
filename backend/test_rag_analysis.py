import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from rag_analysis import parse_analysis_response


def response(**overrides):
    value = {
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
    value.update(overrides)
    return json.dumps(value, ensure_ascii=False)


class AnalysisNormalizationTests(unittest.TestCase):
    def test_accepts_company_alias_and_supplies_role(self):
        result = parse_analysis_response(response(
            mentioned_brands=["New Balance", "Merrell"],
            ordered_mentions=[
                {"position": 1, "company": "New Balance"},
                {"position": 2, "company": "Merrell"},
            ],
        ), "Ответ ассистента")
        self.assertEqual([item["name"] for item in result["ordered_mentions"]], ["New Balance", "Merrell"])
        self.assertTrue(all(item["role"] == "упоминание в списке" for item in result["ordered_mentions"]))

    def test_removes_numeric_placeholders_and_numbering(self):
        result = parse_analysis_response(response(
            mentioned_brands=["1", "2. Nike", "3) Adidas", 4],
            ordered_mentions=["1", "2. Nike", "3) Adidas", "4"],
        ), "Ответ ассистента")
        self.assertEqual(result["mentioned_brands"], ["Nike", "Adidas"])
        self.assertEqual([item["name"] for item in result["ordered_mentions"]], ["Nike", "Adidas"])

    def test_uses_numbered_dictionary_values(self):
        result = parse_analysis_response(response(
            mentioned_brands={"1": "Nike", "2": "Adidas"},
        ), "Ответ ассистента")
        self.assertEqual(result["mentioned_brands"], ["Nike", "Adidas"])


class DirectOptionTests(unittest.TestCase):
    def direct(self, **overrides):
        return response(competitors=["Hostkey"], mentioned_brands=["Hostkey"], ordered_mentions=[{"name": "Hostkey", "position": 1, "role": "рекомендация", "evidence": "Hostkey — аренда серверов."}], **overrides)

    def test_preserves_literal_evidence(self):
        result = parse_analysis_response(self.direct(), "Hostkey — аренда серверов. В описании упомянут Intel.", strict_direct_options=True)
        self.assertEqual(result["ordered_mentions"][0]["evidence"], "Hostkey — аренда серверов.")
        self.assertEqual(result["competitors"], ["Hostkey"])

    def test_rejects_competitors_absent_from_explicit_options(self):
        value = json.loads(self.direct())
        value["ordered_mentions"] = []
        with self.assertRaisesRegex(ValueError, "не извлечён"):
            parse_analysis_response(json.dumps(value), "Hostkey — аренда серверов.", strict_direct_options=True)

    def test_rejects_missing_or_invented_evidence(self):
        for evidence in (None, "Hostkey — чужая цитата.", "аренда серверов."):
            value = json.loads(self.direct())
            value["ordered_mentions"][0]["evidence"] = evidence
            with self.subTest(evidence=evidence), self.assertRaisesRegex(ValueError, "фрагментом"):
                parse_analysis_response(json.dumps(value), "Hostkey — аренда серверов.", strict_direct_options=True)

    def test_rejects_duplicates_and_repeated_positions(self):
        value = json.loads(self.direct())
        value["ordered_mentions"].append(dict(value["ordered_mentions"][0]))
        with self.assertRaisesRegex(ValueError, "повторяющиеся"):
            parse_analysis_response(json.dumps(value), "Hostkey — аренда серверов.", strict_direct_options=True)
        value["ordered_mentions"][0]["position"] = 2
        value["ordered_mentions"].pop()
        with self.assertRaisesRegex(ValueError, "подряд"):
            parse_analysis_response(json.dumps(value), "Hostkey — аренда серверов.", strict_direct_options=True)

    def test_legacy_parser_still_supports_fallback(self):
        result = parse_analysis_response(response(mentioned_brands=["Hostkey"]), "Hostkey")
        self.assertEqual(result["ordered_mentions"][0]["name"], "Hostkey")

    def test_rejects_incidental_mention_role(self):
        value = json.loads(self.direct())
        value["ordered_mentions"][0]["role"] = "упоминание"
        with self.assertRaisesRegex(ValueError, "случайное упоминание"):
            parse_analysis_response(json.dumps(value), "Hostkey — аренда серверов.", strict_direct_options=True)

    def test_rejects_partial_names_inside_another_brand(self):
        for fragment in ("SuperHostkey — сервис.", "HostkeyCloud — сервис."):
            value = json.loads(self.direct())
            value["ordered_mentions"][0]["evidence"] = fragment
            with self.subTest(fragment=fragment), self.assertRaisesRegex(ValueError, "фрагментом"):
                parse_analysis_response(json.dumps(value), fragment, strict_direct_options=True)

    def test_competitor_names_must_match_observed_option_names_exactly(self):
        value = json.loads(self.direct())
        value["competitors"] = ["hostkey"]
        value["mentioned_brands"] = ["hostkey"]
        with self.assertRaisesRegex(ValueError, "не извлечён"):
            parse_analysis_response(json.dumps(value), "Hostkey — аренда серверов.", strict_direct_options=True)


if __name__ == "__main__":
    unittest.main()
