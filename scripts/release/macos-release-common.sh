#!/usr/bin/env bash

readonly RELEASE_LOCK_PATH='/private/tmp/coding-wife-macos-release.lock'
readonly RELEASE_LOCK_WAIT_ATTEMPTS=300
readonly RELEASE_LOCK_WAIT_SECONDS='0.10'

RELEASE_LOCK_OWNED=0
RELEASE_LOCK_RUN_ID=''

release_read_lock_owner() {
  local owner_file="$RELEASE_LOCK_PATH/owner"
  local line=''
  RELEASE_LOCK_OWNER_PID='unknown'
  RELEASE_LOCK_OWNER_RUN='unknown'
  [[ -f "$owner_file" && ! -L "$owner_file" ]] || return 1
  while IFS= read -r line; do
    case "$line" in
      pid=*) RELEASE_LOCK_OWNER_PID="${line#pid=}" ;;
      run=*) RELEASE_LOCK_OWNER_RUN="${line#run=}" ;;
      *) return 1 ;;
    esac
  done < "$owner_file"
  [[ "$RELEASE_LOCK_OWNER_PID" =~ ^[0-9]+$ ]] || return 1
  [[ "$RELEASE_LOCK_OWNER_RUN" =~ ^[0-9A-Fa-f-]{36}$ ]] || return 1
}

release_acquire_lock() {
  local attempt=0
  local wait_attempts="$RELEASE_LOCK_WAIT_ATTEMPTS"
  local requested_run="${CODING_WIFE_RELEASE_LOCK_TOKEN:-}"
  local stale_path=''

  if [[ "${CODING_WIFE_RELEASE_TEST_LOCK_ATTEMPTS:-}" =~ ^[1-9][0-9]{0,2}$ ]] && \
    [[ "${CODING_WIFE_RELEASE_TEST_LOCK_ATTEMPTS}" -le "$RELEASE_LOCK_WAIT_ATTEMPTS" ]]; then
    wait_attempts="${CODING_WIFE_RELEASE_TEST_LOCK_ATTEMPTS}"
  fi

  if [[ -n "$requested_run" && ! "$requested_run" =~ ^[0-9A-Fa-f-]{36}$ ]]; then
    return 2
  fi

  while [[ "$attempt" -lt "$wait_attempts" ]]; do
    if /bin/mkdir "$RELEASE_LOCK_PATH" >/dev/null 2>&1; then
      /bin/chmod 700 "$RELEASE_LOCK_PATH" >/dev/null 2>&1 || return 2
      if [[ -n "$requested_run" ]]; then
        RELEASE_LOCK_RUN_ID="$requested_run"
      else
        RELEASE_LOCK_RUN_ID="$(/usr/bin/uuidgen 2>/dev/null || true)"
      fi
      [[ "$RELEASE_LOCK_RUN_ID" =~ ^[0-9A-Fa-f-]{36}$ ]] || return 2
      if ! /usr/bin/printf 'pid=%s\nrun=%s\n' "$$" "$RELEASE_LOCK_RUN_ID" > "$RELEASE_LOCK_PATH/owner"; then
        return 2
      fi
      /bin/chmod 600 "$RELEASE_LOCK_PATH/owner" >/dev/null 2>&1 || return 2
      RELEASE_LOCK_OWNED=1
      export CODING_WIFE_RELEASE_LOCK_TOKEN="$RELEASE_LOCK_RUN_ID"
      return 0
    fi

    [[ -d "$RELEASE_LOCK_PATH" && ! -L "$RELEASE_LOCK_PATH" ]] || return 2
    if release_read_lock_owner; then
      if [[ -n "$requested_run" && "$RELEASE_LOCK_OWNER_RUN" == "$requested_run" ]]; then
        RELEASE_LOCK_RUN_ID="$requested_run"
        RELEASE_LOCK_OWNED=0
        return 0
      fi
      if ! /bin/kill -0 "$RELEASE_LOCK_OWNER_PID" >/dev/null 2>&1; then
        stale_path="${RELEASE_LOCK_PATH}.stale.$$.$attempt"
        if /bin/mv "$RELEASE_LOCK_PATH" "$stale_path" >/dev/null 2>&1; then
          /bin/chmod -R u+w "$stale_path" >/dev/null 2>&1 || true
          /bin/rm -rf -- "$stale_path" >/dev/null 2>&1 || return 2
          continue
        fi
      fi
    fi
    /bin/sleep "$RELEASE_LOCK_WAIT_SECONDS"
    attempt=$((attempt + 1))
  done

  release_read_lock_owner || true
  /usr/bin/printf '[release] RELEASE_LOCK_BUSY owner_pid=%s run=%s\n' \
    "${RELEASE_LOCK_OWNER_PID:-unknown}" "${RELEASE_LOCK_OWNER_RUN:-unknown}" >&2
  return 1
}

release_release_lock() {
  [[ "$RELEASE_LOCK_OWNED" -eq 1 ]] || return 0
  if ! release_read_lock_owner || \
    [[ "$RELEASE_LOCK_OWNER_PID" != "$$" || "$RELEASE_LOCK_OWNER_RUN" != "$RELEASE_LOCK_RUN_ID" ]]; then
    return 1
  fi
  /bin/rm -f -- "$RELEASE_LOCK_PATH/owner" >/dev/null 2>&1 || return 1
  /bin/rmdir "$RELEASE_LOCK_PATH" >/dev/null 2>&1 || return 1
  RELEASE_LOCK_OWNED=0
  return 0
}

release_mount_device_from_plist() {
  local node_binary="$1"
  local helper="$2"
  local plist="$3"
  local mount_path="$4"
  local log="$5"
  local device=''
  device="$("$node_binary" "$helper" attached-device \
    --plist "$plist" --mount "$mount_path" 2>>"$log")" || return 1
  [[ "$device" =~ ^/dev/disk[0-9]+s[0-9]+$ ]] || return 1
  /usr/bin/printf '%s\n' "$device"
}

release_current_mount_device() {
  local node_binary="$1"
  local helper="$2"
  local mount_path="$3"
  local plist="$4"
  local log="$5"
  /usr/bin/hdiutil info -plist >"$plist" 2>>"$log" || return 1
  release_mount_device_from_plist "$node_binary" "$helper" "$plist" "$mount_path" "$log"
}

release_mount_is_absent() {
  local node_binary="$1"
  local helper="$2"
  local mount_path="$3"
  local device="$4"
  local plist="$5"
  local log="$6"
  /usr/bin/hdiutil info -plist >"$plist" 2>>"$log" || return 1
  "$node_binary" "$helper" assert-mount-absent \
    --plist "$plist" --mount "$mount_path" --device "$device" >>"$log" 2>&1
}

release_mount_path_is_absent() {
  local node_binary="$1"
  local helper="$2"
  local mount_path="$3"
  local plist="$4"
  local log="$5"
  /usr/bin/hdiutil info -plist >"$plist" 2>>"$log" || return 1
  "$node_binary" "$helper" assert-mount-path-absent \
    --plist "$plist" --mount "$mount_path" >>"$log" 2>&1
}

release_detach_mount() {
  local node_binary="$1"
  local helper="$2"
  local mount_path="$3"
  local device="$4"
  local plist="$5"
  local log="$6"
  local attempt=0

  [[ "$device" =~ ^/dev/disk[0-9]+s[0-9]+$ ]] || return 1
  while [[ "$attempt" -lt 100 ]]; do
    if release_mount_is_absent "$node_binary" "$helper" "$mount_path" "$device" "$plist" "$log"; then
      return 0
    fi
    /usr/bin/hdiutil detach -quiet "$device" >>"$log" 2>&1 || \
      /usr/bin/hdiutil detach -quiet -force "$device" >>"$log" 2>&1 || true
    /bin/sleep 0.05
    attempt=$((attempt + 1))
  done
  release_mount_is_absent "$node_binary" "$helper" "$mount_path" "$device" "$plist" "$log"
}
