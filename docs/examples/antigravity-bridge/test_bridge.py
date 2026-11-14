import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agy_cindy_bridge as bridge


class SanitizeSchemaTest(unittest.TestCase):
    def test_drops_fields_outside_gemini_schema(self):
        # Regression: Gemini rejected the whole request with
        # 'Unknown name "encrypted" at ...parameters.properties[0].value'.
        out = bridge.sanitize_schema({
            "type": "object",
            "properties": {"token": {"type": "string", "encrypted": True, "description": "d"}},
            "required": ["token", "missing"],
            "additionalProperties": False,
        })
        self.assertEqual(out, {
            "type": "OBJECT",
            "properties": {"token": {"type": "STRING", "description": "d"}},
            "required": ["token"],
        })

    def test_nullable_anyof_collapses(self):
        out = bridge.sanitize_schema({"anyOf": [{"type": "integer"}, {"type": "null"}]})
        self.assertEqual(out, {"type": "INTEGER", "nullable": True})

    def test_schema_defs_and_ref_dereferencing(self):
        schema = {
            "$defs": {
                "UserRole": {
                    "type": "string",
                    "enum": ["admin", "editor", "viewer"],
                },
                "Profile": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "role": {"$ref": "#/$defs/UserRole"},
                    },
                    "required": ["name", "role"],
                },
            },
            "type": "object",
            "properties": {
                "user": {"$ref": "#/$defs/Profile"},
            },
            "required": ["user"],
        }
        sanitized = bridge.sanitize_schema(schema)
        self.assertEqual(sanitized, {
            "type": "OBJECT",
            "properties": {
                "user": {
                    "type": "OBJECT",
                    "properties": {
                        "name": {"type": "STRING"},
                        "role": {"type": "STRING", "enum": ["admin", "editor", "viewer"]},
                    },
                    "required": ["name", "role"],
                },
            },
            "required": ["user"],
        })

    def test_schema_circular_ref_safety(self):
        schema = {
            "$defs": {
                "Node": {
                    "type": "object",
                    "properties": {
                        "next": {"$ref": "#/$defs/Node"},
                    },
                },
            },
            "type": "object",
            "properties": {
                "head": {"$ref": "#/$defs/Node"},
            },
        }
        sanitized = bridge.sanitize_schema(schema)
        self.assertEqual(sanitized["type"], "OBJECT")
        self.assertEqual(sanitized["properties"]["head"]["type"], "OBJECT")
        self.assertEqual(sanitized["properties"]["head"]["properties"]["next"], {})

    def test_strict_cca_allowlist_strips_disallowed_keys(self):
        schema = {
            "title": "SearchQuery",
            "description": "A search query with validation",
            "type": "object",
            "properties": {
                "q": {
                    "type": "string",
                    "minLength": 3,
                    "maxLength": 100,
                    "description": "search query text",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 50,
                    "default": 10,
                },
                "tags": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 5,
                    "items": {"type": "string"},
                },
            },
            "required": ["q"],
        }
        out = bridge.sanitize_schema(schema)
        self.assertEqual(out, {
            "type": "OBJECT",
            "description": "A search query with validation",
            "properties": {
                "q": {"type": "STRING", "description": "search query text"},
                "limit": {"type": "INTEGER"},
                "tags": {
                    "type": "ARRAY",
                    "items": {"type": "STRING"},
                },
            },
            "required": ["q"],
        })
        self.assertNotIn("title", out)
        self.assertNotIn("minLength", out["properties"]["q"])
        self.assertNotIn("minimum", out["properties"]["limit"])
        self.assertNotIn("minItems", out["properties"]["tags"])

    def test_multi_branch_enum_union(self):
        # Regression from packages/model-compat/src/__tests__/upstream/adapters/google/google-tool-schema.test.js
        schema = {
            "type": "object",
            "properties": {
                "status": {
                    "description": "New status for the task",
                    "anyOf": [
                        {"type": "string", "enum": ["pending", "in_progress", "completed"]},
                        {"type": "string", "enum": ["deleted"]},
                    ],
                },
            },
        }
        out = bridge.sanitize_schema(schema)
        self.assertEqual(out["properties"]["status"], {
            "type": "STRING",
            "description": "New status for the task",
            "enum": ["pending", "in_progress", "completed", "deleted"],
        })

    def test_drops_non_string_enums(self):
        # Numeric enums should be dropped rather than coerced to strings, avoiding invalid schema
        schema = {
            "type": "object",
            "properties": {
                "count": {"type": "integer", "enum": [1, 2, 3]},
                "tag": {"type": "string", "enum": ["a", "b"]},
            },
        }
        out = bridge.sanitize_schema(schema)
        self.assertEqual(out["properties"]["count"], {"type": "INTEGER"})
        self.assertNotIn("enum", out["properties"]["count"])
        self.assertEqual(out["properties"]["tag"], {"type": "STRING", "enum": ["a", "b"]})


class BridgeSecurityAndUpstreamTest(unittest.TestCase):
    def test_re_module_imported(self):
        self.assertTrue(hasattr(bridge, "re"))

    def test_quota_cache_location_not_in_checkout(self):
        checkout_dir = os.path.dirname(os.path.abspath(__file__))
        self.assertFalse(os.path.abspath(bridge.QUOTA_CACHE_FILE).startswith(checkout_dir))

    def test_cors_origin_filter(self):
        self.assertTrue(bool(bridge.ALLOWED_ORIGIN_REGEX.match("http://localhost:3000")))
        self.assertTrue(bool(bridge.ALLOWED_ORIGIN_REGEX.match("http://127.0.0.1:8080")))
        self.assertTrue(bool(bridge.ALLOWED_ORIGIN_REGEX.match("tauri://localhost")))
        self.assertTrue(bool(bridge.ALLOWED_ORIGIN_REGEX.match("vscode-webview://random-token")))
        self.assertFalse(bool(bridge.ALLOWED_ORIGIN_REGEX.match("https://evil.com")))
        self.assertFalse(bool(bridge.ALLOWED_ORIGIN_REGEX.match("http://attacker.com:11436")))

    def test_reasoning_effort_applied_upstream(self):
        req_low = {
            "model": "gemini-4-argon",
            "messages": [{"role": "user", "content": "hi"}],
            "reasoning_effort": "low",
        }
        env_low, _, _ = bridge.build_cca_request(req_low)
        gen_cfg_low = env_low["request"].get("generationConfig", {})
        self.assertIn("thinkingConfig", gen_cfg_low)
        self.assertEqual(gen_cfg_low["thinkingConfig"]["thinkingBudget"], 8192)

        req_min = {
            "model": "gemini-4-argon",
            "messages": [{"role": "user", "content": "hi"}],
            "reasoning_effort": "minimal",
        }
        env_min, _, _ = bridge.build_cca_request(req_min)
        gen_cfg_min = env_min["request"].get("generationConfig", {})
        self.assertIn("thinkingConfig", gen_cfg_min)
        self.assertEqual(gen_cfg_min["thinkingConfig"]["thinkingBudget"], 0)

    def test_supports_fast_mode_is_false_in_catalog(self):
        for model in bridge.MODEL_CATALOG:
            self.assertFalse(model.get("supports_fast", False), f"{model['id']} should not advertise supports_fast")

    def test_preserve_actual_backend_model(self):
        req_opus = {
            "model": "claude-opus-5-5",
            "messages": [{"role": "user", "content": "hello"}],
            "reasoning_effort": "high",
        }
        env_opus, _, _ = bridge.build_cca_request(req_opus)
        self.assertEqual(env_opus["model"], "claude-opus-5-5-high")

        req_argon = {
            "model": "gemini-4-argon",
            "messages": [{"role": "user", "content": "hello"}],
            "reasoning_effort": "high",
        }
        env_argon, _, _ = bridge.build_cca_request(req_argon)
        self.assertEqual(env_argon["model"], "gemini-3.8-flash-tiered")

    def test_map_finish_reason(self):
        self.assertEqual(bridge.map_finish_reason("STOP"), "stop")
        self.assertEqual(bridge.map_finish_reason("STOP", has_tool_calls=True), "tool_calls")
        self.assertEqual(bridge.map_finish_reason("MAX_TOKENS"), "length")
        self.assertEqual(bridge.map_finish_reason("MAX_TOKENS", has_tool_calls=True), "length")
        self.assertEqual(bridge.map_finish_reason("SAFETY"), "content_filter")
        self.assertEqual(bridge.map_finish_reason("RECITATION"), "content_filter")
        self.assertEqual(bridge.map_finish_reason("BLOCKLIST"), "content_filter")
        self.assertEqual(bridge.map_finish_reason("MALFORMED_FUNCTION_CALL"), "error")
        self.assertEqual(bridge.map_finish_reason(None, has_tool_calls=True), "tool_calls")
        self.assertEqual(bridge.map_finish_reason(None, has_tool_calls=False), "stop")

    def test_dynamic_models_merges_static_and_omits_unreported_limits(self):
        gpt_oss = bridge.MODEL_MAP.get("gpt-oss-120b")
        self.assertIsNotNone(gpt_oss)
        self.assertEqual(gpt_oss["context_window"], 128000)
        self.assertEqual(gpt_oss["max_output"], 32768)

        with patch("subprocess.run") as mock_run:
            mock_run.return_value.returncode = 0
            mock_run.return_value.stdout = "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\nunknown-custom-model\tUnknown Custom Model\n"
            models = bridge.fetch_dynamic_agy_models()
            model_by_id = {m["id"]: m for m in models}

            # Known model retains verified static context & output tokens
            self.assertEqual(model_by_id["gpt-oss-120b"]["context_window"], 128000)
            self.assertEqual(model_by_id["gpt-oss-120b"]["max_output"], 32768)

            # Unknown model does not guess 1M or 64k tokens
            self.assertNotIn("context_window", model_by_id["unknown-custom-model"])
            self.assertNotIn("max_output", model_by_id["unknown-custom-model"])

    def test_thinking_tokens_added_to_completion_tokens(self):
        usage_meta = {
            "promptTokenCount": 100,
            "candidatesTokenCount": 50,
            "thoughtsTokenCount": 200,
            "totalTokenCount": 350,
        }
        prompt_toks = usage_meta.get("promptTokenCount", 0)
        cand_toks = usage_meta.get("candidatesTokenCount", 0)
        thought_toks = usage_meta.get("thoughtsTokenCount", 0)
        completion_toks = cand_toks + thought_toks
        total_toks = usage_meta.get("totalTokenCount", prompt_toks + completion_toks)

        final_usage = {
            "prompt_tokens": prompt_toks,
            "completion_tokens": completion_toks,
            "total_tokens": total_toks,
        }
        if thought_toks:
            final_usage["completion_tokens_details"] = {"reasoning_tokens": thought_toks}

        self.assertEqual(final_usage["prompt_tokens"], 100)
        self.assertEqual(final_usage["completion_tokens"], 250)
        self.assertEqual(final_usage["total_tokens"], 350)
        self.assertEqual(final_usage["completion_tokens_details"]["reasoning_tokens"], 200)

    def test_unsuffixed_unknown_models_have_no_fabricated_efforts(self):
        with patch("subprocess.run") as mock_run:
            mock_run.return_value.returncode = 0
            mock_run.return_value.stdout = "unknown-custom-model\tUnknown Custom Model\n"
            models = bridge.fetch_dynamic_agy_models()
            self.assertEqual(len(models), 1)
            self.assertEqual(models[0]["efforts"], [])
            self.assertIsNone(models[0].get("default_effort"))

    def test_tool_choice_translation_to_function_calling_config(self):
        base_req = {
            "model": "gemini-4-argon",
            "messages": [{"role": "user", "content": "hi"}],
            "tools": [{
                "type": "function",
                "function": {
                    "name": "search_docs",
                    "description": "search",
                    "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
                },
            }],
        }
        # tool_choice: none
        req_none = {**base_req, "tool_choice": "none"}
        env_none, _, _ = bridge.build_cca_request(req_none)
        self.assertEqual(env_none["request"]["toolConfig"]["functionCallingConfig"]["mode"], "NONE")

        # tool_choice: required
        req_req = {**base_req, "tool_choice": "required"}
        env_req, _, _ = bridge.build_cca_request(req_req)
        self.assertEqual(env_req["request"]["toolConfig"]["functionCallingConfig"]["mode"], "ANY")

        # tool_choice: auto
        req_auto = {**base_req, "tool_choice": "auto"}
        env_auto, _, _ = bridge.build_cca_request(req_auto)
        self.assertEqual(env_auto["request"]["toolConfig"]["functionCallingConfig"]["mode"], "AUTO")

        # tool_choice: named function
        req_named = {**base_req, "tool_choice": {"type": "function", "function": {"name": "search_docs"}}}
        env_named, _, _ = bridge.build_cca_request(req_named)
        self.assertEqual(env_named["request"]["toolConfig"]["functionCallingConfig"], {
            "mode": "ANY",
            "allowedFunctionNames": ["search_docs"],
        })

        # tool_choice: named unknown function ignored / not set
        req_bad = {**base_req, "tool_choice": {"type": "function", "function": {"name": "non_existent"}}}
        env_bad, _, _ = bridge.build_cca_request(req_bad)
        self.assertNotIn("toolConfig", env_bad["request"])

    def test_prompt_feedback_safety_block_mapping(self):
        self.assertEqual(bridge.map_finish_reason("PROMPT_BLOCKED_SAFETY"), "content_filter")
        self.assertEqual(bridge.map_finish_reason("BLOCKLIST"), "content_filter")
        self.assertEqual(bridge.map_finish_reason("PROHIBITED_CONTENT"), "content_filter")


if __name__ == "__main__":
    unittest.main()
