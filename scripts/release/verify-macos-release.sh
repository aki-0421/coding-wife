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
current_mount=''
current_device=''
current_info_plist=''

release_release_lock() {
  return 0
}

fail() {
  /usr/bin/printf '%s %s\n' "$ERROR_PREFIX" "$1" >&2
  exit 1
}

safe_remove_work() {
  local candidate="$1"
  local parent=''
  local name=''
  [[ -n "$candidate" && -d "$candidate" && ! -L "$candidate" ]] || return 0
  parent="$(cd "$candidate/.." >/dev/null 2>&1 && pwd -P)" || return 1
  name="$(/usr/bin/basename "$candidate" 2>/dev/null || true)"
  [[ "$parent" == '/private/tmp' && "$name" == "$WORK_PREFIX"* ]] || return 1
  /bin/chmod -R u+w "$candidate" >/dev/null 2>&1 || true
  /bin/rm -rf -- "$candidate" >/dev/null 2>&1
}

cleanup_current_mount() {
  local cleanup_device="$current_device"
  [[ -n "$current_mount" ]] || return 0
  if [[ -z "$cleanup_device" ]]; then
    cleanup_device="$(release_current_mount_device \
      "$node_binary" "$script_dir/macos-release.mjs" \
      "$current_mount" "$current_info_plist" "$tool_log" 2>/dev/null || true)"
  fi
  if [[ -n "$cleanup_device" ]]; then
    release_detach_mount \
      "$node_binary" "$script_dir/macos-release.mjs" \
      "$current_mount" "$cleanup_device" "$current_info_plist" "$tool_log" || return 1
  else
    release_mount_path_is_absent \
      "$node_binary" "$script_dir/macos-release.mjs" \
      "$current_mount" "$current_info_plist" "$tool_log" || return 1
  fi
  current_mount=''
  current_device=''
  return 0
}

cleanup() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT HUP INT TERM
  cleanup_current_mount || cleanup_failed=1
  safe_remove_work "$work_dir" || cleanup_failed=1
  release_release_lock || cleanup_failed=1
  if [[ "$cleanup_failed" -ne 0 ]]; then
    /usr/bin/printf '%s %s device=%s mount=release-verify/mount\n' \
      "$ERROR_PREFIX" 'RELEASE_VERIFY_CLEANUP_FAILED' "${current_device:-unresolved}" >&2
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
    *) fail 'RELEASE_VERIFY_ARGUMENT_INVALID' ;;
  esac
done

[[ "$app_seen" -eq 1 && "$dmg_seen" -eq 1 ]] || fail 'RELEASE_VERIFY_ARGUMENT_INVALID'
[[ "$(/usr/bin/uname -s 2>/dev/null || true)" == 'Darwin' ]] || fail 'RELEASE_VERIFY_PLATFORM_UNSUPPORTED'
for tool in /bin/chmod /bin/mkdir /bin/rm /bin/sleep /usr/bin/basename /usr/bin/dirname /usr/bin/hdiutil /usr/bin/mktemp /usr/bin/readlink /usr/bin/touch /usr/bin/uname /usr/bin/uuidgen; do
  [[ -x "$tool" ]] || fail 'RELEASE_VERIFY_TOOL_UNAVAILABLE'
done
script_dir="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_VERIFY_TOOL_UNAVAILABLE'
# shellcheck source=macos-release-common.sh
source "$script_dir/macos-release-common.sh"
node_binary="$(command -v node 2>/dev/null || true)"
[[ -n "$node_binary" && -x "$node_binary" ]] || fail 'RELEASE_VERIFY_TOOL_UNAVAILABLE'
release_acquire_lock || fail 'RELEASE_VERIFY_LOCK_UNAVAILABLE'

app_parent_input="$(/usr/bin/dirname "$app_input" 2>/dev/null)" || fail 'RELEASE_VERIFY_APP_INVALID'
app_name="$(/usr/bin/basename "$app_input" 2>/dev/null)" || fail 'RELEASE_VERIFY_APP_INVALID'
[[ "$app_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]*\.app$ ]] || fail 'RELEASE_VERIFY_APP_INVALID'
[[ -d "$app_input" && ! -L "$app_input" ]] || fail 'RELEASE_VERIFY_APP_INVALID'
app_parent="$(cd "$app_parent_input" >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_VERIFY_APP_INVALID'
app_path="$app_parent/$app_name"
app_manifest="$app_path.release.json"
[[ -f "$app_manifest" && ! -L "$app_manifest" ]] || fail 'RELEASE_VERIFY_APP_MANIFEST_INVALID'

dmg_parent_input="$(/usr/bin/dirname "$dmg_input" 2>/dev/null)" || fail 'RELEASE_VERIFY_DMG_INVALID'
dmg_name="$(/usr/bin/basename "$dmg_input" 2>/dev/null)" || fail 'RELEASE_VERIFY_DMG_INVALID'
[[ "$dmg_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]*\.dmg$ ]] || fail 'RELEASE_VERIFY_DMG_INVALID'
[[ -f "$dmg_input" && ! -L "$dmg_input" ]] || fail 'RELEASE_VERIFY_DMG_INVALID'
dmg_parent="$(cd "$dmg_parent_input" >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_VERIFY_DMG_INVALID'
dmg_path="$dmg_parent/$dmg_name"
dmg_manifest="$dmg_path.release.json"
[[ -f "$dmg_manifest" && ! -L "$dmg_manifest" ]] || fail 'RELEASE_VERIFY_DMG_MANIFEST_INVALID'

work_dir="$(/usr/bin/mktemp -d "/private/tmp/$WORK_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'RELEASE_VERIFY_WORK_UNAVAILABLE'
[[ -d "$work_dir" && ! -L "$work_dir" ]] || fail 'RELEASE_VERIFY_WORK_UNAVAILABLE'
/bin/chmod 700 "$work_dir" >/dev/null 2>&1 || fail 'RELEASE_VERIFY_WORK_UNAVAILABLE'
tool_log="$work_dir/tool.log"
/usr/bin/touch "$tool_log" >/dev/null 2>&1 || fail 'RELEASE_VERIFY_WORK_UNAVAILABLE'
/bin/chmod 600 "$tool_log" >/dev/null 2>&1 || fail 'RELEASE_VERIFY_WORK_UNAVAILABLE'

inventory_path="$work_dir/source-inventory.json"
snapshot_dir="$work_dir/snapshot"
snapshot_path="$snapshot_dir/$dmg_name"
snapshot_metadata="$work_dir/dmg-snapshot.json"
manifest_snapshot="$work_dir/dmg-manifest.snapshot"
manifest_snapshot_metadata="$work_dir/manifest-snapshot.json"
mount_dir="$work_dir/mount"
attach_plist="$work_dir/attach.plist"
info_plist="$work_dir/info.plist"
/bin/mkdir "$snapshot_dir" "$mount_dir" >/dev/null 2>&1 || fail 'RELEASE_VERIFY_WORK_UNAVAILABLE'
mount_dir="$(cd "$mount_dir" >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_VERIFY_WORK_UNAVAILABLE'

"$node_binary" "$script_dir/macos-release.mjs" inventory \
  --app "$app_path" --output "$inventory_path" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_INVENTORY_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" verify-app \
  --app "$app_path" --expected "$inventory_path" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_APP_FAILED'
app_run_id="$("$node_binary" "$script_dir/macos-release.mjs" manifest-run-id --manifest "$app_manifest" 2>>"$tool_log")" || fail 'RELEASE_VERIFY_APP_MANIFEST_INVALID'
"$node_binary" "$script_dir/macos-release.mjs" manifest-verify \
  --kind app --run-id "$app_run_id" --artifact "$app_path" \
  --inventory "$inventory_path" --manifest "$app_manifest" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_APP_MANIFEST_INVALID'

"$node_binary" "$script_dir/macos-release.mjs" snapshot-create \
  --source "$dmg_path" --snapshot "$snapshot_path" --metadata "$snapshot_metadata" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_SNAPSHOT_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" snapshot-create \
  --source "$dmg_manifest" --snapshot "$manifest_snapshot" --metadata "$manifest_snapshot_metadata" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_MANIFEST_SNAPSHOT_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" manifest-verify \
  --kind dmg --run-id "$app_run_id" --artifact "$snapshot_path" \
  --inventory "$inventory_path" --manifest "$manifest_snapshot" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_DMG_MANIFEST_INVALID'

if [[ "${CODING_WIFE_RELEASE_TEST_FAULT:-}" == 'verify-after-snapshot' ]]; then
  fail 'TEST_INJECTED_FAILURE'
fi
if [[ "${CODING_WIFE_RELEASE_TEST_WAIT:-}" == 'verify-after-snapshot' ]]; then
  /usr/bin/touch "$work_dir/test-hook-ready" >/dev/null 2>&1 || fail 'TEST_HOOK_FAILED'
  while [[ ! -f "$work_dir/test-hook-continue" ]]; do /bin/sleep 0.05; done
fi

/usr/bin/hdiutil verify -quiet "$snapshot_path" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_DMG_FAILED'
current_mount="$mount_dir"
current_device=''
current_info_plist="$info_plist"
/usr/bin/hdiutil attach -plist -readonly -nobrowse -noautoopen \
  -mountpoint "$mount_dir" "$snapshot_path" >"$attach_plist" 2>>"$tool_log" || fail 'RELEASE_VERIFY_MOUNT_FAILED'
current_device="$(release_mount_device_from_plist \
  "$node_binary" "$script_dir/macos-release.mjs" \
  "$attach_plist" "$mount_dir" "$tool_log")" || fail 'RELEASE_VERIFY_MOUNT_DEVICE_INVALID'

if [[ "${CODING_WIFE_RELEASE_TEST_FAULT:-}" == 'verify-after-attach' ]]; then
  fail 'TEST_INJECTED_FAILURE'
fi
if [[ "${CODING_WIFE_RELEASE_TEST_WAIT:-}" == 'verify-after-attach' ]]; then
  /usr/bin/touch "$work_dir/test-hook-ready" >/dev/null 2>&1 || fail 'TEST_HOOK_FAILED'
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
  --app "$mount_dir/$app_name" --expected "$inventory_path" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_MOUNTED_APP_FAILED'

release_detach_mount "$node_binary" "$script_dir/macos-release.mjs" \
  "$mount_dir" "$current_device" "$info_plist" "$tool_log" || fail 'RELEASE_VERIFY_DETACH_FAILED'
current_mount=''
current_device=''

"$node_binary" "$script_dir/macos-release.mjs" snapshot-assert \
  --source "$dmg_path" --snapshot "$snapshot_path" --metadata "$snapshot_metadata" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_DMG_CHANGED'
"$node_binary" "$script_dir/macos-release.mjs" snapshot-assert \
  --source "$dmg_manifest" --snapshot "$manifest_snapshot" --metadata "$manifest_snapshot_metadata" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_MANIFEST_CHANGED'
"$node_binary" "$script_dir/macos-release.mjs" verify-app \
  --app "$app_path" --expected "$inventory_path" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_APP_CHANGED'
"$node_binary" "$script_dir/macos-release.mjs" manifest-verify \
  --kind app --run-id "$app_run_id" --artifact "$app_path" \
  --inventory "$inventory_path" --manifest "$app_manifest" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_APP_MANIFEST_CHANGED'

"$node_binary" "$script_dir/macos-release.mjs" dmg-summary --dmg "$snapshot_path" || fail 'RELEASE_VERIFY_SUMMARY_FAILED'
/usr/bin/printf '%s macOS app and independent read-only DMG snapshot verified run=%s.\n' "$ERROR_PREFIX" "$app_run_id"
