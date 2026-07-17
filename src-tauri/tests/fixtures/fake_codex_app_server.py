#!/usr/bin/env python3
"""Deterministic Codex app-server fixture; stdout is JSONL protocol only."""

import json
import os
import pathlib
import sys
import threading
import time


MODE = os.environ.get("CODING_WIFE_CODEX_FAKE_MODE", "default")
STATE_PATH = os.environ.get("CODING_WIFE_CODEX_FAKE_STATE")


def record(value):
    if not STATE_PATH:
        return
    path = pathlib.Path(STATE_PATH)
    previous = path.read_text(encoding="utf-8") if path.exists() else ""
    path.write_text(previous + value + "\n", encoding="utf-8")


def send(value):
    encoded = (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")
    if MODE == "fragmented":
        split = max(1, len(encoded) // 2)
        sys.stdout.buffer.write(encoded[:split])
        sys.stdout.buffer.flush()
        time.sleep(0.01)
        sys.stdout.buffer.write(encoded[split:])
    else:
        sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def generate_schema(output):
    output.mkdir(parents=True, exist_ok=True)
    methods = [
        "thread/list",
        "thread/start",
        "thread/resume",
        "turn/start",
        "turn/interrupt",
        "review/start",
        "account/read",
        "config/read",
        "model/list",
        "item/tool/requestUserInput",
        "ToolRequestUserInput",
        "item/tool/call",
        "item/permissions/requestApproval",
        "dynamicTools",
        "detached",
        "ephemeral",
    ]
    (output / "fixture-schema.json").write_text(
        json.dumps({"methods": methods}), encoding="utf-8"
    )


def result(message_id, value):
    send({"id": message_id, "result": value})


def main():
    args = sys.argv[1:]
    if args == ["--version"]:
        sys.stdout.write("codex-cli 0.144.5\n")
        return 0
    if len(args) >= 5 and args[:2] == ["app-server", "generate-json-schema"]:
        output = pathlib.Path(args[args.index("--out") + 1])
        generate_schema(output)
        return 0
    if not args or args[0] != "app-server":
        return 2

    pending_fixture = []
    for raw_line in sys.stdin.buffer:
        try:
            message = json.loads(raw_line)
        except json.JSONDecodeError:
            return 3
        method = message.get("method")
        message_id = message.get("id")
        params = message.get("params") or {}

        if method == "initialize":
            result(
                message_id,
                {
                    "userAgent": "coding-wife-fixture/0.144.5",
                    "platformFamily": "unix",
                    "platformOs": "macos",
                    "codexHome": "/fixture/codex-home",
                },
            )
            if MODE == "malformed":
                sys.stdout.write("{malformed}\n")
                sys.stdout.flush()
            continue
        if method == "initialized":
            continue
        if method == "account/read":
            result(
                message_id,
                {"account": {"type": "chatgpt"}, "requiresOpenaiAuth": True},
            )
            continue
        if method == "config/read":
            result(message_id, {"config": {"model": "gpt-5.6-sol"}, "origins": {}})
            continue
        if method == "model/list":
            result(
                message_id,
                {
                    "data": [
                        {
                            "id": "gpt-5.6-sol",
                            "model": "gpt-5.6-sol",
                            "supportedReasoningEfforts": [
                                {"reasoningEffort": "low"},
                                {"reasoningEffort": "max"},
                            ],
                        }
                    ],
                    "nextCursor": None,
                },
            )
            if MODE == "crash_after_ready":
                state_path = pathlib.Path(STATE_PATH)
                count = int(state_path.read_text(encoding="utf-8") or "0") if state_path.exists() else 0
                state_path.write_text(str(count + 1), encoding="utf-8")
                if count == 0:
                    threading.Timer(0.15, lambda: os._exit(17)).start()
            continue
        if method == "thread/list":
            result(message_id, {"data": [], "nextCursor": None})
            continue
        if method in ("thread/start", "thread/resume"):
            thread_id = params.get("threadId", "thread-fixture")
            result(
                message_id,
                {
                    "thread": {"id": thread_id},
                    "model": "gpt-5.6-sol",
                    "cwd": params.get("cwd"),
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": "user",
                    "sandbox": "workspace-write",
                    "modelProvider": "openai",
                },
            )
            continue
        if method == "turn/start":
            valid = (
                params.get("model") == "gpt-5.6-sol"
                and params.get("effort") in ("low", "max")
                and "serviceTier" not in params
                and "collaborationMode" not in params
                and "multiAgentMode" not in params
            )
            record("turn_contract_ok" if valid else "turn_contract_invalid")
            if not valid:
                send({"id": message_id, "error": {"code": -32602, "message": "Invalid params"}})
                continue
            result(message_id, {"turn": {"id": "turn-fixture", "status": "inProgress"}})
            send(
                {
                    "method": "turn/started",
                    "params": {
                        "threadId": params["threadId"],
                        "turn": {"id": "turn-fixture", "status": "inProgress"},
                    },
                }
            )
            if MODE == "unknown_request":
                send(
                    {
                        "id": "server-unknown",
                        "method": "item/future/requestApproval",
                        "params": {
                            "threadId": params["threadId"],
                            "turnId": "turn-fixture",
                            "itemId": "item-fixture",
                        },
                    }
                )
            continue
        if method == "turn/interrupt":
            record("interrupt_received")
            result(message_id, {})
            send(
                {
                    "method": "turn/completed",
                    "params": {
                        "threadId": params["threadId"],
                        "turn": {"id": params["turnId"], "status": "interrupted"},
                    },
                }
            )
            continue
        if method == "review/start":
            result(
                message_id,
                {"reviewThreadId": "review-fixture", "turn": {"id": "review-turn"}},
            )
            continue
        if method == "fixture/timeout":
            continue
        if method == "fixture/duplicate":
            result(message_id, {"ok": True})
            result(message_id, {"ok": True})
            continue
        if method in ("fixture/one", "fixture/two") and MODE == "out_of_order":
            pending_fixture.append((message_id, method))
            if len(pending_fixture) == 2:
                for queued_id, queued_method in reversed(pending_fixture):
                    result(queued_id, {"method": queued_method})
            continue
        if message_id == "server-unknown":
            if "error" in message:
                record("unknown_request_rejected")
            continue
        if message_id is not None:
            result(message_id, {})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
