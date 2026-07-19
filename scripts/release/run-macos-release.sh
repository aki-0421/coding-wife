#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C
umask 077

readonly ERROR_PREFIX='[release]'
readonly WORK_PREFIX='.coding-wife-release-run.'
readonly TRANSACTION_PREFIX='.coding-wife-release-transaction.'
readonly JOURNAL_VERSION='1'

output_root_input=''
output_root=''
work_dir=''
tool_log=''
transaction_dir=''
transaction_phase=''
app_present=0
app_manifest_present=0
dmg_present=0
dmg_manifest_present=0

release_release_lock() {
  return 0
}

usage() {
  /usr/bin/printf '%s\n' 'Usage: run-macos-release.sh [--output-root <bundle-directory>]'
}

read_app_failure_detail() {
  local log="${tool_log:-}"
  local line=''

  APP_FAILURE_INNER=''
  APP_FAILURE_CAUSE=''

  [[ -n "$log" && -f "$log" && ! -L "$log" ]] || return 1
  while IFS= read -r line; do
    if [[ "$line" =~ ^\[release\]\ APP_BUILD_FAILED\ cause=(BUILD_STORAGE_EXHAUSTED|BUILD_PROCESS_TERMINATED|RUST_LINK_FAILED|RUST_COMPILE_FAILED|FRONTEND_BUILD_FAILED|TAURI_BUNDLE_FAILED)$ ]]; then
      APP_FAILURE_INNER='APP_BUILD_FAILED'
      APP_FAILURE_CAUSE="${BASH_REMATCH[1]}"
    elif [[ "$line" =~ ^\[release\]\ (APP_BUILD_ARGUMENT_INVALID|APP_BUILD_CLEANUP_FAILED|APP_BUILD_DEMO_RUNTIME_PRESENT|APP_BUILD_INVENTORY_FAILED|APP_BUILD_LICENSE_STALE|APP_BUILD_LOCK_UNAVAILABLE|APP_BUILD_MANIFEST_FAILED|APP_BUILD_OUTPUT_INVALID|APP_BUILD_OUTPUT_UNAVAILABLE|APP_BUILD_PLATFORM_UNSUPPORTED|APP_BUILD_PUBLISH_FAILED|APP_BUILD_READY_FAILED|APP_BUILD_READY_VERIFY_FAILED|APP_BUILD_ROOT_INVALID|APP_BUILD_SEAL_FAILED|APP_BUILD_TOOL_UNAVAILABLE|APP_BUILD_VERIFY_FAILED|APP_BUILD_WORK_UNAVAILABLE)$ ]]; then
      APP_FAILURE_INNER="${BASH_REMATCH[1]}"
      APP_FAILURE_CAUSE=''
    elif [[ "$line" == '[release] APP_BUILD_'* ]]; then
      # The last unrecognized app-build line makes the outer result generic.
      APP_FAILURE_INNER=''
      APP_FAILURE_CAUSE=''
    fi
  done <"$log"
  [[ -n "$APP_FAILURE_INNER" ]]
}

fail() {
  local code="$1"
  APP_FAILURE_INNER=''
  APP_FAILURE_CAUSE=''
  if [[ "$code" == 'RELEASE_APP_FAILED' ]]; then
    read_app_failure_detail 2>/dev/null || true
  fi
  case "$APP_FAILURE_INNER:$APP_FAILURE_CAUSE" in
    APP_BUILD_FAILED:BUILD_STORAGE_EXHAUSTED|APP_BUILD_FAILED:BUILD_PROCESS_TERMINATED|APP_BUILD_FAILED:RUST_LINK_FAILED|APP_BUILD_FAILED:RUST_COMPILE_FAILED|APP_BUILD_FAILED:FRONTEND_BUILD_FAILED|APP_BUILD_FAILED:TAURI_BUNDLE_FAILED)
      /usr/bin/printf '%s %s inner=%s cause=%s\n' \
        "$ERROR_PREFIX" "$code" "$APP_FAILURE_INNER" "$APP_FAILURE_CAUSE" >&2
      ;;
    APP_BUILD_ARGUMENT_INVALID:|APP_BUILD_CLEANUP_FAILED:|APP_BUILD_DEMO_RUNTIME_PRESENT:|APP_BUILD_INVENTORY_FAILED:|APP_BUILD_LICENSE_STALE:|APP_BUILD_LOCK_UNAVAILABLE:|APP_BUILD_MANIFEST_FAILED:|APP_BUILD_OUTPUT_INVALID:|APP_BUILD_OUTPUT_UNAVAILABLE:|APP_BUILD_PLATFORM_UNSUPPORTED:|APP_BUILD_PUBLISH_FAILED:|APP_BUILD_READY_FAILED:|APP_BUILD_READY_VERIFY_FAILED:|APP_BUILD_ROOT_INVALID:|APP_BUILD_SEAL_FAILED:|APP_BUILD_TOOL_UNAVAILABLE:|APP_BUILD_VERIFY_FAILED:|APP_BUILD_WORK_UNAVAILABLE:)
      /usr/bin/printf '%s %s inner=%s\n' \
        "$ERROR_PREFIX" "$code" "$APP_FAILURE_INNER" >&2
      ;;
    *)
      /usr/bin/printf '%s %s\n' "$ERROR_PREFIX" "$code" >&2
      ;;
  esac
  exit 1
}

safe_remove_tree() {
  local candidate="$1"
  local expected_parent="$2"
  local expected_prefix="$3"
  local attempt=0
  local parent=''
  local name=''

  [[ -n "$candidate" ]] || return 0
  [[ -e "$candidate" || -L "$candidate" ]] || return 0
  [[ -d "$candidate" && ! -L "$candidate" ]] || return 1
  parent="$(cd "$candidate/.." >/dev/null 2>&1 && pwd -P)" || return 1
  name="$(/usr/bin/basename "$candidate" 2>/dev/null || true)"
  [[ "$parent" == "$expected_parent" && "$name" == "$expected_prefix"* ]] || return 1
  while [[ -e "$candidate" || -L "$candidate" ]]; do
    [[ "$attempt" -lt 100 && -d "$candidate" && ! -L "$candidate" ]] || return 1
    /bin/chmod -R u+w "$candidate" >/dev/null 2>&1 || true
    /bin/rm -rf -- "$candidate" >/dev/null 2>&1 || true
    [[ ! -e "$candidate" && ! -L "$candidate" ]] && return 0
    /bin/sleep 0.05
    attempt=$((attempt + 1))
  done
}

validate_entry() {
  local kind="$1"
  local candidate="$2"
  case "$kind" in
    directory) [[ -d "$candidate" && ! -L "$candidate" ]] ;;
    file) [[ -f "$candidate" && ! -L "$candidate" ]] ;;
    *) return 1 ;;
  esac
}

remove_entry() {
  local kind="$1"
  local candidate="$2"
  [[ -e "$candidate" || -L "$candidate" ]] || return 0
  validate_entry "$kind" "$candidate" || return 1
  if [[ "$kind" == 'directory' ]]; then
    /bin/chmod -R u+w "$candidate" >/dev/null 2>&1 || true
    /bin/rm -rf -- "$candidate" >/dev/null 2>&1
  else
    /bin/rm -f -- "$candidate" >/dev/null 2>&1
  fi
}

write_journal() {
  local temporary="$transaction_dir/journal.tmp"
  local journal="$transaction_dir/journal"
  [[ -n "$transaction_dir" && -d "$transaction_dir" && ! -L "$transaction_dir" ]] || return 1
  [[ ! -L "$temporary" && ! -L "$journal" ]] || return 1
  /bin/rm -f -- "$temporary" >/dev/null 2>&1 || return 1
  /usr/bin/printf \
    'version=%s\nrun=%s\nphase=%s\napp=%s\napp_manifest=%s\ndmg=%s\ndmg_manifest=%s\n' \
    "$JOURNAL_VERSION" "$RELEASE_LOCK_RUN_ID" "$transaction_phase" \
    "$app_present" "$app_manifest_present" "$dmg_present" "$dmg_manifest_present" \
    >"$temporary" || return 1
  /bin/chmod 600 "$temporary" >/dev/null 2>&1 || return 1
  /bin/mv "$temporary" "$journal" >/dev/null 2>&1 || return 1
  /bin/sync >/dev/null 2>&1 || return 1
}

read_journal() {
  local directory="$1"
  local journal="$directory/journal"
  local line=''
  local count=0
  local seen_version=0
  local seen_run=0
  local seen_phase=0
  local seen_app=0
  local seen_app_manifest=0
  local seen_dmg=0
  local seen_dmg_manifest=0

  J_VERSION=''
  J_RUN=''
  J_PHASE=''
  J_APP=''
  J_APP_MANIFEST=''
  J_DMG=''
  J_DMG_MANIFEST=''
  [[ -f "$journal" && ! -L "$journal" ]] || return 1
  while IFS= read -r line; do
    count=$((count + 1))
    case "$line" in
      version=*) [[ "$seen_version" -eq 0 ]] || return 1; seen_version=1; J_VERSION="${line#version=}" ;;
      run=*) [[ "$seen_run" -eq 0 ]] || return 1; seen_run=1; J_RUN="${line#run=}" ;;
      phase=*) [[ "$seen_phase" -eq 0 ]] || return 1; seen_phase=1; J_PHASE="${line#phase=}" ;;
      app=*) [[ "$seen_app" -eq 0 ]] || return 1; seen_app=1; J_APP="${line#app=}" ;;
      app_manifest=*) [[ "$seen_app_manifest" -eq 0 ]] || return 1; seen_app_manifest=1; J_APP_MANIFEST="${line#app_manifest=}" ;;
      dmg=*) [[ "$seen_dmg" -eq 0 ]] || return 1; seen_dmg=1; J_DMG="${line#dmg=}" ;;
      dmg_manifest=*) [[ "$seen_dmg_manifest" -eq 0 ]] || return 1; seen_dmg_manifest=1; J_DMG_MANIFEST="${line#dmg_manifest=}" ;;
      *) return 1 ;;
    esac
  done <"$journal"

  [[ "$count" -eq 7 && "$J_VERSION" == "$JOURNAL_VERSION" ]] || return 1
  [[ "$J_RUN" =~ ^[0-9A-Fa-f-]{36}$ ]] || return 1
  [[ "$J_PHASE" =~ ^(building|restore-required|publishing|published|committed)$ ]] || return 1
  [[ "$J_APP" =~ ^[01]$ && "$J_APP_MANIFEST" =~ ^[01]$ && "$J_DMG" =~ ^[01]$ && "$J_DMG_MANIFEST" =~ ^[01]$ ]] || return 1
}

restore_entry() {
  local present="$1"
  local final_path="$2"
  local backup_path="$3"
  local kind="$4"
  local phase="$5"

  if [[ "$present" -eq 1 ]]; then
    if [[ -e "$backup_path" || -L "$backup_path" ]]; then
      validate_entry "$kind" "$backup_path" || return 1
      remove_entry "$kind" "$final_path" || return 1
      /bin/mv "$backup_path" "$final_path" >/dev/null 2>&1 || return 1
    else
      [[ "$phase" == 'restore-required' ]] || return 1
      validate_entry "$kind" "$final_path" || return 1
    fi
  else
    [[ ! -e "$backup_path" && ! -L "$backup_path" ]] || return 1
    remove_entry "$kind" "$final_path" || return 1
  fi
}

restore_transaction() {
  local directory="$1"
  local phase="$2"
  local original="$directory/original"

  [[ -d "$original" && ! -L "$original" ]] || return 1
  restore_entry "$J_APP" "$app_path" "$original/app" directory "$phase" || return 1
  restore_entry "$J_APP_MANIFEST" "$app_manifest" "$original/app.manifest" file "$phase" || return 1
  restore_entry "$J_DMG" "$dmg_path" "$original/dmg" file "$phase" || return 1
  restore_entry "$J_DMG_MANIFEST" "$dmg_manifest" "$original/dmg.manifest" file "$phase" || return 1
  /bin/sync >/dev/null 2>&1 || return 1
}

final_run_matches() {
  local expected_run="$1"
  local app_run=''
  local dmg_run=''
  validate_entry directory "$app_path" || return 1
  validate_entry file "$app_manifest" || return 1
  validate_entry file "$dmg_path" || return 1
  validate_entry file "$dmg_manifest" || return 1
  app_run="$("$node_binary" "$script_dir/macos-release.mjs" manifest-run-id --manifest "$app_manifest" 2>/dev/null)" || return 1
  dmg_run="$("$node_binary" "$script_dir/macos-release.mjs" manifest-run-id --manifest "$dmg_manifest" 2>/dev/null)" || return 1
  [[ "$app_run" == "$expected_run" && "$dmg_run" == "$expected_run" ]]
}

recover_transaction() {
  local directory="$1"
  local parent=''
  local name=''
  parent="$(cd "$directory/.." >/dev/null 2>&1 && pwd -P)" || return 1
  name="$(/usr/bin/basename "$directory" 2>/dev/null || true)"
  [[ "$parent" == "$output_root" && "$name" == "$TRANSACTION_PREFIX"* && -d "$directory" && ! -L "$directory" ]] || return 1
  read_journal "$directory" || return 1

  case "$J_PHASE" in
    building)
      ;;
    restore-required|publishing|published)
      restore_transaction "$directory" "$J_PHASE" || return 1
      ;;
    committed)
      final_run_matches "$J_RUN" || return 1
      ;;
    *) return 1 ;;
  esac
  safe_remove_tree "$directory" "$output_root" "$TRANSACTION_PREFIX"
}

recover_stale_transactions() {
  local count=0
  local directory=''
  local transaction=''
  shopt -s nullglob
  for directory in "$output_root/$TRANSACTION_PREFIX"*; do
    count=$((count + 1))
    transaction="$directory"
  done
  shopt -u nullglob
  [[ "$count" -le 1 ]] || return 2
  if [[ "$count" -eq 1 ]]; then
    recover_transaction "$transaction" || return 1
  fi
}

recover_stale_work() {
  local count=0
  local entry=''
  local owner=''
  local run=''
  local recovery_failed=0
  shopt -s nullglob
  for entry in /private/tmp/"$WORK_PREFIX"*; do
    count=$((count + 1))
    if [[ "$count" -gt 16 || ! -d "$entry" || -L "$entry" ]]; then
      recovery_failed=1
      break
    fi
    owner="$entry/owner"
    if [[ ! -f "$owner" || -L "$owner" ]] ||
      ! IFS= read -r run <"$owner" ||
      [[ ! "$run" =~ ^run=[0-9A-Fa-f-]{36}$ ]] ||
      ! safe_remove_tree "$entry" '/private/tmp' "$WORK_PREFIX"; then
      recovery_failed=1
      break
    fi
  done
  shopt -u nullglob
  [[ "$recovery_failed" -eq 0 ]]
}

run_test_hook() {
  local hook="$1"
  if [[ "${CODING_WIFE_RELEASE_TEST_FAULT:-}" == "$hook" ]]; then
    fail 'TEST_INJECTED_FAILURE'
  fi
  if [[ "${CODING_WIFE_RELEASE_TEST_WAIT:-}" == "$hook" ]]; then
    /usr/bin/touch "$work_dir/test-hook-ready" >/dev/null 2>&1 || fail 'TEST_HOOK_FAILED'
    while [[ ! -f "$work_dir/test-hook-continue" ]]; do /bin/sleep 0.05; done
    /bin/rm -f -- "$work_dir/test-hook-ready" "$work_dir/test-hook-continue" >/dev/null 2>&1 || fail 'TEST_HOOK_FAILED'
  fi
}

cleanup_transaction() {
  [[ -n "$transaction_dir" ]] || return 0
  if [[ -d "$transaction_dir" && ! -L "$transaction_dir" ]]; then
    if read_journal "$transaction_dir"; then
      case "$J_PHASE" in
        restore-required|publishing|published)
          restore_transaction "$transaction_dir" "$J_PHASE" || return 1
          ;;
        building|committed)
          ;;
        *) return 1 ;;
      esac
    else
      return 1
    fi
    safe_remove_tree "$transaction_dir" "$output_root" "$TRANSACTION_PREFIX" || return 1
  fi
  transaction_dir=''
}

cleanup() {
  local status=$?
  local cleanup_failed=0
  trap - EXIT HUP INT TERM

  cleanup_transaction || cleanup_failed=1
  if [[ -n "$work_dir" ]]; then
    safe_remove_tree "$work_dir" '/private/tmp' "$WORK_PREFIX" || cleanup_failed=1
  fi
  release_release_lock || cleanup_failed=1
  if [[ "$cleanup_failed" -ne 0 ]]; then
    /usr/bin/printf '%s %s\n' "$ERROR_PREFIX" 'RELEASE_CLEANUP_FAILED' >&2
    exit 1
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

output_root_seen=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-root)
      [[ "$output_root_seen" -eq 0 && $# -ge 2 ]] || fail 'RELEASE_ARGUMENT_INVALID'
      output_root_input="$2"
      output_root_seen=1
      shift 2
      ;;
    --help)
      [[ $# -eq 1 ]] || fail 'RELEASE_ARGUMENT_INVALID'
      usage
      exit 0
      ;;
    *) fail 'RELEASE_ARGUMENT_INVALID' ;;
  esac
done

[[ "$(/usr/bin/uname -s 2>/dev/null || true)" == 'Darwin' ]] || fail 'RELEASE_PLATFORM_UNSUPPORTED'
script_dir="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_ROOT_INVALID'
# shellcheck source=macos-release-common.sh
source "$script_dir/macos-release-common.sh"
project_root="$(cd "$script_dir/../.." >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_ROOT_INVALID'
node_binary="$(command -v node 2>/dev/null || true)"
[[ -n "$node_binary" && -x "$node_binary" ]] || fail 'RELEASE_TOOL_UNAVAILABLE'
for tool in /bin/chmod /bin/mkdir /bin/mv /bin/rm /bin/sleep /bin/sync /usr/bin/basename /usr/bin/dirname /usr/bin/mktemp /usr/bin/touch /usr/bin/uname /usr/bin/uuidgen; do
  [[ -x "$tool" ]] || fail 'RELEASE_TOOL_UNAVAILABLE'
done

if [[ "$output_root_seen" -eq 1 ]]; then
  [[ -n "$output_root_input" && ! "$output_root_input" =~ [[:cntrl:]] ]] || fail 'RELEASE_OUTPUT_INVALID'
else
  output_root_input="$project_root/src-tauri/target/release/bundle"
fi
[[ ! -L "$output_root_input" ]] || fail 'RELEASE_OUTPUT_INVALID'
/bin/mkdir -p "$output_root_input" >/dev/null 2>&1 || fail 'RELEASE_OUTPUT_UNAVAILABLE'
output_root="$(cd "$output_root_input" >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_OUTPUT_UNAVAILABLE'
[[ "$output_root" != '/' && "$output_root" != '/private' && "$output_root" != '/private/tmp' ]] || fail 'RELEASE_OUTPUT_INVALID'

app_parent="$output_root/macos"
dmg_parent="$output_root/dmg"
/bin/mkdir -p "$app_parent" "$dmg_parent" >/dev/null 2>&1 || fail 'RELEASE_OUTPUT_UNAVAILABLE'
app_parent="$(cd "$app_parent" >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_OUTPUT_UNAVAILABLE'
dmg_parent="$(cd "$dmg_parent" >/dev/null 2>&1 && pwd -P)" || fail 'RELEASE_OUTPUT_UNAVAILABLE'
app_path="$app_parent/Coding Wife.app"
app_manifest="$app_path.release.json"
dmg_path="$dmg_parent/Coding-Wife.dmg"
dmg_manifest="$dmg_path.release.json"

release_acquire_lock || fail 'RELEASE_LOCK_UNAVAILABLE'
recover_stale_work || fail 'RELEASE_WORK_RECOVERY_FAILED'

work_dir="$(/usr/bin/mktemp -d "/private/tmp/$WORK_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'RELEASE_WORK_UNAVAILABLE'
[[ -d "$work_dir" && ! -L "$work_dir" ]] || fail 'RELEASE_WORK_UNAVAILABLE'
/bin/chmod 700 "$work_dir" >/dev/null 2>&1 || fail 'RELEASE_WORK_UNAVAILABLE'
/usr/bin/printf 'run=%s\n' "$RELEASE_LOCK_RUN_ID" >"$work_dir/owner" || fail 'RELEASE_WORK_UNAVAILABLE'
/bin/chmod 600 "$work_dir/owner" >/dev/null 2>&1 || fail 'RELEASE_WORK_UNAVAILABLE'
tool_log="$work_dir/tool.log"
/usr/bin/touch "$tool_log" >/dev/null 2>&1 || fail 'RELEASE_WORK_UNAVAILABLE'
/bin/chmod 600 "$tool_log" >/dev/null 2>&1 || fail 'RELEASE_WORK_UNAVAILABLE'

recovery_status=0
recover_stale_transactions || recovery_status=$?
case "$recovery_status" in
  0) ;;
  2) fail 'RELEASE_RECOVERY_AMBIGUOUS' ;;
  *) fail 'RELEASE_RECOVERY_FAILED' ;;
esac
run_test_hook 'release-after-recovery'

transaction_dir="$(/usr/bin/mktemp -d "$output_root/$TRANSACTION_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'RELEASE_TRANSACTION_UNAVAILABLE'
[[ -d "$transaction_dir" && ! -L "$transaction_dir" ]] || fail 'RELEASE_TRANSACTION_UNAVAILABLE'
/bin/chmod 700 "$transaction_dir" >/dev/null 2>&1 || fail 'RELEASE_TRANSACTION_UNAVAILABLE'
/bin/mkdir "$transaction_dir/candidate" "$transaction_dir/original" >/dev/null 2>&1 || fail 'RELEASE_TRANSACTION_UNAVAILABLE'
transaction_phase='building'
write_journal || fail 'RELEASE_TRANSACTION_UNAVAILABLE'

candidate_app="$transaction_dir/candidate/Coding Wife.app"
candidate_app_manifest="$candidate_app.release.json"
candidate_dmg="$transaction_dir/candidate/Coding-Wife.dmg"
candidate_dmg_manifest="$candidate_dmg.release.json"

/bin/bash "$script_dir/build-macos-app.sh" --output "$candidate_app" >>"$tool_log" 2>&1 || fail 'RELEASE_APP_FAILED'
run_test_hook 'release-after-app'
/bin/bash "$script_dir/build-macos-dmg.sh" \
  --app "$candidate_app" \
  --output "$candidate_dmg" \
  --volume-name 'Coding Wife' >>"$tool_log" 2>&1 || fail 'RELEASE_DMG_FAILED'
/bin/bash "$script_dir/verify-macos-release.sh" \
  --app "$candidate_app" \
  --dmg "$candidate_dmg" >>"$tool_log" 2>&1 || fail 'RELEASE_VERIFY_FAILED'

candidate_app_run="$("$node_binary" "$script_dir/macos-release.mjs" manifest-run-id --manifest "$candidate_app_manifest" 2>>"$tool_log")" || fail 'RELEASE_MANIFEST_INVALID'
candidate_dmg_run="$("$node_binary" "$script_dir/macos-release.mjs" manifest-run-id --manifest "$candidate_dmg_manifest" 2>>"$tool_log")" || fail 'RELEASE_MANIFEST_INVALID'
[[ "$candidate_app_run" == "$RELEASE_LOCK_RUN_ID" && "$candidate_dmg_run" == "$RELEASE_LOCK_RUN_ID" ]] || fail 'RELEASE_MIXED_RUN'
run_test_hook 'release-after-candidates'

for entry in \
  "directory:$app_path" \
  "file:$app_manifest" \
  "file:$dmg_path" \
  "file:$dmg_manifest"; do
  kind="${entry%%:*}"
  candidate="${entry#*:}"
  if [[ -e "$candidate" || -L "$candidate" ]]; then
    validate_entry "$kind" "$candidate" || fail 'RELEASE_FINAL_INVALID'
  fi
done
[[ -e "$app_path" ]] && app_present=1
[[ -e "$app_manifest" ]] && app_manifest_present=1
[[ -e "$dmg_path" ]] && dmg_present=1
[[ -e "$dmg_manifest" ]] && dmg_manifest_present=1
transaction_phase='restore-required'
write_journal || fail 'RELEASE_TRANSACTION_FAILED'

[[ "$app_present" -eq 0 ]] || /bin/mv "$app_path" "$transaction_dir/original/app" >/dev/null 2>&1 || fail 'RELEASE_BACKUP_FAILED'
[[ "$app_manifest_present" -eq 0 ]] || /bin/mv "$app_manifest" "$transaction_dir/original/app.manifest" >/dev/null 2>&1 || fail 'RELEASE_BACKUP_FAILED'
[[ "$dmg_present" -eq 0 ]] || /bin/mv "$dmg_path" "$transaction_dir/original/dmg" >/dev/null 2>&1 || fail 'RELEASE_BACKUP_FAILED'
[[ "$dmg_manifest_present" -eq 0 ]] || /bin/mv "$dmg_manifest" "$transaction_dir/original/dmg.manifest" >/dev/null 2>&1 || fail 'RELEASE_BACKUP_FAILED'
/bin/sync >/dev/null 2>&1 || fail 'RELEASE_BACKUP_FAILED'
transaction_phase='publishing'
write_journal || fail 'RELEASE_TRANSACTION_FAILED'

/bin/mv "$candidate_app" "$app_path" >/dev/null 2>&1 || fail 'RELEASE_PUBLISH_FAILED'
/bin/mv "$candidate_app_manifest" "$app_manifest" >/dev/null 2>&1 || fail 'RELEASE_PUBLISH_FAILED'
run_test_hook 'release-after-publish-app'
/bin/mv "$candidate_dmg" "$dmg_path" >/dev/null 2>&1 || fail 'RELEASE_PUBLISH_FAILED'
/bin/mv "$candidate_dmg_manifest" "$dmg_manifest" >/dev/null 2>&1 || fail 'RELEASE_PUBLISH_FAILED'
/bin/sync >/dev/null 2>&1 || fail 'RELEASE_PUBLISH_FAILED'
transaction_phase='published'
write_journal || fail 'RELEASE_TRANSACTION_FAILED'
run_test_hook 'release-after-publish'

/bin/bash "$script_dir/verify-macos-release.sh" \
  --app "$app_path" \
  --dmg "$dmg_path" >>"$tool_log" 2>&1 || fail 'RELEASE_PUBLISH_VERIFY_FAILED'
final_run_matches "$RELEASE_LOCK_RUN_ID" || fail 'RELEASE_MIXED_RUN'
run_test_hook 'release-after-verified'

transaction_phase='committed'
write_journal || fail 'RELEASE_TRANSACTION_FAILED'
safe_remove_tree "$transaction_dir" "$output_root" "$TRANSACTION_PREFIX" || fail 'RELEASE_CLEANUP_FAILED'
transaction_dir=''
safe_remove_tree "$work_dir" '/private/tmp' "$WORK_PREFIX" || fail 'RELEASE_CLEANUP_FAILED'
work_dir=''

/usr/bin/printf '%s macOS release completed run=%s.\n' "$ERROR_PREFIX" "$RELEASE_LOCK_RUN_ID"
