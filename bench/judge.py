# -*- coding: utf-8 -*-
"""roster-bench 语义判分：{"semantic": 判据} 交给 kimi-for-coding 裁决。

约束（task-10-brief）：
- 只用 stdlib（urllib），零三方依赖。
- 端点 https://api.kimi.com/coding/v1，模型 kimi-for-coding，key 取环境变量
  KIMI_CODE_API_KEY。**payload 不传 temperature**——实测约束：该模型只允许
  temperature=1，任何显式值都会被端点拒绝，因此整个字段不出现。
- 失败（HTTP 非 2xx / 传输异常 / 判词不可解析）重试 1 次；仍失败抛
  JudgeUnavailableError，由上层把该题标记 judge-unavailable——绝不静默 pass。
- 判词要求模型只输出 JSON：{"verdict": "pass"|"fail", "reason": "..."}。
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "https://api.kimi.com/coding/v1"
DEFAULT_MODEL = "kimi-for-coding"
API_KEY_ENV = "KIMI_CODE_API_KEY"
DEFAULT_TIMEOUT_S = 60.0
DEFAULT_MAX_ATTEMPTS = 2  # 初次 + 重试 1 次

_FENCE = re.compile(r"^```[a-zA-Z0-9_-]*\s*|\s*```$")

_SYSTEM_PROMPT = (
    "你是基准评测的语义判分器。根据给定判据判断被评答复是否达标。"
    '只输出一个 JSON 对象，格式：{"verdict": "pass" 或 "fail", "reason": "简要理由"}。'
    "不要输出其他任何文字。"
)


class JudgeUnavailableError(RuntimeError):
    """judge 不可用（无 key / 端点失败 / 判词不可解析）。上层必须显式标记，不得静默 pass。"""


def build_payload(criterion, final_text, model=DEFAULT_MODEL):
    """构造 chat/completions payload。注意：刻意不含 temperature 字段。"""
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "判据：%s\n\n被评答复：\n%s\n\n只输出 JSON 判词。" % (criterion, final_text),
            },
        ],
    }


def parse_judge_content(content):
    """解析模型判词；非法输入抛 ValueError（计入一次失败尝试）。"""
    text = _FENCE.sub("", str(content or "").strip()).strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError("判词不是合法 JSON：%r" % content) from exc
    verdict = data.get("verdict")
    if verdict not in ("pass", "fail"):
        raise ValueError("verdict 非法：%r" % (verdict,))
    reason = data.get("reason")
    return {"verdict": verdict, "reason": reason if isinstance(reason, str) else ""}


def default_transport(base_url, payload, headers, timeout_s):
    """stdlib urllib POST。返回 (status, body_text)；网络异常向上抛。"""
    request = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            return response.status, response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:  # 非 2xx 也算一次可重试尝试
        return exc.code, exc.read().decode("utf-8", errors="replace")


def judge_semantic(
    criterion,
    final_text,
    api_key=None,
    base_url=DEFAULT_BASE_URL,
    model=DEFAULT_MODEL,
    transport=None,
    timeout_s=DEFAULT_TIMEOUT_S,
    max_attempts=DEFAULT_MAX_ATTEMPTS,
):
    """对一条语义判据裁决，返回 {"criterion", "verdict", "reason"}。

    transport 可注入以便 stub 测试：(base_url, payload, headers, timeout_s)
    -> (status, body)。默认走 default_transport（真实 urllib）。
    """
    key = api_key or os.environ.get(API_KEY_ENV)
    if not key:
        raise JudgeUnavailableError("%s 未设置，judge 不可用（该题标记 judge-unavailable，不静默 pass）" % API_KEY_ENV)

    transport = transport or default_transport
    payload = build_payload(criterion, final_text, model=model)
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer %s" % key,
    }

    last_error = None
    for _attempt in range(max(1, max_attempts)):
        try:
            status, body = transport(base_url, payload, headers, timeout_s)
            if status < 200 or status >= 300:
                last_error = "HTTP %s：%s" % (status, body[:200])
                continue
            data = json.loads(body)
            content = data["choices"][0]["message"]["content"]
            parsed = parse_judge_content(content)
            return {"criterion": criterion, "verdict": parsed["verdict"], "reason": parsed["reason"]}
        except JudgeUnavailableError:
            raise
        except Exception as exc:  # 传输异常 / JSON 解析失败 / 结构缺失 → 可重试
            last_error = "%s: %s" % (type(exc).__name__, exc)
    raise JudgeUnavailableError("judge 重试 %d 次后仍不可用，最后错误：%s" % (max(1, max_attempts), last_error))
