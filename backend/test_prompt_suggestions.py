import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from prompt_suggestions import curated_prompts, excluded_topics, normalize_suggested_prompts, parse_prompt_payload


class PromptSuggestionTests(unittest.TestCase):
    def test_parses_prompt_payload_from_markdown_and_leading_text(self):
        expected = {"prompts": ["Какой бренд кроссовок лучше?"]}
        self.assertEqual(parse_prompt_payload('```JSON\n{"prompts":["Какой бренд кроссовок лучше?"]}\n```'), expected)
        self.assertEqual(parse_prompt_payload('Результат:\n{"prompts":["Какой бренд кроссовок лучше?"]}\nГотово.'), expected)

    def test_rejects_payload_without_prompt_array(self):
        with self.assertRaisesRegex(ValueError, "JSON с промптами"):
            parse_prompt_payload('{"result": "empty"}')

    def test_removes_brand_comparisons_and_store_queries(self):
        values = [
            "Какой бренд недорогих кроссовок подходит для ежедневной ходьбы?",
            "Сравни Demix, Adidas и New Balance",
            "Где купить недорогую спортивную обувь?",
            "Лучшие бренды доступной спортивной одежды",
            "Купить спортивные штаны для мужчин",
        ]
        self.assertEqual(normalize_suggested_prompts(values, "Demix"), [values[0]])

    def test_deduplicates_and_accepts_natural_category_queries(self):
        values = [
            "Какой бренд бюджетных кроссовок выбрать?",
            "Какой бренд бюджетных кроссовок выбрать?",
            "Какая спортивная одежда подходит для домашних тренировок?",
        ]
        self.assertEqual(normalize_suggested_prompts(values, "Demix"), [values[0]])

    def test_can_keep_larger_candidate_pool_for_review(self):
        values = [f"Какой бренд кроссовок подойдёт для сценария номер {index}?" for index in range(16)]
        self.assertEqual(len(normalize_suggested_prompts(values, "Demix", limit=16)), 16)

    def test_applies_confirmed_demix_topic_exclusions(self):
        values = [
            "Как выбрать качественные спортивные штаны?",
            "Что лучше для йоги: леггинсы или свободные брюки?",
            "Как подобрать удобную спортивную сумку для поездок?",
            "Какой бренд кроссовок подходит для бега по пересечённой местности?",
        ]
        self.assertEqual(normalize_suggested_prompts(values, "Demix"), [values[3]])
        self.assertEqual(len(excluded_topics("Demix")), 4)

    def test_requires_explicit_brand_discovery_intent(self):
        values = [
            "Как правильно выбрать кроссовки для бега?",
            "На что обратить внимание при выборе футбольных бутс?",
            "Какой бренд кроссовок лучше выбрать для бега?",
            "Бутсы какого производителя подойдут для искусственного газона?",
        ]
        self.assertEqual(normalize_suggested_prompts(values, "Demix"), values[2:])
        self.assertEqual(normalize_suggested_prompts(values[:1], "Demix", require_brand_intent=False), values[:1])

    def test_can_accept_natural_recommendation_without_word_brand(self):
        values = [
            "Какой банк лучше выбрать для ежедневных платежей?",
            "Где оформить дебетовую карту с выгодным кэшбэком?",
            "Какие сервисы подходят для управления финансами малого бизнеса?",
        ]
        self.assertEqual(normalize_suggested_prompts(values, "Т-Банк", limit=3, require_brand_intent=False), values)

    def test_limits_final_suggestions_to_three(self):
        values = [f"Какой бренд кроссовок выбрать для сценария {index}?" for index in range(5)]
        self.assertEqual(normalize_suggested_prompts(values, "Demix", limit=3), values[:3])

    def test_demix_has_three_curated_fallback_prompts(self):
        prompts = curated_prompts("Demix")
        self.assertEqual(len(prompts), 3)
        self.assertEqual(normalize_suggested_prompts(prompts, "Demix", limit=3), prompts)


if __name__ == "__main__":
    unittest.main()
