#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C
umask 077

readonly ERROR_PREFIX='[release]'

release_release_lock() {
  return 0
}

fail() {
  /usr/bin/printf '%s %s\n' "$ERROR_PREFIX" "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if ! release_release_lock; then
    /usr/bin/printf '%s %s\n' "$ERROR_PREFIX" 'RELEASE_CLEANUP_FAILED' >&2
    exit 1
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

[[ $# -eq 0 ]] || fail 'RELEASE_ARGUMENT_INVALID'
[[ "$(/usr/bin/uname -s 2>/dev/null || true)" == 'Darwin' ]] || fail 'RELEASE_PLATFORM_UNSUPPORTED'
script_dir="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_ROOT_INVALID'
# shellcheck source=macos-release-common.sh
source "$script_dir/macos-release-common.sh"
project_root="$(cd "$script_dir/../.." >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_ROOT_INVALID'
release_acquire_lock || fail 'RELEASE_LOCK_UNAVAILABLE'

/bin/bash "$script_dir/build-macos-app.sh" || fail 'RELEASE_APP_FAILED'
/bin/bash "$script_dir/build-macos-dmg.sh" \
  --app "$project_root/src-tauri/target/release/bundle/macos/Coding Wife.app" \
  --output "$project_root/src-tauri/target/release/bundle/dmg/Coding-Wife.dmg" \
  --volume-name 'Coding Wife' \
  --overwrite || fail 'RELEASE_DMG_FAILED'
/bin/bash "$script_dir/verify-macos-release.sh" \
  --app "$project_root/src-tauri/target/release/bundle/macos/Coding Wife.app" \
  --dmg "$project_root/src-tauri/target/release/bundle/dmg/Coding-Wife.dmg" || fail 'RELEASE_VERIFY_FAILED'

/usr/bin/printf '%s macOS release completed run=%s.\n' "$ERROR_PREFIX" "$RELEASE_LOCK_RUN_ID"
