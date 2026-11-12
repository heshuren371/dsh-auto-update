/**
 * 桌面版（Electron）自带更新器的检查与版本策略。
 *
 * 桌面版和 Web/CLI 端是两条更新线：Web 端跟随 git 通道（nightly/rc/alpha/stable
 * 都可以，由插件构建并切换）；桌面版的运行时固定在应用包里，只能由应用自己的
 * 更新器升级，并且只接受 rc 或更稳定的正式版——alpha 构建不进入桌面版。
 *
 * 这里只回答「feed 里最新是什么版本、允不允许装」；下载与安装仍由应用外壳完成。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isGreaterVersion, parseVersion } from './semver.js'

/**
 * 桌面版允许的版本线：正式版（无 prerelease）或 rc 预发布。
 * alpha/beta 等开发线拒绝。
 * @param version - semver 字符串。
 * @returns 允许安装返回 true。
 */
export function desktopVersionAllowed(version) {
  const parsed = parseVersion(version)
  if (parsed === null) return false
  return parsed.prerelease.length === 0 || parsed.prerelease[0] === 'rc'
}

/**
 * 桌面版更新通道只有 nightly (开发版) 与 stable (正式版)；其他值视为不可用。
 * @param value - 外部传入的通道名。
 * @returns 合法通道，或 null。
 */
export function normalizeDesktopChannel(value) {
  return value === 'nightly' || value === 'stable' ? value : null
}

/**
 * 从 electron-builder 的 feed YAML 里取顶层 `version`。
 * @param text - feed 文件内容。
 * @returns 版本字符串；没有则 null。
 */
export function parseFeedVersion(text) {
  if (typeof text !== 'string') return null
  const match = /^version:[ \t]*['"]?([^'"\r\n \t]+)['"]?[ \t]*$/m.exec(text)
  return match === null ? null : match[1]
}

/**
 * feed 文件名，对齐 electron-updater 的 getChannelFilePrefix：
 * macOS 带 `-mac`，Windows 不带平台后缀，Linux 带 `-linux`。
 * @param channel - 更新通道。
 * @param platform - `process.platform`。
 * @returns 形如 `nightly-mac.yml`。
 */
export function feedFileName(channel, platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return `${channel}-mac.yml`
  if (platform === 'win32') return `${channel}.yml`
  // electron-updater 在 Linux 上按架构区分 feed：x64 不带后缀。
  return `${channel}-linux${arch === 'x64' ? '' : `-${arch}`}.yml`
}

function yamlField(text, name) {
  const match = new RegExp(`^${name}:[ \\t]*['"]?([^'"\\r\\n]+?)['"]?[ \\t]*$`, 'm').exec(text)
  return match === null ? null : match[1].trim()
}

/**
 * 读打包应用里的 app-update.yml（provider 的 url / channel）。
 * 打包后这个文件在 `Contents/Resources/`（macOS）或可执行文件旁的 `resources/`。
 * @returns `{ file, url, channel }`；找不到返回 null。
 */
export function readAppUpdateConfig({ resourcesPath = process.resourcesPath, execPath = process.execPath } = {}) {
  const candidates = []
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push(path.join(resourcesPath, 'app-update.yml'))
  }
  if (typeof execPath === 'string' && execPath.length > 0) {
    candidates.push(path.join(path.dirname(execPath), '..', 'Resources', 'app-update.yml'))
    candidates.push(path.join(path.dirname(execPath), 'resources', 'app-update.yml'))
  }
  for (const file of candidates) {
    let text
    try {
      if (!existsSync(file)) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const url = yamlField(text, 'url')
    if (url === null) continue
    return { file, url, channel: yamlField(text, 'channel') ?? 'latest' }
  }
  return null
}

/**
 * 当前桌面版应用的版本号。
 * 优先用外壳传下来的 `DSH_CLIENT_VERSION`，否则读 app.asar/package.json。
 * @returns 版本字符串；读不到返回 null。
 */
export function readAppVersion({ env = process.env, resourcesPath = process.resourcesPath } = {}) {
  if (typeof env.DSH_CLIENT_VERSION === 'string' && env.DSH_CLIENT_VERSION.length > 0) return env.DSH_CLIENT_VERSION
  if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) return null
  for (const file of [path.join(resourcesPath, 'app.asar', 'package.json'), path.join(resourcesPath, 'package.json')]) {
    try {
      if (!existsSync(file)) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed?.version === 'string' && parsed.version.length > 0) return parsed.version
    } catch {
      // 换下一个候选
    }
  }
  return null
}

/**
 * 查桌面版 feed 里的最新版本，并按版本策略判定是否允许安装。
 * 网络或配置失败时 `ok=false` 且 `error` 给出原因；调用方不得在此时驱动官方更新器。
 *
 * @param options.installedVersion - 当前应用版本；默认从环境/应用包读取。
 * @param options.resourcesPath - 应用 Resources 目录（默认 `process.resourcesPath`）。
 * @param options.execPath - 应用可执行文件（默认 `process.execPath`）。
 * @param options.platform - 平台（默认 `process.platform`）。
 * @param options.fetchImpl - fetch 实现，测试可注入。
 * @param options.timeoutMs - feed 请求超时。
 * @returns `{ ok, appVersion, channel, feedVersion, newer, allowed, error, checkedAt }`。
 */
export async function checkDesktopUpdate({
  installedVersion,
  channel,
  resourcesPath = process.resourcesPath,
  execPath = process.execPath,
  platform = process.platform,
  arch = process.arch,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
} = {}) {
  const appVersion = installedVersion === undefined ? readAppVersion({ resourcesPath }) : installedVersion
  const base = {
    ok: false,
    appVersion: typeof appVersion === 'string' && appVersion.length > 0 ? appVersion : null,
    channel: null,
    feedVersion: null,
    newer: false,
    allowed: false,
    error: null,
    checkedAt: new Date().toISOString(),
  }
  const config = readAppUpdateConfig({ resourcesPath, execPath })
  if (config === null) return { ...base, error: '找不到桌面版更新配置 app-update.yml' }
  // 优先用应用当前选中的通道（界面可能已从 app-update.yml 的默认值改成另一条）。
  const feedChannel = normalizeDesktopChannel(channel) ?? config.channel
  const url = new URL(feedFileName(feedChannel, platform, arch), config.url.endsWith('/') ? config.url : `${config.url}/`).href
  let text
  try {
    const response = await fetchImpl(url, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok !== true) return { ...base, channel: feedChannel, error: `更新源返回 HTTP ${response.status}` }
    text = await response.text()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ...base, channel: feedChannel, error: `读取桌面版更新源失败：${reason}` }
  }
  const feedVersion = parseFeedVersion(text)
  if (feedVersion === null) return { ...base, channel: feedChannel, error: '更新源里没有可读的版本号' }
  const allowed = desktopVersionAllowed(feedVersion)
  const newer = base.appVersion !== null && isGreaterVersion(feedVersion, base.appVersion)
  return { ...base, ok: true, channel: feedChannel, feedVersion, newer, allowed, error: null }
}
