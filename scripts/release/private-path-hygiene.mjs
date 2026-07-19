import { realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const REMOTE_URL_PREFIX_PATTERN =
  /(?:https?|ftp|sftp|ssh|git):\/\/[^\s<>"'`]*$/iu
const POSIX_HOME_PATH_PATTERN =
  /\/(?:Users|home)\/(?<user>[^/\s"'`,;:]+)(?=\/|[\s"'`,;:]|$)/gu
const PRIVATE_VAR_PATH_PATTERN =
  /\/private\/v\u0061r\/(?<scope>[^/\s"'`,;:]+)(?=\/|[\s"'`,;:]|$)/gu
const WINDOWS_HOME_PATH_PATTERN =
  /[A-Za-z]:[\\/]+Users[\\/]+(?<user>[^\\/\s"'`,;:]+)(?=[\\/]|[\s"'`,;:]|$)/giu
const UNC_PATH_PATTERN =
  /(?:^|[\/\s("'`=:[{,])\\{2,}(?<server>[A-Za-z0-9][A-Za-z0-9._-]{0,62}|<[^<>]+>)\\+(?<share>[A-Za-z0-9][A-Za-z0-9$_.-]{0,79}|<[^<>]+>)(?=\\|[\s"'`,;:]|$)/gu
const EXPLICIT_PLACEHOLDER_PATTERN =
  /^(?:<[^<>]+>|\{[^{}]+\}|\$\{[^{}]+\}|\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|\[[^\[\]]+\]|USER(?:NAME)?|YOUR_(?:USER|USERNAME))$/iu

function isExplicitPlaceholder(value) {
  return EXPLICIT_PLACEHOLDER_PATTERN.test(value)
}

function startsInsideRemoteUrl(value, index) {
  const prefix = value.slice(0, index).replaceAll("\\/", "/")
  return REMOTE_URL_PREFIX_PATTERN.test(prefix)
}

function patternContainsPrivatePath(value, pattern, placeholderGroups) {
  pattern.lastIndex = 0
  for (const match of value.matchAll(pattern)) {
    if (startsInsideRemoteUrl(value, match.index)) continue
    if (
      placeholderGroups.every((group) =>
        isExplicitPlaceholder(match.groups?.[group] ?? ""),
      )
    ) {
      continue
    }
    return true
  }
  return false
}

function exactRootAppears(value, roots) {
  for (const root of roots) {
    const variants = new Set([root, root.replaceAll("\\", "\\\\")])
    for (const variant of variants) {
      let offset = 0
      for (;;) {
        const index = value.indexOf(variant, offset)
        if (index === -1) break
        const next = value[index + variant.length]
        if (
          (next === undefined || !/[A-Za-z0-9._-]/u.test(next)) &&
          !startsInsideRemoteUrl(value, index)
        ) {
          return true
        }
        offset = index + variant.length
      }
    }
  }
  return false
}

export function privatePathRoots(...candidates) {
  const roots = [...candidates, os.homedir()]
  for (const candidate of [...roots]) {
    try {
      roots.push(realpathSync(candidate))
    } catch {
      // The unresolved absolute form remains a useful detection boundary.
    }
  }
  return [...new Set(roots)].filter(
    (value) =>
      typeof value === "string" &&
      path.isAbsolute(value) &&
      value !== path.parse(value).root,
  )
}

export function containsPrivateAbsolutePath(value, roots = []) {
  const views = new Set([value, value.replaceAll("\\/", "/")])
  for (const view of views) {
    if (
      exactRootAppears(view, roots) ||
      patternContainsPrivatePath(view, POSIX_HOME_PATH_PATTERN, ["user"]) ||
      patternContainsPrivatePath(view, PRIVATE_VAR_PATH_PATTERN, ["scope"]) ||
      patternContainsPrivatePath(view, WINDOWS_HOME_PATH_PATTERN, ["user"]) ||
      patternContainsPrivatePath(view, UNC_PATH_PATTERN, ["server", "share"])
    ) {
      return true
    }
  }
  return false
}
