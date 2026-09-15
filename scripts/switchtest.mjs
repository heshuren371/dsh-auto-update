#!/usr/bin/env node
/**
 * scripts/switch.mjs 的沙箱集成测试 —— 不碰 3080 上正在运行的服务。
 *
 *   node scripts/switchtest.mjs [--new <entry>] [--prev <entry>] [--keep]
 *
 * 成功路径：在空闲端口拉起旧入口 → 让切换器把端口换成新入口 → 校验端口仍然可用、
 *            runtime.json 指向新入口、token 地址可访问。
 * 回滚路径：新入口故意做成坏入口 → 切换器必须把旧入口拉回来并标记 rolledBack。
 *
 * 默认新入口 = 当前 dsh 入口（解析 PATH 上的 dsh）。测试进程全部收在独立进程组里，
 * 结束时统一清理；临时目录默认删掉，--keep 保留用于排查。
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
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
function resolveDshEntry() {
  const bin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
  return execFileSync(NODE, ['-e', 'process.stdout.write(require("fs").realpathSync(process.argv[1]))', bin], { encoding: 'utf8' }).trim()
}

const NEW_ENTRY = argValue('--new') ?? process.env.DSH_UPDATE_ENTRY ?? resolveDshEntry()
const PREV_ENTRY = argValue('--prev') ?? NEW_ENTRY
const KEEP = process.argv.includes('--keep')
const BASE = path.join(os.tmpdir(), 'dsh-switchtest-' + String(process.pid))

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

process.stdout.write(`new entry : ${NEW_ENTRY}\nprev entry: ${PREV_ENTRY}\n`)
rmSync(BASE, { recursive: true, force: true })

try {
  process.stdout.write('== 成功路径 ==\n')
  const okPort = await findFreePort()
  const okDir = path.join(BASE, 'ok')
  mkdirSync(okDir, { recursive: true })
  const old = startServer(PREV_ENTRY, okPort, path.join(okDir, 'old.log'))
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
  check('新进程在监听', okStatus !== null && alive(okStatus.newPid) && (await waitPort(okPort, 8000)) === okStatus.newPid)
  check('runtime.active 指向新入口', okRuntime !== null && okRuntime.active !== undefined && okRuntime.active.entry === NEW_ENTRY)
  check('裸 / 返回 401', httpCode('http://127.0.0.1:' + okPort + '/') === '401')
  if (okStatus !== null && typeof okStatus.url === 'string') {
    check('token URL 可访问', /^[23]/.test(httpCode(okStatus.url)), httpCode(okStatus.url))
  }
  killGroup(okStatus === null ? null : okStatus.newPid)
  await sleep(800)

  process.stdout.write('== 回滚路径 ==\n')
  const badPort = await findFreePort()
  const badDir = path.join(BASE, 'rollback')
  mkdirSync(badDir, { recursive: true })
  const broken = path.join(badDir, 'broken-dsh.mjs')
  writeFileSync(broken, 'process.stderr.write("boom: this build is broken\\n"); process.exit(3)\n')
  const old2 = startServer(PREV_ENTRY, badPort, path.join(badDir, 'old.log'))
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
  check('切换器退出码非 0', badCode !== 0, 'code=' + badCode)
  check('状态标记 rolledBack', badStatus !== null && badStatus.phase === 'ready' && badStatus.rolledBack === true, JSON.stringify(badStatus))
  const recovered = await waitPort(badPort, 15_000)
  check('端口恢复监听', recovered !== null, 'listener=' + recovered)
  check('回滚后的服务可访问', httpCode('http://127.0.0.1:' + badPort + '/') === '401')
  killGroup(recovered)
  await sleep(800)
} finally {
  if (!KEEP) rmSync(BASE, { recursive: true, force: true })
  else process.stdout.write(`临时目录保留在 ${BASE}\n`)
}

process.stdout.write(failed === 0 ? '\n== 全部通过 ==\n' : '\n== ' + String(failed) + ' 项失败 ==\n')
process.exit(failed === 0 ? 0 : 1)
