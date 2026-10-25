import copy
import unittest

from input_models import parse_saved_check, parse_task_create, parse_task_patch


class InputModelTests(unittest.TestCase):
    def test_retry_and_legacy_search_metadata_roundtrip(self):
        value = {"brand": "Example", "query": "Question", "analysis_method": "direct", "google_search_used": True, "provider_calls": [{"analysis_attempt": 2, "analysis_method": "direct", "validation_error": "evidence_not_found"}]}
        self.assertEqual(parse_saved_check(value), value)

    def check_payload(self):
        return {
            "brand": "Example", "query": "Which brand?", "provider": "deepseek",
            "position": 1.5, "weighted_position": 2.75, "mentioned": True,
            "analysis_version": "perplexity-direct-v1", "raw_answer": "Example answer",
            "ordered_mentions": [{"name": "Example", "position": 1, "role": "рекомендация", "observed_names": ["Example"], "evidence_spans": ["Example answer"], "identity_relation": "exact_name"}],
            "sources": [{"index": 1, "url": "https://example.test/", "title": "Example", "authority_score": 5, "brand_check_status": "found", "brand_check_basis": "page", "brand_matches": ["Example"], "cited_in_answer": True, "is_brand_source": False}],
            "source_analysis": [{"source_index": 1, "authority": 5, "mentions_brand": True, "sentiment": "нейтральный", "key_point": "Evidence"}],
            "provider_calls": [{"check_id": 42, "stage": "analysis", "endpoint": "https://example.test/", "requested_model": "test", "returned_model": None, "attempt": 1, "retry": 0, "started_at": "2026-10-22T00:00:00Z", "finished_at": "2026-10-22T00:00:01Z", "status": "completed", "http_status": 200, "usage": {"input_tokens": 10}, "response_id": "fixture"}],
        }

    def snapshot(self):
        return {"id": "42", "createdAt": 1000, "provider": "all", "providers": ["deepseek", "openai"], "providerResults": [{"provider": "deepseek", "model": "fixture", "mentioned": True, "position": 1.5, "positionKind": "weighted", "role": "рекомендация"}], "mentioned": True, "position": 1.5, "positionKind": "weighted", "role": "рекомендация", "competitors": [], "reasoning": "Evidence", "quotes": []}

    def task(self):
        return {"version": 2, "opportunityId": "x" * 2300, "brand_id": "5", "brand": "Example", "brandKey": "example", "query": "Which brand?", "provider": "all", "providers": ["deepseek", "openai"], "model": "fixture", "problemType": "brand_missing", "title": "Publish evidence", "workType": "content", "owner": "Editor", "deadline": "2026-11-01", "goal": "Improve presence", "action": "Update source", "verification": "Check again", "targetUrl": "https://example.test/", "notes": "", "status": "planned", "createdAt": 1000, "updatedAt": 1000, "baselineCheckId": "42", "baseline": self.snapshot(), "evidence": {"count": 1, "checkIds": ["42"], "competitors": [], "reasoning": "Evidence", "quotes": []}, "postCheck": None, "verdict": None}

    def test_import_flat_and_wrapped_preserve_every_field_without_defaults(self):
        payload = self.check_payload()
        for value in (payload, {"check": payload}):
            self.assertEqual(parse_saved_check(value), payload)
            self.assertIs(type(parse_saved_check(value)["provider_calls"][0]["usage"]["input_tokens"]), int)
        minimal = {"brand": "Example", "query": "Question"}
        self.assertEqual(parse_saved_check(minimal), minimal)

    def test_provider_results_errors_and_camel_case_legacy_fields(self):
        payload = {"brand": "Example", "query": "Question", "provider": "all", "requestedProviders": ["deepseek"], "rawAnswer": "Answer", "canonicalId": "old-brand", "provider_results": [self.check_payload()], "provider_errors": [{"provider": "openai", "error": "Unavailable", "raw_answer": "", "sources": [], "provider_calls": []}]}
        self.assertEqual(parse_saved_check(payload), payload)

    def test_create_current_and_minimal_legacy_payloads(self):
        full = self.task()
        self.assertEqual(parse_task_create(full), full)
        minimal = {"brand": "Example", "brandKey": "example", "status": "planned"}
        self.assertEqual(parse_task_create({"task": minimal}), minimal)

    def test_patch_preserves_only_supplied_fields(self):
        self.assertEqual(parse_task_patch({"task": {"status": "in_progress"}}), {"status": "in_progress"})
        self.assertEqual(parse_task_patch({"notes": "", "deadline": "", "targetUrl": ""}), {"notes": "", "deadline": "", "targetUrl": ""})
        existing = self.task()
        changes = parse_task_patch({"title": "Updated", "status": "ready_for_check"})
        merged = {**existing, **changes}
        for key in ("baseline", "evidence", "postCheck", "verdict"):
            self.assertEqual(merged[key], existing[key])

    def test_measurement_patch_keeps_fractional_positions(self):
        value = {"postCheck": self.snapshot(), "verdict": "improved", "comparison": {"verdict": "improved", "providers": ["deepseek"], "unavailable": ["openai"]}, "status": "measured"}
        self.assertEqual(parse_task_patch(value), value)

    def test_rejects_malformed_and_mixed_wrappers(self):
        for parser, key in ((parse_saved_check, "check"), (parse_task_create, "task"), (parse_task_patch, "task")):
            for value in (None, [], "text", {key: None}, {key: []}, {key: {}, "extra": True}, {key: {key: {}}}):
                with self.subTest(parser=parser.__name__, value=value):
                    with self.assertRaises(ValueError):
                        parser(value)

    def test_rejects_unknown_and_server_owned_fields(self):
        for key in ("unknown", "user_id", "id", "created_at", "updated_at", "quota_state", "quota_cycle"):
            for parser, payload in ((parse_saved_check, self.check_payload()), (parse_task_create, self.task()), (parse_task_patch, {})):
                with self.subTest(parser=parser.__name__, key=key):
                    with self.assertRaises(ValueError):
                        parser({**payload, key: 1})

    def test_rejects_unknown_nested_metadata_fields(self):
        for key, nested in (("provider_calls", [{"unknown": "value"}]), ("sources", [{"unknown": True}]), ("ordered_mentions", [{"name": "Example", "unknown": 1}]), ("provider_results", [{"unknown": "value"}])):
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    parse_saved_check({**self.check_payload(), key: nested})

    def test_rejects_wrong_types_without_coercion(self):
        for key, value in (("brand", 10), ("query", False), ("provider", None), ("mentioned", "false"), ("position", "1.2"), ("position", True), ("raw_answer", []), ("sources_count", "1"), ("competitors", "Example")):
            with self.subTest(key=key, value=value):
                with self.assertRaises(ValueError):
                    parse_saved_check({**self.check_payload(), key: value})
        for key, value in (("brand_id", True), ("title", 1), ("owner", None), ("createdAt", "1000"), ("evidence", []), ("status", 2)):
            with self.subTest(key=key, value=value):
                with self.assertRaises(ValueError):
                    parse_task_patch({key: value})

    def test_rejects_unsupported_enums(self):
        for parser, payload, key, value in ((parse_saved_check, self.check_payload(), "provider", "other"), (parse_saved_check, self.check_payload(), "role", "other"), (parse_task_create, self.task(), "workType", "other"), (parse_task_patch, {}, "status", "other"), (parse_task_patch, {}, "verdict", "other"), (parse_task_patch, {}, "problemType", "other")):
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    parser({**payload, key: value})

    def test_text_limits_match_forms_and_nonblank_required_text(self):
        for key, limit in (("title", 200), ("owner", 120), ("goal", 2000), ("action", 6000), ("verification", 2000), ("notes", 3000)):
            self.assertEqual(parse_task_patch({key: "x" * limit}), {key: "x" * limit})
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    parse_task_patch({key: "x" * (limit + 1)})
        for key in ("brand", "query"):
            with self.assertRaises(ValueError):
                parse_saved_check({**self.check_payload(), key: "   "})
        for key in ("title", "action"):
            with self.assertRaises(ValueError):
                parse_task_patch({key: "   "})

    def test_deadline_and_target_url_validation(self):
        for value in ("2026-02-30", "20261022", "2026-1-01"):
            with self.assertRaises(ValueError):
                parse_task_patch({"deadline": value})
        for value in ("ftp://example.test/", "javascript:example", "/relative", "https://", "https://example.test/ space"):
            with self.assertRaises(ValueError):
                parse_task_patch({"targetUrl": value})

    def test_nonfinite_numbers_rejected_everywhere(self):
        for value in (float("nan"), float("inf"), -float("inf")):
            for payload in ({"position": value}, {"metrics": {"score": value}}, {"provider_calls": [{"usage": {"input_tokens": value}}]}):
                with self.assertRaises(ValueError):
                    parse_saved_check({**self.check_payload(), **payload})

    def test_nesting_bound_and_no_input_mutation(self):
        payload = self.check_payload()
        original = copy.deepcopy(payload)
        parse_saved_check(payload)
        self.assertEqual(payload, original)
        accepted = {"provider": "deepseek"}
        for _ in range(3):
            accepted = {"provider_results": [accepted]}
        bounded = {**self.check_payload(), **accepted}
        self.assertEqual(parse_saved_check(bounded), bounded)
        nested = {"provider": "deepseek"}
        for _ in range(4):
            nested = {"provider_results": [nested]}
        with self.assertRaisesRegex(ValueError, "eight levels"):
            parse_saved_check({**self.check_payload(), **nested})

    def test_invalid_ids_and_nonpositive_positions_rejected(self):
        for value in (0, -1, "0", "abc", 1.5, True, 9223372036854775808, "9223372036854775808"):
            with self.assertRaises(ValueError):
                parse_task_patch({"baselineCheckId": value})
        for value in (0, -1):
            with self.assertRaises(ValueError):
                parse_saved_check({**self.check_payload(), "position": value})


if __name__ == "__main__":
    unittest.main()
