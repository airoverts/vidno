import json
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from contextvars import copy_context
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
from fastapi.testclient import TestClient

import ai_request_logs as audit
import deepseek_client
import gemini_client
import gigachat_client
import main
import openai_client
import perplexity_client
import yandex_client


URL = "https://provider.example.test/generate"


def response(data=None, status=200, content=None):
    arguments = {"content": content} if content is not None else {"json": data or {}}
    return httpx.Response(status, request=httpx.Request("POST", URL), **arguments)


class TokenUsageTests(unittest.TestCase):
    def test_responses_usage_for_openai_yandex_and_perplexity(self):
        for provider in ("openai", "yandex", "perplexity"):
            with self.subTest(provider=provider):
                counts = audit.usage_counts(provider, {"usage": {"input_tokens": 31, "output_tokens": 11, "total_tokens": 42}})
                self.assertEqual((counts["input_tokens"], counts["output_tokens"], counts["total_tokens"]), (31, 11, 42))

    def test_completion_usage_for_gigachat_and_deepseek(self):
        for provider in ("gigachat", "deepseek"):
            with self.subTest(provider=provider):
                counts = audit.usage_counts(provider, {"usage": {"prompt_tokens": 19, "completion_tokens": 7, "total_tokens": 26}})
                self.assertEqual((counts["input_tokens"], counts["output_tokens"], counts["total_tokens"]), (19, 7, 26))

    def test_gemini_sdk_usage(self):
        data = SimpleNamespace(usage_metadata=SimpleNamespace(prompt_token_count=20, candidates_token_count=8, total_token_count=33, cached_content_token_count=4, thoughts_token_count=5))
        counts = audit.usage_counts("gemini", data)
        self.assertEqual(counts, {"input_tokens": 20, "output_tokens": 8, "total_tokens": 33, "cached_tokens": 4, "reasoning_tokens": 5})

    def test_nested_counts_are_not_added_to_total_twice(self):
        counts = audit.usage_counts("openai", {"usage": {"input_tokens": 20, "output_tokens": 10, "input_tokens_details": {"cached_tokens": 5}, "output_tokens_details": {"reasoning_tokens": 4}}})
        self.assertEqual(counts, {"input_tokens": 20, "output_tokens": 10, "total_tokens": 30, "cached_tokens": 5, "reasoning_tokens": 4})

    def test_explicit_zero_is_preserved(self):
        counts = audit.usage_counts("deepseek", {"usage": {"prompt_tokens": 0, "completion_tokens": 0}})
        self.assertEqual((counts["input_tokens"], counts["output_tokens"], counts["total_tokens"]), (0, 0, 0))

    def test_unknown_usage_is_not_zero(self):
        for data in ({}, {"usage": None}, {"usage": "invalid"}):
            with self.subTest(data=data):
                self.assertTrue(all(value is None for value in audit.usage_counts("openai", data).values()))

    def test_partial_usage_does_not_invent_total(self):
        counts = audit.usage_counts("openai", {"usage": {"input_tokens": 13}})
        self.assertEqual(counts["input_tokens"], 13)
        self.assertIsNone(counts["output_tokens"])
        self.assertIsNone(counts["total_tokens"])

    def test_invalid_and_out_of_range_counts_are_unknown(self):
        for value in (-1, True, False, "10", 1.5, float("inf"), 2 ** 63):
            with self.subTest(value=value):
                counts = audit.usage_counts("openai", {"usage": {"input_tokens": value, "output_tokens": value, "total_tokens": value}})
                self.assertIsNone(counts["input_tokens"])
                self.assertIsNone(counts["output_tokens"])
                self.assertIsNone(counts["total_tokens"])

    def test_computed_total_cannot_overflow_postgres_bigint(self):
        counts = audit.usage_counts("openai", {"usage": {"input_tokens": 2 ** 63 - 1, "output_tokens": 1}})
        self.assertIsNone(counts["total_tokens"])


class TransportLoggingTests(unittest.TestCase):
    def setUp(self):
        self.records = []
        self.writer = patch.object(audit, "insert_log", side_effect=lambda row: self.records.append(dict(row)))
        self.writer.start()

    def tearDown(self):
        self.writer.stop()

    def test_success_links_server_context_and_preserves_returned_model(self):
        data = {"model": "actual-model", "usage": {"input_tokens": 12, "output_tokens": 3}, "output_text": "private answer"}
        with patch.object(audit.httpx, "post", return_value=response(data)) as post:
            with audit.request_scope(17, "check", request_id="server-request"):
                audit.set_check_id(63)
                with audit.stage_scope("generation"):
                    result = audit.logged_http_post("openai", "requested-model", 1, URL, json={"input": "private prompt"}, headers={"Authorization": "Bearer private-key"})
        self.assertEqual(result.json(), data)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(len(self.records), 1)
        row = self.records[0]
        self.assertEqual((row["user_id"], row["request_id"], row["check_id"]), (17, "server-request", 63))
        self.assertEqual((row["provider"], row["operation"], row["stage"], row["attempt"]), ("openai", "check", "generation", 1))
        self.assertEqual((row["requested_model"], row["returned_model"]), ("requested-model", "actual-model"))
        self.assertEqual((row["input_tokens"], row["output_tokens"], row["total_tokens"]), (12, 3, 15))
        self.assertEqual((row["status"], row["http_status"]), ("success", 200))
        self.assertGreaterEqual(row["duration_ms"], 0)
        self.assertIsNotNone(row["started_at"])
        serialized = json.dumps(row, default=str)
        for forbidden in ("private prompt", "private answer", "private-key", "Authorization"):
            self.assertNotIn(forbidden, serialized)

    def test_missing_actual_model_is_unknown(self):
        with patch.object(audit.httpx, "post", return_value=response({"usage": {"input_tokens": 1}})):
            with audit.request_scope(17, "brief"):
                audit.logged_http_post("deepseek", "configured", 1, URL)
        self.assertIsNone(self.records[0]["returned_model"])

    def test_http_error_is_logged_before_caller_raises(self):
        with patch.object(audit.httpx, "post", return_value=response({"error": {"message": "private error"}}, 429)):
            with audit.request_scope(17, "brief"):
                result = audit.logged_http_post("deepseek", "configured", 2, URL)
        self.assertEqual(result.status_code, 429)
        self.assertEqual((self.records[0]["status"], self.records[0]["http_status"], self.records[0]["attempt"]), ("http_error", 429, 2))
        self.assertNotIn("private error", json.dumps(self.records, default=str))

    def test_timeout_is_logged_and_reraised_without_sensitive_message(self):
        error = httpx.ReadTimeout("private timeout details", request=httpx.Request("POST", URL))
        with patch.object(audit.httpx, "post", side_effect=error):
            with audit.request_scope(17, "check"):
                with self.assertRaises(httpx.ReadTimeout):
                    audit.logged_http_post("openai", "configured", 1, URL)
        self.assertEqual(self.records[0]["status"], "network_error")
        self.assertIsNone(self.records[0]["total_tokens"])
        self.assertNotIn("private timeout details", json.dumps(self.records, default=str))

    def test_usage_is_logged_even_if_caller_cannot_parse_answer(self):
        data = {"model": "actual", "usage": {"input_tokens": 5, "output_tokens": 7}, "output_text": "not valid json"}
        with patch.object(audit.httpx, "post", return_value=response(data)):
            with audit.request_scope(17, "brief"):
                result = audit.logged_http_post("openai", "configured", 1, URL)
                with self.assertRaises(ValueError):
                    json.loads(result.json()["output_text"])
        self.assertEqual(len(self.records), 1)
        self.assertEqual(self.records[0]["total_tokens"], 12)

    def test_invalid_response_json_does_not_break_transport(self):
        with patch.object(audit.httpx, "post", return_value=response(content=b"not json")):
            with audit.request_scope(17, "brief"):
                result = audit.logged_http_post("deepseek", "configured", 1, URL)
        self.assertEqual(result.content, b"not json")
        self.assertEqual(len(self.records), 1)
        self.assertIsNone(self.records[0]["total_tokens"])

    def test_write_failure_keeps_provider_response(self):
        with patch.object(audit, "insert_log", side_effect=RuntimeError("private database connection")):
            with patch.object(audit.httpx, "post", return_value=response({"model": "actual"})):
                with audit.request_scope(17, "brief"):
                    with self.assertLogs(audit.__name__, level="ERROR") as captured:
                        result = audit.logged_http_post("deepseek", "configured", 1, URL)
        self.assertEqual(result.status_code, 200)
        self.assertNotIn("private database connection", " ".join(captured.output))

    def test_no_authenticated_context_does_not_create_unowned_row(self):
        with patch.object(audit.httpx, "post", return_value=response({})):
            audit.logged_http_post("deepseek", "configured", 1, URL)
        self.assertEqual(self.records, [])

    def test_request_scope_resets_after_exception(self):
        with self.assertRaises(ValueError):
            with audit.request_scope(17, "brief"):
                raise ValueError("stop")
        with patch.object(audit.httpx, "post", return_value=response({})):
            audit.logged_http_post("deepseek", "configured", 1, URL)
        self.assertEqual(self.records, [])

    def test_parallel_requests_do_not_mix_users(self):
        barrier = threading.Barrier(2)

        def execute(user_id):
            with audit.request_scope(user_id, "check", request_id=f"request-{user_id}"):
                audit.set_check_id(user_id + 100)
                barrier.wait(timeout=5)
                with audit.stage_scope("analysis"):
                    audit.logged_http_post("perplexity", "configured", 1, URL)

        with patch.object(audit.httpx, "post", side_effect=lambda *args, **kwargs: response({})):
            with ThreadPoolExecutor(max_workers=2) as executor:
                list(executor.map(execute, (17, 18)))
        actual = {(row["user_id"], row["request_id"], row["check_id"], row["stage"]) for row in self.records}
        self.assertEqual(actual, {(17, "request-17", 117, "analysis"), (18, "request-18", 118, "analysis")})

    def test_copied_worker_context_retains_request_and_check(self):
        with patch.object(audit.httpx, "post", side_effect=lambda *args, **kwargs: response({})):
            with audit.request_scope(17, "check_all", request_id="combined-request"):
                audit.set_check_id(61)
                with ThreadPoolExecutor(max_workers=2) as executor:
                    futures = [executor.submit(copy_context().run, audit.logged_http_post, provider, "configured", 1, URL) for provider in ("openai", "deepseek")]
                    for future in futures:
                        future.result()
        self.assertEqual(len(self.records), 2)
        self.assertTrue(all((row["user_id"], row["request_id"], row["check_id"]) == (17, "combined-request", 61) for row in self.records))

    def test_gemini_sdk_logs_before_answer_processing(self):
        data = SimpleNamespace(model_version="gemini-actual", usage_metadata=SimpleNamespace(prompt_token_count=8, candidates_token_count=3, total_token_count=11))
        client = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(return_value=data)))
        with audit.request_scope(17, "check"):
            result = audit.logged_generate_content(client, "gemini-configured", contents="private prompt")
        self.assertIs(result, data)
        self.assertEqual((self.records[0]["returned_model"], self.records[0]["total_tokens"]), ("gemini-actual", 11))
        self.assertNotIn("private prompt", json.dumps(self.records, default=str))

    def test_gemini_network_retry_logs_each_attempt(self):
        data = SimpleNamespace(model_version="gemini-actual", usage_metadata=SimpleNamespace(prompt_token_count=8, candidates_token_count=3, total_token_count=11))
        client = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(side_effect=[httpx.ReadTimeout("private timeout"), data])))
        with patch.object(gemini_client, "_get_client", return_value=client), patch.object(gemini_client.time, "sleep"):
            with audit.request_scope(17, "check"):
                self.assertIs(gemini_client._generate_content(contents="private prompt"), data)
        self.assertEqual([row["attempt"] for row in self.records], [1, 2])
        self.assertEqual([row["status"] for row in self.records], ["network_error", "success"])
        self.assertEqual(self.records[1]["total_tokens"], 11)

    def test_provider_retries_create_separate_attempts(self):
        timeout = httpx.ReadTimeout("timeout", request=httpx.Request("POST", URL))
        with patch.object(audit.httpx, "post", side_effect=[timeout, response({}, 503), response({"usage": {"prompt_tokens": 4, "completion_tokens": 2}})]), patch.object(deepseek_client.time, "sleep"):
            with audit.request_scope(17, "brief", request_id="retry-request"):
                result = deepseek_client._post_with_retry({"model": "deepseek-test"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual([row["attempt"] for row in self.records], [1, 2, 3])
        self.assertEqual([row["status"] for row in self.records], ["network_error", "http_error", "success"])
        self.assertTrue(all(row["request_id"] == "retry-request" for row in self.records))
        self.assertEqual(self.records[-1]["total_tokens"], 6)

    def test_gigachat_auth_refresh_does_not_reset_physical_attempt_number(self):
        successful = {"model": "GigaChat-actual", "choices": [{"message": {"content": "answer"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 2, "completion_tokens": 1}}
        with ExitStack() as stack:
            stack.enter_context(patch.object(gigachat_client, "is_configured", return_value=True))
            stack.enter_context(patch.object(gigachat_client, "_get_access_token", return_value="fixture-token"))
            stack.enter_context(patch.object(gigachat_client, "_tls_verify", return_value=True))
            stack.enter_context(patch.object(gigachat_client.time, "sleep"))
            stack.enter_context(patch.object(audit.httpx, "post", side_effect=[response({}, 401), response({}, 503), response(successful)]))
            with audit.request_scope(17, "brief"):
                self.assertEqual(gigachat_client._call_gigachat([]), "answer")
        self.assertEqual([row["attempt"] for row in self.records], [1, 2, 3])
        self.assertEqual([row["http_status"] for row in self.records], [401, 503, 200])

    def test_openai_yandex_and_perplexity_retry_boundaries(self):
        for module, provider in ((openai_client, "openai"), (yandex_client, "yandex"), (perplexity_client, "perplexity")):
            self.records.clear()
            with self.subTest(provider=provider), ExitStack() as stack:
                stack.enter_context(patch.object(audit.httpx, "post", side_effect=[response({}, 503), response({"model": "actual", "usage": {"input_tokens": 5, "output_tokens": 2}})]))
                stack.enter_context(patch.object(module.time, "sleep"))
                with audit.request_scope(17, "check"):
                    module._post_with_retry({"model": "configured"})
                self.assertEqual([row["attempt"] for row in self.records], [1, 2])
                self.assertEqual([row["status"] for row in self.records], ["http_error", "success"])
                self.assertTrue(all(row["provider"] == provider for row in self.records))
                self.assertEqual(self.records[-1]["total_tokens"], 7)

    def test_perplexity_validation_retries_are_both_logged(self):
        def payload(text):
            return {"model": "perplexity/sonar", "status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}], "usage": {"input_tokens": 5, "output_tokens": 2}}

        answer = "1. Selectel — облачные серверы."
        valid = json.dumps({"ordered_mentions": [{"name": "Selectel", "role": "рекомендация", "evidence": answer}]})
        with patch.object(perplexity_client, "API_KEY", "fixture"), patch.object(audit.httpx, "post", side_effect=[response(payload("not json")), response(payload(valid))]):
            with audit.request_scope(17, "check", request_id="analysis-request"):
                audit.set_check_id(61)
                result = perplexity_client.analyze_answer("Selectel", "Где арендовать сервер?", answer)
        self.assertTrue(result["mentioned"])
        self.assertEqual(len(self.records), 2)
        self.assertTrue(all((row["stage"], row["request_id"], row["check_id"], row["total_tokens"]) == ("analysis", "analysis-request", 61, 7) for row in self.records))

    def test_gemini_retries_are_visible_without_sdk_hidden_attempts(self):
        data = SimpleNamespace(model_version="gemini-actual", usage_metadata=SimpleNamespace(prompt_token_count=8, candidates_token_count=3, total_token_count=11))
        error = gemini_client.errors.ServerError(503, {"error": {"message": "private provider error", "status": "UNAVAILABLE"}})
        client = SimpleNamespace(models=SimpleNamespace(generate_content=Mock(side_effect=[error, data])))
        with patch.object(gemini_client, "_get_client", return_value=client), patch.object(gemini_client.time, "sleep"):
            with audit.request_scope(17, "check"):
                result = gemini_client._generate_content(contents="private prompt")
        self.assertIs(result, data)
        self.assertEqual([row["attempt"] for row in self.records], [1, 2])
        self.assertEqual([row["http_status"] for row in self.records], [503, 200])
        self.assertEqual([row["status"] for row in self.records], ["http_error", "success"])
        self.assertNotIn("private provider error", json.dumps(self.records, default=str))


class RequestIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(main.app.dependency_overrides.clear)
        self.addCleanup(main._check_times.clear)
        main.app.dependency_overrides[main._current_user] = lambda: {"id": 17, "role": "client"}
        self.client = TestClient(main.app)
        self.records = []
        self.stack.enter_context(patch.object(audit, "insert_log", side_effect=lambda row: self.records.append(dict(row))))
        self.stack.enter_context(patch.object(audit.httpx, "post", side_effect=lambda *args, **kwargs: response({"model": "actual", "usage": {"input_tokens": 4, "output_tokens": 2}})))
        self.started = {"id": 61, "brand_id": 9, "status": "running", "created_at": "now", "completed_at": None}
        self.stack.enter_context(patch.object(main, "start_check", return_value=self.started))
        self.stack.enter_context(patch.object(main, "finish_check", side_effect=lambda user_id, check_id, status, result=None, error=None: {**self.started, "status": status, "completed_at": "later", "result": result, "error": error}))
        self.stack.enter_context(patch.object(main, "is_perplexity_configured", return_value=True))

    def test_check_all_route_propagates_authenticated_context_to_all_workers(self):
        def run(request, user_id, use_cache):
            audit.logged_http_post(request.provider, "configured", 1, URL)
            return {"provider": request.provider, "model": request.provider, "mentioned": False, "sources": [], "ordered_mentions": []}

        self.stack.enter_context(patch.object(main, "_run_check", side_effect=run))
        result = self.client.post("/api/check-all", json={"brand": "Vidno", "query": "Which service?", "providers": ["openai", "deepseek"]})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(self.records), 2)
        self.assertTrue(all((row["user_id"], row["check_id"], row["operation"]) == (17, 61, "check_all") for row in self.records))
        self.assertEqual(len({row["request_id"] for row in self.records}), 1)

    def test_cached_checks_do_not_relog_old_provider_metadata(self):
        provider = {"generate": Mock(side_effect=AssertionError("cache hit must not call provider")), "configured": lambda: True, "model": lambda: "configured"}
        cached = {"provider": "openai", "sources": [], "provider_calls": [{"usage": {"input_tokens": 500}}]}
        self.stack.enter_context(patch.dict(main.PROVIDERS, {"openai": provider}))
        self.stack.enter_context(patch.object(main, "get_result_cache", return_value=cached))
        result = self.client.post("/api/check", json={"brand": "Vidno", "query": "Which service?", "provider": "openai"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.records, [])
        provider["generate"].assert_not_called()

    def test_generation_and_analysis_share_request_but_have_distinct_stages(self):
        def generate(query):
            audit.logged_http_post("openai", "configured", 1, URL)
            return {"raw_answer": "An answer", "sources": []}

        def analyze(*args):
            audit.logged_http_post("perplexity", "configured", 1, URL)
            return {"mentioned": False, "position": None, "competitors": [], "ordered_mentions": []}

        self.stack.enter_context(patch.dict(main.PROVIDERS, {"openai": {"generate": generate, "configured": lambda: True, "model": lambda: "configured"}}))
        self.stack.enter_context(patch.object(main, "get_result_cache", return_value=None))
        self.stack.enter_context(patch.object(main, "set_result_cache"))
        self.stack.enter_context(patch.object(main, "analyze_with_perplexity", side_effect=analyze))
        result = self.client.post("/api/check", json={"brand": "Vidno", "query": "Which service?", "provider": "openai"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual([(row["provider"], row["stage"]) for row in self.records], [("openai", "generation"), ("perplexity", "analysis")])
        self.assertEqual(len({row["request_id"] for row in self.records}), 1)
        self.assertTrue(all(row["check_id"] == 61 for row in self.records))

    def test_imported_metadata_does_not_create_usage_rows(self):
        self.stack.enter_context(patch.object(main, "create_saved_check", return_value={"id": 62}))
        result = self.client.post("/api/checks", json={"brand": "Vidno", "query": "Which service?", "provider": "openai", "provider_calls": [{"usage": {"input_tokens": 500}}]})
        self.assertEqual(result.status_code, 201)
        self.assertEqual(self.records, [])

    def test_brief_has_authenticated_user_and_no_check_id(self):
        def generate(*args, **kwargs):
            audit.logged_http_post("deepseek", "configured", 1, URL)
            return json.dumps({"title": "A title", "goal": "A goal", "action": "An action", "verification": "Check"})

        self.stack.enter_context(patch.object(main, "require_workspace_access"))
        self.stack.enter_context(patch.dict(main.PROVIDERS, {"deepseek": {"configured": lambda: True}}))
        self.stack.enter_context(patch.object(main, "_call_deepseek", side_effect=generate))
        result = self.client.post("/api/brief", json={"brand": "Vidno", "query": "Which service?", "provider": "deepseek", "checks_count": 1, "evidence": "Observed result"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(self.records), 1)
        self.assertEqual((self.records[0]["operation"], self.records[0]["user_id"], self.records[0]["check_id"]), ("brief", 17, None))

    def test_prompt_suggestions_have_authenticated_user_and_no_check_id(self):
        prompts = ["Первый запрос?", "Второй запрос?", "Третий запрос?"]

        def generate(*args, **kwargs):
            with audit.stage_scope("prompt_suggestions"):
                audit.logged_http_post("perplexity", "configured", 1, URL)
            return {"prompts": prompts}

        self.stack.enter_context(patch.object(main, "require_workspace_access"))
        self.stack.enter_context(patch.object(main, "normalize_suggested_prompts", return_value=prompts))
        self.stack.enter_context(patch.object(main, "generate_perplexity_prompt_payload", side_effect=generate))
        result = self.client.post("/api/prompt-suggestions", json={"brand": "Vidno"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(self.records), 1)
        self.assertEqual((self.records[0]["operation"], self.records[0]["user_id"], self.records[0]["check_id"]), ("prompt_suggestions", 17, None))


class AdminLogsApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def tearDown(self):
        main.app.dependency_overrides.clear()

    def test_requires_cookie_session(self):
        self.assertEqual(self.client.get("/api/admin/ai-requests").status_code, 401)

    def test_rejects_regular_user(self):
        main.app.dependency_overrides[main._current_user] = lambda: {"id": 7, "role": "client"}
        self.assertEqual(self.client.get("/api/admin/ai-requests").status_code, 403)

    def admin(self):
        main.app.dependency_overrides[main._current_user] = lambda: {"id": 7, "role": "admin"}

    def test_validated_filters_and_pagination_reach_storage(self):
        self.admin()
        payload = {"items": [], "total": 0, "page": 2, "page_size": 3, "summary": {"attempts": 0, "errors": 0, "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "missing_usage": 0}}
        with patch.object(main, "list_ai_requests", return_value=payload) as read:
            result = self.client.get("/api/admin/ai-requests", params={"date_from": "2026-10-01T00:00:00Z", "date_to": "2026-11-01T00:00:00Z", "user": "client@example.test", "model": "actual", "provider": "openai", "operation": "check_all", "status": "success", "page": 2, "page_size": 3})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json(), payload)
        kwargs = read.call_args.kwargs
        for key, expected in {"user": "client@example.test", "model": "actual", "provider": "openai", "operation": "check_all", "status": "success", "page": 2, "page_size": 3}.items():
            self.assertEqual(kwargs[key], expected)

    def test_invalid_filter_values_are_rejected(self):
        self.admin()
        for params in ({"page": 0}, {"page_size": 101}, {"page_size": 0}, {"provider": "unknown"}, {"status": "unknown"}, {"operation": "unknown"}, {"date_from": "not-a-date"}, {"date_from": "2026-11-02T00:00:00Z", "date_to": "2026-11-01T00:00:00Z"}):
            with self.subTest(params=params), patch.object(main, "list_ai_requests") as read:
                self.assertEqual(self.client.get("/api/admin/ai-requests", params=params).status_code, 422)
                read.assert_not_called()
