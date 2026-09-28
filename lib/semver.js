/**
 * 极简 semver 校验与比较（零依赖）。
 *
 * 对齐官方 Desktop 更新器的判定方式：先 valid() 校验 feed 版本，再用
 * semver.gt(candidate, current) 决定是否真的有更新；不盲信上游的
 * isUpdateAvailable 标记，也绝不让「不比当前新」的目标进入构建。
 * 支持 1.2.3 / 1.2.3-rc.1 / 1.2.3+build 形式，够 harness 用。
 */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析版本号；非法返回 null。 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = VERSION_RE.exec(text.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** 是否是合法 semver。 */
export function isValidVersion(text) {
  return parseVersion(text) !== null
}

function comparePrerelease(left, right) {
  // 无 prerelease 视为更大：1.0.0 > 1.0.0-rc.1（semver 规则）。
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumber = /^\d+$/.test(a) ? Number(a) : null
    const bNumber = /^\d+$/.test(b) ? Number(b) : null
    if (aNumber !== null && bNumber !== null) {
      if (aNumber !== bNumber) return aNumber < bNumber ? -1 : 1
      continue
    }
    if (aNumber !== null) return -1
    if (bNumber !== null) return 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** 比较两个版本：a<b 返回 -1，相等 0，a>b 返回 1；任一非法返回 null。 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** a 是否严格新于 b；任一非法返回 false（宁可不更新，也不误报）。 */
export function isGreaterVersion(a, b) {
  const result = compareVersions(a, b)
  return result !== null && result > 0
}
