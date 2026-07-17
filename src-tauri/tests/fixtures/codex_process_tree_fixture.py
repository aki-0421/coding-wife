#!/usr/bin/env python3
"""Process-group fixture whose grandchild deliberately keeps stdio open."""

import os
import pathlib
import signal
import time


def hold_stdio():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        time.sleep(1)


def main():
    state = os.environ.get("CODING_WIFE_PROCESS_TREE_STATE")
    if not state:
        return 2

    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    grandchild = os.fork()
    if grandchild == 0:
        hold_stdio()
        return 0

    pathlib.Path(state).write_text(str(grandchild), encoding="utf-8")
    if os.environ.get("CODING_WIFE_PROCESS_TREE_PARENT_EXIT") == "1":
        return 0
    hold_stdio()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
