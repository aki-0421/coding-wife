#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C
umask 077

readonly ERROR_PREFIX='[release]'
readonly WORK_PREFIX='.coding-wife-release-verify.'

app_input=''
dmg_input=''
work_dir=''
mount_dir=''
mount_device=''
attached=0

fail() {
  printf '%s %s\n' "$ERROR_PREFIX" "$1" >&2
  exit 1
}

resolve_mount_device() {
  local candidate="$1"
  local device=''
  device="$(/bin/df -P "$candidate" 2>/dev/null | /usr/bin/awk 'NR == 2 { print $1 }')"
  [[ "$device" =~ ^/dev/disk[0-9]+s[0-9]+$ ]] || return 1
  printf '%s\n' "$device"
}

detach_mount() {
  local candidate="$1"
  local device="$2"
  local attempt=0
  local target="$candidate"

  if [[ "$device" =~ ^/dev/disk[0-9]+s[0-9]+$ ]]; then
    target="$device"
  fi

  while [[ "$attempt" -lt 200 ]]; do
    if ! /usr/bin/hdiutil info 2>/dev/null | /usr/bin/grep -Fq -- "$candidate"; then
      return 0
    fi
    /usr/bin/hdiutil detach -quiet "$target" >/dev/null 2>&1 || \
      /usr/bin/hdiutil detach -quiet -force "$target" >/dev/null 2>&1 || true
    /bin/sleep 0.05
    attempt=$((attempt + 1))
  done
  return 1
}

cleanup() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT HUP INT TERM
  if [[ "$attached" -eq 1 && -n "$mount_dir" ]]; then
    if [[ -z "$mount_device" ]]; then
      mount_device="$(resolve_mount_device "$mount_dir" 2>/dev/null || true)"
    fi
    detach_mount "$mount_dir" "$mount_device" || cleanup_failed=1
  fi
  if [[ -n "$work_dir" && -d "$work_dir" && ! -L "$work_dir" ]]; then
    local name=''
    name="$(/usr/bin/basename "$work_dir" 2>/dev/null || true)"
    if [[ "$name" == "$WORK_PREFIX"* ]]; then
      /bin/chmod -R u+w "$work_dir" >/dev/null 2>&1 || true
      /bin/rm -rf -- "$work_dir" >/dev/null 2>&1 || cleanup_failed=1
    else
      cleanup_failed=1
    fi
  fi
  if [[ "$cleanup_failed" -ne 0 ]]; then
    printf '%s %s device=%s mount=release-verify/mount\n' "$ERROR_PREFIX" 'RELEASE_VERIFY_CLEANUP_FAILED' "${mount_device:-unresolved}" >&2
    exit 1
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

app_seen=0
dmg_seen=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ "$app_seen" -eq 0 && $# -ge 2 ]] || fail 'RELEASE_VERIFY_ARGUMENT_INVALID'
      app_input="$2"
      app_seen=1
      shift 2
      ;;
    --dmg)
      [[ "$dmg_seen" -eq 0 && $# -ge 2 ]] || fail 'RELEASE_VERIFY_ARGUMENT_INVALID'
      dmg_input="$2"
      dmg_seen=1
      shift 2
      ;;
    *)
      fail 'RELEASE_VERIFY_ARGUMENT_INVALID'
      ;;
  esac
done

[[ "$app_seen" -eq 1 && "$dmg_seen" -eq 1 ]] || fail 'RELEASE_VERIFY_ARGUMENT_INVALID'
[[ "$(/usr/bin/uname -s 2>/dev/null || true)" == 'Darwin' ]] || fail 'RELEASE_VERIFY_PLATFORM_UNSUPPORTED'
for tool in /bin/chmod /bin/df /bin/mkdir /bin/rm /bin/sleep /usr/bin/awk /usr/bin/basename /usr/bin/dirname /usr/bin/grep /usr/bin/hdiutil /usr/bin/mktemp /usr/bin/readlink /usr/bin/touch; do
  [[ -x "$tool" ]] || fail 'RELEASE_VERIFY_TOOL_UNAVAILABLE'
done

script_dir="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_VERIFY_TOOL_UNAVAILABLE'
node_binary="$(command -v node 2>/dev/null || true)"
[[ -n "$node_binary" && -x "$node_binary" ]] || fail 'RELEASE_VERIFY_TOOL_UNAVAILABLE'

app_name="$(/usr/bin/basename "$app_input" 2>/dev/null)" || fail 'RELEASE_VERIFY_APP_INVALID'
[[ "$app_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]*\.app$ ]] || fail 'RELEASE_VERIFY_APP_INVALID'
[[ -d "$app_input" && ! -L "$app_input" ]] || fail 'RELEASE_VERIFY_APP_INVALID'
[[ -f "$dmg_input" && ! -L "$dmg_input" ]] || fail 'RELEASE_VERIFY_DMG_INVALID'

work_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/$WORK_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'RELEASE_VERIFY_WORK_UNAVAILABLE'
[[ -d "$work_dir" && ! -L "$work_dir" ]] || fail 'RELEASE_VERIFY_WORK_UNAVAILABLE'
mount_dir="$work_dir/mount"
inventory_path="$work_dir/source-inventory.json"
tool_log="$work_dir/tool.log"
/bin/mkdir "$mount_dir" >/dev/null 2>&1 || fail 'RELEASE_VERIFY_WORK_UNAVAILABLE'

"$node_binary" "$script_dir/macos-release.mjs" verify-app --app "$app_input" || fail 'RELEASE_VERIFY_APP_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" inventory --app "$app_input" --output "$inventory_path" >"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_INVENTORY_FAILED'

if ! /usr/bin/hdiutil verify -quiet "$dmg_input" >>"$tool_log" 2>&1; then
  fail 'RELEASE_VERIFY_DMG_FAILED'
fi
if ! /usr/bin/hdiutil attach \
  -quiet \
  -readonly \
  -nobrowse \
  -noautoopen \
  -mountpoint "$mount_dir" \
  "$dmg_input" >>"$tool_log" 2>&1; then
  fail 'RELEASE_VERIFY_MOUNT_FAILED'
fi
attached=1
mount_device="$(resolve_mount_device "$mount_dir")" || fail 'RELEASE_VERIFY_MOUNT_DEVICE_INVALID'

if [[ "${CODING_WIFE_RELEASE_TEST_FAULT:-}" == 'after-attach' ]]; then
  fail 'TEST_INJECTED_FAILURE'
fi
if [[ "${CODING_WIFE_RELEASE_TEST_WAIT:-}" == 'after-attach' ]]; then
  /usr/bin/touch "$work_dir/test-hook-ready" || fail 'TEST_HOOK_FAILED'
  while :; do /bin/sleep 1; done
fi

shopt -s dotglob nullglob
root_entries=("$mount_dir"/*)
shopt -u dotglob nullglob
[[ ${#root_entries[@]} -eq 2 ]] || fail 'RELEASE_VERIFY_CONTENTS_INVALID'
[[ -d "$mount_dir/$app_name" && ! -L "$mount_dir/$app_name" ]] || fail 'RELEASE_VERIFY_CONTENTS_INVALID'
[[ -L "$mount_dir/Applications" ]] || fail 'RELEASE_VERIFY_CONTENTS_INVALID'
[[ "$(/usr/bin/readlink "$mount_dir/Applications" 2>/dev/null || true)" == '/Applications' ]] || fail 'RELEASE_VERIFY_CONTENTS_INVALID'

if /usr/bin/touch "$mount_dir/.coding-wife-write-probe" >/dev/null 2>&1; then
  /bin/rm -f "$mount_dir/.coding-wife-write-probe" >/dev/null 2>&1 || true
  fail 'RELEASE_VERIFY_NOT_READ_ONLY'
fi

"$node_binary" "$script_dir/macos-release.mjs" verify-app \
  --app "$mount_dir/$app_name" \
  --expected "$inventory_path" || fail 'RELEASE_VERIFY_MOUNTED_APP_FAILED'

detach_mount "$mount_dir" "$mount_device" || fail 'RELEASE_VERIFY_DETACH_FAILED'
attached=0
mount_device=''

"$node_binary" "$script_dir/macos-release.mjs" dmg-summary --dmg "$dmg_input" || fail 'RELEASE_VERIFY_SUMMARY_FAILED'
printf '%s macOS app and independent read-only DMG mount verified.\n' "$ERROR_PREFIX"
