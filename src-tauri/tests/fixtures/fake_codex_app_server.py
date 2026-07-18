#!/usr/bin/env python3
"""Deterministic Codex app-server fixture; stdout is JSONL protocol only."""

import json
import os
import pathlib
import stat
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
    fixture = pathlib.Path(__file__).with_name(
        "codex_schema_subset_v0_144_5.json"
    )
    documents = json.loads(fixture.read_text(encoding="utf-8"))
    for relative, document in documents.items():
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(document), encoding="utf-8")


def result(message_id, value):
    send({"id": message_id, "result": value})


def validate_attachment_inputs(inputs, expected_image, expected_notes):
    try:
        if not isinstance(inputs, list) or len(inputs) != 2:
            return False, []
        image = inputs[0]
        notes = inputs[1]
        image_path = pathlib.Path(image.get("path", ""))
        notes_path = pathlib.Path(notes.get("path", ""))
        paths = [image_path, notes_path]
        private_shape = all(
            "attachment-snapshots" in path.parts
            and path.name.endswith(".snapshot")
            and stat.S_IMODE(path.stat().st_mode) == 0o600
            and stat.S_IMODE(path.parent.stat().st_mode) == 0o700
            for path in paths
        )
        valid = (
            image.get("type") == "localImage"
            and image_path.read_bytes() == expected_image
            and notes.get("type") == "mention"
            and notes.get("name") == "notes.txt"
            and notes_path.read_bytes() == expected_notes
            and private_shape
        )
        return valid, paths
    except (OSError, TypeError, ValueError):
        return False, []


def main():
    args = sys.argv[1:]
    if args == ["--version"]:
        sys.stdout.write("codex-cli 0.144.5\n")
        return 0
    if len(args) >= 5 and args[:2] == ["app-server", "generate-json-schema"]:
        output = pathlib.Path(args[args.index("--out") + 1])
        if MODE == "schema_malformed":
            output.mkdir(parents=True, exist_ok=True)
            (output / "ClientRequest.json").write_text("{}", encoding="utf-8")
            return 0
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
            if MODE == "protocol_after_ready":
                record("initialize")
            if (
                MODE == "experimental_rejected"
                and params.get("capabilities", {}).get("experimentalApi") is True
            ):
                record("experimental_initialize_rejected")
                send(
                    {
                        "id": message_id,
                        "error": {
                            "code": -32600,
                            "message": "experimentalApi is unsupported",
                        },
                    }
                )
                continue
            if MODE == "experimental_rejected":
                record("stable_initialize_accepted")
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
            if MODE == "protocol_after_ready":
                def emit_protocol_violation():
                    record("protocol_violation_emitted")
                    sys.stdout.write("{malformed}\n")
                    sys.stdout.flush()

                threading.Timer(0.05, emit_protocol_violation).start()
            continue
        if method == "thread/list":
            result(message_id, {"data": [], "nextCursor": None})
            continue
        if method in ("thread/start", "thread/resume"):
            thread_id = params.get("threadId", "thread-fixture")
            experimental_fields = {
                "allowProviderModelFallback",
                "runtimeWorkspaceRoots",
                "experimentalRawEvents",
                "dynamicTools",
                "environments",
            }
            if MODE == "experimental_rejected":
                stable = not any(field in params for field in experimental_fields)
                record("stable_thread_contract_ok" if stable else "stable_thread_contract_invalid")
                if not stable:
                    send(
                        {
                            "id": message_id,
                            "error": {"code": -32602, "message": "Invalid params"},
                        }
                    )
                    continue
            response = {
                "thread": {
                    "id": thread_id,
                    "cwd": params.get("cwd"),
                    "ephemeral": False,
                },
                "model": "gpt-5.6-sol",
                "cwd": params.get("cwd"),
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "sandbox": {
                    "type": "workspaceWrite",
                    "writableRoots": [params.get("cwd")],
                    "networkAccess": False,
                },
                "modelProvider": "openai",
            }
            if MODE == "thread_policy_missing":
                response.pop("approvalPolicy")
            elif MODE == "thread_policy_model":
                response["model"] = "other-model"
            elif MODE == "thread_policy_cwd":
                response["thread"]["cwd"] = "/fixture/outside"
            elif MODE == "thread_policy_sandbox":
                response["sandbox"]["type"] = "dangerFullAccess"
            elif MODE == "thread_policy_ephemeral":
                response["thread"]["ephemeral"] = True
            result(
                message_id,
                response,
            )
            continue
        if method == "turn/start":
            input_text = ""
            if isinstance(params.get("input"), list) and params["input"]:
                input_text = params["input"][0].get("text", "")
            try:
                continuation = json.loads(input_text)
            except (json.JSONDecodeError, TypeError):
                continuation = None
            valid = (
                params.get("model") == "gpt-5.6-sol"
                and params.get("effort") in ("low", "max")
                and "serviceTier" not in params
                and "collaborationMode" not in params
                and "multiAgentMode" not in params
            )
            attachment_paths = []
            attachment_modes = {
                "attachments",
                "attachments_race",
                "attachments_rejected",
                "attachments_terminal_first",
                "attachments_crash",
            }
            if MODE in attachment_modes:
                inputs = params.get("input")
                expected_image = (
                    b"\x89PNG\r\n\x1a\nvalidated-image"
                    if MODE == "attachments_race"
                    else b"\x89PNG\r\n\x1a\nfixture"
                )
                expected_notes = (
                    b"validated-notes"
                    if MODE == "attachments_race"
                    else b"bounded notes"
                )
                attachment_valid, attachment_paths = validate_attachment_inputs(
                    inputs, expected_image, expected_notes
                )
                record(
                    "attachment_exact_bytes_ok"
                    if attachment_valid
                    else "attachment_exact_bytes_invalid"
                )
                valid = valid and attachment_valid
            record("turn_contract_ok" if valid else "turn_contract_invalid")
            if not valid:
                send({"id": message_id, "error": {"code": -32602, "message": "Invalid params"}})
                continue
            if MODE == "attachments_rejected":
                send({"id": message_id, "error": {"code": -32603, "message": "Rejected fixture"}})
                continue
            if MODE == "attachments_crash":
                os._exit(29)
            if isinstance(continuation, dict) and continuation.get("kind") == "decision_result":
                structured = (
                    continuation.get("schemaVersion") == 1
                    and str(continuation.get("decisionHandle", "")).startswith("decision-")
                    and str(continuation.get("optionId", "")).startswith("option-")
                    and set(continuation) == {
                        "schemaVersion",
                        "kind",
                        "decisionHandle",
                        "optionId",
                    }
                )
                record("decision_continuation_ok" if structured else "decision_continuation_invalid")
                if MODE == "decision_continuation_crash":
                    os._exit(23)
                result(
                    message_id,
                    {"turn": {"id": "turn-decision-continuation", "status": "inProgress"}},
                )
                send(
                    {
                        "method": "turn/started",
                        "params": {
                            "threadId": params["threadId"],
                            "turn": {"id": "turn-decision-continuation", "status": "inProgress"},
                        },
                    }
                )
                continue
            notification_first = MODE in (
                "decision_notification_first",
                "attachments_terminal_first",
            )
            if not notification_first:
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
            if MODE == "attachments_terminal_first":
                send(
                    {
                        "method": "turn/completed",
                        "params": {
                            "threadId": params["threadId"],
                            "turn": {"id": "turn-fixture", "status": "completed"},
                        },
                    }
                )
                deadline = time.monotonic() + 2.0
                while any(path.exists() for path in attachment_paths) and time.monotonic() < deadline:
                    time.sleep(0.01)
                record(
                    "attachment_terminal_cleanup_ok"
                    if not any(path.exists() for path in attachment_paths)
                    else "attachment_terminal_cleanup_invalid"
                )
                result(
                    message_id,
                    {"turn": {"id": "turn-fixture", "status": "inProgress"}},
                )
                continue
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
            if MODE == "native_rui":
                send(
                    {
                        "id": "server-rui",
                        "method": "item/tool/requestUserInput",
                        "params": {
                            "threadId": params["threadId"],
                            "turnId": "turn-fixture",
                            "itemId": "item-rui",
                            "questions": [
                                {
                                    "id": "choice",
                                    "header": "Choice",
                                    "question": "Choose a safe option",
                                    "options": [
                                        {"label": "Continue", "description": "Continue safely"},
                                        {"label": "Stop", "description": "Stop this turn"},
                                    ],
                                }
                            ],
                        },
                    }
                )
            if MODE in (
                "decision_fallback",
                "decision_invalid",
                "decision_continuation_crash",
                "decision_notification_first",
            ):
                output = (
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "kind": "decision_request",
                            "message": "A choice is required",
                            "decisionId": "fixture-decision",
                            "question": "Choose a safe option",
                            "options": [
                                {
                                    "id": "continue",
                                    "label": "Continue",
                                    "description": "Continue safely",
                                },
                                {
                                    "id": "stop",
                                    "label": "Stop",
                                    "description": "Stop this turn",
                                },
                            ],
                            "allowFreeform": False,
                        },
                        separators=(",", ":"),
                    )
                    if MODE in (
                        "decision_fallback",
                        "decision_continuation_crash",
                        "decision_notification_first",
                    )
                    else "Choose Continue or Stop"
                )
                send(
                    {
                        "method": "item/completed",
                        "params": {
                            "threadId": params["threadId"],
                            "turnId": "turn-fixture",
                            "item": {
                                "id": "item-decision",
                                "type": "agentMessage",
                                "text": output,
                            },
                        },
                    }
                )
                if MODE != "decision_invalid":
                    send(
                        {
                            "method": "turn/completed",
                            "params": {
                                "threadId": params["threadId"],
                                "turn": {"id": "turn-fixture", "status": "completed"},
                            },
                        }
                    )
                if notification_first:
                    record("decision_notifications_before_response")
                    time.sleep(0.15)
                    result(
                        message_id,
                        {"turn": {"id": "turn-fixture", "status": "inProgress"}},
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
        if message_id == "server-rui":
            if message.get("result", {}).get("answers", {}).get("choice") == {
                "answers": ["Continue"]
            }:
                record("native_rui_answered")
            continue
        if message_id is not None:
            result(message_id, {})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
