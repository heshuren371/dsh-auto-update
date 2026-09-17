/**
 * @local/dsh-auto-update — 试运行（canary）探针。
 *
 * 核心安全原则：**先证明新版本能用真实 profile 起来，再动正在跑的服务。**
 * 探针在一台空闲端口上拉起候选入口，解析它打印的 token URL，做一次 HTTP
 * 校验，然后无论成败都收掉自己拉起的进程。它不接触真实端口、不碰正在跑的服务。
 *
 * 试运行失败且原因是某个第三方 loader entry 时，`parseLoaderConflicts` 会给出
 * 可以临时禁用的条目 id —— 上层据此生成 --patch 覆盖层重试，从而绕开
 * “一个插件不兼容、整棵插件树起不来”的连锁故障。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { killChild, makeLinePump } from './util.js'

/** 试运行从启动到可用的上限；冷启动插件多时会慢，给足余量。 */
export const CANARY_READY_TIMEOUT_MS = 150_000
/** 单次 HTTP 探测的超时。 */
export const CANARY_HTTP_TIMEOUT_MS = 5_000
/** 保留的试运行输出上限（字节），只为报错展示，不做完整日志。 */
export const MAX_CANARY_OUTPUT = 256 * 1024

/**
 * dsh web 启动后打印的带 token 地址：
 *   dsh web: http://127.0.0.1:61104/?token=xxxx
 * 允许任意主机名（--host 0.0.0.0 / IPv6），端口单独捕获。
 */
const URL_RE = /https?:\/\/([^\s/]+):(\d+)\/\?token=([A-Za-z0-9_-]+)/

/**
 * Cordis loader 失败信息。两种动作、四种形态：
 *   failed to apply  loader entry webserver (@deepseek-ai/dsh-host-webserver): ...
 *   failed to apply  loader entry include (cordis:include): ...
 *   failed to import loader entry bad-plugin (this-module-does-not-exist): ...
 *   failed to apply  loader entry my-widget: ...（没有括号里的包名）
 * 模块解析失败用的是 "import"，插件 apply 抛错用的是 "apply"。
 */
const CONFLICT_RE = /failed to (?:apply|import) loader entry ([^\s(:]+)(?: \(([^)]+)\))?:/g
/** 官方包 / 内核 loader 条目：即使失败也不该被临时禁用。 */
const CORE_PACKAGE_RE = /^@deepseek-ai\/|^cordis([:/]|$)|^dsh-/
const CORE_ENTRY_IDS = new Set(['include', 'webserver', 'loader', 'cordis', 'timer', 'hmr'])
/** loader entry id 必须长得像 id，避免把带特殊字符的文本写进 YAML。 */
const SAFE_ID_RE = /^[A-Za-z0-9._@/-]{1,120}$/

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 严格解析端口字面量：只接受 1~5 位纯数字且落在 0..65535。
 * Number.parseInt('9000abc') 会得到 9000 —— 这种宽松解析会把非法参数当成合法端口，
 * 于是切换器去等一个根本不是 dsh 监听的端口。这里改成整体匹配，非法一律 null。
 */
function strictPort(text) {
  if (typeof text !== 'string' || !/^\d{1,5}$/.test(text)) return null
  const value = Number.parseInt(text, 10)
  return value >= 0 && value <= 65535 ? value : null
}

/** 从启动参数里解析监听端口；没有合法 --port 时用 fallback（dsh web 默认 3080）。 */
export function parsePort(args, fallback = 3080) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--port' && typeof args[i + 1] === 'string') {
      const value = strictPort(args[i + 1])
      if (value !== null) return value
    }
    if (typeof arg === 'string' && arg.startsWith('--port=')) {
      const value = strictPort(arg.slice('--port='.length))
      if (value !== null) return value
    }
  }
  return fallback
}

/** 去掉参数里的 --port / --port=N（试运行要换成自己的空闲端口）。 */
export function stripPortArgs(args) {
  const out = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--port') { i += 1; continue }
    if (typeof arg === 'string' && arg.startsWith('--port=')) continue
    out.push(arg)
  }
  return out
}

/** 生成试运行参数：换端口 + --no-open，其余（profile、host 等）原样保留。 */
export function withCanaryArgs(args, port) {
  return [...stripPortArgs(args), '--port', String(port), '--no-open']
}

/**
 * 把 `web` 子命令改写成等价的 `--profile web`。
 *
 * launcher 明确拒绝 `web` 子命令与父级 flag（--patch 等）同时出现：
 *   error: web takes none of parent --profile, --from-default-profile, --patch, ...
 * 所以一旦要在前面追加 --patch，就必须换成 --profile 形式。
 */
export function normalizeWebArgs(args) {
  const out = Array.isArray(args) ? [...args] : []
  if (out.length > 0 && out[0] === 'web') return ['--profile', 'web', ...out.slice(1)]
  return out
}

/** 在启动参数前插入 --patch 覆盖层（必须放在 launcher 参数最前面）。 */
export function withQuarantineArg(args, patchFile) {
  if (typeof patchFile !== 'string' || patchFile.length === 0) return [...args]
  return ['--patch', patchFile, ...normalizeWebArgs(args)]
}

/**
 * 从试运行输出里提取“可以临时禁用”的冲突条目。
 * @param text - stdout + stderr 的合并文本。
 * @returns 形如 [{ id, pkg, core }]，按出现顺序去重。
 */
export function parseLoaderConflicts(text) {
  const found = new Map()
  CONFLICT_RE.lastIndex = 0
  let match = CONFLICT_RE.exec(text)
  while (match !== null) {
    const id = match[1]
    const pkg = match[2] ?? ''
    if (SAFE_ID_RE.test(id) && !found.has(id)) {
      const core = CORE_ENTRY_IDS.has(id) || (pkg.length > 0 && CORE_PACKAGE_RE.test(pkg))
      found.set(id, { id, pkg, core })
    }
    match = CONFLICT_RE.exec(text)
  }
  return [...found.values()]
}

/** 生成禁用条目的 --patch 覆盖层内容。 */
export function quarantinePatchText(ids) {
  const lines = [
    '# 由 dsh-auto-update 自动生成：这些插件与新版本不兼容，试运行失败后临时禁用。',
    '# 升级/更换插件后可在「设置 → 通用 → DSH 更新」里点“重新启用插件”清除本文件。',
  ]
  for (const id of ids) {
    if (!SAFE_ID_RE.test(id)) continue
    // YAML 单引号字符串：内部的 ' 写成 ''。
    lines.push(`- id: '${id.replaceAll("'", "''")}'`)
    lines.push('  disabled: true')
  }
  return lines.join('\n') + '\n'
}

/** 把禁用列表写到覆盖层文件（原子写不必要：文件小且只在试运行前读）。 */
export function writeQuarantinePatch(file, ids) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, quarantinePatchText(ids))
}

/** 找一个空闲的本地端口。返回后端口即被释放，存在极小的竞争窗口，够用。 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** 发起一次 HTTP 请求取状态码；连不上/超时返回 null。 */
export async function httpStatus(url, { timeoutMs = CANARY_HTTP_TIMEOUT_MS } = {}) {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'dsh-auto-update-canary' },
    })
    return response.status
  } catch {
    return null
  }
}

/** 端口上是否已经有监听者（用于重启前的占位检查）。 */
export function isPortListening(port, { timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function normalizeProbeHost(host) {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return '127.0.0.1'
  if (host === '[::1]') return '::1'
  return host
}

/**
 * 在一台空闲端口上试运行候选入口，验证它能被真实 profile 加载并对外服务。
 *
 * @param options.entry - 候选 dsh CLI 入口（JS 文件）。
 * @param options.args - 原始启动参数（会替换 --port 并追加 --no-open）。
 * @param options.cwd - 工作目录（与真实服务保持一致，profile 行为才一致）。
 * @param options.env - 额外环境变量。
 * @param options.quarantineFile - 有禁用条目时的 --patch 覆盖层；无则 null。
 * @param options.timeoutMs - 从启动到可用的上限。
 * @param options.onLine - 每行输出回调（用于把试运行日志接到界面）。
 * @param options.onSpawn - 子进程创建回调（宿主据此登记，取消/停用时能立刻收掉）。
 * @param options.onExit - 子进程收尾回调（与 onSpawn 配对，务必成对登记/摘除）。
 * @returns { ok, port, url, bareUrl, pid, exitCode, output, error, conflicts }
 */
export async function canaryBoot({
  entry,
  args = [],
  cwd,
  env = {},
  quarantineFile = null,
  timeoutMs = CANARY_READY_TIMEOUT_MS,
  onLine,
  onSpawn,
  onExit,
} = {}) {
  let port
  try {
    port = await findFreePort()
  } catch (error) {
    return { ok: false, port: null, url: null, pid: null, exitCode: null, output: [], error: `无法分配空闲端口：${messageOf(error)}`, conflicts: [] }
  }

  const finalArgs = withCanaryArgs(withQuarantineArg(args, quarantineFile), port)
  const output = []
  let outputBytes = 0
  const append = (line) => {
    if (outputBytes < MAX_CANARY_OUTPUT) {
      output.push(line)
      outputBytes += line.length + 1
    }
    onLine?.(line)
  }

  let child
  try {
    child = spawn(process.execPath, [entry, ...finalArgs], {
      cwd,
      env: {
        ...process.env,
        DSH_AUTO_UPDATE_CANARY: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
  } catch (error) {
    return { ok: false, port, url: null, pid: null, exitCode: null, output, error: `无法启动试运行进程：${messageOf(error)}`, conflicts: [] }
  }

  onSpawn?.(child)

  const outPump = makeLinePump(append)
  const errPump = makeLinePump(append)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  let tokenUrl = null
  let urlPort = port
  let urlHost = '127.0.0.1'
  // 只按单个 chunk 匹配会漏掉「地址正好被切成两块」的情况（stdout 背压、进程分两次
  // write 都会发生），健康的构建就会白等到超时。这里保留一小段滚动尾巴，
  // 跨 chunk 拼起来的地址也能认出来；解析成功后立刻停止累积，避免误匹配旧日志。
  const SCAN_TAIL_CHARS = 4096
  let scanTail = ''
  const feed = (chunk) => {
    if (tokenUrl !== null) return
    scanTail = (scanTail + chunk).slice(-SCAN_TAIL_CHARS)
    const match = URL_RE.exec(scanTail)
    if (match !== null) {
      urlHost = normalizeProbeHost(match[1])
      urlPort = Number.parseInt(match[2], 10)
      tokenUrl = `http://${match[1]}:${match[2]}/?token=${match[3]}`
    }
  }
  child.stdout.on('data', (chunk) => { outPump.push(chunk); feed(chunk) })
  child.stderr.on('data', (chunk) => { errPump.push(chunk); feed(chunk) })

  let exitCode = null
  let spawnError = null
  child.on('error', (error) => { spawnError = messageOf(error) })
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => { exitCode = code === null ? -1 : code; resolve() })
  })

  const deadline = Date.now() + timeoutMs
  let ready = false
  let lastStatus = null
  // 是否在就绪前就结束了（而不是等到超时才被我们收掉）。收尾时用它区分
  // 「进程崩溃早退」和「根本没打印地址的超时」——两者的排查方向完全不同。
  let exitedEarly = false
  while (Date.now() < deadline) {
    if (exitCode !== null || spawnError !== null) { exitedEarly = true; break }
    if (tokenUrl !== null) {
      lastStatus = await httpStatus(tokenUrl)
      if (lastStatus !== null && lastStatus >= 200 && lastStatus < 400) { ready = true; break }
    } else if (urlPort !== port && await isPortListening(urlPort)) {
      // 还没打印出 token URL，但端口已经起来了：再等下一轮解析。
    }
    await new Promise((resolve) => { setTimeout(resolve, 400) })
  }

  try {
    outPump.flush()
    errPump.flush()
    killChild(child, 'SIGTERM')
    // 给进程 2 秒优雅退出，随后强制收尾，保证试运行不留孤儿。
    await Promise.race([
      exited,
      new Promise((resolve) => { setTimeout(resolve, 2000) }),
    ])
  } finally {
    if (child.exitCode === null) killChild(child, 'SIGKILL')
    // 无论收尾成败都要通知宿主摘除登记，否则 state.children 会留下幽灵条目。
    onExit?.(child)
  }

  const bareUrl = `http://${urlHost}:${urlPort}/`
  const text = output.join('\n')
  if (ready) {
    return { ok: true, port: urlPort, url: tokenUrl, bareUrl, pid: child.pid, exitCode: null, output, error: null, conflicts: [] }
  }
  const conflicts = parseLoaderConflicts(text)
  const reason = spawnError !== null
    ? `试运行进程启动失败：${spawnError}`
    : exitedEarly && exitCode !== null
      ? `试运行进程在就绪前退出（退出码 ${exitCode}）`
      : tokenUrl === null
        ? `试运行超时：${Math.round(timeoutMs / 1000)}s 内没有打印出可访问地址`
        : `试运行进程起来了，但 HTTP 校验未通过（最后状态码 ${lastStatus ?? '连不上'}）`
  return { ok: false, port: urlPort, url: tokenUrl, bareUrl, pid: child.pid, exitCode, output, error: reason, conflicts }
}

/** 输出末尾若干行，用于界面报错（不刷屏）。 */
export function tailLines(lines, count = 12) {
  if (!Array.isArray(lines)) return []
  return lines.slice(Math.max(0, lines.length - count))
}
