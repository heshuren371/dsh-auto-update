#!/usr/bin/env node
/**
 * dsh-auto-update 的安全重启器（独立进程，不依赖正在退出的那个 dsh 进程）。
 *
 * 用法：node scripts/switch.mjs <job.json>
 *
 * 它做的事，按顺序：
 *   1. 确认旧服务真的退出（它自己负责发信号，因为发起重启的进程马上就会死）；
 *   2. 清掉占着端口的旧 dsh 残留进程（**只动看起来是 dsh web 的进程**）；
 *   3. 启动新入口，跟踪它的启动日志，等它打印出可访问地址并通过 HTTP 校验；
 *   4. 成功 → 把 active 版本写进 runtime.json；失败 → 立刻用旧入口回滚，并把
 *      失败原因写进 switch-status.json。
 *
 * 全部只用 Node 内置模块：切换器要在插件代码可能正处于半更新状态时也能跑。
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'

const jobPath = process.argv[2]
if (typeof jobPath !== 'string' || jobPath.length === 0) {
  process.stderr.write('usage: node scripts/switch.mjs <job.json>\n')
  process.exit(2)
}

// 调试用：打印拉起某个 pid 的 launchd 作业 label（找不到输出空行）。
if (process.argv[2] === '--launchd-for') {
  process.stdout.write((launchdLabelForPid(Number.parseInt(process.argv[3] ?? '', 10)) ?? '') + '\n')
  process.exit(0)
}

let job
try {
  job = JSON.parse(readFileSync(jobPath, 'utf8'))
} catch (error) {
  process.stderr.write(`无法读取 job 文件 ${jobPath}：${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(2)
}

const PORT = Number.isInteger(job.port) ? job.port : 3080
const READY_TIMEOUT_MS = Number.isInteger(job.readyTimeoutMs) ? job.readyTimeoutMs : 120_000
const LOG_PATH = typeof job.logPath === 'string' ? job.logPath : path.join(path.dirname(jobPath), 'switch.log')
const STATUS_FILE = typeof job.statusFile === 'string' ? job.statusFile : path.join(path.dirname(jobPath), 'switch-status.json')
const RUNTIME_FILE = typeof job.runtimeFile === 'string' ? job.runtimeFile : null
const URL_RE = /https?:\/\/([^\s/]+):(\d+)\/\?token=([A-Za-z0-9_-]+)/

mkdirSync(path.dirname(LOG_PATH), { recursive: true })
mkdirSync(path.dirname(STATUS_FILE), { recursive: true })

function now() { return new Date().toISOString() }
function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms) }) }
function messageOf(error) { return error instanceof Error ? error.message : String(error) }
function appendLog(line) {
  try { writeFileSync(LOG_PATH, `[${now()}] [switch] ${line}\n`, { flag: 'a' }) } catch { /* 日志失败不影响切换 */ }
}
function writeJsonAtomic(file, value, mode) {
  try {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', mode === undefined ? undefined : { mode })
    renameSync(tmp, file)
  } catch (error) {
    appendLog(`写入 ${file} 失败：${messageOf(error)}`)
  }
}
let status = { phase: 'starting', at: now(), port: PORT, newPid: null, url: null, error: null, message: '切换器已启动' }
function setStatus(patch) {
  status = { ...status, ...patch, at: now() }
  writeJsonAtomic(STATUS_FILE, status)
  appendLog(`phase=${status.phase} ${status.message ?? ''}${status.error !== null ? ' error=' + status.error : ''}`)
}
/**
 * 读取「从 fromOffset 起」的日志尾部（最多 cap 字节）。
 *
 * 偏移量和 fileSize() 一样按**字节**算：日志里全是中文（switch.mjs 自己写的状态行
 * 就是中文），字节数 > UTF-16 字符数。早先把字节偏移直接喂给 text.slice()，切片
 * 起点会越过后来的 token URL —— 回滚路径必然超时，成功路径也只是碰巧过关。
 * 这里按 Buffer 切，两端语义一致；subarray 切在半截多字节处时 toString 会补 U+FFFD，
 * 不影响后面的正则匹配。
 */
function readFileTail(file, fromOffset, cap = 512 * 1024) {
  try {
    const buffer = readFileSync(file)
    return buffer.subarray(Math.max(fromOffset, buffer.length - cap)).toString('utf8')
  } catch {
    return ''
  }
}
function fileSize(file) {
  try { return statSync(file).size } catch { return 0 }
}

/**
 * 找出拉起指定 pid 的 launchd 作业 label（仅 macOS）。
 * `launchctl submit` 建出来的 dsh-web 带 keepalive：不先摘掉作业就杀进程，
 * launchd 会立刻再拉一个出来抢端口。这里按 pid 反查，宿主没传 label 也能兜住。
 */
function launchdLabelForPid(pid) {
  if (process.platform !== 'darwin' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' })
    for (const line of out.split('\n')) {
      const match = /^(\d+)\s+\d+\s+(\S+)\s*$/.exec(line)
      if (match !== null && Number.parseInt(match[1], 10) === pid) return match[2]
    }
  } catch {
    // launchctl 不可用：当作没有作业托管。
  }
  return null
}

function processCommand(pid) {
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
/**
 * 只认「确实是我们启动的 dsh web」的进程；绝不误杀不认识的进程。
 * @param entryHints - 已知入口路径，命令行里出现任意一个就直接认定。
 */
function looksLikeOurServer(pid, entryHints = []) {
  const command = processCommand(pid)
  if (command.length === 0) return false
  for (const hint of entryHints) {
    if (typeof hint === 'string' && hint.length > 0 && command.includes(hint)) return true
  }
  const isWeb = /(^|\s)web(\s|$)/.test(command) || command.includes('--profile web')
  if (!isWeb) return false
  // npm 全局安装时命令行是 `.../bin/dsh web`（软链），路径里一般会带 dsh。
  return /(^|\/)(dsh|bin\.js)(\s|$)/.test(command) || /dsh/i.test(command)
}
function signal(pid, sig) {
  try { process.kill(pid, sig); return true } catch { return false }
}
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(200)
  }
  return !isAlive(pid)
}

/** 端口上的监听进程；lsof 不可用时返回 null（调用方退化为 TCP 探测）。 */
function lsofListeners(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    return out.split('\n').map((line) => Number.parseInt(line.trim(), 10)).filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return null
  }
}
function tcpBusy(port) {
  return new Promise((resolve) => {
    import('node:net').then(({ connect }) => {
      const socket = connect({ port, host: '127.0.0.1' })
      let settled = false
      const done = (value) => { if (!settled) { settled = true; socket.destroy(); resolve(value) } }
      socket.setTimeout(800)
      socket.once('connect', () => done(true))
      socket.once('timeout', () => done(false))
      socket.once('error', () => done(false))
    }).catch(() => resolve(false))
  })
}
async function httpCheck(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
    return response.status
  } catch {
    return null
  }
}

/** 启动一个入口，输出直接写日志文件；返回 child（已 unref）。 */
function spawnServer(spec, fromOffset) {
  const fd = openSync(LOG_PATH, 'a')
  const child = spawn(job.node, [spec.entry, ...(Array.isArray(spec.args) ? spec.args : [])], {
    cwd: typeof job.cwd === 'string' && job.cwd.length > 0 ? job.cwd : process.cwd(),
    env: { ...process.env, DSH_AUTO_UPDATE_SWITCH: '1' },
    detached: true,
    stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  child.unref()
  appendLog(`启动 pid=${child.pid} entry=${spec.entry} args=${(spec.args ?? []).join(' ')}`)
  return child
}

/**
 * 等一个刚启动的入口就绪：解析它写进日志的 token URL，再做 HTTP 校验。
 * @returns { ok, url, port, error }
 */
async function waitReady(child, fromOffset, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let tokenUrl = null
  let bareUrl = null
  let lastError = '等待启动'
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) {
      const tail = readFileTail(LOG_PATH, fromOffset).split('\n').slice(-12).join('\n')
      return { ok: false, error: `新进程在就绪前退出。日志末尾：\n${tail}`, url: null }
    }
    const text = readFileTail(LOG_PATH, fromOffset)
    if (tokenUrl === null) {
      const match = URL_RE.exec(text)
      if (match !== null) {
        tokenUrl = `http://${match[1]}:${match[2]}/?token=${match[3]}`
        bareUrl = `http://127.0.0.1:${match[2]}/`
      }
    }
    if (tokenUrl !== null) {
      const code = await httpCheck(tokenUrl)
      if (code !== null && code >= 200 && code < 400) return { ok: true, url: tokenUrl, port: PORT, error: null }
      const bare = await httpCheck(bareUrl)
      if (bare !== null && (bare === 401 || (bare >= 200 && bare < 400))) {
        // 服务已经在监听，只是带 token 的请求还没稳定；这对“能起来”已经足够。
        return { ok: true, url: tokenUrl, port: PORT, error: null }
      }
      lastError = `HTTP 校验未通过（token=${code ?? '连不上'} bare=${bare ?? '连不上'}）`
    }
    await sleep(300)
  }
  return { ok: false, error: `${Math.round(timeoutMs / 1000)}s 内未就绪（${lastError}）`, url: tokenUrl }
}

function writeRuntimeActive(spec, extra) {
  if (RUNTIME_FILE === null) return
  let runtime = {}
  try {
    const parsed = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) runtime = parsed
  } catch { /* 首次写入 */ }
  const active = {
    entry: spec.entry,
    root: spec.root ?? null,
    version: spec.version ?? null,
    commit: spec.commit ?? null,
    pid: extra.pid ?? null,
    url: extra.url ?? null,
    port: PORT,
    startedAt: now(),
  }
  writeJsonAtomic(RUNTIME_FILE, { ...runtime, active, lastSwitchAt: now() }, 0o600)
  // 给 shell 用人眼可读的 pure-text 指针：dsh 函数守卫可以一行读出来。
  try {
    writeFileSync(path.join(path.dirname(RUNTIME_FILE), 'active-entry'), active.entry + '\n')
  } catch (error) {
    appendLog(`写入 active-entry 失败：${messageOf(error)}`)
  }
}

async function main() {
  appendLog(`job=${jobPath} oldPid=${job.oldPid} port=${PORT}`)
  setStatus({ message: `等待旧服务退出（pid ${job.oldPid}）` })

  // 0) 如果旧服务是被 launchd 作业拉起的，先摘掉作业，免得杀掉进程后 launchd
  //    （keepalive）又拉一个出来抢端口。宿主没传 label 时按 pid 反查兜底。
  const launchdLabel = (typeof job.launchdLabel === 'string' && job.launchdLabel.length > 0)
    ? job.launchdLabel
    : launchdLabelForPid(job.oldPid)
  if (launchdLabel !== null) {
    try {
      execFileSync('launchctl', ['remove', launchdLabel], { stdio: 'ignore' })
      appendLog(`已移除 launchd 作业 ${launchdLabel}（避免 keepalive 把旧进程拉回来）`)
    } catch {
      // 作业不存在或权限不足：继续走后续清理。
    }
  }

  // 1) 旧进程退出（本进程负责发信号，因为宿主进程马上就要死了）。
  // job.oldPid 是宿主自己写的 process.pid，默认信任；trustOldPid=false 时才做命令行校验。
  if (isAlive(job.oldPid) && (job.trustOldPid === true || looksLikeOurServer(job.oldPid, [job.prev?.entry]))) {
    signal(job.oldPid, 'SIGTERM')
    if (!(await waitGone(job.oldPid, 15_000))) {
      signal(job.oldPid, 'SIGKILL')
      await waitGone(job.oldPid, 3_000)
    }
  }

  // 2) 端口清理：只动看起来是 dsh web 的残留进程。
  setStatus({ message: `检查端口 ${PORT}` })
  const listeners = lsofListeners(PORT)
  if (listeners !== null) {
    for (const pid of listeners) {
      if (pid === process.pid || pid === job.oldPid) continue
      if (looksLikeOurServer(pid, [job.prev?.entry, job.new?.entry])) {
        appendLog(`端口被旧 dsh 残留进程占用，先清理 pid=${pid}`)
        signal(pid, 'SIGTERM')
        if (!(await waitGone(pid, 5000))) { signal(pid, 'SIGKILL'); await waitGone(pid, 2000) }
      }
    }
  }
  const busy = await tcpBusy(PORT)
  if (busy) {
    // lsof 缺失时可能漏判；这里再确认一次占用者身份，绝不盲目杀。
    const remaining = lsofListeners(PORT)
    const killable = (remaining ?? []).filter((pid) => looksLikeOurServer(pid, [job.prev?.entry, job.new?.entry]))
    if (killable.length > 0) {
      for (const pid of killable) { signal(pid, 'SIGKILL') }
      await sleep(500)
    }
    if (await tcpBusy(PORT)) {
      setStatus({ phase: 'failed', error: `端口 ${PORT} 仍被占用（不是 dsh web 的进程，未清理）。请手动处理后重试。`, message: '启动中止' })
      process.exit(1)
    }
  }

  // 3) 启动新版本。
  const startOffset = fileSize(LOG_PATH)
  setStatus({ phase: 'starting', message: `启动新版本 ${job.new?.version ?? ''}` })
  const child = spawnServer(job.new, startOffset)
  status.newPid = child.pid
  writeJsonAtomic(STATUS_FILE, status)
  const ready = await waitReady(child, startOffset, READY_TIMEOUT_MS)
  if (ready.ok) {
    writeRuntimeActive(job.new, { pid: child.pid, url: ready.url })
    setStatus({ phase: 'ready', newPid: child.pid, url: ready.url, error: null, message: '新版本已就绪' })
    appendLog('切换成功')
    process.exit(0)
  }

  // 4) 新版本起不来：收掉它，用旧入口回滚。
  appendLog(`新版本未就绪：${ready.error}`)
  try { process.kill(-child.pid, 'SIGTERM') } catch { /* 可能已退出 */ }
  await waitGone(child.pid, 5000)
  if (isAlive(child.pid)) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* 已退出 */ } }

  if (job.prev === undefined || job.prev === null || typeof job.prev.entry !== 'string' || !existsSync(job.prev.entry)) {
    setStatus({ phase: 'failed', error: `新版本启动失败：${ready.error}；且没有可用的旧入口，未能回滚。`, message: '重启失败' })
    process.exit(1)
  }

  setStatus({ phase: 'rolling-back', error: ready.error, message: '新版本启动失败，正在回滚到旧版本' })
  const rollbackOffset = fileSize(LOG_PATH)
  const prevChild = spawnServer(job.prev, rollbackOffset)
  const prevReady = await waitReady(prevChild, rollbackOffset, READY_TIMEOUT_MS)
  if (prevReady.ok) {
    writeRuntimeActive(job.prev, { pid: prevChild.pid, url: prevReady.url })
    setStatus({
      phase: 'ready',
      newPid: prevChild.pid,
      url: prevReady.url,
      rolledBack: true,
      error: ready.error,
      message: '新版本启动失败，已回滚到旧版本（服务已恢复）',
    })
    process.exit(1)
  }
  setStatus({
    phase: 'failed',
    newPid: null,
    error: `新版本失败：${ready.error}\n回滚也失败：${prevReady.error}`,
    message: '服务未能恢复，请手动运行 dsh web',
  })
  process.exit(2)
}

main().catch((error) => {
  setStatus({ phase: 'failed', error: messageOf(error), message: '切换器异常退出' })
  process.exit(2)
})
