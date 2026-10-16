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

    def test_clarifies_user_bank_example_without_inserting_companies(self):
        query = "Какой банк выбрать для повседневных переводов и удобного управления деньгами через приложение?"
        prompts = normalize_suggested_prompts([query], "СберБанк", require_brand_intent=False, clarify_recommendations=True)
        self.assertEqual(prompts, [query + " Назови 3–5 конкретных вариантов и кратко объясни, чем подходит каждый."])
        self.assertEqual(query, "Какой банк выбрать для повседневных переводов и удобного управления деньгами через приложение?")

    def test_recommendation_mode_rejects_how_to_and_preset_named_choices(self):
        values = [
            "Как правильно выбрать банк для повседневных платежей?",
            "На что обратить внимание при выборе банка?",
            "Что лучше: Сбербанк, ВТБ и Альфа-Банк для переводов?",
            "Какой банк выбрать между Т-Банк и Альфа-Банк?",
            "Какой банк выбрать для ежедневных платежей?",
        ]
        prompts = normalize_suggested_prompts(values, "Газпромбанк", require_brand_intent=False, clarify_recommendations=True)
        self.assertEqual(len(prompts), 1)
        self.assertTrue(prompts[0].startswith(values[-1]))

    def test_recommendation_mode_excludes_alias_and_domain_variants(self):
        values = [
            "Какие услуги тбанк подходят для ежедневных платежей?",
            "Какие карты Тинькофф подходят для ежедневных платежей?",
            "Какие услуги tbank.ru подходят для ежедневных платежей?",
            "Какие сервисы подходят для международных платежей?",
        ]
        prompts = normalize_suggested_prompts(values, "Т-Банк", require_brand_intent=False, clarify_recommendations=True, excluded_names=["Тинькофф", "https://www.tbank.ru/"])
        self.assertEqual(len(prompts), 1)
        self.assertTrue(prompts[0].startswith(values[-1]))

    def test_recommendation_mode_preserves_categories_and_geography(self):
        values = [
            "Какие CRM и ERP подходят для небольшого производства?",
            "Какие банки работают в Москве и Санкт-Петербурге?",
            "Какие сервисы подходят для управления финансами малого бизнеса?",
            "Какие сервисы подходят для выхода на мировой рынок?",
        ]
        prompts = normalize_suggested_prompts(values, "Мир", limit=4, require_brand_intent=False, clarify_recommendations=True)
        self.assertEqual(len(prompts), 4)
        self.assertTrue(all(result.startswith(original) for result, original in zip(prompts, values)))

    def test_recommendation_mode_keeps_explicit_options_and_rationale_once(self):
        query = "Назови 3–5 банков для повседневных переводов и кратко объясни, чем подходит каждый."
        prompts = normalize_suggested_prompts([query, query], "Газпромбанк", require_brand_intent=False, clarify_recommendations=True)
        self.assertEqual(prompts, [query])

    def test_recommendation_mode_is_opt_in_for_generated_suggestions(self):
        query = "Какой банк выбрать для повседневных переводов?"
        self.assertEqual(normalize_suggested_prompts([query], "Газпромбанк", require_brand_intent=False), [query])

    def test_recommendation_can_ask_why_each_option_suits_the_task(self):
        query = "Назови несколько банков для переводов и объясни, почему каждый подходит."
        self.assertEqual(normalize_suggested_prompts([query], "Газпромбанк", require_brand_intent=False, clarify_recommendations=True), [query])

    def test_recommendation_mode_rejects_single_named_comparison_or_seed(self):
        values = [
            "Какие банки лучше, чем ВТБ?",
            "Какие банки подходят, например ВТБ?",
            "Какие сервисы использовать вместо Acme?",
            "Какие банки подходят, например: «Альфа-Банк»?",
            "Какие сервисы подходят, такие как OpenAI?",
        ]
        self.assertEqual(normalize_suggested_prompts(values, "Газпромбанк", require_brand_intent=False, clarify_recommendations=True), [])

    def test_recommendation_mode_keeps_categories_after_comparison_or_example(self):
        values = [
            "Какие сервисы использовать вместо VPN?",
            "Какие решения подходят, например CRM?",
            "Какие инструменты лучше, чем API для этой задачи?",
            "Какие банки подходят для повседневных платежей в России?",
        ]
        prompts = normalize_suggested_prompts(values, "Газпромбанк", limit=4, require_brand_intent=False, clarify_recommendations=True)
        self.assertEqual(len(prompts), len(values))
        self.assertTrue(all(result.startswith(original) for result, original in zip(prompts, values)))

    def test_single_named_seed_filter_does_not_modify_manual_queries(self):
        query = "Какие банки лучше, чем ВТБ?"
        self.assertEqual(normalize_suggested_prompts([query], "Газпромбанк", require_brand_intent=False), [query])


if __name__ == "__main__":
    unittest.main()
