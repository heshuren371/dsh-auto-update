#!/usr/bin/env node
/**
 * dsh-auto-update 失败包 CLI：把「最近一次更新失败」变成人能看、AI 能接手的东西。
 *
 *   node scripts/repair.mjs                     打印可读失败摘要
 *   node scripts/repair.mjs --prompt            只输出 agentPrompt（可直接粘贴给 AI 代理）
 *   node scripts/repair.mjs --json              输出完整 FailureBundle（JSON）
 *   node scripts/repair.mjs --clear             删除 failures/latest.json 与 latest.log
 *   node scripts/repair.mjs --assist            用后台 dsh 会话按 agentPrompt 自动修复
 *   node scripts/repair.mjs --assist --dry-run  只打印将执行的命令，不启动任何会话
 *
 * 失败包契约（由插件流水线写入，backend 同步实现）：
 *   $DSH_UPDATE_STATE/failures/latest.json   结构化 FailureBundle
 *   $DSH_UPDATE_STATE/failures/latest.log    完整流水线日志（末尾含失败上下文）
 *
 * 路径解析与 lib/index.js 一致：DSH_HOME（默认 ~/.dsh）+ DSH_UPDATE_STATE
 * （默认 $DSH_HOME/dsh-auto-update）。只用 Node 内置模块：插件自身处于半更新
 * 状态时这个脚本也要能跑。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const STATE_DIR = process.env.DSH_UPDATE_STATE ?? path.join(DSH_HOME, 'dsh-auto-update')
const FAIL_DIR = path.join(STATE_DIR, 'failures')
const LATEST_JSON = path.join(FAIL_DIR, 'latest.json')
const LATEST_LOG = path.join(FAIL_DIR, 'latest.log')
/** 独立切换器维护的运行入口指针，和 lib/index.js 写到同一个位置。 */
const ACTIVE_ENTRY_FILE = path.join(STATE_DIR, 'active-entry')
const PROFILES_DIR = path.join(DSH_HOME, 'profiles')
/** 本插件生成的 dsh shim 是 /bin/sh 脚本，不能交给 node 跑；解析 PATH 时要跳过。 */
const SHIM_MARK = '由 dsh-auto-update 生成'
/** 摘要里标签按 4 个 CJK 字符（8 列）对齐。 */
const LABEL_WIDTH = 8
/** --assist 默认档案：先看环境变量，再退回 headless。 */
const DEFAULT_ASSIST_PROFILE = 'headless'
/** 读取日志尾部时的字节上限，避免一整个大日志进内存。 */
const TAIL_BYTES = 512 * 1024

const SELF = process.argv[1] ?? 'scripts/repair.mjs'

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFile(target) {
  try { return statSync(target).isFile() } catch { return false }
}

function isDirectory(target) {
  try { return statSync(target).isDirectory() } catch { return false }
}

/** 取第一个非空字符串（用于 --profile / $DSH_UPDATE_ASSIST_PROFILE / 默认值）。 */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/** 单引号包裹，保证路径/提示词里的空格、换行、引号安全。 */
function sh(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** 粗略显示宽度：标签都是 CJK，按 2 列算才能对齐。 */
function displayWidth(text) {
  let width = 0
  for (const ch of text) width += ch.codePointAt(0) >= 0x1100 ? 2 : 1
  return width
}

/** 打一行「标签 : 值」；值多行时后续行按同一列缩进。 */
function printField(label, value) {
  const prefix = `  ${label}${' '.repeat(Math.max(0, LABEL_WIDTH - displayWidth(label)))} : `
  const lines = String(value).split('\n')
  console.log(`${prefix}${lines[0]}`)
  const pad = ' '.repeat(displayWidth(prefix))
  for (const line of lines.slice(1)) console.log(`${pad}${line}`)
}

function display(value, fallback = '(未提供)') {
  if (typeof value === 'string') return value.length > 0 ? value : fallback
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function shortSha(sha) {
  return typeof sha === 'string' && sha.length > 12 ? sha.slice(0, 12) : sha
}

function describeTarget(target) {
  if (!isObject(target)) return '(未提供)'
  const parts = []
  if (typeof target.version === 'string' && target.version.length > 0) parts.push(`版本 ${target.version}`)
  if (typeof target.ref === 'string' && target.ref.length > 0) parts.push(`ref ${target.ref}`)
  if (typeof target.sha === 'string' && target.sha.length > 0) parts.push(`sha ${shortSha(target.sha)}`)
  if (typeof target.channel === 'string' && target.channel.length > 0) parts.push(`通道 ${target.channel}`)
  return parts.length > 0 ? parts.join('  ') : '(未提供)'
}

function describeRunning(running) {
  if (!isObject(running)) return '(未提供)'
  const parts = []
  if (typeof running.version === 'string' && running.version.length > 0) parts.push(`版本 ${running.version}`)
  if (typeof running.commit === 'string' && running.commit.length > 0) parts.push(`commit ${shortSha(running.commit)}`)
  if (typeof running.root === 'string' && running.root.length > 0) parts.push(`root ${running.root}`)
  return parts.length > 0 ? parts.join('  ') : '(未提供)'
}

function logPathOf(bundle) {
  return typeof bundle.logPath === 'string' && bundle.logPath.length > 0 ? bundle.logPath : LATEST_LOG
}

/** agentPrompt 正常是字符串；旧包或手写包可能是字符串数组，这里都兼容。 */
function promptText(bundle) {
  if (!isObject(bundle)) return ''
  if (typeof bundle.agentPrompt === 'string') return bundle.agentPrompt
  if (Array.isArray(bundle.agentPrompt)) {
    return bundle.agentPrompt.filter((line) => typeof line === 'string').join('\n')
  }
  return ''
}

/** 只读文件头，用来判断 PATH 上的 dsh 是不是 sh shim（不把整个文件读进来）。 */
function readHead(file, bytes = 4096) {
  let fd = null
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* 已关闭 */ }
    }
  }
}

function looksLikeShellShim(file) {
  const head = readHead(file)
  if (head.includes(SHIM_MARK)) return true
  // 任何非 node 的 shebang（#!/bin/sh 等）都不能用 node 执行。
  if (head.startsWith('#!') && !/node/i.test(head)) return true
  return false
}

/**
 * 找 PATH 上真正的 dsh 入口：按目录顺序找，realpath 后跳过本插件生成的 shim
 * 和 sh 脚本，返回能交给 node 跑的那个文件。
 */
function findPathDshEntry() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue
    const candidate = path.join(dir, 'dsh')
    if (!existsSync(candidate)) continue
    let real = candidate
    try { real = realpathSync(candidate) } catch { real = candidate }
    if (!isFile(real)) continue
    if (looksLikeShellShim(real)) continue
    return real
  }
  return null
}

/**
 * 入口解析顺序：$DSH_UPDATE_ENTRY → active-entry → PATH 上 dsh 的 realpath。
 * 显式设置的 $DSH_UPDATE_ENTRY 不存在时不静默换源，而是记进 attempts 后继续找，
 * 全部失败时把整条尝试链打印出来。
 */
function resolveEntry() {
  const attempts = []
  const envEntry = typeof process.env.DSH_UPDATE_ENTRY === 'string' && process.env.DSH_UPDATE_ENTRY.length > 0
    ? process.env.DSH_UPDATE_ENTRY
    : null
  if (envEntry !== null) {
    if (isFile(envEntry)) return { entry: path.resolve(envEntry), source: '$DSH_UPDATE_ENTRY' }
    attempts.push(`$DSH_UPDATE_ENTRY=${envEntry}（不是存在的文件）`)
  } else {
    attempts.push('$DSH_UPDATE_ENTRY（未设置）')
  }

  let activeValue = ''
  try { activeValue = readFileSync(ACTIVE_ENTRY_FILE, 'utf8').trim() } catch { activeValue = '' }
  if (activeValue.length > 0 && isFile(activeValue)) {
    return { entry: activeValue, source: ACTIVE_ENTRY_FILE }
  }
  attempts.push(`${ACTIVE_ENTRY_FILE} -> ${activeValue.length > 0 ? activeValue + '（不存在）' : '（没有可用的指针）'}`)

  const pathEntry = findPathDshEntry()
  if (pathEntry !== null) return { entry: pathEntry, source: 'PATH 上 dsh 的真实入口' }
  attempts.push('PATH 上没有找到能交给 node 运行的 dsh 入口')
  return { entry: null, attempts }
}

function listProfiles() {
  try {
    return readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort()
  } catch {
    return []
  }
}

/** 读日志最后 count 行；bundle.logTail 没有时直接读日志文件尾部兜底。 */
function readTailLines(file, count) {
  try {
    const buffer = readFileSync(file)
    const text = buffer.subarray(Math.max(0, buffer.length - TAIL_BYTES)).toString('utf8')
    const lines = text.split('\n')
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.slice(-count)
  } catch {
    return []
  }
}

function failureTail(bundle, count = 10) {
  const logTail = Array.isArray(bundle.logTail) ? bundle.logTail : []
  const lines = logTail.map((line) => (typeof line === 'string' ? line : String(line)))
  if (lines.length > 0) return lines.slice(-count)
  return readTailLines(logPathOf(bundle), count)
}

/** 读失败包：返回 { bundle, error }；文件不存在时 bundle 为 null。 */
function loadBundle() {
  if (!existsSync(LATEST_JSON)) return { bundle: null, error: null }
  let text
  try {
    text = readFileSync(LATEST_JSON, 'utf8')
  } catch (error) {
    return { bundle: null, error: `无法读取失败包 ${LATEST_JSON}：${messageOf(error)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { bundle: null, error: `失败包 ${LATEST_JSON} 不是合法 JSON：${messageOf(error)}` }
  }
  if (!isObject(parsed)) return { bundle: null, error: `失败包 ${LATEST_JSON} 不是 JSON 对象。` }
  return { bundle: parsed, error: null }
}

function fail(message, code = 2) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n')
  return code
}

function selfLabel() {
  const rel = path.relative(process.cwd(), SELF)
  const shown = rel.length > 0 ? rel : SELF
  return /\s/.test(shown) ? sh(shown) : shown
}

function printSummary(bundle) {
  console.log('最近一次更新失败')
  console.log('')
  printField('时间', display(bundle.at))
  printField('类型', display(bundle.kind))
  printField('提示', display(bundle.hint))
  printField('失败步骤', display(bundle.step))
  printField('错误', display(bundle.error))
  printField('目标版本', describeTarget(bundle.target))
  printField('当前运行', describeRunning(bundle.running))
  if (Array.isArray(bundle.attempts) && bundle.attempts.length > 0) {
    printField('尝试次数', `${bundle.attempts.length} 次`)
  }

  console.log('')
  console.log('  复现命令：')
  const reproduce = Array.isArray(bundle.reproduce)
    ? bundle.reproduce.filter((line) => typeof line === 'string' && line.length > 0)
    : []
  if (reproduce.length === 0) console.log('    （失败包未提供）')
  else for (const line of reproduce) console.log(`    ${line}`)

  console.log('')
  console.log('  日志尾部（最后 10 行）：')
  const tail = failureTail(bundle, 10)
  if (tail.length === 0) console.log('    （失败包没有 logTail，也读不到日志文件）')
  else for (const line of tail) console.log(`    ${line}`)

  console.log('')
  printField('日志路径', logPathOf(bundle))
  console.log('')
  console.log(`  交给 AI 代理：node ${selfLabel()} --prompt`)
  console.log(`  自动修复    ：node ${selfLabel()} --assist`)
}

function printPrompt(bundle) {
  const prompt = promptText(bundle)
  if (prompt.trim().length === 0) {
    return fail(`失败包 ${LATEST_JSON} 里没有 agentPrompt，无法输出。可用 --json 查看完整结构。`, 1)
  }
  process.stdout.write(prompt.endsWith('\n') ? prompt : prompt + '\n')
  return 0
}

function clearFailures() {
  const removed = []
  for (const file of [LATEST_JSON, LATEST_LOG]) {
    if (!existsSync(file)) continue
    try {
      rmSync(file, { force: true })
      removed.push(file)
    } catch (error) {
      return fail(`删除 ${file} 失败：${messageOf(error)}`, 1)
    }
  }
  if (removed.length === 0) {
    console.log(`没有失败记录（无需清理）：${FAIL_DIR}`)
    return 0
  }
  for (const file of removed) console.log(`已删除 ${file}`)
  return 0
}

/** --assist 的工作目录优先用失败包里的 repo（代理直接在现场排查），不存在则用当前目录。 */
function assistCwd(bundle) {
  const repo = typeof bundle.repo === 'string' && bundle.repo.length > 0 ? bundle.repo : null
  if (repo !== null && isDirectory(repo)) return repo
  return process.cwd()
}

function assist(bundle, profileArg, dryRun) {
  if (bundle === null) {
    return fail(`没有失败记录，无法 --assist：${LATEST_JSON} 不存在。先复现一次更新失败，或手动放入失败包。`, 1)
  }
  const prompt = promptText(bundle)
  if (prompt.trim().length === 0) {
    return fail(`失败包 ${LATEST_JSON} 里没有 agentPrompt，无法 --assist。可用 --json 查看完整结构。`, 1)
  }

  const profile = firstNonEmpty(profileArg, process.env.DSH_UPDATE_ASSIST_PROFILE, DEFAULT_ASSIST_PROFILE)
  if (profile.includes('/') || profile.includes('\\') || profile === '.' || profile === '..') {
    return fail(`profile 名称不合法：${profile}（只能是 ${PROFILES_DIR} 下的一级目录名）`, 2)
  }
  const profileDir = path.join(PROFILES_DIR, profile)
  if (!isDirectory(profileDir)) {
    const available = listProfiles()
    return fail([
      `profile "${profile}" 不存在：${profileDir}`,
      `可用 profile（${PROFILES_DIR}）：${available.length > 0 ? available.join('、') : '(没有可用的 profile 目录)'}`,
      '用 --profile <name> 或 $DSH_UPDATE_ASSIST_PROFILE 指定。',
    ].join('\n'), 1)
  }

  const resolved = resolveEntry()
  if (resolved.entry === null) {
    return fail([
      '找不到可用的 dsh 入口，--assist 中止。已尝试：',
      ...resolved.attempts.map((line) => `  - ${line}`),
      '可用 $DSH_UPDATE_ENTRY 显式指定，或先安装受管 dsh（scripts/use-managed-dsh.mjs）。',
    ].join('\n'), 1)
  }

  const entry = resolved.entry
  const cwd = assistCwd(bundle)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = path.join(FAIL_DIR, `assist-${stamp}.log`)
  const argv = [process.execPath, entry, '--profile', profile, prompt]

  if (dryRun) {
    console.log('[dry-run] 只打印将执行的命令，不会启动任何 dsh 会话。')
    console.log('')
    printField('入口', `${entry}（来自 ${resolved.source}）`)
    printField('node', process.execPath)
    printField('profile', `${profile}（${profileDir}）`)
    printField('工作目录', cwd)
    printField('日志', `${logPath}（dry-run 不创建）`)
    console.log('')
    console.log('  将执行：')
    console.log(`    ${argv.map(sh).join(' ')}`)
    return 0
  }

  let fd = null
  try {
    mkdirSync(FAIL_DIR, { recursive: true })
    fd = openSync(logPath, 'a')
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* 已关闭 */ }
    }
    return fail(`无法创建修复日志 ${logPath}：${messageOf(error)}`, 1)
  }

  let child
  try {
    child = spawn(process.execPath, [entry, '--profile', profile, prompt], {
      cwd,
      env: process.env,
      detached: true,
      // stdio 全部重定向到日志：CLI 退出后修复会话继续在后台跑。
      stdio: ['ignore', fd, fd],
    })
  } catch (error) {
    closeSync(fd)
    return fail(`启动修复会话失败：${messageOf(error)}`, 1)
  }
  closeSync(fd)

  if (typeof child.pid !== 'number') {
    return fail('启动修复会话失败：子进程没有 pid。', 1)
  }
  child.on('error', (error) => {
    process.stderr.write(`修复会话子进程错误：${messageOf(error)}\n`)
  })
  // descendant 进程：脱离当前 CLI 的进程组与事件循环，CLI 退出后继续跑。
  child.unref()

  console.log('已在后台启动 dsh 修复会话（descendant 进程）。')
  console.log('')
  printField('pid', String(child.pid))
  printField('profile', profile)
  printField('入口', entry)
  printField('工作目录', cwd)
  printField('日志', logPath)
  printField('跟踪日志', `tail -f ${sh(logPath)}`)
  console.log('')
  console.log('  说明：该会话独立于本命令运行；进度写在上面的日志里，本命令不等待它。')
  return 0
}

function printUsage() {
  console.log(`把「最近一次更新失败」打成可读摘要，或交给 AI 代理修复。

用法：node scripts/repair.mjs [选项]

  （无）               打印可读失败摘要；没有失败包时以非 0 退出
  --prompt             只输出失败包里的 agentPrompt，可直接粘贴给 AI 代理
  --json               输出完整失败包（JSON）
  --clear              删除 failures/latest.json 与 failures/latest.log
  --assist             用后台 dsh 会话按 agentPrompt 自动修复
  --profile <name>     配合 --assist：指定 dsh profile（默认 $DSH_UPDATE_ASSIST_PROFILE 或 ${DEFAULT_ASSIST_PROFILE}）
  --dry-run            配合 --assist：只打印将执行的命令，不启动进程
  -h, --help           显示本帮助

路径：
  DSH_HOME        默认 ~/.dsh
  DSH_UPDATE_STATE 默认 $DSH_HOME/dsh-auto-update（失败包在它的 failures/ 下）
  dsh 入口解析    $DSH_UPDATE_ENTRY → $DSH_UPDATE_STATE/active-entry → PATH 上 dsh 的 realpath`)
}

function parseArgs(args) {
  const modes = []
  const positional = []
  let profileArg = null
  let dryRun = false
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--profile') {
      const value = args[index + 1]
      index += 1
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        return { error: '--profile 需要一个 profile 名称。' }
      }
      profileArg = value
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length)
      if (value.length === 0) return { error: '--profile 需要一个 profile 名称。' }
      profileArg = value
    } else if (arg === '--prompt' || arg === '--json' || arg === '--clear' || arg === '--assist') {
      modes.push(arg)
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '-h' || arg === '--help') {
      help = true
    } else if (arg.startsWith('-')) {
      return { error: `未知参数：${arg}（用 --help 看用法）` }
    } else {
      positional.push(arg)
    }
  }
  return { modes, positional, profileArg, dryRun, help }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error !== undefined) return fail(parsed.error, 2)
  if (parsed.help) {
    printUsage()
    return 0
  }
  const modes = new Set(parsed.modes)
  if (modes.size > 1) return fail('--prompt / --json / --clear / --assist 只能选一个。', 2)
  const mode = modes.size === 1 ? parsed.modes[0] : null
  if (parsed.positional.length > 0) return fail(`多余的参数：${parsed.positional.join(' ')}（用 --help 看用法）`, 2)
  if (parsed.dryRun && mode !== '--assist') return fail('--dry-run 只能与 --assist 一起使用。', 2)
  if (parsed.profileArg !== null && mode !== '--assist') return fail('--profile 只能与 --assist 一起使用。', 2)

  if (mode === '--clear') return clearFailures()

  const loaded = loadBundle()
  if (loaded.error !== null) return fail(loaded.error, 1)

  if (mode === '--json') {
    if (loaded.bundle === null) return fail(`没有失败记录：${LATEST_JSON} 不存在。`, 1)
    process.stdout.write(JSON.stringify(loaded.bundle, null, 2) + '\n')
    return 0
  }
  if (mode === '--prompt') {
    if (loaded.bundle === null) return fail(`没有失败记录：${LATEST_JSON} 不存在。`, 1)
    return printPrompt(loaded.bundle)
  }
  if (mode === '--assist') return assist(loaded.bundle, parsed.profileArg, parsed.dryRun)

  if (loaded.bundle === null) {
    return fail(`没有失败记录：${LATEST_JSON} 不存在。更新失败时插件会把失败包写到这里；也可以先跑一次更新复现。`, 1)
  }
  printSummary(loaded.bundle)
  return 0
}

process.exitCode = main()
