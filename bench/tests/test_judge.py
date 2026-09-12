# -*- coding: utf-8 -*-
"""roster-bench judge 单测（TDD：先失败后实现；全部不真调 kimi API）。

覆盖：payload 形状（不传 temperature）、判词解析、重试 1 次、不可用标记、
无 key 短路，以及经本地 stub HTTP 服务器的默认 urllib 传输端到端。
运行：
    /usr/bin/python3 -m unittest discover -t bench -s bench/tests -v
"""
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from judge import (  # noqa: E402
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    JudgeUnavailableError,
    build_payload,
    judge_semantic,
    parse_judge_content,
)


def kimi_body(content):
    """kimi-for-coding 响应形状。"""
    return json.dumps({"choices": [{"message": {"role": "assistant", "content": content}}]})


def ok_body(verdict="pass", reason="符合判据"):
    return kimi_body(json.dumps({"verdict": verdict, "reason": reason}, ensure_ascii=False))


class RecordingTransport:
    """stub HTTP 层：按脚本返回 (status, body)，并记录调用参数。"""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def __call__(self, url, payload, headers, timeout_s):
        self.calls.append({"url": url, "payload": payload, "headers": headers, "timeout_s": timeout_s})
        status, body = self.script.pop(0)
        return status, body


class BuildPayloadTest(unittest.TestCase):
    def test_omits_temperature(self):
        payload = build_payload("判据X", "答复Y")
        self.assertNotIn("temperature", payload)

    def test_default_model_is_kimi_for_coding(self):
        self.assertEqual(DEFAULT_MODEL, "kimi-for-coding")
        self.assertEqual(build_payload("c", "r")["model"], "kimi-for-coding")

    def test_messages_carry_criterion_and_reply(self):
        payload = build_payload("是否说明了X", "答复正文")
        text = json.dumps(payload, ensure_ascii=False)
        self.assertIn("是否说明了X", text)
        self.assertIn("答复正文", text)
        roles = [m["role"] for m in payload["messages"]]
        self.assertEqual(roles[0], "system")
        self.assertEqual(roles[-1], "user")

    def test_default_base_url_is_kimi_coding_v1(self):
        self.assertEqual(DEFAULT_BASE_URL, "https://api.kimi.com/coding/v1")


class ParseJudgeContentTest(unittest.TestCase):
    def test_plain_json(self):
        parsed = parse_judge_content('{"verdict": "pass", "reason": "r"}')
        self.assertEqual(parsed, {"verdict": "pass", "reason": "r"})

    def test_fenced_json(self):
        parsed = parse_judge_content('```json\n{"verdict": "fail", "reason": "缺事实"}\n```')
        self.assertEqual(parsed["verdict"], "fail")

    def test_invalid_verdict_value_rejected(self):
        with self.assertRaises(ValueError):
            parse_judge_content('{"verdict": "ok", "reason": "r"}')

    def test_non_json_rejected(self):
        with self.assertRaises(ValueError):
            parse_judge_content("我觉得行")


class JudgeSemanticTest(unittest.TestCase):
    CRITERION = "答复是否说明了重启要求"
    REPLY = "安装后必须重启 Harness 进程。"

    def test_pass_verdict_roundtrip(self):
        transport = RecordingTransport([(200, ok_body("pass", "说明了"))])
        result = judge_semantic(self.CRITERION, self.REPLY, api_key="k123", transport=transport)
        self.assertEqual(result, {"criterion": self.CRITERION, "verdict": "pass", "reason": "说明了"})

    def test_fail_verdict_roundtrip(self):
        transport = RecordingTransport([(200, ok_body("fail", "未说明"))])
        result = judge_semantic(self.CRITERION, self.REPLY, api_key="k123", transport=transport)
        self.assertEqual(result["verdict"], "fail")

    def test_transport_receives_bearer_and_payload(self):
        transport = RecordingTransport([(200, ok_body())])
        judge_semantic(self.CRITERION, self.REPLY, api_key="k123", transport=transport)
        call = transport.calls[0]
        self.assertEqual(call["headers"]["Authorization"], "Bearer k123")
        self.assertIn("application/json", call["headers"]["Content-Type"])
        self.assertEqual(call["url"], DEFAULT_BASE_URL)
        self.assertNotIn("temperature", call["payload"])

    def test_retry_once_on_server_error(self):
        transport = RecordingTransport([(500, "boom"), (200, ok_body())])
        result = judge_semantic(self.CRITERION, self.REPLY, api_key="k123", transport=transport)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(len(transport.calls), 2)

    def test_unavailable_after_exhausted_retries(self):
        transport = RecordingTransport([(500, "boom"), (503, "boom")])
        with self.assertRaises(JudgeUnavailableError):
            judge_semantic(self.CRITERION, self.REPLY, api_key="k123", transport=transport)
        self.assertEqual(len(transport.calls), 2)  # 初次 + 重试 1 次，不无限重试

    def test_unavailable_on_garbage_content(self):
        transport = RecordingTransport([(200, "我觉得行"), (200, "真的行")])
        with self.assertRaises(JudgeUnavailableError):
            judge_semantic(self.CRITERION, self.REPLY, api_key="k123", transport=transport)

    def test_missing_api_key_short_circuits_without_transport(self):
        def must_not_call(*_args):
            raise AssertionError("无 key 时不应发起任何请求")

        with mock.patch.dict(os.environ):
            os.environ.pop("KIMI_CODE_API_KEY", None)
            with self.assertRaises(JudgeUnavailableError):
                judge_semantic(self.CRITERION, self.REPLY, transport=must_not_call)

    def test_api_key_falls_back_to_env(self):
        transport = RecordingTransport([(200, ok_body())])
        with mock.patch.dict(os.environ, {"KIMI_CODE_API_KEY": "from-env"}):
            judge_semantic(self.CRITERION, self.REPLY, transport=transport)
        self.assertEqual(transport.calls[0]["headers"]["Authorization"], "Bearer from-env")


class _StubKimiHandler(BaseHTTPRequestHandler):
    """本地 stub kimi 端点：固定返回 pass 判词，用于打通默认 urllib 传输层。"""

    def do_POST(self):  # noqa: N802 - http.server 命名约定
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        body = ok_body("pass", "本地 stub 判过").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


class DefaultTransportEndToEndTest(unittest.TestCase):
    def test_default_urllib_transport_against_local_stub(self):
        server = HTTPServer(("127.0.0.1", 0), _StubKimiHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = judge_semantic(
                "本地判据", "本地答复",
                api_key="local-stub",
                base_url="http://127.0.0.1:%d/v1" % server.server_address[1],
            )
        finally:
            server.shutdown()
            server.server_close()
        self.assertEqual(result["verdict"], "pass")


if __name__ == "__main__":
    unittest.main()
