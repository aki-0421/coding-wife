#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C
umask 077

readonly ERROR_PREFIX='[release]'
readonly WORK_PREFIX='.coding-wife-app-build.'
readonly READY_PREFIX='.coding-wife-app-ready.'
readonly BACKUP_PREFIX='.coding-wife-app-backup.'

work_dir=''
ready_container=''
backup_container=''
app_path=''
manifest_path=''
publish_started=0
publish_committed=0
original_app=0
original_manifest=0
output_input=''

release_release_lock() {
  return 0
}

classify_app_build_failure() {
  local log="${tool_log:-}"
  local line=''
  local storage=0
  local terminated=0
  local linker=0
  local compiler=0
  local frontend=0
  local bundler=0

  [[ -n "$log" && -f "$log" && ! -L "$log" ]] || return 1
  while IFS= read -r line; do
    case "$line" in
      *'No space left on device'*|*'os error 28'*) storage=1 ;;
      *'signal: 9'*|*'SIGKILL'*|*'Killed: 9'*) terminated=1 ;;
      *'linking with '*failed*|*'Undefined symbols for architecture'*) linker=1 ;;
      *'error[E'[0-9][0-9][0-9][0-9]']'*|*'error: could not compile'*) compiler=1 ;;
      *'beforeBuildCommand'*failed*|*'ELIFECYCLE'*) frontend=1 ;;
      *'failed to bundle project'*|*'failed to bundle app'*) bundler=1 ;;
    esac
  done <"$log"

  if [[ "$storage" -eq 1 ]]; then
    /usr/bin/printf '%s' 'BUILD_STORAGE_EXHAUSTED'
  elif [[ "$terminated" -eq 1 ]]; then
    /usr/bin/printf '%s' 'BUILD_PROCESS_TERMINATED'
  elif [[ "$linker" -eq 1 ]]; then
    /usr/bin/printf '%s' 'RUST_LINK_FAILED'
  elif [[ "$compiler" -eq 1 ]]; then
    /usr/bin/printf '%s' 'RUST_COMPILE_FAILED'
  elif [[ "$frontend" -eq 1 ]]; then
    /usr/bin/printf '%s' 'FRONTEND_BUILD_FAILED'
  elif [[ "$bundler" -eq 1 ]]; then
    /usr/bin/printf '%s' 'TAURI_BUNDLE_FAILED'
  else
    return 1
  fi
}

fail() {
  local code="$1"
  local cause=''
  if [[ "$code" == 'APP_BUILD_FAILED' ]]; then
    cause="$(classify_app_build_failure 2>/dev/null || true)"
  fi
  case "$cause" in
    BUILD_STORAGE_EXHAUSTED|BUILD_PROCESS_TERMINATED|RUST_LINK_FAILED|RUST_COMPILE_FAILED|FRONTEND_BUILD_FAILED|TAURI_BUNDLE_FAILED)
      /usr/bin/printf '%s %s cause=%s\n' "$ERROR_PREFIX" "$code" "$cause" >&2
      ;;
    *) /usr/bin/printf '%s %s\n' "$ERROR_PREFIX" "$code" >&2 ;;
  esac
  exit 1
}

usage() {
  /usr/bin/printf '%s\n' 'Usage: build-macos-app.sh [--output <bundle.app>]'
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

rollback_publish() {
  local failed=0
  [[ "$publish_started" -eq 1 && "$publish_committed" -eq 0 ]] || return 0

  if [[ -e "$app_path" || -L "$app_path" ]]; then
    [[ -d "$app_path" && ! -L "$app_path" ]] || failed=1
    if [[ "$failed" -eq 0 ]]; then
      /bin/chmod -R u+w "$app_path" >/dev/null 2>&1 || true
      /bin/rm -rf -- "$app_path" >/dev/null 2>&1 || failed=1
    fi
  fi
  if [[ -e "$manifest_path" || -L "$manifest_path" ]]; then
    [[ -f "$manifest_path" && ! -L "$manifest_path" ]] || failed=1
    [[ "$failed" -ne 0 ]] || /bin/rm -f -- "$manifest_path" >/dev/null 2>&1 || failed=1
  fi

  if [[ "$original_app" -eq 1 ]]; then
    [[ -d "$backup_container/original.app" && ! -L "$backup_container/original.app" ]] || failed=1
    [[ "$failed" -ne 0 ]] || /bin/mv "$backup_container/original.app" "$app_path" >/dev/null 2>&1 || failed=1
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
    /usr/bin/printf '%s %s\n' "$ERROR_PREFIX" 'APP_BUILD_CLEANUP_FAILED' >&2
    exit 1
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

output_seen=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      [[ "$output_seen" -eq 0 && $# -ge 2 ]] || fail 'APP_BUILD_ARGUMENT_INVALID'
      output_input="$2"
      output_seen=1
      shift 2
      ;;
    --help)
      [[ $# -eq 1 ]] || fail 'APP_BUILD_ARGUMENT_INVALID'
      usage
      exit 0
      ;;
    *) fail 'APP_BUILD_ARGUMENT_INVALID' ;;
  esac
done
[[ "$(/usr/bin/uname -s 2>/dev/null || true)" == 'Darwin' ]] || fail 'APP_BUILD_PLATFORM_UNSUPPORTED'

script_dir="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)" || fail 'APP_BUILD_ROOT_INVALID'
# shellcheck source=macos-release-common.sh
source "$script_dir/macos-release-common.sh"
project_root="$(cd "$script_dir/../.." >/dev/null 2>&1 && pwd -P)" || fail 'APP_BUILD_ROOT_INVALID'
node_binary="$(command -v node 2>/dev/null || true)"
pnpm_binary="$(command -v pnpm 2>/dev/null || true)"
[[ -n "$node_binary" && -x "$node_binary" && -n "$pnpm_binary" && -x "$pnpm_binary" ]] || fail 'APP_BUILD_TOOL_UNAVAILABLE'
for tool in /bin/chmod /bin/mkdir /bin/mv /bin/rm /bin/sleep /usr/bin/basename /usr/bin/dirname /usr/bin/ditto /usr/bin/mktemp /usr/bin/touch /usr/bin/uname /usr/bin/uuidgen; do
  [[ -x "$tool" ]] || fail 'APP_BUILD_TOOL_UNAVAILABLE'
done

release_acquire_lock || fail 'APP_BUILD_LOCK_UNAVAILABLE'

if [[ "$output_seen" -eq 1 ]]; then
  [[ -n "$output_input" && ! "$output_input" =~ [[:cntrl:]] ]] || fail 'APP_BUILD_OUTPUT_INVALID'
  output_parent_input="$(/usr/bin/dirname "$output_input" 2>/dev/null)" || fail 'APP_BUILD_OUTPUT_INVALID'
  output_name="$(/usr/bin/basename "$output_input" 2>/dev/null)" || fail 'APP_BUILD_OUTPUT_INVALID'
  [[ ${#output_name} -le 127 && "$output_name" =~ ^[A-Za-z0-9][A-Za-z0-9._\ -]*\.app$ ]] || fail 'APP_BUILD_OUTPUT_INVALID'
else
  output_parent_input="$project_root/src-tauri/target/release/bundle/macos"
  output_name='Coding Wife.app'
fi
/bin/mkdir -p "$output_parent_input" >/dev/null 2>&1 || fail 'APP_BUILD_OUTPUT_UNAVAILABLE'
output_parent="$(cd "$output_parent_input" >/dev/null 2>&1 && pwd -P)" || fail 'APP_BUILD_OUTPUT_UNAVAILABLE'
app_path="$output_parent/$output_name"
manifest_path="$app_path.release.json"

[[ ! -L "$app_path" && ! -L "$manifest_path" ]] || fail 'APP_BUILD_OUTPUT_INVALID'
if [[ -e "$app_path" ]]; then
  [[ -d "$app_path" && ! -L "$app_path" ]] || fail 'APP_BUILD_OUTPUT_INVALID'
fi
if [[ -e "$manifest_path" ]]; then
  [[ -f "$manifest_path" && ! -L "$manifest_path" ]] || fail 'APP_BUILD_OUTPUT_INVALID'
fi

work_dir="$(/usr/bin/mktemp -d "/private/tmp/$WORK_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'APP_BUILD_WORK_UNAVAILABLE'
[[ -d "$work_dir" && ! -L "$work_dir" ]] || fail 'APP_BUILD_WORK_UNAVAILABLE'
/bin/chmod 700 "$work_dir" >/dev/null 2>&1 || fail 'APP_BUILD_WORK_UNAVAILABLE'
tool_log="$work_dir/tool.log"
/usr/bin/touch "$tool_log" >/dev/null 2>&1 || fail 'APP_BUILD_WORK_UNAVAILABLE'
/bin/chmod 600 "$tool_log" >/dev/null 2>&1 || fail 'APP_BUILD_WORK_UNAVAILABLE'

candidate_target="$work_dir/target"
candidate_app="$candidate_target/release/bundle/macos/Coding Wife.app"
candidate_inventory="$work_dir/candidate-inventory.json"
/bin/mkdir "$candidate_target" >/dev/null 2>&1 || fail 'APP_BUILD_WORK_UNAVAILABLE'

task_cargo_home="${CARGO_HOME:-${HOME:-/private/tmp}/.cargo}"
task_rustup_home="${RUSTUP_HOME:-${HOME:-/private/tmp}/.rustup}"
flag_separator=$'\x1f'
export CARGO_TARGET_DIR="$candidate_target"
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$project_root=workspace${flag_separator}--remap-path-prefix=$task_cargo_home=cargo${flag_separator}--remap-path-prefix=$task_rustup_home=rustup${flag_separator}--remap-path-prefix=$work_dir=build"
unset RUSTFLAGS
export CARGO_PROFILE_RELEASE_DEBUG=0
export CARGO_PROFILE_RELEASE_STRIP=symbols

if ! (
  cd "$project_root"
  "$pnpm_binary" tauri build --ci --bundles app
) >>"$tool_log" 2>&1; then
  fail 'APP_BUILD_FAILED'
fi

[[ -d "$candidate_app" && ! -L "$candidate_app" ]] || fail 'APP_BUILD_OUTPUT_INVALID'
if ! (
  cd "$project_root"
  "$node_binary" scripts/licenses/dependency-notices.mjs --check
) >>"$tool_log" 2>&1; then
  fail 'APP_BUILD_LICENSE_STALE'
fi
"$node_binary" "$script_dir/production-bundle.mjs" --root "$candidate_app" >>"$tool_log" 2>&1 || fail 'APP_BUILD_DEMO_RUNTIME_PRESENT'
/bin/bash "$script_dir/seal-macos-app.sh" --app "$candidate_app" >>"$tool_log" 2>&1 || fail 'APP_BUILD_SEAL_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" verify-app --app "$candidate_app" >>"$tool_log" 2>&1 || fail 'APP_BUILD_VERIFY_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" inventory --app "$candidate_app" --output "$candidate_inventory" >>"$tool_log" 2>&1 || fail 'APP_BUILD_INVENTORY_FAILED'

ready_container="$(/usr/bin/mktemp -d "$output_parent/$READY_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'APP_BUILD_READY_FAILED'
[[ -d "$ready_container" && ! -L "$ready_container" ]] || fail 'APP_BUILD_READY_FAILED'
/bin/chmod 700 "$ready_container" >/dev/null 2>&1 || fail 'APP_BUILD_READY_FAILED'
ready_app="$ready_container/$output_name"
ready_manifest="$ready_container/$output_name.release.json"
/usr/bin/ditto "$candidate_app" "$ready_app" >>"$tool_log" 2>&1 || fail 'APP_BUILD_READY_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" verify-app --app "$ready_app" --expected "$candidate_inventory" >>"$tool_log" 2>&1 || fail 'APP_BUILD_READY_VERIFY_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" manifest-create \
  --kind app \
  --run-id "$RELEASE_LOCK_RUN_ID" \
  --artifact "$ready_app" \
  --inventory "$candidate_inventory" \
  --output "$ready_manifest" >>"$tool_log" 2>&1 || fail 'APP_BUILD_MANIFEST_FAILED'

if [[ "${CODING_WIFE_RELEASE_TEST_FAULT:-}" == 'app-after-ready' ]]; then
  fail 'TEST_INJECTED_FAILURE'
fi
if [[ "${CODING_WIFE_RELEASE_TEST_WAIT:-}" == 'app-after-ready' ]]; then
  /usr/bin/touch "$work_dir/test-hook-ready" >/dev/null 2>&1 || fail 'TEST_HOOK_FAILED'
  while :; do /bin/sleep 1; done
fi

backup_container="$(/usr/bin/mktemp -d "$output_parent/$BACKUP_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'APP_BUILD_PUBLISH_FAILED'
[[ -d "$backup_container" && ! -L "$backup_container" ]] || fail 'APP_BUILD_PUBLISH_FAILED'
/bin/chmod 700 "$backup_container" >/dev/null 2>&1 || fail 'APP_BUILD_PUBLISH_FAILED'

[[ -e "$app_path" ]] && original_app=1
[[ -e "$manifest_path" ]] && original_manifest=1
publish_started=1
if [[ "$original_app" -eq 1 ]]; then
  /bin/mv "$app_path" "$backup_container/original.app" >/dev/null 2>&1 || fail 'APP_BUILD_PUBLISH_FAILED'
fi
if [[ "$original_manifest" -eq 1 ]]; then
  /bin/mv "$manifest_path" "$backup_container/original.manifest" >/dev/null 2>&1 || fail 'APP_BUILD_PUBLISH_FAILED'
fi
/bin/mv "$ready_app" "$app_path" >/dev/null 2>&1 || fail 'APP_BUILD_PUBLISH_FAILED'
/bin/mv "$ready_manifest" "$manifest_path" >/dev/null 2>&1 || fail 'APP_BUILD_PUBLISH_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" manifest-verify \
  --kind app \
  --run-id "$RELEASE_LOCK_RUN_ID" \
  --artifact "$app_path" \
  --inventory "$candidate_inventory" \
  --manifest "$manifest_path" >>"$tool_log" 2>&1 || fail 'APP_BUILD_PUBLISH_FAILED'
publish_committed=1

safe_remove_tree "$backup_container" "$output_parent" "$BACKUP_PREFIX" || fail 'APP_BUILD_CLEANUP_FAILED'
backup_container=''
safe_remove_tree "$ready_container" "$output_parent" "$READY_PREFIX" || fail 'APP_BUILD_CLEANUP_FAILED'
ready_container=''
safe_remove_tree "$work_dir" '/private/tmp' "$WORK_PREFIX" || fail 'APP_BUILD_CLEANUP_FAILED'
work_dir=''

/usr/bin/printf '%s macOS app built and verified run=%s.\n' "$ERROR_PREFIX" "$RELEASE_LOCK_RUN_ID"
