#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C
umask 077

readonly ERROR_PREFIX='[release]'

fail() {
  printf '%s %s\n' "$ERROR_PREFIX" "$1" >&2
  exit 1
}

[[ $# -eq 0 ]] || fail 'APP_BUILD_ARGUMENT_INVALID'
[[ "$(/usr/bin/uname -s 2>/dev/null || true)" == 'Darwin' ]] || fail 'APP_BUILD_PLATFORM_UNSUPPORTED'

script_dir="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)" || fail 'APP_BUILD_ROOT_INVALID'
project_root="$(cd "$script_dir/../.." >/dev/null 2>&1 && pwd -P)" || fail 'APP_BUILD_ROOT_INVALID'
app_path="$project_root/src-tauri/target/release/bundle/macos/Coding Wife.app"
node_binary="$(command -v node 2>/dev/null || true)"
pnpm_binary="$(command -v pnpm 2>/dev/null || true)"
[[ -n "$node_binary" && -x "$node_binary" && -n "$pnpm_binary" && -x "$pnpm_binary" ]] || fail 'APP_BUILD_TOOL_UNAVAILABLE'

task_cargo_home="${CARGO_HOME:-${HOME}/.cargo}"
task_rustup_home="${RUSTUP_HOME:-${HOME}/.rustup}"
flag_separator=$'\x1f'
export CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=$project_root=workspace${flag_separator}--remap-path-prefix=$task_cargo_home=cargo${flag_separator}--remap-path-prefix=$task_rustup_home=rustup"
unset RUSTFLAGS
export CARGO_PROFILE_RELEASE_DEBUG=0
export CARGO_PROFILE_RELEASE_STRIP=symbols

(
  cd "$project_root"
  "$pnpm_binary" tauri build --ci --bundles app
) || fail 'APP_BUILD_FAILED'

[[ -d "$app_path" && ! -L "$app_path" ]] || fail 'APP_BUILD_OUTPUT_INVALID'
"$node_binary" "$script_dir/production-bundle.mjs" --root "$app_path" || fail 'APP_BUILD_DEMO_RUNTIME_PRESENT'
/bin/bash "$script_dir/seal-macos-app.sh" --app "$app_path" || fail 'APP_BUILD_SEAL_FAILED'
"$node_binary" "$script_dir/macos-release.mjs" verify-app --app "$app_path" || fail 'APP_BUILD_VERIFY_FAILED'

printf '%s macOS app built and verified.\n' "$ERROR_PREFIX"
