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


if __name__ == "__main__":
    unittest.main()
