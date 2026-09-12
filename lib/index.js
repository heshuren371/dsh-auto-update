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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
/** 探测不到运行目录时的兜底路径。 */
const FALLBACK_REPO = '/Users/heshuren/deepseek-harness'
/** 内存日志环形缓冲上限：行数 + 总字节数双重封顶。 */
const MAX_LOG_LINES = 400
/**
 * 只限行数是不够的：单行最长可到 MAX_PENDING，400 行 × 64KB = 25MB 常驻，
 * 而且每次 `/state` 都要把它 JSON 序列化一遍。按总字节再封一次顶。
 */
const MAX_LOG_BYTES = 256 * 1024
/** 单次 git fetch 的超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 120_000
/**
 * 单条 git 查询的超时。
 * 没有它，一次挂住的 git（陈旧 index.lock、网络盘、超大仓库的 status）就能让
 * readSnapshot 永远不返回 —— 而 startUpdate 已经同步把 phase 置成 updating，
 * 于是状态机永久卡死，连取消都没有进程可杀。
 */
const GIT_TIMEOUT_MS = 20_000
/** 整条更新流水线的兜底超时：构建再慢也不该无限挂着占住状态机。 */
const PIPELINE_TIMEOUT_MS = 30 * 60_000
/**
 * 校验 origin 是否就是本插件声称要跟随的仓库。
 * 不校验的话，origin 被改成任意地址时会把陌生代码拉进来再执行它的构建脚本。
 * 确认自己就是要从别处拉代码时，设 DSH_UPDATE_ALLOW_ANY_ORIGIN=1 关掉这道闸。
 */
const ORIGIN_PATTERN = /(^|[/:])deepseek-ai\/deepseek-harness(\.git)?\/?$/
const ALLOW_ANY_ORIGIN = process.env.DSH_UPDATE_ALLOW_ANY_ORIGIN === '1'
/**
 * 变更类接口要求的自定义请求头。
 * 跨站页面无法在"简单请求"里加自定义头，加了就会触发 CORS 预检而失败，
 * 这是 cookie 之外的第二道闸（cookie 已经是 SameSite=Strict）。
 */
const GUARD_HEADER = 'x-dsh-updater'

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
  /** 日志当前占用字节数，配合 MAX_LOG_BYTES 做总量封顶。 */
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
  /** 用户主动取消的标记：收尾时据此区分"失败"与"已取消"。 */
  cancelRequested: false,
  /** 流水线代次：只有最新一代的收尾回调有权改写状态，避免旧回调覆盖新一轮。 */
  runId: 0,
}

function appendLog(line) {
  const text = String(line).replace(/\s+$/, '')
  if (text.length === 0) return
  state.seq += 1
  state.log.push({ seq: state.seq, line: text })
  state.logBytes += text.length
  // 行数与字节数任一超标就丢最旧的；至少保留一行，方便看到出错原因。
  while (state.log.length > MAX_LOG_LINES
    || (state.logBytes > MAX_LOG_BYTES && state.log.length > 1)) {
    const dropped = state.log.shift()
    state.logBytes -= dropped.line.length
  }
}

/**
 * 清空日志内容，但**不重置 seq**。
 * 客户端按 `since=seq` 做增量拉取；seq 一旦回退，客户端会认为"没有新内容"，
 * 整条更新日志都会丢。seq 在进程生命周期内保持单调递增。
 */
function resetLog() {
  state.log = []
  state.logBytes = 0
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

/**
 * 结束一个子进程**及其整个进程组**。
 *
 * `child.kill()` 只杀直接子进程（我们是 `/bin/bash -c`），它拉起的 git / pnpm
 * 会活下来继续攥着 stdio 管道 —— 那样 Node 的 'close' 事件永远不到，
 * 状态机就卡在 updating 了。所以子进程用 detached 起在独立进程组里，
 * 这里对负 pid 发信号，整组一起收。
 * @param child - 目标子进程；已退出时是空操作。
 * @param signal - 信号名。
 */
function killChild(child, signal = 'SIGTERM') {
  if (child === null || child === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // 进程组已不存在（或平台不支持）：退回杀直接子进程。
    try { child.kill(signal) } catch { /* 已退出 */ }
  }
}

/** 运行一段 bash 脚本，逐行回调输出，返回退出码。 */
function runBash(script, { cwd, onLine, onErrLine, timeoutMs, pipeline = false } = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      // 别让 ssh 在 host key / 口令上挂住整个流水线。
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      HUSKY: '0',
    }
    // 保证 pnpm / node 与当前进程同一套工具链，即使 PATH 被精简过。
    const nodeBin = path.dirname(process.execPath)
    env.PATH = `${nodeBin}${path.delimiter}${env.PATH ?? ''}`
    let child
    try {
      child = spawn('/bin/bash', ['-c', script], {
        cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
        // 独立进程组：取消时能连 git / pnpm 孙进程一起收掉。
        detached: true,
      })
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
    // stdout / stderr 分开走：git 的 "fatal: ..." 走 stderr，
    // 混在一起会让失败输出被当成正常结果解析（例如把 fatal 文本当成 commit sha）。
    //
    // 两个必须守住的性能边界：
    //  1) 不能对不断变长的 pending 反复 split —— 那是 O(n²)（实测 8MB 输出堆峰值 232MB）。
    //     没有换行的块走快路径，直接累积。
    //  2) 单行不能无限长。pnpm / git 的进度条只用 \r 不回 \n；超过 MAX_PENDING 就截断成一行。
    const MAX_PENDING = 16 * 1024
    const makePump = (sink) => {
      let pending = ''
      return {
        push(chunk) {
          if (chunk.indexOf('\n') === -1) {
            pending += chunk
          } else {
            pending += chunk
            const parts = pending.split('\n')
            pending = parts.pop() ?? ''
            for (const part of parts) sink?.(part)
          }
          if (pending.length > MAX_PENDING) {
            const dropped = pending.length - MAX_PENDING
            sink?.(`${pending.slice(0, MAX_PENDING)} …（单行过长，已截断 ${dropped} 字符）`)
            pending = ''
          }
        },
        flush() {
          if (pending.length > 0) sink?.(pending)
          pending = ''
        },
      }
    }
    const outPump = makePump(onLine)
    const errPump = makePump(onErrLine ?? onLine)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => outPump.push(chunk))
    child.stderr.on('data', (chunk) => errPump.push(chunk))
    child.on('error', (error) => {
      onLine?.(`子进程错误：${error instanceof Error ? error.message : String(error)}`)
      finish(-1)
    })
    child.on('close', (code) => {
      outPump.flush()
      errPump.flush()
      finish(code === null ? -1 : code)
    })
    // 兜底：'close' 要等所有 stdio 管道关闭。若孙进程（git / pnpm）还活着攥着
    // 管道，close 可能几分钟都不来 —— 状态机会一直卡在 updating。
    // 'exit' 只表示直接子进程结束了，这里给它一个短宽限期，到点就收尾。
    let exitTimer = null
    child.on('exit', (code) => {
      exitTimer = setTimeout(() => {
        onLine?.('（子进程已退出但管道仍被占用，按已结束处理）')
        outPump.flush()
        errPump.flush()
        finish(code === null ? -1 : code)
      }, 2000)
      exitTimer.unref?.()
    })
    child.on('close', () => { if (exitTimer !== null) clearTimeout(exitTimer) })
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(() => {
        onLine?.(`命令超时（${Math.round(timeoutMs / 1000)}s），已终止。`)
        killChild(child, 'SIGKILL')
      }, timeoutMs)
    }
    // 登记到当前 Fiber 名下，插件停用时能一起回收（见 apply 的清理 effect）。
    state.children.add(child)
    if (pipeline) state.pipeline = child
    child.on('close', () => {
      state.children.delete(child)
      if (state.pipeline === child) state.pipeline = null
    })
  })
}

/** 运行一段脚本并收集输出；out 只含 stdout，err 只含 stderr。 */
async function capture(script, { cwd, timeoutMs } = {}) {
  const out = []
  const err = []
  // git 查询的输出本该很小；万一仓库里有超长输出（超大 status / 恶意配置），
  // 也不要让它把整个堆吃满。
  const CAPTURE_LIMIT_BYTES = 1024 * 1024
  let outBytes = 0
  let errBytes = 0
  const collect = (list, add) => (line) => {
    if (add(line.length + 1) > CAPTURE_LIMIT_BYTES) return
    list.push(line)
  }
  const code = await runBash(script, {
    cwd,
    timeoutMs,
    onLine: collect(out, (n) => (outBytes += n)),
    onErrLine: collect(err, (n) => (errBytes += n)),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** 单个 git 查询：失败时返回空串而不是抛错。 */
async function git(args, { cwd, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const { out } = await capture(`git -C ${sh(cwd ?? state.repo)} ${args}`, {
    cwd: cwd ?? state.repo,
    timeoutMs,
  })
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

/**
 * 上游引用：**优先当前分支自己的 upstream**。
 * `git pull` 真正用的是它；只看 origin/HEAD 会让"落后几个提交"和
 * "实际去拉哪个分支"对不上（默认分支是 main 的仓库尤其明显）。
 * @returns 形如 origin/master 的引用；无法判定时返回 null。
 */
async function upstreamRef(repo) {
  const tracking = await git('rev-parse --abbrev-ref --symbolic-full-name @{upstream}', { cwd: repo })
  if (tracking.length > 0 && tracking.includes('/')) return tracking
  const symbolic = await git('symbolic-ref --short refs/remotes/origin/HEAD', { cwd: repo })
  if (symbolic.length > 0) return symbolic
  return null
}

/**
 * 采集一次完整快照：本地提交、上游提交、领先/落后、工作区是否脏。
 * 每个快照都带 `ok`：只有 ok 为 true 时前端才把它当成可信状态显示。
 */
async function readSnapshot(repo = state.repo) {
  const originUrl = await git('remote get-url origin', { cwd: repo })
  const originOk = originUrl.length > 0 && ORIGIN_PATTERN.test(originUrl)
  const base = { repo, upstream: UPSTREAM, originUrl: originUrl.length > 0 ? originUrl : null, originOk }

  // 先用退出码判定"是不是仓库"：不能靠输出非空，git 的报错也在输出里。
  const probe = await capture(`git -C ${sh(repo)} rev-parse --is-inside-work-tree`, {
    cwd: repo,
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (probe.code !== 0 || probe.out.trim() !== 'true') {
    return { ...base, ref: null, isRepo: false, ok: false, error: `不是 git 仓库或 git 不可用：${repo}` }
  }

  const ref = await upstreamRef(repo)
  const [branch, headSha, remoteSha, headLine, remoteLine, status, countLine] = await Promise.all([
    git('rev-parse --abbrev-ref HEAD', { cwd: repo }),
    git('rev-parse HEAD', { cwd: repo }),
    ref === null ? Promise.resolve('') : git(`rev-parse ${sh(ref)}`, { cwd: repo }),
    git("log -1 --format='%h%x1f%s%x1f%cI'", { cwd: repo }),
    ref === null ? Promise.resolve('') : git(`log -1 --format='%h%x1f%s%x1f%cI' ${sh(ref)}`, { cwd: repo }),
    git('status --porcelain', { cwd: repo }),
    ref === null ? Promise.resolve('') : git(`rev-list --left-right --count HEAD...${sh(ref)}`, { cwd: repo }),
  ])

  // 上游引用解析不出来时必须报错，绝不能退化成 behind:0 —— 那会永久显示"已是最新"。
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
  const ahead = Number.parseInt(counts[0] ?? '0', 10) || 0
  const behind = Number.parseInt(counts[1] ?? '0', 10) || 0
  return {
    ...base,
    ref,
    isRepo: true,
    ok: true,
    branch: branch.length > 0 ? branch : 'HEAD(detached)',
    version: readVersion(repo),
    head: { sha: headSha, ...(parseCommitLine(headLine) ?? { short: headSha.slice(0, 8), subject: '', date: '' }) },
    remote: { sha: remoteSha, ...(parseCommitLine(remoteLine) ?? { short: remoteSha.slice(0, 8), subject: '', date: '' }) },
    behind,
    ahead,
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    updateAvailable: behind > 0,
    checkedAt: state.checkedAt,
  }
}

/**
 * 读取上次检测的缓存，让界面在联网前先有内容。
 * 严格校验形状：字段缺失的缓存会让前端在取 head.short 时崩掉渲染。
 */
function loadCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null
    const parsed = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const snapshot = parsed.snapshot
    if (typeof snapshot !== 'object' || snapshot === null) return null
    // 只信 ok:true 的快照；旧版本写的缓存也顺带被这行淘汰。
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

/**
 * 落地缓存，让重启后不联网也能先显示上次状态。
 * 只缓存可信快照：把"读不出来"的错误状态缓存下来，会在修好之后继续显示旧错误。
 */
function saveCache(snapshot) {
  if (snapshot === null || snapshot === undefined || snapshot.ok !== true) return
  try {
    writeFileSync(CACHE_FILE, JSON.stringify({ snapshot, checkedAt: state.checkedAt }, null, 2))
  } catch {
    // 缓存只是体验优化，写不进去也不影响功能。
  }
}

/** 检测更新：git fetch 后比对。返回 { ok, error? }，供路由如实回传。 */
async function check() {
  if (state.phase === 'updating') return { ok: false, error: '更新正在进行中，暂时不能检测' }
  if (state.phase === 'checking') return { ok: false, error: '检测已经在进行中' }
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
    saveCache(snapshot)
    return { ok: false, error: 'git fetch 失败，请检查网络或仓库权限' }
  }
  // 快照不可信时如实报错：绝不能因为 behind 算不出来就说"已是最新"。
  if (snapshot.ok !== true) {
    const reason = snapshot.error ?? '无法读取仓库状态'
    setPhase('error', reason)
    appendLog(`· 检测受阻：${reason}`)
    saveCache(snapshot)
    return { ok: false, error: reason }
  }
  setPhase('idle')
  appendLog(snapshot.updateAvailable
    ? `· 发现 ${snapshot.behind} 个新提交（本地 ${snapshot.head.short} → 上游 ${snapshot.remote?.short ?? '?'}）`
    : '· 已是最新版本')
  saveCache(snapshot)
  return { ok: true }
}

/**
 * 更新流水线脚本：全过程 set -e，任一步失败即中止。
 * @param branch - 当前所在分支，由快照给出；不再写死 master。
 */
function pipelineScript(branch) {
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
    `git pull --ff-only origin ${sh(branch)}`,
    'echo "::step::install"',
    'pnpm install',
    'echo "::step::build"',
    'pnpm run build',
    'echo "::step::done"',
  ].join('\n')
}

/**
 * 启动更新流水线（后台执行，调用方立即拿到响应）。
 * 启动前先重新采集一次快照：分支、origin 是否可信都以当下为准，不用可能过期的缓存。
 */
async function startUpdate() {
  if (state.phase === 'updating') return { ok: false, error: '更新正在进行中' }
  if (state.phase === 'checking') return { ok: false, error: '正在检测上游提交，请稍后再试' }

  // 同步占位：下面的 await 期间不允许第二个请求挤进来。
  const previousPhase = state.phase
  state.phase = 'updating'

  let snapshot
  try {
    snapshot = await readSnapshot()
  } catch (error) {
    // readSnapshot 目前不会抛，但一旦它抛了而这里不兜住，状态机会永久卡在 updating，
    // 用户再也点不动任何按钮。
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
  // 读快照这一步耗时可观，期间用户可能已经按了取消；这里补一次检查，
  // 避免"已取消"之后流水线还是被拉起来。
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
  state.startedAt = new Date().toISOString()
  state.finishedAt = null
  appendLog('=== 开始更新 ===')
  appendLog(`分支 ${snapshot.branch}，来源 ${snapshot.originUrl ?? '未知'}`)
  appendLog('提示：构建需要几分钟，期间可以关闭这个设置面板，进度不会中断。')

  const stepOf = new Map(PIPELINE.map((step) => [step.id, step.label]))
  void runBash(pipelineScript(snapshot.branch), {
    cwd: state.repo,
    pipeline: true,
    timeoutMs: PIPELINE_TIMEOUT_MS,
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
    // 旧一代流水线的收尾回调没有资格改写当前状态。
    if (runId !== state.runId) return
    state.finishedAt = new Date().toISOString()
    state.step = null
    if (state.cancelRequested) {
      state.cancelRequested = false
      appendLog('=== 已取消（仓库可能停在中间状态，必要时按下面的回滚方式处理）===')
      setPhase('idle')
      return
    }
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
    setPhase('error', '更新流水线失败，详见日志')
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
  // 复用启动时的原始参数：写死 `web --no-open` 会丢掉 --port / --host / --profile 等，
  // 新进程可能监听在别的地址上，页面再也连不回来。
  const launchArgs = process.argv.slice(2)
  const cliArgs = launchArgs.length > 0 ? launchArgs : ['web', '--no-open']
  // 日志无限追加会一直涨；超过 1MB 先清空再写。
  try {
    if (existsSync(logPath) && statSync(logPath).size > 1024 * 1024) writeFileSync(logPath, '')
  } catch {
    // 清不掉也无所谓，日志大小不影响功能。
  }
  // 交给一个脱离的 shell：先回应用户，再从容重启。
  const script = [
    'sleep 3',
    'command -v launchctl >/dev/null 2>&1 && launchctl remove dsh-web 2>/dev/null',
    `export PATH=${sh(path.dirname(nodeBin))}:$PATH`,
    `kill ${pid} 2>/dev/null || true`,
    `for i in $(seq 1 100); do kill -0 ${pid} 2>/dev/null || break; sleep 0.1; done`,
    `kill -9 ${pid} 2>/dev/null || true`,
    `cd ${sh(cwd)} || exit 1`,
    `nohup ${sh(nodeBin)} ${sh(entry)} ${cliArgs.map((arg) => sh(arg)).join(' ')} >> ${sh(logPath)} 2>&1 &`,
  ].join('; ')
  try {
    const child = spawn('/bin/sh', ['-c', script], { cwd, detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return { ok: true, logPath, command: `${nodeBin} ${entry} ${cliArgs.join(' ')}` }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 变更类接口的第二道闸。
 * cookie 已经是 SameSite=Strict，跨站请求本来就带不上；这里再要求一个自定义头 +
 * JSON content-type，让任何"简单请求"形式的跨站提交在预检阶段就被挡掉。
 * @param req - Node 请求对象。
 * @returns 请求是否带着合法标记。
 */
function isGuardedPost(req) {
  const header = req.headers?.[GUARD_HEADER]
  const contentType = req.headers?.['content-type']
  return typeof header === 'string' && typeof contentType === 'string'
    && contentType.toLowerCase().includes('application/json')
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
      // ---- 访问栅栏：这一行必须在最前面 ----
      // webServer 不做鉴权，插件路由默认是谁都能打的。这里复用 harness 自己的
      // 判定：Host 白名单（防 DNS rebinding）+ sec-fetch-site/Origin 同源检查
      // + 浏览器会话 cookie，不通过直接 401/403。
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
          if (!isGuardedPost(req)) {
            sendJson(res, 403, { ok: false, error: '缺少必要的请求标记' })
            return
          }
          const result = await check()
          // result 放在后面：它的 ok 必须覆盖 publicState 里的 ok: true。
          sendJson(res, result.ok ? 200 : 409, { ...publicState(), ...result })
          return
        }
        if (route === '/api/update' && method === 'POST') {
          if (!isGuardedPost(req)) {
            sendJson(res, 403, { ok: false, error: '缺少必要的请求标记' })
            return
          }
          const result = await startUpdate()
          sendJson(res, result.ok ? 200 : 409, { ...publicState(), ...result })
          return
        }
        if (route === '/api/cancel' && method === 'POST') {
          if (!isGuardedPost(req)) {
            sendJson(res, 403, { ok: false, error: '缺少必要的请求标记' })
            return
          }
          // 只杀流水线：绝不能误杀 readSnapshot 那批短命的 git 查询。
          const child = state.pipeline
          if (child !== null) {
            state.cancelRequested = true
            appendLog('· 用户取消了更新，正在终止流水线')
            killChild(child, 'SIGTERM')
          } else if (state.phase === 'updating') {
            // 流水线还在读快照、尚未 spawn：先记下取消意图，startUpdate 会消费掉它。
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
          if (!isGuardedPost(req)) {
            sendJson(res, 403, { ok: false, error: '缺少必要的请求标记' })
            return
          }
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

  // 插件停用/更新时不留孤儿进程：正在跑的 git / pnpm 一并优雅终止。
  ctx.effect(() => () => {
    for (const child of state.children) {
      killChild(child, 'SIGTERM')
    }
    state.children.clear()
    state.pipeline = null
  }, 'auto-update: 回收子进程')

  appendLog(`插件已加载，仓库：${state.repo}`)
  if (state.snapshot === null) appendLog('点击「检查更新」即可比对上游提交。')
}

export { apply, inject, name }
