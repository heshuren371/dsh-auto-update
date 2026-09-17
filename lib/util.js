/**
 * @local/dsh-auto-update — 共享底层工具。
 *
 * 只放「宿主流水线」和「试运行探针」都要用的东西：shell 转义、子进程
 * 生命周期、行缓冲、原子写文件。刻意不依赖任何 Cordis / DSH API，方便单测直接 import。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

let cachedGitBin = null

/**
 * 找一个**真正能用**的 git。
 *
 * macOS 上 /usr/bin/git 是个 shim：Xcode 许可没接受时它会直接以 69 退出
 * （"You have not agreed to the Xcode license agreements"）。Homebrew 的 git
 * 也可能没装。这里按 PATH → Homebrew → CLT → Xcode 的顺序逐个试 --version，
 * 谁真的能跑就用谁；全都不可用时退回 'git'，把原始错误留给调用方展示。
 */
export function resolveGitBin() {
  if (cachedGitBin !== null) return cachedGitBin
  const candidates = []
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.length > 0) candidates.push(path.join(dir, 'git'))
  }
  candidates.push(
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
    '/Library/Developer/CommandLineTools/usr/bin/git',
    '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
  )
  const seen = new Set()
  for (const candidate of candidates) {
    let resolved
    try { resolved = path.resolve(candidate) } catch { continue }
    if (seen.has(resolved)) continue
    seen.add(resolved)
    if (!existsSync(resolved)) continue
    try {
      const result = spawnSync(resolved, ['--version'], { encoding: 'utf8', timeout: 10_000 })
      const output = (result.stdout ?? '') + (result.stderr ?? '')
      if (result.status === 0 && !/Xcode license/i.test(output)) {
        cachedGitBin = resolved
        return cachedGitBin
      }
    } catch {
      // 换下一个候选。
    }
  }
  cachedGitBin = 'git'
  return cachedGitBin
}

/** 单引号包裹，避免路径里的空格/特殊字符。正确转义单引号本身。 */
export function sh(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
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
export function killChild(child, signal = 'SIGTERM') {
  if (child === null || child === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // 进程组已不存在（或平台不支持）：退回杀直接子进程。
    try { child.kill(signal) } catch { /* 已退出 */ }
  }
}

/**
 * 把 chunk 流切成行。两个必须守住的性能边界：
 *  1) 不能对不断变长的 pending 反复 split —— 那是 O(n²)（实测 8MB 输出堆峰值 232MB）。
 *     没有换行的块走快路径，直接累积。
 *  2) 单行不能无限长。pnpm / git 的进度条只用 \r 不回 \n；超过 maxPending 就截断。
 */
export function makeLinePump(sink, { maxPending = 16 * 1024 } = {}) {
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
      if (pending.length > maxPending) {
        const dropped = pending.length - maxPending
        sink?.(`${pending.slice(0, maxPending)} …（单行过长，已截断 ${dropped} 字符）`)
        pending = ''
      }
    },
    flush() {
      if (pending.length > 0) sink?.(pending)
      pending = ''
    },
  }
}

/**
 * 判定「值得优先保留的错误行」。bestDetail 用它挑最有信息量的一行，
 * 有界行缓冲也用它决定溢出时先淘汰谁 —— 两处必须同一套判定，不能各写一份。
 */
export const ERROR_LINE_RE = /error|fatal|not agreed|license/i

/**
 * 有界行收集器：只保留最后 maxLines 行。
 *
 * pnpm install / build 能刷出几万行 stderr，全留着只是白吃内存；但真正的失败
 * 原因（error / fatal / license）常常出现在几万行噪音**之前**，单纯截掉尾部再让
 * bestDetail 去挑就什么都挑不到了。所以溢出时优先淘汰最旧的非关键行，
 * 关键行最多也就 maxLines 行，内存照样有界。
 */
export function createLineBuffer({ maxLines = 200, priorityRe = ERROR_LINE_RE } = {}) {
  const lines = []
  return {
    lines,
    push(line) {
      lines.push(line)
      if (lines.length <= maxLines) return
      if (priorityRe === null) { lines.shift(); return }
      const index = lines.findIndex((item) => !priorityRe.test(item))
      lines.splice(index === -1 ? 0 : index, 1)
    },
  }
}

/**
 * 运行一段 bash 脚本，逐行回调输出，返回退出码。
 * @param script - 交给 /bin/bash -c 的脚本。
 * @param options - cwd / env / 回调 / 超时 / onSpawn / onExit。
 */
export function runBash(script, {
  cwd,
  env,
  onLine,
  onErrLine,
  timeoutMs,
  detached = true,
  onSpawn,
  onExit,
} = {}) {
  return new Promise((resolve) => {
    const childEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      // 别让 ssh 在 host key / 口令上挂住整个流水线。
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
      HUSKY: '0',
      ...(env ?? {}),
    }
    // 保证 pnpm / node 与当前进程同一套工具链，即使 PATH 被精简过。
    // 同时把解析出的可用 git 目录放到最前：/usr/bin/git 可能被 Xcode 许可检查拦住。
    const nodeBin = path.dirname(process.execPath)
    const gitBin = resolveGitBin()
    const gitDir = gitBin === 'git' ? null : path.dirname(gitBin)
    childEnv.PATH = [nodeBin, gitDir, childEnv.PATH]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join(path.delimiter)
    let child
    try {
      child = spawn('/bin/bash', ['-c', script], {
        cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
        // 独立进程组：取消时能连 git / pnpm 孙进程一起收掉。
        detached,
      })
    } catch (error) {
      onLine?.(`无法启动子进程：${error instanceof Error ? error.message : String(error)}`)
      resolve(-1)
      return
    }
    onSpawn?.(child)
    let timer = null
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      onExit?.(child, code)
      resolve(code)
    }
    // stdout / stderr 分开走：git 的 "fatal: ..." 走 stderr，
    // 混在一起会让失败输出被当成正常结果解析（例如把 fatal 文本当成 commit sha）。
    const outPump = makeLinePump(onLine)
    const errPump = makeLinePump(onErrLine ?? onLine)
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
  })
}

/** 运行一段脚本并收集输出；out 只含 stdout，err 只含 stderr。 */
export async function capture(script, { cwd, timeoutMs, env } = {}) {
  const out = []
  const err = []
  // git 查询的输出本该很小；万一仓库里有超长输出，也不要让它把整个堆吃满。
  const CAPTURE_LIMIT_BYTES = 1024 * 1024
  let outBytes = 0
  let errBytes = 0
  const collect = (list, add) => (line) => {
    if (add(line.length + 1) > CAPTURE_LIMIT_BYTES) return
    list.push(line)
  }
  const code = await runBash(script, {
    cwd,
    env,
    timeoutMs,
    onLine: collect(out, (n) => (outBytes += n)),
    onErrLine: collect(err, (n) => (errBytes += n)),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** 原子写文件：先写临时文件再 rename，避免读到半截 JSON。 */
export function writeFileAtomic(file, data, { mode } = {}) {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode })
  renameSync(tmp, file)
}

/** 原子写 JSON。 */
export function writeJsonAtomic(file, value, options) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', options)
}

/** 读 JSON，失败返回 null（不抛）。 */
export function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/** Promise 版 sleep。 */
export function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 进程是否还活着（信号 0 探测）。 */
export function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
