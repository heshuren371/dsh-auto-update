#!/usr/bin/env node
/**
 * scripts/switch.mjs 的沙箱集成测试 —— 不碰 3080 上正在运行的服务。
 *
 *   node scripts/switchtest.mjs [--new <entry>] [--prev <entry>] [--keep]
 *
 * 成功路径：在空闲端口拉起旧入口 → 让切换器把端口换成新入口 → 校验端口仍然可用、
 *            runtime.json / active-entry 指向新入口、token 地址可访问。
 * 回滚路径：新入口故意做成坏入口 → 切换器必须把旧入口拉回来并标记 rolledBack，
 *            且把运行指针指回旧入口。
 * 外部进程安全：用一个非 dsh 的 HTTP 进程占住端口，切换器必须拒绝启动（非 0 退出），
 *            并且绝不误杀 / 顶掉该进程 —— 端口自始至终由它服务。
 *
 * 默认入口取运行指针 active-entry（PATH 上的 dsh 可能是 use-managed-dsh.mjs 生成的
 * shell 包装脚本，不能直接喂给 node），并用 `node <entry> --version` 预检。
 * 拉起的 dsh 会把插件状态目录隔离到临时沙箱，绝不碰 ~/.dsh/dsh-auto-update；
 * 测试进程全部收在独立进程组里，结束时统一清理；临时目录默认删掉，--keep 保留排查。
 */
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findFreePort } from '../lib/probe.js'
import { readJson } from '../lib/util.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SWITCH = path.join(here, 'switch.mjs')
const NODE = process.execPath

function argValue(flag) {
  const at = process.argv.indexOf(flag)
  return at === -1 ? null : process.argv[at + 1] ?? null
}
/**
 * 解析一个**真正的 JS 入口**（dsh 的 bin.js），而不是 PATH 上的 shell 包装脚本。
 *
 * use-managed-dsh.mjs 生成的 ~/.local/bin/dsh 是 sh 脚本，它自己 exec `node <entry>`；
 * 直接 `node <shim> web ...` 只会 SyntaxError。所以这里按
 *   运行指针 active-entry → PATH 上 dsh 的 realpath
 * 的顺序取候选，逐个用 `node <候选> --version` 预检（宿主切换前也是这么预检的），
 * 第一个真正能跑的才返回。
 */
function resolveDshEntry() {
  const stateDir = typeof process.env.DSH_UPDATE_STATE === 'string' && process.env.DSH_UPDATE_STATE.length > 0
    ? process.env.DSH_UPDATE_STATE
    : path.join(os.homedir(), '.dsh', 'dsh-auto-update')
  const candidates = []
  if (typeof process.env.DSH_UPDATE_ENTRY === 'string' && process.env.DSH_UPDATE_ENTRY.length > 0) candidates.push(process.env.DSH_UPDATE_ENTRY.trim())
  try { candidates.push(readFileSync(path.join(stateDir, 'active-entry'), 'utf8').trim()) } catch { /* 还没有运行指针 */ }
  try {
    const bin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
    candidates.push(execFileSync(NODE, ['-e', 'process.stdout.write(require("fs").realpathSync(process.argv[1]))', bin], { encoding: 'utf8' }).trim())
  } catch { /* PATH 上没有 dsh */ }
  const seen = new Set()
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0 || seen.has(candidate)) continue
    seen.add(candidate)
    if (!existsSync(candidate)) continue
    try {
      const version = execFileSync(NODE, [candidate, '--version'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      if (version.length > 0) return candidate
    } catch { /* 换下一个候选 */ }
  }
  throw new Error('找不到可用的 dsh JS 入口（可用 --new/--prev 或 DSH_UPDATE_ENTRY 指定）')
}

const NEW_ENTRY = argValue('--new') ?? process.env.DSH_UPDATE_ENTRY ?? resolveDshEntry()
const PREV_ENTRY = argValue('--prev') ?? NEW_ENTRY
const KEEP = process.argv.includes('--keep')
const BASE = path.join(os.tmpdir(), 'dsh-switchtest-' + String(process.pid))
// 被拉起的 dsh 也会加载本插件：把它的状态目录隔离到临时沙箱，绝不碰
// ~/.dsh/dsh-auto-update 里的真实运行指针 / runtime.json（调用方指定了就不覆盖）。
if (typeof process.env.DSH_UPDATE_STATE !== 'string' || process.env.DSH_UPDATE_STATE.length === 0) {
  process.env.DSH_UPDATE_STATE = path.join(BASE, 'state')
}

let failed = 0
function check(label, ok, detail) {
  if (ok) process.stdout.write('  ok   ' + label + '\n')
  else { failed += 1; process.stdout.write('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail) + '\n') }
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
function killGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return
  try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* 已退出 */ } }
}
/** 存活且不是僵尸进程：信号 0 对僵尸也会成功，只看它会漏判“其实已经被杀了”。 */
function aliveReal(pid) {
  if (!alive(pid)) return false
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    return stat.length > 0 && stat.startsWith('Z') === false
  } catch {
    return false
  }
}
async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(150)
  }
  return !alive(pid)
}
/** 收掉一个（可能还带着子进程的）测试进程，并等它真的消失。 */
async function killAndWait(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  killGroup(pid)
  if (await waitGone(pid, 3_000)) return
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
  await waitGone(pid, 2_000)
}
async function waitPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('lsof', ['-nP', '-tiTCP:' + String(port), '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
      if (out.length > 0) return Number.parseInt(out.split('\n')[0], 10)
    } catch { /* 还没起来 */ }
    await sleep(300)
  }
  return null
}
function startServer(entry, port, log) {
  const fd = openSync(log, 'a')
  const child = spawn(NODE, [entry, 'web', '--port', String(port), '--no-open'], {
    detached: true, stdio: ['ignore', fd, fd],
  })
  child.unref()
  return child
}
function writeJob(dir, fields) {
  mkdirSync(dir, { recursive: true })
  const job = {
    jobVersion: 1,
    node: NODE,
    cwd: os.homedir(),
    trustOldPid: true,
    logPath: path.join(dir, 'switch.log'),
    statusFile: path.join(dir, 'switch-status.json'),
    runtimeFile: path.join(dir, 'runtime.json'),
    readyTimeoutMs: 150_000,
    ...fields,
  }
  const file = path.join(dir, 'switch-job.json')
  writeFileSync(file, JSON.stringify(job, null, 2))
  return file
}
function runSwitch(jobFile) {
  try {
    execFileSync(NODE, [SWITCH, jobFile], { encoding: 'utf8', timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return 0
  } catch (error) {
    return error.status === undefined ? 99 : error.status
  }
}
function httpCode(url) {
  try {
    return execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', url], { encoding: 'utf8', timeout: 10_000 })
  } catch {
    return 'curl-failed'
  }
}
function httpBody(url) {
  try {
    return execFileSync('curl', ['-sS', url], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return ''
  }
}
/** 读 active-entry（shell 用的纯文本运行指针）；不存在返回 null。 */
function activeEntryAt(dir) {
  try {
    return readFileSync(path.join(dir, 'active-entry'), 'utf8')
  } catch {
    return null
  }
}
function checkActiveEntry(label, dir, entry) {
  const text = activeEntryAt(dir)
  check(label, text === entry + '\n', 'got ' + JSON.stringify(text) + ', want ' + JSON.stringify(entry + '\n'))
}

/**
 * 外部进程安全用例：端口被一个**非 dsh** 的进程占着时，切换器必须拒绝启动，
 * 并且绝不能把无关进程杀掉 / 顶掉。外部进程由本用例自己拉起、自己收掉。
 */
async function runExternalGuardCase() {
  process.stdout.write('== 外部进程安全 ==\n')
  const port = await findFreePort()
  const dir = path.join(BASE, 'external-guard')
  mkdirSync(dir, { recursive: true })
  const script = path.join(dir, 'port-guard.mjs')
  writeFileSync(script, [
    "import http from 'node:http'",
    'const port = Number.parseInt(process.argv[2], 10)',
    "const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('port-guard-ok') })",
    "server.listen(port, '127.0.0.1')",
    '',
  ].join('\n'))
  const fd = openSync(path.join(dir, 'guard.log'), 'a')
  const guard = spawn(NODE, [script, String(port)], { detached: true, stdio: ['ignore', fd, fd] })
  guard.unref()
  closeSync(fd)
  try {
    const listener = await waitPort(port, 15_000)
    check('外部非 dsh 进程已占住端口', listener === guard.pid, 'listener=' + String(listener) + ' pid=' + String(guard.pid))
    const job = writeJob(dir, {
      oldPid: guard.pid,
      // 关键：不信任 oldPid，逼切换器自己按命令行判断“像不像 dsh web”。
      trustOldPid: false,
      port,
      new: { entry: NEW_ENTRY, args: ['web', '--port', String(port), '--no-open'], root: path.dirname(NEW_ENTRY), version: null, commit: null },
      prev: { entry: PREV_ENTRY, args: ['web', '--port', String(port), '--no-open'], root: null, version: null, commit: null },
    })
    const code = runSwitch(job)
    const status = readJson(path.join(dir, 'switch-status.json'))
    check('切换器拒绝启动（退出码非 0）', code !== 0, 'code=' + String(code))
    check('状态 phase=failed 且说明端口被非 dsh 进程占用', status !== null && status.phase === 'failed' && String(status.error ?? '').includes('仍被占用'), JSON.stringify(status))
    check('外部进程仍存活（未被误杀）', aliveReal(guard.pid))
    check('端口仍由外部进程监听', (await waitPort(port, 5_000)) === guard.pid)
    check('外部服务仍正常响应', httpBody('http://127.0.0.1:' + String(port) + '/') === 'port-guard-ok')
    check('未写 runtime.json（没把外部进程当成切换成功）', readJson(path.join(dir, 'runtime.json')) === null)
  } finally {
    await killAndWait(guard.pid)
    check('测试已收掉外部进程', aliveReal(guard.pid) === false)
  }
}

process.stdout.write(`new entry : ${NEW_ENTRY}\nprev entry: ${PREV_ENTRY}\n`)
rmSync(BASE, { recursive: true, force: true })
/** 测试期间拉起的进程，finally 里兜底收掉，避免残留占着端口。 */
const cleanupPids = []

try {
  await runExternalGuardCase()

  process.stdout.write('== 成功路径 ==\n')
  const okPort = await findFreePort()
  const okDir = path.join(BASE, 'ok')
  mkdirSync(okDir, { recursive: true })
  const old = startServer(PREV_ENTRY, okPort, path.join(okDir, 'old.log'))
  cleanupPids.push(old.pid)
  const listener = await waitPort(okPort, 90_000)
  check('旧服务已监听', listener !== null, 'pid=' + listener)
  const okJob = writeJob(okDir, {
    oldPid: old.pid,
    port: okPort,
    new: { entry: NEW_ENTRY, args: ['web', '--port', String(okPort), '--no-open'], root: path.dirname(NEW_ENTRY), version: null, commit: null },
    prev: { entry: PREV_ENTRY, args: ['web', '--port', String(okPort), '--no-open'], root: null, version: null, commit: null },
  })
  const okCode = runSwitch(okJob)
  const okStatus = readJson(path.join(okDir, 'switch-status.json'))
  const okRuntime = readJson(path.join(okDir, 'runtime.json'))
  check('切换器退出码 0', okCode === 0, 'code=' + okCode)
  check('状态 phase=ready', okStatus !== null && okStatus.phase === 'ready', JSON.stringify(okStatus))
  check('状态 port 等于目标端口', okStatus !== null && okStatus.port === okPort, 'port=' + String(okStatus?.port))
  check('状态 url 是 token 地址', typeof okStatus?.url === 'string' && okStatus.url.includes('token='), String(okStatus?.url))
  check('newPid 是正整数且存活', Number.isInteger(okStatus?.newPid) && aliveReal(okStatus.newPid), 'newPid=' + String(okStatus?.newPid))
  check('新进程在监听', okStatus !== null && alive(okStatus.newPid) && (await waitPort(okPort, 8000)) === okStatus.newPid)
  check('runtime.active 指向新入口', okRuntime !== null && okRuntime.active !== undefined && okRuntime.active.entry === NEW_ENTRY)
  check('runtime.active.pid 与新进程一致', okRuntime !== null && okRuntime.active?.pid === okStatus?.newPid, JSON.stringify(okRuntime?.active))
  check('runtime.active.port 等于目标端口', okRuntime !== null && okRuntime.active?.port === okPort, JSON.stringify(okRuntime?.active))
  checkActiveEntry('active-entry 指向新入口', okDir, NEW_ENTRY)
  check('裸 / 返回 401', httpCode('http://127.0.0.1:' + okPort + '/') === '401')
  if (okStatus !== null && typeof okStatus.url === 'string') {
    check('token URL 可访问', /^[23]/.test(httpCode(okStatus.url)), httpCode(okStatus.url))
  }
  if (Number.isInteger(okStatus?.newPid)) cleanupPids.push(okStatus.newPid)
  await killAndWait(okStatus === null ? null : okStatus.newPid)

  process.stdout.write('== 回滚路径 ==\n')
  const badPort = await findFreePort()
  const badDir = path.join(BASE, 'rollback')
  mkdirSync(badDir, { recursive: true })
  const broken = path.join(badDir, 'broken-dsh.mjs')
  writeFileSync(broken, 'process.stderr.write("boom: this build is broken\\n"); process.exit(3)\n')
  const old2 = startServer(PREV_ENTRY, badPort, path.join(badDir, 'old.log'))
  cleanupPids.push(old2.pid)
  const listener2 = await waitPort(badPort, 90_000)
  check('旧服务已监听', listener2 !== null, 'pid=' + listener2)
  const badJob = writeJob(badDir, {
    oldPid: old2.pid,
    port: badPort,
    new: { entry: broken, args: ['web', '--port', String(badPort), '--no-open'], root: null, version: 'broken', commit: null },
    prev: { entry: PREV_ENTRY, args: ['web', '--port', String(badPort), '--no-open'], root: null, version: null, commit: null },
  })
  const badCode = runSwitch(badJob)
  const badStatus = readJson(path.join(badDir, 'switch-status.json'))
  const badRuntime = readJson(path.join(badDir, 'runtime.json'))
  check('切换器退出码非 0', badCode !== 0, 'code=' + badCode)
  check('状态标记 rolledBack', badStatus !== null && badStatus.phase === 'ready' && badStatus.rolledBack === true, JSON.stringify(badStatus))
  check('回滚原因写进了 error', typeof badStatus?.error === 'string' && badStatus.error.length > 0, JSON.stringify(badStatus?.error))
  const recovered = await waitPort(badPort, 15_000)
  check('端口恢复监听', recovered !== null, 'listener=' + recovered)
  check('回滚进程存活且就是监听者', badStatus !== null && recovered === badStatus.newPid && aliveReal(badStatus.newPid), 'recovered=' + String(recovered) + ' newPid=' + String(badStatus?.newPid))
  check('回滚后 runtime.active 指回旧入口', badRuntime !== null && badRuntime.active?.entry === PREV_ENTRY, JSON.stringify(badRuntime?.active))
  checkActiveEntry('回滚后 active-entry 指回旧入口', badDir, PREV_ENTRY)
  check('回滚后的服务可访问', httpCode('http://127.0.0.1:' + badPort + '/') === '401')
  if (Number.isInteger(recovered)) cleanupPids.push(recovered)
  await killAndWait(recovered)
} finally {
  for (const pid of cleanupPids) await killAndWait(pid)
  if (!KEEP) rmSync(BASE, { recursive: true, force: true })
  else process.stdout.write(`临时目录保留在 ${BASE}\n`)
}

process.stdout.write(failed === 0 ? '\n== 全部通过 ==\n' : '\n== ' + String(failed) + ' 项失败 ==\n')
process.exit(failed === 0 ? 0 : 1)
