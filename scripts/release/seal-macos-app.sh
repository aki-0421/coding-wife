#!/usr/bin/env bash

set -euo pipefail
IFS=$'\n\t'
export LC_ALL=C
umask 077

readonly ERROR_PREFIX='[release]'
readonly WORK_PREFIX='.coding-wife-sign-work.'

app_input=''
work_dir=''

fail() {
  printf '%s %s\n' "$ERROR_PREFIX" "$1" >&2
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$work_dir" && -d "$work_dir" && ! -L "$work_dir" ]]; then
    local name=''
    name="$(/usr/bin/basename "$work_dir" 2>/dev/null || true)"
    if [[ "$name" == "$WORK_PREFIX"* ]]; then
      /bin/chmod -R u+w "$work_dir" >/dev/null 2>&1 || true
      /bin/rm -rf -- "$work_dir" >/dev/null 2>&1 || status=1
    else
      status=1
    fi
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ $# -ne 2 || "$1" != '--app' || -z "$2" ]]; then
  fail 'APP_SEAL_ARGUMENT_INVALID'
fi
app_input="$2"

[[ "$(/usr/bin/uname -s 2>/dev/null || true)" == 'Darwin' ]] || fail 'APP_SEAL_PLATFORM_UNSUPPORTED'
for tool in /bin/chmod /bin/rm /usr/bin/basename /usr/bin/codesign /usr/bin/file /usr/bin/find /usr/bin/grep /usr/bin/mktemp; do
  [[ -x "$tool" ]] || fail 'APP_SEAL_TOOL_UNAVAILABLE'
done

[[ -d "$app_input" && ! -L "$app_input" ]] || fail 'APP_SEAL_BUNDLE_INVALID'
[[ -d "$app_input/Contents" && ! -L "$app_input/Contents" ]] || fail 'APP_SEAL_BUNDLE_INVALID'
[[ -f "$app_input/Contents/Info.plist" && ! -L "$app_input/Contents/Info.plist" ]] || fail 'APP_SEAL_BUNDLE_INVALID'

work_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/$WORK_PREFIX"'XXXXXX' 2>/dev/null)" || fail 'APP_SEAL_WORK_UNAVAILABLE'
[[ -d "$work_dir" && ! -L "$work_dir" ]] || fail 'APP_SEAL_WORK_UNAVAILABLE'
tool_log="$work_dir/tool.log"
nested_count=0

sign_target() {
  if ! /usr/bin/codesign --force --sign - --timestamp=none "$1" >>"$tool_log" 2>&1; then
    fail 'APP_SEAL_SIGN_FAILED'
  fi
  nested_count=$((nested_count + 1))
}

while IFS= read -r -d '' candidate; do
  if /usr/bin/file -b "$candidate" 2>/dev/null | /usr/bin/grep -q '^Mach-O'; then
    sign_target "$candidate"
  fi
done < <(/usr/bin/find "$app_input/Contents" -type f -print0)

while IFS= read -r -d '' candidate; do
  sign_target "$candidate"
done < <(
  /usr/bin/find "$app_input/Contents" -depth -type d \( \
    -name '*.framework' -o \
    -name '*.xpc' -o \
    -name '*.appex' -o \
    -name '*.plugin' \
  \) -print0
)

if [[ "$nested_count" -lt 1 ]]; then
  fail 'APP_SEAL_NESTED_CODE_MISSING'
fi

if ! /usr/bin/codesign --force --sign - --timestamp=none "$app_input" >>"$tool_log" 2>&1; then
  fail 'APP_SEAL_SIGN_FAILED'
fi
if ! /usr/bin/codesign --verify --deep --strict --verbose=2 "$app_input" >>"$tool_log" 2>&1; then
  fail 'APP_SEAL_VERIFY_FAILED'
fi

printf '%s nested code and app resources sealed with a timestamp-free ad-hoc signature.\n' "$ERROR_PREFIX"
