/**
 * @local/dsh-auto-update — 宿主半（Host）。
 *
 * 核心安全原则（v0.2 重构）：
 *   1. **不在正在运行的代码上更新**。更新在独立的 git worktree「试运行副本」里
 *      install + build，主仓库和正在跑的服务都不受影响。
 *   2. **先试启动，再切换**。新构建必须能在空闲端口上用真实 profile 起来并通过
 *      HTTP 校验，才有资格谈重启；起不来就什么都不动，报错退出。
 *   3. **插件冲突自动隔离**。试启动报 `failed to apply loader entry <id>` 且
 *      属于第三方插件时，生成 --patch 覆盖层临时禁用该条目后重试；最多禁 8 个。
 *   4. **重启是独立进程负责的**。scripts/switch.mjs 在宿主进程死掉之后继续工作：
 *      清理端口残留 → 起新版本 → 等就绪 → 失败则用旧入口回滚。全程写
 *      switch-status.json，界面能看到真实结果，不会「服务到底起没起来」全靠猜。
 *
 * 对外面（路由前缀 `/dsh-updater`，客户端半用 fetch 调用）：
 *   GET  /dsh-updater/api/state?since=N  读取当前状态 + 增量日志
 *   POST /dsh-updater/api/check          执行 git fetch 并比对上游
 *   POST /dsh-updater/api/update         启动更新流水线（后台，立即返回）
 *   POST /dsh-updater/api/cancel         终止正在运行的流水线
 *   POST /dsh-updater/api/restart        用安全切换器重启 dsh web
 *   POST /dsh-updater/api/plugins/retry  清除「临时禁用插件」列表
 *
 * 零核心改动：卸载插件即摘除路由，不留任何后台进程。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture, killChild, readJson, runBash, sh, sleep, writeJsonAtomic } from './util.js'
import {
  CANARY_READY_TIMEOUT_MS,
  canaryBoot,
  parsePort,
  tailLines,
  withQuarantineArg,
  writeQuarantinePatch,
} from './probe.js'

/** Cordis 插件名，用于 Loader 诊断。 */
const name = 'auto-update'
/**
 * 硬依赖。
 *
 * webServer 提供对外 HTTP 面；connection 提供访问栅栏 —— 这不是可选的：
 * `webServer` 本身**不做任何鉴权**，cookie/Origin 检查只在 harness 自己的
 * RPC 通道和静态首页里执行，任何插件注册的 webServer 路由默认对全网开放。
 * 缺了 connection 就无法判断请求来源，那就宁可不加载。
 */
const inject = ['webServer', 'connection']

/** HTTP 路由前缀。刻意用独立前缀，避免与其他插件冲突。 */
const ROUTE_PREFIX = '/dsh-updater'
/** 上游仓库地址（仅用于展示）。 */
const UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness'
/** 探测不到运行目录时的兜底路径：默认假设 harness 克隆在 `~/deepseek-harness`。 */
const FALLBACK_REPO = path.join(os.homedir(), 'deepseek-harness')
/** 内存日志环形缓冲上限：行数 + 总字节数双重封顶。 */
const MAX_LOG_LINES = 400
const MAX_LOG_BYTES = 256 * 1024
/** 单次 git fetch 的超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 120_000
/** 单条 git 查询的超时。 */
const GIT_TIMEOUT_MS = 20_000
/** 整条更新流水线的兜底超时：构建再慢也不该无限挂着占住状态机。 */
const PIPELINE_TIMEOUT_MS = 45 * 60_000
/** 试运行副本数量：蓝绿两套，切换时上一套仍然完整，回滚不用重建。 */
const SLOT_NAMES = ['a', 'b']
/** 一次更新里最多自动禁用多少个不兼容插件。 */
const MAX_QUARANTINE = 8
/**
 * 试运行「快速失败」的重试次数。
 * 多个 dsh 实例并发加载同一 profile、或系统瞬时资源紧张时，会出现
 * `hmr.registerConfig is not a function` 之类的偶发启动失败；重试即可排除。
 * 超时（挂住）不重试：那通常不是竞态，重试只会拖长等待。
 */
const MAX_CANARY_RETRIES = 2
/**
 * 校验 origin 是否就是本插件声称要跟随的仓库。
 * 不确认的话，origin 被改成任意地址时会把陌生代码拉进来再执行它的构建脚本。
 */
const ORIGIN_PATTERN = /(^|[/:])deepseek-ai\/deepseek-harness(\.git)?\/?$/
const ALLOW_ANY_ORIGIN = process.env.DSH_UPDATE_ALLOW_ANY_ORIGIN === '1'
/** 变更类接口要求的自定义请求头（跨站简单请求加不上）。 */
const GUARD_HEADER = 'x-dsh-updater'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
/** 上次检测结果的落地缓存。 */
const CACHE_FILE = path.join(DSH_HOME, 'dsh-auto-update-cache.json')
/** 本插件的持久状态目录：蓝绿副本、运行指针、切换状态都放这里。 */
const STATE_DIR = process.env.DSH_UPDATE_STATE ?? path.join(DSH_HOME, 'dsh-auto-update')
const SLOTS_DIR = path.join(STATE_DIR, 'slots')
const RUNTIME_FILE = path.join(STATE_DIR, 'runtime.json')
const SWITCH_JOB_FILE = path.join(STATE_DIR, 'switch-job.json')
const SWITCH_STATUS_FILE = path.join(STATE_DIR, 'switch-status.json')
const SWITCH_LOG = path.join(STATE_DIR, 'switch.log')
const QUARANTINE_FILE = path.join(STATE_DIR, 'quarantine.yml')
/** 独立切换器。宿主进程退出后由它接手启动新版本。 */
const SWITCH_SCRIPT = fileURLToPath(new URL('../scripts/switch.mjs', import.meta.url))

/** 流水线步骤标签。 */
const PIPELINE = [
  { id: 'snapshot', label: '记录回滚点' },
  { id: 'fetch', label: '拉取上游提交' },
  { id: 'stage', label: '准备试运行副本' },
  { id: 'install', label: '安装依赖' },
  { id: 'build', label: '构建产物' },
  { id: 'canary', label: '试运行校验' },
]
const STEP_LABEL = new Map(PIPELINE.map((step) => [step.id, step.label]))

/** 进程内状态。插件停用即随之消失；磁盘上的 runtime.json 只是运行指针。 */
const state = {
  repo: FALLBACK_REPO,
  phase: 'idle',
  step: null,
  error: null,
  log: [],
  logBytes: 0,
  seq: 0,
  snapshot: null,
  checkedAt: null,
  startedAt: null,
  finishedAt: null,
  /** 正在跑的更新流水线。cancel 只允许杀它，不能误杀一次普通的 git 查询。 */
  pipeline: null,
  /** 所有在跑的子进程；插件停用时统一回收，不留孤儿构建。 */
  children: new Set(),
  cancelRequested: false,
  /** 流水线代次：只有最新一代的收尾回调有权改写状态。 */
  runId: 0,
  /** runtime.json 的内容：active / candidate / quarantined / lastUpdate。 */
  runtimeAsset: null,
  /** 试运行结果摘要（冲突、端口、错误），供界面展示。 */
  canary: null,
  /** 被临时禁用的 loader entry id 集合。 */
  quarantine: new Set(),
  /** 启动真实服务用的原始参数（试运行和重启都复用它）。 */
  restartArgs: ['web'],
}

function appendLog(line) {
  const text = String(line).replace(/\s+$/, '')
  if (text.length === 0) return
  state.seq += 1
  state.log.push({ seq: state.seq, line: text })
  state.logBytes += text.length
  while (state.log.length > MAX_LOG_LINES
    || (state.logBytes > MAX_LOG_BYTES && state.log.length > 1)) {
    const dropped = state.log.shift()
    state.logBytes -= dropped.line.length
  }
}

/** 清空日志但**不重置 seq**：客户端按 seq 增量拉取，回退会让它永远拉不到内容。 */
function resetLog() {
  state.log = []
  state.logBytes = 0
}

function setPhase(phase, error = null) {
  state.phase = phase
  state.error = error
}

function nowIso() {
  return new Date().toISOString()
}

/** 判定某个目录是否看起来是 harness 仓库根（worktree 的 .git 是文件，existsSync 同样成立）。 */
function looksLikeRepo(dir) {
  try {
    return existsSync(path.join(dir, '.git')) && existsSync(path.join(dir, 'pnpm-workspace.yaml'))
  } catch {
    return false
  }
}

/**
 * 从副本（git worktree）回溯到主仓库根：worktree 的 --git-common-dir 指向
 * 主仓库的 .git。fetch / 建副本都在主仓库做。
 */
function resolveMainWorktree(dir) {
  try {
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', timeout: 5000,
    }).trim()
    if (common.length > 0) {
      const root = path.dirname(common)
      if (looksLikeRepo(root)) return root
    }
  } catch {
    // 不是 git 仓库或 git 不可用：保持原路径。
  }
  return dir
}

/**
 * 探测当前 dsh 实际运行的仓库根。
 * 依次尝试：显式环境变量 → CLI 入口所在目录向上回溯 → 兜底路径。
 * 如果入口本身在试运行副本里，回溯到主仓库。
 */
function detectRepo() {
  const candidates = []
  const fromEnv = process.env.DSH_UPDATE_REPO
  if (typeof fromEnv === 'string' && fromEnv.length > 0) candidates.push(fromEnv)
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry.length > 0) {
    let current = path.dirname(path.resolve(entry))
    for (let depth = 0; depth < 8 && current !== path.dirname(current); depth += 1) {
      candidates.push(current)
      current = path.dirname(current)
    }
  }
  candidates.push(FALLBACK_REPO)
  for (const candidate of candidates) {
    if (looksLikeRepo(candidate)) return resolveMainWorktree(candidate)
  }
  return FALLBACK_REPO
}

/** 单个 git 查询：返回 stdout（已 trim）。 */
async function git(repo, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const { out } = await capture(`git -C ${sh(repo)} ${args}`, { cwd: repo, timeoutMs })
  return out.trim()
}

/** 读取工作目录里 package.json 的版本号。 */
function readVersion(dir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** 读取某个提交里的 package.json 版本号（不 checkout）。 */
async function readVersionAt(repo, sha) {
  const { code, out } = await capture(`git -C ${sh(repo)} show ${sh(sha + ':package.json')}`, { cwd: repo, timeoutMs: GIT_TIMEOUT_MS })
  if (code !== 0) return null
  try {
    const parsed = JSON.parse(out)
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** 解析 `%h\x1f%s\x1f%cI` 形式的单行提交摘要。 */
function parseCommitLine(line) {
  if (line.length === 0) return null
  const [short, subject, date] = line.split('\u001f')
  if (short === undefined || short.length === 0) return null
  return { short, subject: subject ?? '', date: date ?? '' }
}

/** 上游引用：优先当前分支自己的 upstream；否则 origin/HEAD。 */
async function upstreamRef(repo) {
  const tracking = await git(repo, 'rev-parse --abbrev-ref --symbolic-full-name @{upstream}')
  if (tracking.length > 0 && tracking.includes('/')) return tracking
  const symbolic = await git(repo, 'symbolic-ref --short refs/remotes/origin/HEAD')
  if (symbolic.length > 0) return symbolic
  return null
}

/**
 * 采集一次快照。`behind` 是「上游相对**正在运行的版本**」的提交数：
 * 更新是在副本里做的，主仓库 HEAD 不再代表运行版本。
 */
async function readSnapshot(repo = state.repo) {
  const originUrl = await git(repo, 'remote get-url origin')
  const originOk = originUrl.length > 0 && ORIGIN_PATTERN.test(originUrl)
  const base = { repo, upstream: UPSTREAM, originUrl: originUrl.length > 0 ? originUrl : null, originOk }

  const probe = await capture(`git -C ${sh(repo)} rev-parse --is-inside-work-tree`, { cwd: repo, timeoutMs: GIT_TIMEOUT_MS })
  if (probe.code !== 0 || probe.out.trim() !== 'true') {
    return { ...base, ref: null, isRepo: false, ok: false, error: `不是 git 仓库或 git 不可用：${repo}` }
  }

  const ref = await upstreamRef(repo)
  const [branch, repoHeadSha, remoteSha, repoHeadLine, remoteLine, status, countLine] = await Promise.all([
    git(repo, 'rev-parse --abbrev-ref HEAD'),
    git(repo, 'rev-parse HEAD'),
    ref === null ? Promise.resolve('') : git(repo, `rev-parse ${sh(ref)}`),
    git(repo, "log -1 --format='%h%x1f%s%x1f%cI'"),
    ref === null ? Promise.resolve('') : git(repo, `log -1 --format='%h%x1f%s%x1f%cI' ${sh(ref)}`),
    git(repo, 'status --porcelain'),
    ref === null ? Promise.resolve('') : git(repo, `rev-list --left-right --count HEAD...${sh(ref)}`),
  ])

  if (ref === null || remoteSha.length === 0) {
    return {
      ...base,
      ref: ref ?? null,
      isRepo: true,
      ok: false,
      branch: branch.length > 0 ? branch : 'HEAD(detached)',
      version: readVersion(repo),
      error: `无法解析上游引用（${ref ?? '当前分支没有 upstream，也读不到 origin/HEAD'}），先执行一次 git fetch origin`,
    }
  }

  const dirtyLines = status.length > 0 ? status.split('\n').filter((line) => line.trim().length > 0) : []
  const counts = countLine.split(/\s+/).filter((part) => part.length > 0)
  const repoAhead = Number.parseInt(counts[0] ?? '0', 10) || 0
  const repoBehind = Number.parseInt(counts[1] ?? '0', 10) || 0

  // 运行版本：优先 runtime.json 里记录的 active 副本；否则退回主仓库 HEAD。
  const active = state.runtimeAsset?.active
  const hasActive = typeof active?.commit === 'string' && /^[0-9a-f]{7,40}$/.test(active.commit)
  let behind = repoBehind
  let head = { sha: repoHeadSha, ...(parseCommitLine(repoHeadLine) ?? { short: repoHeadSha.slice(0, 8), subject: '', date: '' }) }
  const version = readVersion(repo)
  if (hasActive) {
    const count = await git(repo, `rev-list --count ${sh(active.commit + '..' + ref)}`)
    if (/^\d+$/.test(count)) behind = Number.parseInt(count, 10)
    const activeLine = await git(repo, `log -1 --format='%h%x1f%s%x1f%cI' ${sh(active.commit)}`)
    head = {
      sha: active.commit,
      ...(parseCommitLine(activeLine) ?? { short: active.commit.slice(0, 8), subject: '', date: '' }),
    }
  }
  // 首次从「不受管」的运行方式（例如 npm 全局安装）迁移过来时，即便仓库已是最新，
  // 也需要允许做一次「构建副本 → 试运行 → 切换」。否则界面永远不给更新按钮。
  const mustMigrate = !hasActive || runningMatchesActive() === false
  return {
    ...base,
    ref,
    isRepo: true,
    ok: true,
    branch: branch.length > 0 ? branch : 'HEAD(detached)',
    version: hasActive && typeof active.version === 'string' ? active.version : version,
    head,
    repoHead: { sha: repoHeadSha, ...(parseCommitLine(repoHeadLine) ?? { short: repoHeadSha.slice(0, 8), subject: '', date: '' }) },
    remote: { sha: remoteSha, ...(parseCommitLine(remoteLine) ?? { short: remoteSha.slice(0, 8), subject: '', date: '' }) },
    behind,
    ahead: repoAhead,
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    mustMigrate,
    updateAvailable: behind > 0 || mustMigrate,
    runningFromRepo: hasActive,
    checkedAt: state.checkedAt,
  }
}

/** 读取上次检测缓存（严格校验形状）。 */
function loadCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const snapshot = parsed.snapshot
    if (typeof snapshot !== 'object' || snapshot === null) return null
    if (snapshot.ok !== true || snapshot.isRepo !== true) return null
    if (typeof snapshot.branch !== 'string') return null
    if (typeof snapshot.head !== 'object' || snapshot.head === null) return null
    if (typeof snapshot.head.short !== 'string') return null
    if (typeof snapshot.behind !== 'number' || typeof snapshot.ahead !== 'number') return null
    if (snapshot.remote !== null && (typeof snapshot.remote !== 'object' || typeof snapshot.remote.short !== 'string')) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function saveCache(snapshot) {
  if (snapshot === null || snapshot === undefined || snapshot.ok !== true) return
  try {
    writeJsonAtomic(CACHE_FILE, { snapshot, checkedAt: state.checkedAt })
  } catch {
    // 缓存只是体验优化。
  }
}

/** 读取磁盘上的运行指针 / 禁用列表。形状异常时忽略，不让插件起不来。 */
function loadRuntimeAsset() {
  const parsed = readJson(RUNTIME_FILE)
  if (parsed === null) return
  state.runtimeAsset = parsed
  const quarantined = Array.isArray(parsed.quarantined)
    ? parsed.quarantined.filter((value) => typeof value === 'string' && value.length > 0)
    : []
  state.quarantine = new Set(quarantined)
}

/** active-entry 是给 shell 用的纯文本指针（runtime.json 里是 JSON + token）。 */
function writeActiveEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0) return
  try {
    writeFileSync(path.join(STATE_DIR, 'active-entry'), entry + '\n')
  } catch {
    // 只是给 shell 用的便利文件，写不进去不影响功能。
  }
}

/** 合并写回运行指针（0600：里面有 token URL）。 */
function saveRuntimeAsset(patch) {
  const previous = state.runtimeAsset !== null && typeof state.runtimeAsset === 'object' ? state.runtimeAsset : {}
  const next = { ...previous, ...patch, updatedAt: nowIso() }
  state.runtimeAsset = next
  try {
    writeJsonAtomic(RUNTIME_FILE, next, { mode: 0o600 })
    if (typeof next.active?.entry === 'string') writeActiveEntry(next.active.entry)
  } catch (error) {
    appendLog(`· 写入运行指针失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 读取切换器写的状态（每次请求读一次；文件很小）。 */
function loadSwitchStatus() {
  const parsed = readJson(SWITCH_STATUS_FILE)
  if (parsed === null) return null
  if (typeof parsed.phase !== 'string') return null
  return {
    phase: parsed.phase,
    at: typeof parsed.at === 'string' ? parsed.at : null,
    port: typeof parsed.port === 'number' ? parsed.port : null,
    newPid: typeof parsed.newPid === 'number' ? parsed.newPid : null,
    url: typeof parsed.url === 'string' ? parsed.url : null,
    error: typeof parsed.error === 'string' ? parsed.error : null,
    message: typeof parsed.message === 'string' ? parsed.message : null,
    rolledBack: parsed.rolledBack === true,
  }
}

/** 当前进程入口是否就是 runtime.json 记录的 active 入口。 */
function runningMatchesActive() {
  const active = state.runtimeAsset?.active
  const entry = process.argv[1]
  if (typeof active?.entry !== 'string' || typeof entry !== 'string') return null
  return path.resolve(active.entry) === path.resolve(entry)
}

/** 检测更新：git fetch 后比对。 */
async function check() {
  if (state.phase === 'updating') return { ok: false, error: '更新正在进行中，暂时不能检测' }
  if (state.phase === 'checking') return { ok: false, error: '检测已经在进行中' }
  setPhase('checking')
  appendLog(`· 正在检测更新：git fetch origin（${state.repo}）`)
  const code = await runBash(`git -C ${sh(state.repo)} fetch --prune origin`, {
    cwd: state.repo,
    onLine: (line) => appendLog(line),
    timeoutMs: FETCH_TIMEOUT_MS,
    // 登记进统一回收集合：插件停用时不能留下没人管的 git fetch。
    onSpawn: (child) => state.children.add(child),
    onExit: (child) => state.children.delete(child),
  })
  state.checkedAt = nowIso()
  const snapshot = await readSnapshot()
  state.snapshot = snapshot
  if (code !== 0) {
    setPhase('error', 'git fetch 失败，请检查网络或仓库权限')
    appendLog(`· 检测失败（退出码 ${code}）`)
    saveCache(snapshot)
    return { ok: false, error: 'git fetch 失败，请检查网络或仓库权限' }
  }
  if (snapshot.ok !== true) {
    const reason = snapshot.error ?? '无法读取仓库状态'
    setPhase('error', reason)
    appendLog(`· 检测受阻：${reason}`)
    saveCache(snapshot)
    return { ok: false, error: reason }
  }
  // 如果已经有一个试运行通过、还没切换的候选，检查更新不能把「可重启」状态抹掉。
  const pendingCandidate = state.runtimeAsset?.candidate
  const candidateReady = pendingCandidate !== null && pendingCandidate !== undefined
    && pendingCandidate.canaryOk === true
    && typeof pendingCandidate.entry === 'string'
    && existsSync(pendingCandidate.entry)
    && runningMatchesActive() !== true
  setPhase(candidateReady ? 'done' : 'idle')
  appendLog(snapshot.updateAvailable
    ? `· 发现 ${snapshot.behind} 个新提交（运行 ${snapshot.head.short} → 上游 ${snapshot.remote?.short ?? '?'}）`
    : `· 已是最新版本（运行 ${snapshot.head.short}）`)
  if (candidateReady) appendLog('· 已有试运行通过、等待切换的新版本，点「重启生效」即可。')
  saveCache(snapshot)
  return { ok: true }
}

class PipelineCancelled extends Error {
  constructor() { super('已取消'); this.name = 'PipelineCancelled' }
}

/** 运行一步 bash，接入取消 / 子进程回收 / 整体超时。 */
async function stepBash(script, { cwd, timeoutMs = PIPELINE_TIMEOUT_MS } = {}) {
  if (state.cancelRequested) throw new PipelineCancelled()
  const code = await runBash(script, {
    cwd,
    timeoutMs,
    onLine: (line) => appendLog(line),
    onErrLine: (line) => appendLog(line),
    onSpawn: (child) => {
      state.children.add(child)
      state.pipeline = child
    },
    onExit: (child) => {
      state.children.delete(child)
      if (state.pipeline === child) state.pipeline = null
    },
  })
  if (state.cancelRequested) throw new PipelineCancelled()
  return code
}

/** 解析更新目标：默认跟随分支 upstream；DSH_UPDATE_CHANNEL=tag 时跟随最新 dsh-v* 标签。 */
async function resolveTarget(repo) {
  const channel = process.env.DSH_UPDATE_CHANNEL === 'tag' ? 'tag' : 'master'
  if (channel === 'tag') {
    const tags = await git(repo, "tag --sort=-creatordate --list 'dsh-v*'")
    const tag = tags.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
    if (tag === undefined) throw new Error('仓库里没有 dsh-v* 标签；可去掉 DSH_UPDATE_CHANNEL=tag 跟随分支')
    const sha = await git(repo, `rev-parse ${sh(tag + '^{commit}')}`)
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`无法解析标签 ${tag}`)
    return { ref: tag, sha, version: await readVersionAt(repo, sha), channel }
  }
  const ref = await upstreamRef(repo)
  if (ref === null) throw new Error('无法解析上游引用（当前分支没有 upstream，也读不到 origin/HEAD）')
  const sha = await git(repo, `rev-parse ${sh(ref)}`)
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`无法解析 ${ref}`)
  return { ref, sha, version: await readVersionAt(repo, sha), channel }
}

/** 已注册的 worktree 路径集合（用于判断副本目录是否已被 git 认领）。 */
async function registeredWorktrees(repo) {
  const out = await git(repo, 'worktree list --porcelain')
  const paths = new Set()
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) paths.add(path.resolve(line.slice('worktree '.length).trim()))
  }
  return paths
}

/** 找到并准备「非 active」的那套副本；蓝绿交替，上一套保持可用以便秒回滚。 */
async function prepareSlot(repo, sha) {
  const activeRoot = state.runtimeAsset?.active?.root
  const activeResolved = typeof activeRoot === 'string' ? path.resolve(activeRoot) : null
  let chosen = null
  for (const slotName of SLOT_NAMES) {
    const candidate = path.resolve(path.join(SLOTS_DIR, slotName))
    if (activeResolved !== null && candidate === activeResolved) continue
    chosen = candidate
    break
  }
  if (chosen === null) chosen = path.resolve(path.join(SLOTS_DIR, SLOT_NAMES[0]))

  await git(repo, 'worktree prune')
  const registered = await registeredWorktrees(repo)
  if (registered.has(chosen)) {
    const code = await stepBash(`git -C ${sh(chosen)} checkout --detach ${sh(sha)}`)
    if (code !== 0) throw new Error(`试运行副本切换提交失败：${chosen}`)
  } else {
    if (existsSync(chosen)) rmSync(chosen, { recursive: true, force: true })
    const code = await stepBash(`git -C ${sh(repo)} worktree add --detach ${sh(chosen)} ${sh(sha)}`)
    if (code !== 0) throw new Error(`创建试运行副本失败：${chosen}`)
  }
  return chosen
}

/**
 * 试运行 + 冲突隔离：新构建必须能起来；起不来且报的是第三方 loader entry，
 * 就写 --patch 禁用该条重试。全部重试都失败则整体失败（正在跑的服务不受影响）。
 */
async function canaryWithQuarantine(slot, target) {
  const entry = path.join(slot, 'apps/cli/lib/bin.js')
  if (!existsSync(entry)) {
    return { ok: false, entry, error: `构建完成但入口不存在：${entry}`, conflicts: [], attempts: 0 }
  }
  let attempts = 0
  for (;;) {
    if (state.cancelRequested) throw new PipelineCancelled()
    attempts += 1
    const quarantineFile = state.quarantine.size > 0 ? QUARANTINE_FILE : null
    if (quarantineFile !== null) writeQuarantinePatch(QUARANTINE_FILE, [...state.quarantine])
    appendLog(attempts === 1
      ? `· 在空闲端口试启动新版本（真实 profile）…`
      : `· 第 ${attempts} 次试启动（已临时禁用 ${state.quarantine.size} 个插件）…`)
    const attemptStart = Date.now()
    let result = await canaryBoot({
      entry,
      args: state.restartArgs,
      cwd: process.cwd(),
      quarantineFile,
      timeoutMs: CANARY_READY_TIMEOUT_MS,
      onLine: (line) => appendLog(`[canary] ${line}`),
    })
    // 没有可隔离的冲突、且是快速退出（非超时）时，先重试排除偶发竞态。
    const hasConflictCandidate = result.conflicts.some((conflict) => !conflict.core && !state.quarantine.has(conflict.id))
    for (let retry = 1; !result.ok && !hasConflictCandidate && retry <= MAX_CANARY_RETRIES
      && result.exitCode !== null && Date.now() - attemptStart < 60_000; retry += 1) {
      appendLog(`· 试运行快速失败（退出码 ${result.exitCode}），第 ${retry}/${MAX_CANARY_RETRIES} 次重试…`)
      await sleep(2000)
      result = await canaryBoot({
        entry,
        args: state.restartArgs,
        cwd: process.cwd(),
        quarantineFile,
        timeoutMs: CANARY_READY_TIMEOUT_MS,
        onLine: (line) => appendLog(`[canary] ${line}`),
      })
    }
    if (result.ok) {
      appendLog(`· 试运行通过：${result.bareUrl}（pid ${result.pid}，已收掉）`)
      return { ok: true, entry, port: result.port, url: result.url, bareUrl: result.bareUrl, attempts, conflicts: [], error: null }
    }
    appendLog(`· 试运行失败：${result.error}`)
    for (const line of tailLines(result.output, 8)) appendLog(`[canary] ${line}`)
    const fresh = result.conflicts.filter((conflict) => !conflict.core && !state.quarantine.has(conflict.id))
    if (fresh.length === 0) {
      return { ok: false, entry, error: result.error, conflicts: result.conflicts, attempts }
    }
    for (const conflict of fresh) {
      state.quarantine.add(conflict.id)
      appendLog(`· 临时禁用不兼容插件：${conflict.id}${conflict.pkg.length > 0 ? `（${conflict.pkg}）` : ''}`)
    }
    if (state.quarantine.size > MAX_QUARANTINE) {
      return { ok: false, entry, error: `不兼容插件超过 ${MAX_QUARANTINE} 个，已放弃自动隔离`, conflicts: result.conflicts, attempts }
    }
    saveRuntimeAsset({ quarantined: [...state.quarantine] })
  }
}

function summarizeRuntime(active) {
  if (active === null || active === undefined || typeof active !== 'object') return null
  return {
    entry: typeof active.entry === 'string' ? active.entry : null,
    root: typeof active.root === 'string' ? active.root : null,
    version: typeof active.version === 'string' ? active.version : null,
    commit: typeof active.commit === 'string' ? active.commit : null,
  }
}

/** 后台执行整条更新流水线。调用方已同步把 phase 置成 updating。 */
async function runUpdate(runId) {
  const repo = state.repo
  let rollbackSha = null
  try {
    const mark = (id) => {
      if (runId !== state.runId) throw new PipelineCancelled()
      state.step = id
      appendLog(`--- ${STEP_LABEL.get(id) ?? id} ---`)
    }

    mark('snapshot')
    rollbackSha = await git(repo, 'rev-parse HEAD')
    if (!/^[0-9a-f]{40}$/.test(rollbackSha)) throw new Error('无法读取主仓库 HEAD')
    const rollbackRef = await capture(`git -C ${sh(repo)} branch -f dsh-rollback ${sh(rollbackSha)}`, { cwd: repo, timeoutMs: GIT_TIMEOUT_MS })
    if (rollbackRef.code !== 0) {
      throw new Error(`无法写入回滚分支 dsh-rollback：${rollbackRef.err.trim().split('\n').pop() ?? '未知原因'}`)
    }
    appendLog(`主仓库回滚点：dsh-rollback = ${rollbackSha.slice(0, 8)}（更新不改动主仓库工作区）`)

    mark('fetch')
    const fetchCode = await stepBash(`git -C ${sh(repo)} fetch --prune origin`, { timeoutMs: FETCH_TIMEOUT_MS })
    if (fetchCode !== 0) throw new Error('git fetch 失败，请检查网络或仓库权限')
    const target = await resolveTarget(repo)
    appendLog(`目标版本：${target.ref} @ ${target.sha.slice(0, 8)}（${target.version ?? '未知版本'}，通道 ${target.channel}）`)

    mark('stage')
    const slot = await prepareSlot(repo, target.sha)
    appendLog(`试运行副本：${slot}`)

    mark('install')
    const installCode = await stepBash('pnpm install', { cwd: slot })
    if (installCode !== 0) throw new Error('pnpm install 失败')

    mark('build')
    const buildCode = await stepBash('pnpm run build', { cwd: slot })
    if (buildCode !== 0) throw new Error('pnpm run build 失败')

    mark('canary')
    const previousActive = summarizeRuntime(state.runtimeAsset?.active)
    const canary = await canaryWithQuarantine(slot, target)
    state.canary = {
      ok: canary.ok,
      port: canary.port ?? null,
      bareUrl: canary.bareUrl ?? null,
      attempts: canary.attempts ?? 0,
      conflicts: Array.isArray(canary.conflicts) ? canary.conflicts : [],
      error: canary.error ?? null,
      at: nowIso(),
    }
    if (!canary.ok) throw new Error(canary.error ?? '试运行未通过')
    if (runId !== state.runId) throw new PipelineCancelled()

    const entry = path.join(slot, 'apps/cli/lib/bin.js')
    saveRuntimeAsset({
      candidate: {
        root: slot,
        entry,
        version: target.version,
        commit: target.sha,
        ref: target.ref,
        channel: target.channel,
        stagedAt: nowIso(),
        canaryOk: true,
      },
      quarantined: [...state.quarantine],
      lastUpdate: { at: nowIso(), ok: true, from: previousActive, to: summarizeRuntime({ root: slot, entry, version: target.version, commit: target.sha }) },
    })
    state.finishedAt = nowIso()
    state.step = null
    appendLog('=== 更新完成：新版本已用真实 profile 试运行通过 ===')
    appendLog('正在运行的服务没有被改动；点「重启生效」后会由独立切换器完成切换，失败会自动回滚。')
    setPhase('done')
  } catch (error) {
    state.finishedAt = nowIso()
    state.step = null
    if (error instanceof PipelineCancelled) {
      appendLog('=== 已取消（正在运行的服务未受影响；试运行副本可能是不完整的，下次更新会重建）===')
      setPhase('idle')
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    appendLog(`=== 更新失败：${message} ===`)
    appendLog('正在运行的服务没有被改动，无需回滚；修好后可再点一次更新。')
    if (rollbackSha !== null) appendLog(`主仓库如需恢复：git -C ${repo} checkout dsh-rollback`)
    setPhase('error', message)
  }
}

/**
 * 启动更新流水线（后台执行，调用方立即拿到响应）。
 * 启动前先重新采集一次快照，origin / 仓库都以当下为准。
 */
async function startUpdate() {
  if (state.phase === 'updating') return { ok: false, error: '更新正在进行中' }
  if (state.phase === 'checking') return { ok: false, error: '正在检测上游提交，请稍后再试' }

  const previousPhase = state.phase
  state.phase = 'updating'

  let snapshot
  try {
    snapshot = await readSnapshot()
  } catch (error) {
    setPhase(previousPhase, null)
    const message = error instanceof Error ? error.message : String(error)
    appendLog(`· 读取仓库状态失败：${message}`)
    return { ok: false, error: `读取仓库状态失败：${message}` }
  }
  state.snapshot = snapshot
  const rejection = (() => {
    if (snapshot.ok !== true) return snapshot.error ?? `无法读取仓库状态：${state.repo}`
    if (snapshot.isRepo !== true) return snapshot.error ?? `不是 git 仓库：${state.repo}`
    if (snapshot.branch === 'HEAD(detached)') return '仓库处于 detached HEAD，无法判断该更新哪个分支'
    if (snapshot.originOk === false && !ALLOW_ANY_ORIGIN) {
      return `origin 不是预期仓库，已拒绝拉取代码：${snapshot.originUrl ?? '未配置'}`
        + '（确认无误可设 DSH_UPDATE_ALLOW_ANY_ORIGIN=1 解除限制）'
    }
    return null
  })()
  if (rejection !== null) {
    setPhase(previousPhase, null)
    appendLog(`· 拒绝更新：${rejection}`)
    return { ok: false, error: rejection }
  }
  if (state.cancelRequested) {
    state.cancelRequested = false
    setPhase(previousPhase, null)
    appendLog('· 已按取消请求放弃启动')
    return { ok: false, error: '已取消' }
  }

  state.cancelRequested = false
  const runId = state.runId + 1
  state.runId = runId
  resetLog()
  setPhase('updating')
  state.error = null
  state.step = null
  state.startedAt = nowIso()
  state.finishedAt = null
  state.canary = null
  appendLog('=== 开始更新（主仓库不被改动，先在副本里构建并试运行）===')
  appendLog(`仓库 ${state.repo}，通道 ${process.env.DSH_UPDATE_CHANNEL === 'tag' ? 'tag' : 'master'}，来源 ${snapshot.originUrl ?? '未知'}`)
  appendLog('提示：构建+试运行需要几分钟；期间正在运行的 dsh web 不受影响，可以关闭设置面板。')

  void runUpdate(runId)
  return { ok: true, started: true }
}

/**
 * 用独立切换器重启：脚本负责「等旧进程退出 → 清端口残留 → 起新版本 → 校验 →
 * 失败则回滚」。宿主只负责预检和落 job 文件，避免旧代码在自杀后没人接手。
 */
function scheduleRestart() {
  if (state.phase === 'updating') {
    return { ok: false, error: '更新流水线还在跑；等它完成后（或点取消）再重启' }
  }
  const currentEntry = process.argv[1]
  if (typeof currentEntry !== 'string' || currentEntry.length === 0) {
    return { ok: false, error: '无法确定 dsh 入口路径，请手动重启' }
  }
  if (!existsSync(SWITCH_SCRIPT)) {
    return { ok: false, error: `安全切换器不存在，请重新安装/更新插件：${SWITCH_SCRIPT}` }
  }
  const candidate = state.runtimeAsset?.candidate
  const hasCandidate = candidate !== null && candidate !== undefined
    && typeof candidate.entry === 'string' && existsSync(candidate.entry)
  const target = hasCandidate
    ? { entry: candidate.entry, root: candidate.root ?? null, version: candidate.version ?? null, commit: candidate.commit ?? null }
    : { entry: currentEntry, root: state.runtimeAsset?.active?.root ?? null, version: state.runtimeAsset?.active?.version ?? null, commit: state.runtimeAsset?.active?.commit ?? null }
  if (!existsSync(target.entry)) {
    return { ok: false, error: `目标入口不存在，已放弃重启：${target.entry}` }
  }
  // 预检：新入口至少要能响应 --version，避免把明显坏的入口交给切换器。
  const probe = spawnSync(process.execPath, [target.entry, '--version'], { encoding: 'utf8', timeout: 20_000 })
  if (probe.status !== 0) {
    const reason = (probe.stderr ?? '').trim().split('\n').slice(-3).join(' / ') || `退出码 ${probe.status}`
    return { ok: false, error: `新入口预检失败（--version）：${reason}` }
  }

  const port = parsePort(state.restartArgs, 3080)
  const quarantineFile = state.quarantine.size > 0 ? QUARANTINE_FILE : null
  if (quarantineFile !== null) writeQuarantinePatch(QUARANTINE_FILE, [...state.quarantine])
  const job = {
    jobVersion: 1,
    oldPid: process.pid,
    // 这个 pid 是宿主自己写的，切换器可以信任；false 时才退回命令行校验。
    trustOldPid: true,
    // 旧服务如果由 restart-web.sh 的 launchd 作业托管，切换前先摘掉它。
    launchdLabel: 'dsh-web',
    port,
    cwd: process.cwd(),
    node: process.execPath,
    logPath: SWITCH_LOG,
    statusFile: SWITCH_STATUS_FILE,
    runtimeFile: RUNTIME_FILE,
    readyTimeoutMs: CANARY_READY_TIMEOUT_MS,
    new: { entry: target.entry, args: withQuarantineArg(state.restartArgs, quarantineFile), root: target.root, version: target.version, commit: target.commit },
    prev: {
      entry: currentEntry,
      args: [...state.restartArgs],
      root: state.runtimeAsset?.active?.root ?? null,
      version: state.runtimeAsset?.active?.version ?? null,
      commit: state.runtimeAsset?.active?.commit ?? null,
    },
  }
  try {
    writeJsonAtomic(SWITCH_JOB_FILE, job, { mode: 0o600 })
    const child = spawn(process.execPath, [SWITCH_SCRIPT, SWITCH_JOB_FILE], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return {
    ok: true,
    port,
    entry: target.entry,
    version: target.version,
    willRestart: true,
    message: '切换器已启动：先起新版本并校验，失败会自动回滚到旧版本。',
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 变更类接口的第二道闸：自定义头 + JSON content-type。 */
function isGuardedPost(req) {
  const header = req.headers?.[GUARD_HEADER]
  const contentType = req.headers?.['content-type']
  return typeof header === 'string' && typeof contentType === 'string'
    && contentType.toLowerCase().includes('application/json')
}

/** 组装给前端的 JSON（只含标量，不泄漏内部对象）。 */
function publicState(since = 0) {
  // 独立切换器会在宿主启动之后才把 active 写进 runtime.json，所以每次请求都重读一次。
  loadRuntimeAsset()
  const active = state.runtimeAsset?.active ?? null
  const candidate = state.runtimeAsset?.candidate ?? null
  return {
    ok: true,
    repo: state.repo,
    upstream: UPSTREAM,
    phase: state.phase,
    step: state.step,
    error: state.error,
    checkedAt: state.checkedAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    seq: state.seq,
    log: state.log.filter((entry) => entry.seq > since),
    snapshot: state.snapshot,
    canary: state.canary === null ? null : {
      ok: state.canary.ok === true,
      port: state.canary.port ?? null,
      bareUrl: state.canary.bareUrl ?? null,
      attempts: state.canary.attempts ?? 0,
      conflicts: Array.isArray(state.canary.conflicts) ? state.canary.conflicts : [],
      error: state.canary.error ?? null,
      at: state.canary.at ?? null,
    },
    quarantined: [...state.quarantine],
    runtime: {
      currentEntry: process.argv[1] ?? null,
      matchesActive: runningMatchesActive(),
      // 实时判断，不依赖可能过期的检测缓存：没有 active 或当前入口不是 active，就值得迁移。
      mustMigrate: active === null || runningMatchesActive() === false,
      canSwitch: candidate !== null && candidate !== undefined && candidate.canaryOk === true
        && typeof candidate.entry === 'string' && existsSync(candidate.entry)
        && runningMatchesActive() !== true,
      active: summarizeRuntime(active),
      candidate: summarizeRuntime(candidate),
      candidateStagedAt: typeof candidate?.stagedAt === 'string' ? candidate.stagedAt : null,
      candidateCanaryOk: candidate?.canaryOk === true,
      channel: process.env.DSH_UPDATE_CHANNEL === 'tag' ? 'tag' : 'master',
    },
    switch: loadSwitchStatus(),
  }
}

/**
 * 挂载路由。
 * @param ctx - Cordis 上下文。
 */
function apply(ctx) {
  state.repo = detectRepo()
  const argv = process.argv.slice(2)
  state.restartArgs = argv.length > 0 ? argv : ['web']
  loadRuntimeAsset()
  // 自我修复 shell 用的纯文本指针（例如从旧版本升级上来时还没有这个文件）。
  if (typeof state.runtimeAsset?.active?.entry === 'string') writeActiveEntry(state.runtimeAsset.active.entry)
  const cached = loadCache()
  if (cached !== null && cached.snapshot !== undefined) {
    state.snapshot = cached.snapshot
    state.checkedAt = cached.checkedAt ?? null
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      // ---- 访问栅栏：这一行必须在最前面 ----
      // webServer 不做鉴权，插件路由默认是谁都能打的。这里复用 harness 自己的判定。
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
        const method = req.method ?? 'GET'
        if (route === '/api/state' && method === 'GET') {
          const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
          sendJson(res, 200, publicState(since))
          return
        }
        if (route === '/api/check' && method === 'POST') {
          if (!isGuardedPost(req)) { sendJson(res, 403, { ok: false, error: '缺少必要的请求标记' }); return }
          const result = await check()
          sendJson(res, result.ok ? 200 : 409, { ...publicState(), ...result })
          return
        }
        if (route === '/api/update' && method === 'POST') {
          if (!isGuardedPost(req)) { sendJson(res, 403, { ok: false, error: '缺少必要的请求标记' }); return }
          const result = await startUpdate()
          sendJson(res, result.ok ? 200 : 409, { ...publicState(), ...result })
          return
        }
        if (route === '/api/cancel' && method === 'POST') {
          if (!isGuardedPost(req)) { sendJson(res, 403, { ok: false, error: '缺少必要的请求标记' }); return }
          const child = state.pipeline
          if (child !== null) {
            state.cancelRequested = true
            appendLog('· 用户取消了更新，正在终止流水线')
            killChild(child, 'SIGTERM')
          } else if (state.phase === 'updating') {
            state.cancelRequested = true
            appendLog('· 取消请求已收到，流水线尚未启动')
          } else {
            sendJson(res, 409, { ...publicState(), ok: false, error: '当前没有正在运行的更新' })
            return
          }
          sendJson(res, 200, publicState())
          return
        }
        if (route === '/api/restart' && method === 'POST') {
          if (!isGuardedPost(req)) { sendJson(res, 403, { ok: false, error: '缺少必要的请求标记' }); return }
          const result = scheduleRestart()
          sendJson(res, result.ok ? 200 : 500, result)
          return
        }
        if (route === '/api/plugins/retry' && method === 'POST') {
          if (!isGuardedPost(req)) { sendJson(res, 403, { ok: false, error: '缺少必要的请求标记' }); return }
          state.quarantine = new Set()
          try { rmSync(QUARANTINE_FILE, { force: true }) } catch { /* 文件可能不存在 */ }
          saveRuntimeAsset({ quarantined: [] })
          appendLog('· 已清除临时禁用列表；下次更新/重启会重新尝试加载这些插件。')
          sendJson(res, 200, publicState())
          return
        }
        sendJson(res, 404, { ok: false, error: `未知端点：${route}` })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'auto-update: 更新检测接口')

  // 插件停用/更新时不留孤儿进程：正在跑的 git / pnpm 一并优雅终止。
  ctx.effect(() => () => {
    for (const child of state.children) {
      killChild(child, 'SIGTERM')
    }
    state.children.clear()
    state.pipeline = null
  }, 'auto-update: 回收子进程')

  const active = state.runtimeAsset?.active
  appendLog(`插件已加载，主仓库：${state.repo}`)
  if (typeof active?.entry === 'string') {
    appendLog(`当前运行版本：${active.version ?? '未知'} @ ${(active.commit ?? '').slice(0, 8)}（${active.root ?? active.entry}）`)
  }
  if (runningMatchesActive() === false) {
    appendLog('提示：当前入口不是 runtime.json 记录的版本；更新并重启后会自动切到试运行通过的副本。')
  }
  if (state.quarantine.size > 0) {
    appendLog(`提示：有 ${state.quarantine.size} 个插件被临时禁用：${[...state.quarantine].join(', ')}`)
  }
  if (state.snapshot === null) appendLog('点击「检查更新」即可比对上游提交。')
}

export { apply, inject, name }
