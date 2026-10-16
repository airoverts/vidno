import json
import unittest

from answer_options import AnswerOptionError, OPTION_EXTRACTION_SCHEMA, build_option_messages, parse_answer_options
from brand_identity import find_observed_alias


def extracted(*items, **legacy):
    return json.dumps({**legacy, "ordered_mentions": list(items)}, ensure_ascii=False)


def option(name, evidence, role="рекомендация", **extra):
    return {"name": name, "role": role, "evidence": evidence, **extra}


class AnswerOptionExtractionTests(unittest.TestCase):
    def assert_code(self, code, text, answer):
        with self.assertRaises(AnswerOptionError) as caught:
            parse_answer_options(text, answer)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn(answer, str(caught.exception))

    def test_minimal_schema_has_no_model_computed_metrics(self):
        self.assertEqual(set(OPTION_EXTRACTION_SCHEMA["properties"]), {"ordered_mentions"})
        properties = OPTION_EXTRACTION_SCHEMA["properties"]["ordered_mentions"]["items"]["properties"]
        self.assertEqual(set(properties), {"name", "role", "evidence"})

    def test_messages_do_not_supply_target_brand_or_aliases(self):
        messages = build_option_messages("Какой банк выбрать?", "СберБанк подходит для переводов.")
        self.assertEqual(set(json.loads(messages[1]["content"])), {"query", "assistant_answer"})
        self.assertIn('"ordered_mentions":[]', messages[0]["content"])

    def test_plain_options_derive_positions_and_neutral_skeleton(self):
        answer = "Hostkey — серверы.\nSelectel — облако."
        result = parse_answer_options(extracted(option("Selectel", "Selectel — облако."), option("Hostkey", "Hostkey — серверы.")), answer)
        self.assertEqual([item["name"] for item in result["ordered_mentions"]], ["Hostkey", "Selectel"])
        self.assertEqual([item["position"] for item in result["ordered_mentions"]], [1, 2])
        self.assertFalse(result["mentioned"])
        self.assertIsNone(result["position"])
        self.assertEqual(result["role"], "не упомянут")
        self.assertEqual(result["competitors"], [])
        self.assertEqual(result["quotes"], [])
        self.assertEqual(result["source_analysis"], [])

    def test_legacy_computed_fields_are_ignored(self):
        answer = "Hostkey — серверы."
        text = extracted(option("Hostkey", answer, position=37), mentioned=True, position=99, competitors=["Invented"], mentioned_brands=["Invented"], sources_count=42, role="рекомендация")
        result = parse_answer_options(text, answer)
        self.assertFalse(result["mentioned"])
        self.assertIsNone(result["position"])
        self.assertEqual(result["ordered_mentions"][0]["position"], 1)
        self.assertEqual(result["sources_count"], 0)

    def test_markdown_bold_and_inline_code_map_to_original_evidence(self):
        answer = "1. **Hostkey** — серверы.\n2. `Selectel` — облако."
        result = parse_answer_options(extracted(option("Hostkey", "Hostkey — серверы."), option("Selectel", "Selectel — облако.")), answer)
        self.assertEqual([item["evidence"] for item in result["ordered_mentions"]], ["**Hostkey** — серверы.", "`Selectel` — облако."])
        for item in result["ordered_mentions"]:
            self.assertEqual(answer[item["evidence_start"]:item["evidence_end"]], item["evidence"])
            self.assertIn(item["name"], item["evidence"])
            self.assertTrue(find_observed_alias(answer, [item["name"]])[0])

    def test_nested_markdown_and_wrapped_text(self):
        answer = "**Hostkey** — аренда\n  серверов и _поддержка_."
        text = extracted(option("**Hostkey**", "Hostkey - аренда серверов и поддержка."))
        result = parse_answer_options(text, answer)
        item = result["ordered_mentions"][0]
        self.assertEqual(item["evidence"], answer)
        self.assertIn(item["name"], answer)

    def test_typographic_bank_dash_preserves_raw_name(self):
        answer = "Т‑Банк — удобное приложение."
        result = parse_answer_options(extracted(option("Т-Банк", "Т-Банк - удобное приложение.")), answer)
        self.assertEqual(result["ordered_mentions"][0]["name"], "Т‑Банк")
        self.assertEqual(result["ordered_mentions"][0]["evidence"], answer)

    def test_case_differences_map_to_original_spelling_without_rewriting_evidence(self):
        answer = "**СберБанк** — удобное приложение."
        result = parse_answer_options(extracted(option("сбербанк", "Сбербанк - удобное приложение.")), answer)
        item = result["ordered_mentions"][0]
        self.assertEqual(item["evidence"], answer)
        self.assertEqual(item["display_name"], "СберБанк")

    def test_internal_markdown_in_name_remains_discoverable(self):
        answer = "**Timeweb** Cloud — облачные серверы."
        result = parse_answer_options(extracted(option("Timeweb Cloud", "Timeweb Cloud — облачные серверы.")), answer)
        name = result["ordered_mentions"][0]["name"]
        self.assertIn(name, answer)
        self.assertTrue(find_observed_alias(answer, [name])[0])

    def test_nested_and_triple_emphasis(self):
        for formatted in ("***Hostkey***", "*_Hostkey_*", "**`Hostkey`**"):
            answer = f"{formatted} — серверы."
            result = parse_answer_options(extracted(option("Hostkey", "Hostkey - серверы.")), answer)
            self.assertEqual(result["ordered_mentions"][0]["evidence"], answer)

    def test_error_codes_are_bounded_and_do_not_echo_caller_data(self):
        error = AnswerOptionError("private caller value")
        self.assertEqual(error.code, "invalid_options")
        self.assertNotIn("private", str(error))

    def test_rejects_paraphrased_or_fabricated_evidence(self):
        answer = "Hostkey — аренда серверов."
        self.assert_code("evidence_not_found", extracted(option("Hostkey", "Hostkey — дешёвые серверы.")), answer)
        self.assert_code("evidence_not_found", extracted(option("Invented", "Invented — аренда серверов.")), answer)

    def test_rejects_partial_brand_even_when_evidence_is_only_name(self):
        answer = "SuperIntel — подходящий сервис."
        self.assert_code("name_not_in_evidence", extracted(option("Intel", answer)), answer)
        self.assert_code("evidence_not_found", extracted(option("Intel", "Intel")), answer)

    def test_rejects_partial_brand_split_by_markdown(self):
        answer = "Super**Intel** — подходящий сервис."
        self.assert_code("name_not_in_evidence", extracted(option("Intel", answer)), answer)

    def test_rejects_unsupported_incidental_and_source_roles(self):
        answer = "Hostkey упомянут как источник."
        for role in ("упоминание", "источник", "партнёр"):
            with self.subTest(role=role):
                self.assert_code("unsupported_role", extracted(option("Hostkey", answer, role=role)), answer)

    def test_valid_duplicates_deduplicate_after_evidence_validation(self):
        answer = "Hostkey — серверы.\nHostkey — круглосуточная поддержка."
        result = parse_answer_options(extracted(option("Hostkey", answer.splitlines()[1]), option("Hostkey", answer.splitlines()[0])), answer)
        self.assertEqual(len(result["ordered_mentions"]), 1)
        self.assertEqual(result["ordered_mentions"][0]["evidence"], answer.splitlines()[0])

    def test_invalid_duplicate_is_not_silently_dropped(self):
        answer = "Hostkey — серверы."
        self.assert_code("evidence_not_found", extracted(option("Hostkey", answer), option("Hostkey", "Hostkey — выдуманный вариант.")), answer)

    def test_order_uses_direct_evidence_not_earlier_incidental_name(self):
        answer = "Ранее Selectel упоминался как партнёр.\nHostkey — первый рекомендуемый вариант.\nSelectel — второй рекомендуемый вариант."
        result = parse_answer_options(extracted(option("Selectel", answer.splitlines()[2]), option("Hostkey", answer.splitlines()[1])), answer)
        self.assertEqual([item["name"] for item in result["ordered_mentions"]], ["Hostkey", "Selectel"])

    def test_options_in_shared_quote_use_name_order(self):
        answer = "Рекомендую Hostkey и Selectel."
        result = parse_answer_options(extracted(option("Selectel", answer), option("Hostkey", answer)), answer)
        self.assertEqual([item["name"] for item in result["ordered_mentions"]], ["Hostkey", "Selectel"])

    def test_no_options_is_valid(self):
        result = parse_answer_options(extracted(), "Для выбора оцените комиссии и поддержку.")
        self.assertEqual(result["ordered_mentions"], [])
        self.assertFalse(result["mentioned"])

    def test_rejects_malformed_json_and_list(self):
        self.assert_code("invalid_json", "not json", "raw answer")
        self.assert_code("invalid_options", '{"ordered_mentions":{}}', "raw answer")
        self.assert_code("invalid_option", '{"ordered_mentions":["Hostkey"]}', "raw answer")
        self.assert_code("evidence_missing", extracted({"name": "Hostkey", "role": "рекомендация"}), "raw answer")

    def test_company_products_remain_separate_for_parent_grouping(self):
        answer = "СберБанк — личные финансы.\nСберБизнес — счёт для бизнеса."
        result = parse_answer_options(extracted(option("СберБанк", answer.splitlines()[0]), option("СберБизнес", answer.splitlines()[1])), answer)
        self.assertEqual(len(result["ordered_mentions"]), 2)


if __name__ == "__main__":
    unittest.main()
