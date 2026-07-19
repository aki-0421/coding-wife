#!/usr/bin/env python3
"""Process-group fixture whose grandchild deliberately keeps stdio open."""

import os
import pathlib
import signal


def hold_stdio():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        signal.pause()


def publish_state(path_value, value):
    path = pathlib.Path(path_value)
    pending = path.with_name(f"{path.name}.pending")
    pending.write_text(value, encoding="utf-8")
    os.replace(pending, path)


def main():
    state = os.environ.get("CODING_WIFE_PROCESS_TREE_STATE")
    if not state:
        return 2

    parent_state = os.environ.get("CODING_WIFE_PROCESS_TREE_PARENT_STATE")
    ready_state = os.environ.get("CODING_WIFE_PROCESS_TREE_READY_STATE")

    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    grandchild = os.fork()
    if grandchild == 0:
        hold_stdio()
        return 0

    parent = os.getpid()
    process_group = os.getpgrp()
    publish_state(state, str(grandchild))
    if parent_state:
        publish_state(parent_state, str(parent))
    if ready_state:
        publish_state(ready_state, f"{parent}:{process_group}:{grandchild}")
    if os.environ.get("CODING_WIFE_PROCESS_TREE_PARENT_EXIT") == "1":
        return 0
    hold_stdio()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
