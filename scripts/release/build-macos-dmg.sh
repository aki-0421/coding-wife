#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C
umask 077

readonly ERROR_PREFIX='error:'
readonly READY_PREFIX='.coding-wife-dmg-ready.'
readonly WORK_PREFIX='.coding-wife-dmg-work.'

app_input=''
output_input=''
volume_name=''
overwrite=0
work_dir=''
ready_path=''
mount_dir=''
mount_device=''
attached=0

usage() {
  printf '%s\n' 'Usage: build-macos-dmg.sh --app <bundle.app> --output <image.dmg> --volume-name <name> [--overwrite]'
}

fail() {
  printf '%s %s\n' "$ERROR_PREFIX" "$1" >&2
  exit 1
}

safe_remove_work_dir() {
  local candidate="$1"
  local name=''

  [[ -n "$candidate" && -d "$candidate" && ! -L "$candidate" ]] || return 0
  name="$(/usr/bin/basename "$candidate" 2>/dev/null || true)"
  [[ "$name" == "$WORK_PREFIX"* ]] || return 1
  /bin/chmod -R u+w "$candidate" >/dev/null 2>&1 || true
  /bin/rm -rf -- "$candidate" >/dev/null 2>&1
}

safe_remove_ready_path() {
  local candidate="$1"
  local name=''

  [[ -n "$candidate" ]] || return 0
  name="$(/usr/bin/basename "$candidate" 2>/dev/null || true)"
  [[ "$name" == "$READY_PREFIX"* ]] || return 1
  [[ ! -d "$candidate" || -L "$candidate" ]] || return 1
  /bin/rm -f -- "$candidate" >/dev/null 2>&1
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

  safe_remove_work_dir "$work_dir" || cleanup_failed=1
  safe_remove_ready_path "$ready_path" || cleanup_failed=1

  if [[ "$cleanup_failed" -ne 0 ]]; then
    printf '%s %s device=%s mount=release-work/mount\n' "$ERROR_PREFIX" 'CLEANUP_FAILED' "${mount_device:-unresolved}" >&2
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
      [[ "$app_seen" -eq 0 && $# -ge 2 ]] || fail 'INVALID_ARGUMENTS'
      app_input="$2"
      app_seen=1
      shift 2
      ;;
    --output)
      [[ "$output_seen" -eq 0 && $# -ge 2 ]] || fail 'INVALID_ARGUMENTS'
      output_input="$2"
      output_seen=1
      shift 2
      ;;
    --volume-name)
      [[ "$volume_seen" -eq 0 && $# -ge 2 ]] || fail 'INVALID_ARGUMENTS'
      volume_name="$2"
      volume_seen=1
      shift 2
      ;;
    --overwrite)
      [[ "$overwrite_seen" -eq 0 ]] || fail 'INVALID_ARGUMENTS'
      overwrite=1
      overwrite_seen=1
      shift
      ;;
    --help)
      [[ $# -eq 1 ]] || fail 'INVALID_ARGUMENTS'
      usage
      exit 0
      ;;
    *)
      fail 'INVALID_ARGUMENTS'
      ;;
  esac
done

[[ "$app_seen" -eq 1 && "$output_seen" -eq 1 && "$volume_seen" -eq 1 ]] || fail 'INVALID_ARGUMENTS'

[[ "$(/usr/bin/uname -s 2>/dev/null || true)" == 'Darwin' ]] || fail 'UNSUPPORTED_PLATFORM'

for tool in \
  /bin/chmod \
  /bin/df \
  /bin/ln \
  /bin/mkdir \
  /bin/mv \
  /bin/rm \
  /bin/sleep \
  /usr/bin/basename \
  /usr/bin/awk \
  /usr/bin/dirname \
  /usr/bin/ditto \
  /usr/bin/grep \
  /usr/bin/hdiutil \
  /usr/bin/mktemp \
  /usr/bin/readlink \
  /usr/bin/touch; do
  [[ -x "$tool" ]] || fail 'REQUIRED_TOOL_UNAVAILABLE'
done

script_dir="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)" || fail 'REQUIRED_TOOL_UNAVAILABLE'
node_binary="$(command -v node 2>/dev/null || true)"
[[ -n "$node_binary" && -x "$node_binary" ]] || fail 'REQUIRED_TOOL_UNAVAILABLE'

[[ -n "$app_input" && -n "$output_input" && -n "$volume_name" ]] || fail 'INVALID_ARGUMENTS'
[[ ! "$app_input" =~ [[:cntrl:]] && ! "$output_input" =~ [[:cntrl:]] && ! "$volume_name" =~ [[:cntrl:]] ]] || fail 'INVALID_ARGUMENTS'
[[ ${#volume_name} -le 63 && "$volume_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]*$ ]] || fail 'INVALID_VOLUME_NAME'

app_parent_input="$(/usr/bin/dirname "$app_input" 2>/dev/null)" || fail 'INVALID_APP_BUNDLE'
app_name="$(/usr/bin/basename "$app_input" 2>/dev/null)" || fail 'INVALID_APP_BUNDLE'
[[ ${#app_name} -le 127 && "$app_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]*\.app$ ]] || fail 'INVALID_APP_BUNDLE'
[[ -d "$app_input" && ! -L "$app_input" ]] || fail 'INVALID_APP_BUNDLE'
[[ -d "$app_input/Contents" && ! -L "$app_input/Contents" ]] || fail 'INVALID_APP_BUNDLE'
[[ -f "$app_input/Contents/Info.plist" && ! -L "$app_input/Contents/Info.plist" ]] || fail 'INVALID_APP_BUNDLE'
app_parent="$(cd "$app_parent_input" >/dev/null 2>&1 && pwd -P)" || fail 'INVALID_APP_BUNDLE'
app_path="$app_parent/$app_name"

output_parent_input="$(/usr/bin/dirname "$output_input" 2>/dev/null)" || fail 'INVALID_OUTPUT_PATH'
output_name="$(/usr/bin/basename "$output_input" 2>/dev/null)" || fail 'INVALID_OUTPUT_PATH'
[[ ${#output_name} -le 127 && "$output_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]*\.dmg$ ]] || fail 'INVALID_OUTPUT_PATH'
/bin/mkdir -p "$output_parent_input" >/dev/null 2>&1 || fail 'OUTPUT_DIRECTORY_UNAVAILABLE'
output_parent="$(cd "$output_parent_input" >/dev/null 2>&1 && pwd -P)" || fail 'OUTPUT_DIRECTORY_UNAVAILABLE'
output_path="$output_parent/$output_name"

case "$output_path/" in
  "$app_path/"*) fail 'INVALID_OUTPUT_PATH' ;;
esac

[[ ! -L "$output_path" ]] || fail 'INVALID_OUTPUT_PATH'
if [[ -e "$output_path" ]]; then
  [[ -f "$output_path" && "$overwrite" -eq 1 ]] || fail 'OUTPUT_EXISTS'
fi

work_dir="$(/usr/bin/mktemp -d "$output_parent/$WORK_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'WORK_DIRECTORY_UNAVAILABLE'
[[ -d "$work_dir" && ! -L "$work_dir" ]] || fail 'WORK_DIRECTORY_UNAVAILABLE'
/bin/chmod 700 "$work_dir" >/dev/null 2>&1 || fail 'WORK_DIRECTORY_UNAVAILABLE'

stage_dir="$work_dir/stage"
mount_dir="$work_dir/mount"
rw_image="$work_dir/source.dmg"
candidate_image="$work_dir/candidate.dmg"
tool_log="$work_dir/tool.log"
source_inventory="$work_dir/source-inventory.json"

/bin/mkdir "$stage_dir" "$mount_dir" >/dev/null 2>&1 || fail 'STAGING_FAILED'

if ! "$node_binary" "$script_dir/macos-release.mjs" inventory \
  --app "$app_path" \
  --output "$source_inventory" >"$tool_log" 2>&1; then
  fail 'APP_INVENTORY_FAILED'
fi

if ! /usr/bin/ditto "$app_path" "$stage_dir/$app_name" >"$tool_log" 2>&1; then
  fail 'APP_COPY_FAILED'
fi
[[ -f "$stage_dir/$app_name/Contents/Info.plist" ]] || fail 'APP_COPY_FAILED'
if ! "$node_binary" "$script_dir/macos-release.mjs" compare \
  --app "$stage_dir/$app_name" \
  --expected "$source_inventory" >>"$tool_log" 2>&1; then
  fail 'APP_COPY_INVENTORY_MISMATCH'
fi

if ! /bin/ln -s /Applications "$stage_dir/Applications" >>"$tool_log" 2>&1; then
  fail 'APPLICATIONS_LINK_FAILED'
fi

if ! /usr/bin/hdiutil create \
  -quiet \
  -ov \
  -srcfolder "$stage_dir" \
  -volname "$volume_name" \
  -fs HFS+ \
  -format UDRW \
  "$rw_image" >>"$tool_log" 2>&1; then
  fail 'IMAGE_CREATE_FAILED'
fi

if ! /usr/bin/hdiutil convert \
  -quiet \
  "$rw_image" \
  -format UDZO \
  -imagekey zlib-level=9 \
  -o "$candidate_image" >>"$tool_log" 2>&1; then
  fail 'IMAGE_CONVERT_FAILED'
fi

if ! /usr/bin/hdiutil verify -quiet "$candidate_image" >>"$tool_log" 2>&1; then
  fail 'IMAGE_VERIFY_FAILED'
fi

if ! /usr/bin/hdiutil attach \
  -quiet \
  -readonly \
  -nobrowse \
  -noautoopen \
  -mountpoint "$mount_dir" \
  "$candidate_image" >>"$tool_log" 2>&1; then
  fail 'IMAGE_MOUNT_FAILED'
fi
attached=1
mount_device="$(resolve_mount_device "$mount_dir")" || fail 'IMAGE_MOUNT_DEVICE_INVALID'

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
[[ ${#root_entries[@]} -eq 2 ]] || fail 'IMAGE_CONTENTS_INVALID'
[[ -d "$mount_dir/$app_name" && ! -L "$mount_dir/$app_name" ]] || fail 'IMAGE_CONTENTS_INVALID'
[[ -f "$mount_dir/$app_name/Contents/Info.plist" ]] || fail 'IMAGE_CONTENTS_INVALID'
[[ -L "$mount_dir/Applications" ]] || fail 'IMAGE_CONTENTS_INVALID'
[[ "$(/usr/bin/readlink "$mount_dir/Applications" 2>/dev/null || true)" == '/Applications' ]] || fail 'IMAGE_CONTENTS_INVALID'
if ! "$node_binary" "$script_dir/macos-release.mjs" compare \
  --app "$mount_dir/$app_name" \
  --expected "$source_inventory" >>"$tool_log" 2>&1; then
  fail 'IMAGE_APP_INVENTORY_MISMATCH'
fi

if /usr/bin/touch "$mount_dir/.coding-wife-write-probe" >/dev/null 2>&1; then
  /bin/rm -f "$mount_dir/.coding-wife-write-probe" >/dev/null 2>&1 || true
  fail 'IMAGE_NOT_READ_ONLY'
fi

detach_mount "$mount_dir" "$mount_device" || fail 'IMAGE_DETACH_FAILED'
attached=0
mount_device=''

ready_path="$(/usr/bin/mktemp "$output_parent/$READY_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'ARTIFACT_PUBLISH_FAILED'
if ! /bin/mv -f "$candidate_image" "$ready_path" >/dev/null 2>&1; then
  fail 'ARTIFACT_PUBLISH_FAILED'
fi

if ! safe_remove_work_dir "$work_dir"; then
  fail 'CLEANUP_FAILED'
fi
work_dir=''

[[ ! -L "$output_path" ]] || fail 'INVALID_OUTPUT_PATH'
if [[ -e "$output_path" ]]; then
  [[ -f "$output_path" && "$overwrite" -eq 1 ]] || fail 'OUTPUT_EXISTS'
fi

if ! /bin/mv -f "$ready_path" "$output_path" >/dev/null 2>&1; then
  fail 'ARTIFACT_PUBLISH_FAILED'
fi
ready_path=''

printf '%s\n' 'macOS DMG created and verified.'
