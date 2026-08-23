import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from prompt_suggestions import normalize_suggested_prompts


class PromptSuggestionTests(unittest.TestCase):
    def test_removes_brand_comparisons_and_store_queries(self):
        values = [
            "Какие недорогие кроссовки подходят для ежедневной ходьбы?",
            "Сравни Demix, Adidas и New Balance",
            "Где купить недорогую спортивную обувь?",
            "Лучшие бренды доступной спортивной одежды",
        ]
        self.assertEqual(normalize_suggested_prompts(values, "Demix"), [values[0], values[3]])

    def test_deduplicates_and_accepts_natural_category_queries(self):
        values = [
            "Какой бренд бюджетных кроссовок выбрать?",
            "Какой бренд бюджетных кроссовок выбрать?",
            "Какая спортивная одежда подходит для домашних тренировок?",
        ]
        self.assertEqual(len(normalize_suggested_prompts(values, "Demix")), 2)


if __name__ == "__main__":
    unittest.main()
