/**
 * @local/dsh-auto-update — 宿主半（Host）。
 *
 * 职责：检测 deepseek-harness 仓库是否有上游更新，并提供「一键更新」的
 * 后台流水线。全部是本机 git / pnpm 操作，不依赖任何第三方服务。
 *
 * 对外面（路由前缀 `/dsh-updater`，客户端半用 fetch 调用）：
 *   GET  /dsh-updater/api/state?since=N  读取当前状态 + 增量日志
 *   POST /dsh-updater/api/check          执行 git fetch 并比对上游
 *   POST /dsh-updater/api/update         启动更新流水线（后台，立即返回）
 *   POST /dsh-updater/api/cancel         终止正在运行的流水线
 *   POST /dsh-updater/api/restart        重启 dsh web 使新版本生效
 *
 * 零核心改动：卸载插件即摘除路由，不留任何后台进程。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Cordis 插件名，用于 Loader 诊断。 */
const name = 'auto-update'
/** 没有 webServer 就没有对外的 HTTP 面，因此是硬依赖。 */
const inject = ['webServer']

/** HTTP 路由前缀。刻意用独立前缀，避免与其他插件冲突。 */
const ROUTE_PREFIX = '/dsh-updater'
/** 上游仓库地址（仅用于展示）。 */
const UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness'
/** 探测不到运行目录时的兜底路径。 */
const FALLBACK_REPO = '/Users/heshuren/deepseek-harness'
/** 内存日志环形缓冲上限。 */
const MAX_LOG_LINES = 400
/** 单次 git fetch 的超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 120_000

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
/** 上次检测结果的落地缓存，重启后无需联网即可先显示已知状态。 */
const CACHE_FILE = path.join(DSH_HOME, 'dsh-auto-update-cache.json')

/** 流水线步骤标签：脚本里用 ::step:: 标记回传，前端据此显示进度。 */
const PIPELINE = [
  { id: 'snapshot', label: '记录回滚点' },
  { id: 'pull', label: '拉取上游提交' },
  { id: 'install', label: '安装依赖' },
  { id: 'build', label: '构建产物' },
]

/** 进程内状态。插件停用即随之消失，缓存文件只是显示用的快照。 */
const state = {
  repo: FALLBACK_REPO,
  phase: 'idle',
  step: null,
  error: null,
  log: [],
  seq: 0,
  snapshot: null,
  checkedAt: null,
  startedAt: null,
  finishedAt: null,
  running: null,
}

function appendLog(line) {
  const text = String(line).replace(/\s+$/, '')
  if (text.length === 0) return
  state.seq += 1
  state.log.push({ seq: state.seq, line: text })
  while (state.log.length > MAX_LOG_LINES) state.log.shift()
}

function resetLog() {
  state.log = []
  state.seq = 0
}

function setPhase(phase, error = null) {
  state.phase = phase
  state.error = error
}

/** 判定某个目录是否看起来是 harness 仓库根。 */
function looksLikeRepo(dir) {
  try {
    return existsSync(path.join(dir, '.git')) && existsSync(path.join(dir, 'pnpm-workspace.yaml'))
  } catch {
    return false
  }
}

/**
 * 探测当前 dsh 实际运行的仓库根。
 * 依次尝试：显式环境变量 → CLI 入口所在目录向上回溯 → 兜底路径。
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
    if (looksLikeRepo(candidate)) return candidate
  }
  return FALLBACK_REPO
}

/** 运行一段 bash 脚本，逐行回调输出，返回退出码。 */
function runBash(script, { cwd, onLine, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', HUSKY: '0' }
    // 保证 pnpm / node 与当前进程同一套工具链，即使 PATH 被精简过。
    const nodeBin = path.dirname(process.execPath)
    env.PATH = `${nodeBin}${path.delimiter}${env.PATH ?? ''}`
    let child
    try {
      child = spawn('/bin/bash', ['-c', script], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      onLine?.(`无法启动子进程：${error instanceof Error ? error.message : String(error)}`)
      resolve(-1)
      return
    }
    let timer = null
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(code)
    }
    let buffer = ''
    const pump = (chunk) => {
      buffer += chunk
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) onLine?.(part)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', pump)
    child.stderr.on('data', pump)
    child.on('error', (error) => {
      onLine?.(`子进程错误：${error instanceof Error ? error.message : String(error)}`)
      finish(-1)
    })
    child.on('close', (code) => {
      if (buffer.length > 0) onLine?.(buffer)
      finish(code === null ? -1 : code)
    })
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(() => {
        onLine?.(`命令超时（${Math.round(timeoutMs / 1000)}s），已终止。`)
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      }, timeoutMs)
    }
    state.running = child
    child.on('close', () => { if (state.running === child) state.running = null })
  })
}

/** 运行一段脚本并收集输出。 */
async function capture(script, { cwd, timeoutMs } = {}) {
  const lines = []
  const code = await runBash(script, { cwd, onLine: (line) => lines.push(line), timeoutMs })
  return { code, out: lines.join('\n') }
}

/** 单个 git 查询：失败时返回空串而不是抛错。 */
async function git(args, { cwd } = {}) {
  const { out } = await capture(`git -C ${sh(cwd ?? state.repo)} ${args}`, { cwd: cwd ?? state.repo })
  return out.trim()
}

/** 单引号包裹，避免路径里的空格/特殊字符。 */
function sh(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** 读取仓库 package.json 里的版本号。 */
function readVersion(repo) {
  try {
    const raw = readFileSync(path.join(repo, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
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

/** 上游分支的远端跟踪引用名（通常是 origin/master）。 */
async function upstreamRef(repo) {
  const ref = await git('symbolic-ref --short refs/remotes/origin/HEAD', { cwd: repo })
  if (ref.length > 0) return ref
  return 'origin/master'
}

/** 采集一次完整快照：本地提交、上游提交、领先/落后、工作区是否脏。 */
async function readSnapshot(repo = state.repo) {
  const ref = await upstreamRef(repo)
  const [branch, headSha, remoteSha, headLine, remoteLine, status, countLine] = await Promise.all([
    git('rev-parse --abbrev-ref HEAD', { cwd: repo }),
    git('rev-parse HEAD', { cwd: repo }),
    git(`rev-parse ${sh(ref)}`, { cwd: repo }),
    git("log -1 --format='%h%x1f%s%x1f%cI'", { cwd: repo }),
    git(`log -1 --format='%h%x1f%s%x1f%cI' ${sh(ref)}`, { cwd: repo }),
    git('status --porcelain', { cwd: repo }),
    git(`rev-list --left-right --count HEAD...${sh(ref)}`, { cwd: repo }),
  ])
  const dirtyLines = status.length > 0 ? status.split('\n').filter((line) => line.trim().length > 0) : []
  const counts = countLine.split(/\s+/).filter((part) => part.length > 0)
  const ahead = Number.parseInt(counts[0] ?? '0', 10) || 0
  const behind = Number.parseInt(counts[1] ?? '0', 10) || 0
  const isRepo = headSha.length > 0
  if (!isRepo) {
    return {
      repo, upstream: UPSTREAM, ref,
      isRepo: false,
      error: `不是 git 仓库或 git 不可用：${repo}`,
    }
  }
  return {
    repo,
    upstream: UPSTREAM,
    ref,
    isRepo: true,
    branch: branch.length > 0 ? branch : 'HEAD(detached)',
    version: readVersion(repo),
    head: { sha: headSha, ...(parseCommitLine(headLine) ?? { short: headSha.slice(0, 8), subject: '', date: '' }) },
    remote: remoteSha.length > 0
      ? { sha: remoteSha, ...(parseCommitLine(remoteLine) ?? { short: remoteSha.slice(0, 8), subject: '', date: '' }) }
      : null,
    behind,
    ahead,
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    updateAvailable: behind > 0,
    checkedAt: state.checkedAt,
  }
}

/** 读取上次检测的缓存，让界面在联网前先有内容。 */
function loadCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

function saveCache(snapshot) {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify({ snapshot, checkedAt: state.checkedAt }, null, 2))
  } catch {
    // 缓存只是体验优化，写不进去也不影响功能。
  }
}

/** 检测更新：git fetch 后比对。 */
async function check() {
  if (state.phase === 'updating') return
  setPhase('checking')
  appendLog(`· 正在检测更新：git fetch origin（${state.repo}）`)
  const code = await runBash(`git -C ${sh(state.repo)} fetch --prune origin`, {
    cwd: state.repo,
    onLine: (line) => appendLog(line),
    timeoutMs: FETCH_TIMEOUT_MS,
  })
  state.checkedAt = new Date().toISOString()
  const snapshot = await readSnapshot()
  state.snapshot = snapshot
  if (code !== 0) {
    setPhase('error', 'git fetch 失败，请检查网络或仓库权限')
    appendLog(`· 检测失败（退出码 ${code}）`)
  } else {
    setPhase('idle')
    appendLog(snapshot.updateAvailable
      ? `· 发现 ${snapshot.behind} 个新提交（本地 ${snapshot.head.short} → 上游 ${snapshot.remote?.short ?? '?'}）`
      : '· 已是最新版本')
  }
  saveCache(snapshot)
}

/** 更新流水线脚本：全过程 set -e，任一步失败即中止。 */
function pipelineScript() {
  return [
    'set -e',
    'echo "::step::snapshot"',
    'git rev-parse HEAD',
    `git branch -f dsh-rollback HEAD && echo "回滚点已记为分支 dsh-rollback（$(git rev-parse --short HEAD)）"`,
    'if [ -n "$(git status --porcelain)" ]; then',
    '  echo "工作区有未提交改动，先 stash 起来（git stash list 可找回）"',
    '  git stash push -u -m "dsh-auto-update-$(date +%Y%m%d-%H%M%S)"',
    'fi',
    'echo "::step::pull"',
    'git pull --ff-only origin master',
    'echo "::step::install"',
    'pnpm install',
    'echo "::step::build"',
    'pnpm run build',
    'echo "::step::done"',
  ].join('\n')
}

/** 启动更新流水线（后台执行，调用方立即拿到响应）。 */
function startUpdate() {
  if (state.phase === 'updating') return { ok: false, error: '更新正在进行中' }
  resetLog()
  setPhase('updating')
  state.error = null
  state.startedAt = new Date().toISOString()
  state.finishedAt = null
  appendLog('=== 开始更新 ===')
  appendLog('提示：构建需要几分钟，期间可以关闭这个设置面板，进度不会中断。')

  const stepOf = new Map(PIPELINE.map((step) => [step.id, step.label]))
  void runBash(pipelineScript(), {
    cwd: state.repo,
    onLine: (line) => {
      const marker = /^::step::(.+)$/.exec(line.trim())
      if (marker !== null) {
        const id = marker[1]
        state.step = id === 'done' ? null : id
        appendLog(`--- ${stepOf.get(id) ?? id} ---`)
        return
      }
      appendLog(line)
    },
  }).then(async (code) => {
    state.finishedAt = new Date().toISOString()
    if (code === 0) {
      appendLog('=== 更新完成，重启 dsh web 后生效 ===')
      const snapshot = await readSnapshot()
      state.snapshot = snapshot
      state.checkedAt = new Date().toISOString()
      saveCache(snapshot)
      setPhase('done')
      return
    }
    appendLog(`=== 更新失败（退出码 ${code}）===`)
    appendLog('回滚方式：git checkout dsh-rollback && pnpm install && pnpm run build')
    setPhase('error', `更新流水线在第 ${code} 步失败，详见日志`)
  })
  return { ok: true, started: true }
}

/**
 * 重启 dsh web：延迟几秒后杀掉当前进程并用同样的入口重新拉起。
 *
 * 三条硬性要求（踩过的坑）：
 * - dsh 是 `#!/usr/bin/env node` 脚本，只用 `dsh web` 拉起时依赖 PATH，
 *   在精简环境（launchd 作业等）里会以 127 退出。这里始终用绝对路径的
 *   `process.execPath` 直接跑 CLI 入口，不看 PATH。
 * - 入口必须真实存在，否则宁可不重启，也不能先把旧进程杀掉。
 * - 如果旧进程是被 launchd 作业 `dsh-web` 拉起的，先摘掉作业，免得杀掉后
 *   launchd 又拉一个，变成双实例抢端口。
 */
function scheduleRestart() {
  const pid = process.pid
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) {
    return { ok: false, error: '无法确定 dsh 入口路径，请手动重启' }
  }
  if (!existsSync(entry)) {
    return { ok: false, error: `dsh 入口不存在，已放弃重启：${entry}` }
  }
  const cwd = process.cwd()
  const logPath = path.join(cwd, '.dsh-updater-restart.log')
  const nodeBin = process.execPath
  // 交给一个脱离的 shell：先回应用户，再从容重启。
  const script = [
    'sleep 3',
    'command -v launchctl >/dev/null 2>&1 && launchctl remove dsh-web 2>/dev/null',
    `export PATH=${sh(path.dirname(nodeBin))}:$PATH`,
    `kill ${pid} 2>/dev/null || true`,
    `for i in $(seq 1 100); do kill -0 ${pid} 2>/dev/null || break; sleep 0.1; done`,
    `kill -9 ${pid} 2>/dev/null || true`,
    `cd ${sh(cwd)} || exit 1`,
    `nohup ${sh(nodeBin)} ${sh(entry)} web --no-open >> ${sh(logPath)} 2>&1 &`,
  ].join('; ')
  try {
    const child = spawn('/bin/sh', ['-c', script], { cwd, detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, logPath, command: `${nodeBin} ${entry} web` }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 组装给前端的 JSON（只含标量，不泄漏内部对象）。 */
function publicState(since = 0) {
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
  }
}

/**
 * 挂载路由。
 * @param ctx - Cordis 上下文。
 */
function apply(ctx) {
  state.repo = detectRepo()
  const cached = loadCache()
  if (cached !== null && cached.snapshot !== undefined) {
    state.snapshot = cached.snapshot
    state.checkedAt = cached.checkedAt ?? null
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
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
          await check()
          sendJson(res, 200, publicState())
          return
        }
        if (route === '/api/update' && method === 'POST') {
          const result = startUpdate()
          sendJson(res, result.ok ? 200 : 409, { ...result, ...publicState() })
          return
        }
        if (route === '/api/cancel' && method === 'POST') {
          const child = state.running
          if (child !== null) {
            appendLog('· 用户取消了更新')
            try { child.kill('SIGTERM') } catch { /* 已退出 */ }
          }
          setPhase('idle')
          state.step = null
          sendJson(res, 200, publicState())
          return
        }
        if (route === '/api/restart' && method === 'POST') {
          const result = scheduleRestart()
          // 必须如实回传 ok：预检失败时前端要显示错误，而不是假装已重启。
          sendJson(res, result.ok ? 200 : 500, result)
          return
        }
        sendJson(res, 404, { ok: false, error: `未知端点：${route}` })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'auto-update: 更新检测接口')

  appendLog(`插件已加载，仓库：${state.repo}`)
  if (state.snapshot === null) appendLog('点击「检查更新」即可比对上游提交。')
}

export { apply, inject, name }
