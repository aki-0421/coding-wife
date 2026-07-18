#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C
umask 077

readonly ERROR_PREFIX='[release]'
readonly WORK_PREFIX='.coding-wife-dmg-work.'
readonly READY_PREFIX='.coding-wife-dmg-ready.'
readonly BACKUP_PREFIX='.coding-wife-dmg-backup.'

app_input=''
output_input=''
volume_name=''
overwrite=0
work_dir=''
ready_container=''
backup_container=''
current_mount=''
current_device=''
current_info_plist=''
output_path=''
manifest_path=''
publish_started=0
publish_committed=0
original_output=0
original_manifest=0

release_release_lock() {
  return 0
}

usage() {
  /usr/bin/printf '%s\n' 'Usage: build-macos-dmg.sh --app <bundle.app> --output <image.dmg> --volume-name <name> [--overwrite]'
}

fail() {
  /usr/bin/printf '%s %s\n' "$ERROR_PREFIX" "$1" >&2
  exit 1
}

safe_remove_tree() {
  local candidate="$1"
  local expected_parent="$2"
  local expected_prefix="$3"
  local parent=''
  local name=''

  [[ -n "$candidate" && -d "$candidate" && ! -L "$candidate" ]] || return 0
  parent="$(cd "$candidate/.." >/dev/null 2>&1 && pwd -P)" || return 1
  name="$(/usr/bin/basename "$candidate" 2>/dev/null || true)"
  [[ "$parent" == "$expected_parent" && "$name" == "$expected_prefix"* ]] || return 1
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

rollback_publish() {
  local failed=0
  [[ "$publish_started" -eq 1 && "$publish_committed" -eq 0 ]] || return 0

  if [[ -e "$output_path" || -L "$output_path" ]]; then
    [[ -f "$output_path" && ! -L "$output_path" ]] || failed=1
    [[ "$failed" -ne 0 ]] || /bin/rm -f -- "$output_path" >/dev/null 2>&1 || failed=1
  fi
  if [[ -e "$manifest_path" || -L "$manifest_path" ]]; then
    [[ -f "$manifest_path" && ! -L "$manifest_path" ]] || failed=1
    [[ "$failed" -ne 0 ]] || /bin/rm -f -- "$manifest_path" >/dev/null 2>&1 || failed=1
  fi
  if [[ "$original_output" -eq 1 ]]; then
    [[ -f "$backup_container/original.dmg" && ! -L "$backup_container/original.dmg" ]] || failed=1
    [[ "$failed" -ne 0 ]] || /bin/mv "$backup_container/original.dmg" "$output_path" >/dev/null 2>&1 || failed=1
  fi
  if [[ "$original_manifest" -eq 1 ]]; then
    [[ -f "$backup_container/original.manifest" && ! -L "$backup_container/original.manifest" ]] || failed=1
    [[ "$failed" -ne 0 ]] || /bin/mv "$backup_container/original.manifest" "$manifest_path" >/dev/null 2>&1 || failed=1
  fi
  return "$failed"
}

cleanup() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT HUP INT TERM

  cleanup_current_mount || cleanup_failed=1
  rollback_publish || cleanup_failed=1
  if [[ -n "$ready_container" ]]; then
    safe_remove_tree "$ready_container" "${output_parent:-invalid}" "$READY_PREFIX" || cleanup_failed=1
  fi
  if [[ -n "$backup_container" ]]; then
    safe_remove_tree "$backup_container" "${output_parent:-invalid}" "$BACKUP_PREFIX" || cleanup_failed=1
  fi
  if [[ -n "$work_dir" ]]; then
    safe_remove_tree "$work_dir" '/private/tmp' "$WORK_PREFIX" || cleanup_failed=1
  fi
  release_release_lock || cleanup_failed=1

  if [[ "$cleanup_failed" -ne 0 ]]; then
    /usr/bin/printf '%s %s device=%s mount=release-dmg/mount\n' \
      "$ERROR_PREFIX" 'DMG_CLEANUP_FAILED' "${current_device:-unresolved}" >&2
    exit 1
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

app_seen=0
output_seen=0
volume_seen=0
overwrite_seen=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app)
      [[ "$app_seen" -eq 0 && $# -ge 2 ]] || fail 'DMG_ARGUMENT_INVALID'
      app_input="$2"
      app_seen=1
      shift 2
      ;;
    --output)
      [[ "$output_seen" -eq 0 && $# -ge 2 ]] || fail 'DMG_ARGUMENT_INVALID'
      output_input="$2"
      output_seen=1
      shift 2
      ;;
    --volume-name)
      [[ "$volume_seen" -eq 0 && $# -ge 2 ]] || fail 'DMG_ARGUMENT_INVALID'
      volume_name="$2"
      volume_seen=1
      shift 2
      ;;
    --overwrite)
      [[ "$overwrite_seen" -eq 0 ]] || fail 'DMG_ARGUMENT_INVALID'
      overwrite=1
      overwrite_seen=1
      shift
      ;;
    --help)
      [[ $# -eq 1 ]] || fail 'DMG_ARGUMENT_INVALID'
      usage
      exit 0
      ;;
    *) fail 'DMG_ARGUMENT_INVALID' ;;
  esac
done

[[ "$app_seen" -eq 1 && "$output_seen" -eq 1 && "$volume_seen" -eq 1 ]] || fail 'DMG_ARGUMENT_INVALID'
[[ "$(/usr/bin/uname -s 2>/dev/null || true)" == 'Darwin' ]] || fail 'DMG_PLATFORM_UNSUPPORTED'

for tool in /bin/chmod /bin/ln /bin/mkdir /bin/mv /bin/rm /bin/sleep /usr/bin/basename /usr/bin/dirname /usr/bin/ditto /usr/bin/hdiutil /usr/bin/mktemp /usr/bin/readlink /usr/bin/touch /usr/bin/uname /usr/bin/uuidgen; do
  [[ -x "$tool" ]] || fail 'DMG_TOOL_UNAVAILABLE'
done
script_dir="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)" || fail 'DMG_TOOL_UNAVAILABLE'
# shellcheck source=macos-release-common.sh
source "$script_dir/macos-release-common.sh"
node_binary="$(command -v node 2>/dev/null || true)"
[[ -n "$node_binary" && -x "$node_binary" ]] || fail 'DMG_TOOL_UNAVAILABLE'
release_acquire_lock || fail 'DMG_LOCK_UNAVAILABLE'

[[ -n "$app_input" && -n "$output_input" && -n "$volume_name" ]] || fail 'DMG_ARGUMENT_INVALID'
[[ ! "$app_input" =~ [[:cntrl:]] && ! "$output_input" =~ [[:cntrl:]] && ! "$volume_name" =~ [[:cntrl:]] ]] || fail 'DMG_ARGUMENT_INVALID'
[[ ${#volume_name} -le 63 && "$volume_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]*$ ]] || fail 'DMG_VOLUME_NAME_INVALID'

app_parent_input="$(/usr/bin/dirname "$app_input" 2>/dev/null)" || fail 'DMG_APP_INVALID'
app_name="$(/usr/bin/basename "$app_input" 2>/dev/null)" || fail 'DMG_APP_INVALID'
[[ ${#app_name} -le 127 && "$app_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]*\.app$ ]] || fail 'DMG_APP_INVALID'
[[ -d "$app_input" && ! -L "$app_input" ]] || fail 'DMG_APP_INVALID'
app_parent="$(cd "$app_parent_input" >/dev/null 2>&1 && pwd -P)" || fail 'DMG_APP_INVALID'
app_path="$app_parent/$app_name"
app_manifest="$app_path.release.json"
[[ -f "$app_manifest" && ! -L "$app_manifest" ]] || fail 'DMG_APP_MANIFEST_INVALID'

output_parent_input="$(/usr/bin/dirname "$output_input" 2>/dev/null)" || fail 'DMG_OUTPUT_INVALID'
output_name="$(/usr/bin/basename "$output_input" 2>/dev/null)" || fail 'DMG_OUTPUT_INVALID'
[[ ${#output_name} -le 127 && "$output_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]*\.dmg$ ]] || fail 'DMG_OUTPUT_INVALID'
/bin/mkdir -p "$output_parent_input" >/dev/null 2>&1 || fail 'DMG_OUTPUT_UNAVAILABLE'
output_parent="$(cd "$output_parent_input" >/dev/null 2>&1 && pwd -P)" || fail 'DMG_OUTPUT_UNAVAILABLE'
output_path="$output_parent/$output_name"
manifest_path="$output_path.release.json"

case "$output_path/" in "$app_path/"*) fail 'DMG_OUTPUT_INVALID' ;; esac
[[ ! -L "$output_path" && ! -L "$manifest_path" ]] || fail 'DMG_OUTPUT_INVALID'
if [[ -e "$output_path" || -e "$manifest_path" ]]; then
  [[ "$overwrite" -eq 1 ]] || fail 'DMG_OUTPUT_EXISTS'
  [[ ! -e "$output_path" || -f "$output_path" ]] || fail 'DMG_OUTPUT_INVALID'
  [[ ! -e "$manifest_path" || -f "$manifest_path" ]] || fail 'DMG_OUTPUT_INVALID'
fi

work_dir="$(/usr/bin/mktemp -d "/private/tmp/$WORK_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'DMG_WORK_UNAVAILABLE'
[[ -d "$work_dir" && ! -L "$work_dir" ]] || fail 'DMG_WORK_UNAVAILABLE'
/bin/chmod 700 "$work_dir" >/dev/null 2>&1 || fail 'DMG_WORK_UNAVAILABLE'
tool_log="$work_dir/tool.log"
/usr/bin/touch "$tool_log" >/dev/null 2>&1 || fail 'DMG_WORK_UNAVAILABLE'
/bin/chmod 600 "$tool_log" >/dev/null 2>&1 || fail 'DMG_WORK_UNAVAILABLE'

stage_dir="$work_dir/stage"
rw_image="$work_dir/source.dmg"
candidate_image="$work_dir/candidate.dmg"
source_inventory="$work_dir/source-inventory.json"
/bin/mkdir "$stage_dir" >/dev/null 2>&1 || fail 'DMG_STAGE_FAILED'

"$node_binary" "$script_dir/macos-release.mjs" inventory \
  --app "$app_path" --output "$source_inventory" >>"$tool_log" 2>&1 || fail 'DMG_SOURCE_INVENTORY_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" verify-app \
  --app "$app_path" --expected "$source_inventory" >>"$tool_log" 2>&1 || fail 'DMG_SOURCE_APP_INVALID'
app_run_id="$("$node_binary" "$script_dir/macos-release.mjs" manifest-run-id --manifest "$app_manifest" 2>>"$tool_log")" || fail 'DMG_APP_MANIFEST_INVALID'
"$node_binary" "$script_dir/macos-release.mjs" manifest-verify \
  --kind app --run-id "$app_run_id" --artifact "$app_path" \
  --inventory "$source_inventory" --manifest "$app_manifest" >>"$tool_log" 2>&1 || fail 'DMG_APP_MANIFEST_INVALID'

/usr/bin/ditto "$app_path" "$stage_dir/$app_name" >>"$tool_log" 2>&1 || fail 'DMG_APP_COPY_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" verify-app \
  --app "$stage_dir/$app_name" --expected "$source_inventory" >>"$tool_log" 2>&1 || fail 'DMG_STAGED_APP_INVALID'
/bin/ln -s /Applications "$stage_dir/Applications" >>"$tool_log" 2>&1 || fail 'DMG_APPLICATIONS_LINK_FAILED'

/usr/bin/hdiutil create -quiet -ov -srcfolder "$stage_dir" -volname "$volume_name" \
  -fs HFS+ -format UDRW "$rw_image" >>"$tool_log" 2>&1 || fail 'DMG_IMAGE_CREATE_FAILED'
/usr/bin/hdiutil convert -quiet "$rw_image" -format UDZO -imagekey zlib-level=9 \
  -o "$candidate_image" >>"$tool_log" 2>&1 || fail 'DMG_IMAGE_CONVERT_FAILED'
/usr/bin/hdiutil verify -quiet "$candidate_image" >>"$tool_log" 2>&1 || fail 'DMG_IMAGE_VERIFY_FAILED'

verify_candidate_mount() {
  local mount_index="$1"
  local attach_plist="$work_dir/attach-$mount_index.plist"
  local mount_dir="$work_dir/mount-$mount_index"
  local info_plist="$work_dir/info-$mount_index.plist"
  local hook="dmg-after-attach-$mount_index"
  local root_entries=()

  /bin/mkdir "$mount_dir" >/dev/null 2>&1 || return 1
  mount_dir="$(cd "$mount_dir" >/dev/null 2>&1 && pwd -P)" || return 1
  current_mount="$mount_dir"
  current_device=''
  current_info_plist="$info_plist"

  /usr/bin/hdiutil attach -plist -readonly -nobrowse -noautoopen \
    -mountpoint "$mount_dir" "$candidate_image" >"$attach_plist" 2>>"$tool_log" || return 1
  current_device="$(release_mount_device_from_plist \
    "$node_binary" "$script_dir/macos-release.mjs" \
    "$attach_plist" "$mount_dir" "$tool_log")" || return 1

  if [[ "${CODING_WIFE_RELEASE_TEST_FAULT:-}" == "$hook" || \
    "${CODING_WIFE_RELEASE_TEST_FAULT:-}" == 'dmg-after-attach' ]]; then
    return 1
  fi
  if [[ "${CODING_WIFE_RELEASE_TEST_WAIT:-}" == "$hook" || \
    "${CODING_WIFE_RELEASE_TEST_WAIT:-}" == 'dmg-after-attach' ]]; then
    /usr/bin/touch "$work_dir/test-hook-ready" >/dev/null 2>&1 || return 1
    while :; do /bin/sleep 1; done
  fi

  shopt -s dotglob nullglob
  root_entries=("$mount_dir"/*)
  shopt -u dotglob nullglob
  [[ ${#root_entries[@]} -eq 2 ]] || return 1
  [[ -d "$mount_dir/$app_name" && ! -L "$mount_dir/$app_name" ]] || return 1
  [[ -L "$mount_dir/Applications" ]] || return 1
  [[ "$(/usr/bin/readlink "$mount_dir/Applications" 2>/dev/null || true)" == '/Applications' ]] || return 1
  if /usr/bin/touch "$mount_dir/.coding-wife-write-probe" >/dev/null 2>&1; then
    /bin/rm -f "$mount_dir/.coding-wife-write-probe" >/dev/null 2>&1 || true
    return 1
  fi
  "$node_binary" "$script_dir/macos-release.mjs" verify-app \
    --app "$mount_dir/$app_name" --expected "$source_inventory" >>"$tool_log" 2>&1 || return 1

  release_detach_mount "$node_binary" "$script_dir/macos-release.mjs" \
    "$mount_dir" "$current_device" "$info_plist" "$tool_log" || return 1
  current_mount=''
  current_device=''
  return 0
}

verify_candidate_mount 1 || fail 'DMG_FIRST_MOUNT_VERIFY_FAILED'
verify_candidate_mount 2 || fail 'DMG_SECOND_MOUNT_VERIFY_FAILED'

ready_container="$(/usr/bin/mktemp -d "$output_parent/$READY_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'DMG_READY_FAILED'
[[ -d "$ready_container" && ! -L "$ready_container" ]] || fail 'DMG_READY_FAILED'
/bin/chmod 700 "$ready_container" >/dev/null 2>&1 || fail 'DMG_READY_FAILED'
ready_image="$ready_container/$output_name"
ready_manifest="$ready_container/$output_name.release.json"
/bin/mv "$candidate_image" "$ready_image" >/dev/null 2>&1 || fail 'DMG_READY_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" manifest-create \
  --kind dmg --run-id "$app_run_id" --artifact "$ready_image" \
  --inventory "$source_inventory" --output "$ready_manifest" >>"$tool_log" 2>&1 || fail 'DMG_MANIFEST_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" manifest-verify \
  --kind dmg --run-id "$app_run_id" --artifact "$ready_image" \
  --inventory "$source_inventory" --manifest "$ready_manifest" >>"$tool_log" 2>&1 || fail 'DMG_MANIFEST_FAILED'

if [[ "${CODING_WIFE_RELEASE_TEST_FAULT:-}" == 'dmg-after-verified' ]]; then
  fail 'TEST_INJECTED_FAILURE'
fi
if [[ "${CODING_WIFE_RELEASE_TEST_WAIT:-}" == 'dmg-after-verified' ]]; then
  /usr/bin/touch "$work_dir/test-hook-ready" >/dev/null 2>&1 || fail 'TEST_HOOK_FAILED'
  while :; do /bin/sleep 1; done
fi

backup_container="$(/usr/bin/mktemp -d "$output_parent/$BACKUP_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'DMG_PUBLISH_FAILED'
[[ -d "$backup_container" && ! -L "$backup_container" ]] || fail 'DMG_PUBLISH_FAILED'
/bin/chmod 700 "$backup_container" >/dev/null 2>&1 || fail 'DMG_PUBLISH_FAILED'
[[ -e "$output_path" ]] && original_output=1
[[ -e "$manifest_path" ]] && original_manifest=1
publish_started=1
if [[ "$original_output" -eq 1 ]]; then
  /bin/mv "$output_path" "$backup_container/original.dmg" >/dev/null 2>&1 || fail 'DMG_PUBLISH_FAILED'
fi
if [[ "$original_manifest" -eq 1 ]]; then
  /bin/mv "$manifest_path" "$backup_container/original.manifest" >/dev/null 2>&1 || fail 'DMG_PUBLISH_FAILED'
fi
/bin/mv "$ready_image" "$output_path" >/dev/null 2>&1 || fail 'DMG_PUBLISH_FAILED'
/bin/mv "$ready_manifest" "$manifest_path" >/dev/null 2>&1 || fail 'DMG_PUBLISH_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" manifest-verify \
  --kind dmg --run-id "$app_run_id" --artifact "$output_path" \
  --inventory "$source_inventory" --manifest "$manifest_path" >>"$tool_log" 2>&1 || fail 'DMG_PUBLISH_FAILED'
publish_committed=1

safe_remove_tree "$backup_container" "$output_parent" "$BACKUP_PREFIX" || fail 'DMG_CLEANUP_FAILED'
backup_container=''
safe_remove_tree "$ready_container" "$output_parent" "$READY_PREFIX" || fail 'DMG_CLEANUP_FAILED'
ready_container=''
safe_remove_tree "$work_dir" '/private/tmp' "$WORK_PREFIX" || fail 'DMG_CLEANUP_FAILED'
work_dir=''

/usr/bin/printf '%s macOS DMG created and verified run=%s.\n' "$ERROR_PREFIX" "$app_run_id"
