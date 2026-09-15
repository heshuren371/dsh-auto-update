#!/usr/bin/env node
/**
 * dsh-auto-update 自检。
 *
 *   node scripts/selftest.mjs              只跑纯函数单测（不起进程、不碰 profile）
 *   node scripts/selftest.mjs --integration [entry]
 *                                          额外做一次真实试运行：在空闲端口上按
 *                                          当前 profile 启动 dsh web 并做 HTTP 校验，
 *                                          然后收掉。默认入口取 DSH_UPDATE_ENTRY，
 *                                          否则用 dsh --version 的解析结果。
 *
 * 集成测试会真实加载一次当前 profile（含已装插件），属于“可接受的副作用”，
 * 但绝不接触 3080 上的正在运行的服务。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canaryBoot } from '../lib/probe.js'
import {
  findFreePort,
  httpStatus,
  parseLoaderConflicts,
  parsePort,
  quarantinePatchText,
  stripPortArgs,
  withCanaryArgs,
  withQuarantineArg,
} from '../lib/probe.js'
import { makeLinePump, readJson, sh, writeJsonAtomic } from '../lib/util.js'

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) { passed += 1; process.stdout.write(`  ok   ${label}\n`) }
  else { failed += 1; process.stdout.write(`  FAIL ${label}${detail === undefined ? '' : ' — ' + detail}\n`) }
}
function equal(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(label, a === e, `got ${a}, want ${e}`)
}

process.stdout.write('== 纯函数 ==\n')

// -- sh() 转义
equal('sh 单引号转义', sh("a'b"), "'a'\\''b'")
equal('sh 普通路径', sh('/a b/c'), "'/a b/c'")

// -- 端口解析 / 参数改写
equal('parsePort 默认', parsePort(['web'], 3080), 3080)
equal('parsePort 空格形式', parsePort(['web', '--port', '9000'], 3080), 9000)
equal('parsePort 等号形式', parsePort(['web', '--port=9001'], 3080), 9001)
equal('stripPortArgs', stripPortArgs(['web', '--port', '9000', '--host', 'x']), ['web', '--host', 'x'])
equal('withCanaryArgs', withCanaryArgs(['web', '--port=9000'], 1234), ['web', '--port', '1234', '--no-open'])
equal('withQuarantineArg 把 web 规范成 --profile web', withQuarantineArg(['web'], '/q.yml'), ['--patch', '/q.yml', '--profile', 'web'])
equal('withQuarantineArg 保留已有 --profile', withQuarantineArg(['--profile', 'web', '--no-open'], '/q.yml'), ['--patch', '/q.yml', '--profile', 'web', '--no-open'])
equal('withQuarantineArg 无文件', withQuarantineArg(['web'], null), ['web'])

// -- loader 冲突解析（用线上真实报错文本）
const realError = [
  'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):',
  'failed to apply loader entry webserver (@deepseek-ai/dsh-host-webserver): listen EADDRINUSE: address already in use 127.0.0.1:3080',
].join('\n')
equal('真实 EADDRINUSE 文本识别为内核条目', parseLoaderConflicts(realError).map((c) => [c.id, c.core]), [
  ['include', true],
  ['webserver', true],
])
const pluginError = 'failed to apply loader entry music-player (@local/dsh-music-player): boom'
const importError = 'failed to import loader entry bad-plugin-test (this-module-does-not-exist-xyz): Cannot find package'
equal('import 形态也能识别', parseLoaderConflicts(importError).map((c) => [c.id, c.core]), [['bad-plugin-test', false]])
equal('第三方插件条目可隔离', parseLoaderConflicts(pluginError).map((c) => [c.id, c.core]), [['music-player', false]])
equal('无括号包名', parseLoaderConflicts('failed to apply loader entry my-widget: nope').map((c) => [c.id, c.core]), [['my-widget', false]])
equal('重复条目去重', parseLoaderConflicts(pluginError + '\n' + pluginError).length, 1)
equal('恶意 id 不进入隔离名单', parseLoaderConflicts('failed to apply loader entry bad id: x').length, 0)

// -- 隔离 patch 文本
const patch = quarantinePatchText(['music-player', "o'brien"])
check('patch 使用 disabled: true', patch.includes("- id: 'music-player'\n  disabled: true"))
check('patch 拒绝带引号的非法 id', !patch.includes("o'brien"))
check('patch 拒绝非法 id', !quarantinePatchText(['bad id']).includes('bad id'))

// -- 行缓冲
const lines = []
const pump = makeLinePump((line) => lines.push(line), { maxPending: 8 })
pump.push('abc')
pump.push('def\nghi\n')
pump.flush()
equal('makeLinePump 分行', lines, ['abcdef', 'ghi'])
const truncated = []
const pump2 = makeLinePump((line) => truncated.push(line), { maxPending: 4 })
pump2.push('0123456789')
check('makeLinePump 截断超长行', truncated.length === 1 && truncated[0].includes('已截断'))

// -- 原子 JSON 读写
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-selftest-'))
writeJsonAtomic(path.join(tmp, 'x.json'), { a: 1 })
equal('writeJsonAtomic/readJson 往返', readJson(path.join(tmp, 'x.json')), { a: 1 })
rmSync(tmp, { recursive: true, force: true })

// -- 空闲端口
const port = await findFreePort()
check('findFreePort 返回合法端口', Number.isInteger(port) && port > 0 && port < 65536, String(port))
const status = await httpStatus('http://127.0.0.1:1/', { timeoutMs: 800 })
check('httpStatus 失败返回 null', status === null || typeof status === 'number')

process.stdout.write(`\n== 结果：${passed} 通过，${failed} 失败 ==\n`)

if (process.argv.includes('--integration')) {
  process.stdout.write('\n== 集成：真实 profile 试运行 ==\n')
  let entry = process.env.DSH_UPDATE_ENTRY
  if (entry === undefined || entry.length === 0) {
    try {
      const dshBin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
      entry = execFileSync('node', ['-e', 'process.stdout.write(require("fs").realpathSync(process.argv[1]))', dshBin], { encoding: 'utf8' }).trim()
    } catch {
      process.stdout.write('  跳过：找不到 dsh 入口（可用 DSH_UPDATE_ENTRY 指定）\n')
      process.exit(failed === 0 ? 0 : 1)
    }
  }
  process.stdout.write(`  入口：${entry}\n`)
  const result = await canaryBoot({
    entry,
    args: ['web'],
    cwd: os.homedir(),
    timeoutMs: 150_000,
    onLine: (line) => { if (/error|Error|failed|listen/.test(line)) process.stdout.write(`    | ${line}\n`) },
  })
  if (result.ok) {
    process.stdout.write(`  ok   试运行通过：${result.bareUrl}（pid ${result.pid}，已收掉）\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL 试运行失败：${result.error}\n`)
    for (const line of result.output.slice(-12)) process.stdout.write(`    | ${line}\n`)
  }
}

// --pipeline：通过宿主插件的 HTTP 面跑一次真实流水线（副本构建 + 试运行）。
// 默认用临时状态目录，跑完清理；DSH_UPDATE_STATE 已设置时用它，--keep 保留现场。
if (process.argv.includes('--pipeline')) {
  process.stdout.write('\n== 全流水线：副本构建 + 试运行（隔离状态目录）==\n')
  const keep = process.argv.includes('--keep')
  const implicitState = process.env.DSH_UPDATE_STATE === undefined || process.env.DSH_UPDATE_STATE.length === 0
  const stateDir = implicitState
    ? mkdtempSync(path.join(os.tmpdir(), 'dsh-update-state-'))
    : process.env.DSH_UPDATE_STATE
  process.env.DSH_UPDATE_STATE = stateDir
  if (process.env.DSH_UPDATE_REPO === undefined || process.env.DSH_UPDATE_REPO.length === 0) {
    process.env.DSH_UPDATE_REPO = path.join(os.homedir(), 'deepseek-harness')
  }
  process.stdout.write(`  状态目录：${stateDir}\n  仓库：${process.env.DSH_UPDATE_REPO}\n`)

  let handler = null
  const ctx = {
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    webServer: { register(spec) { handler = spec.handler; return () => {} } },
    connection: { requestRejection() { return undefined } },
  }
  // 模拟真实的 `dsh web` 启动：插件用 process.argv 作为试运行/切换参数，
  // 不能把自检脚本自己的 flag（--pipeline）带进去。
  process.argv = [process.argv[0], process.argv[1], 'web']
  const mod = await import('../lib/index.js')
  mod.apply(ctx)
  const invoke = (options) => new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      writeHead(code) { this.statusCode = code },
      end(body) { resolve({ status: this.statusCode, body: String(body ?? '') }) },
    }
    Promise.resolve(handler({ method: options.method, url: options.url, headers: options.headers ?? {} }, res)).catch(reject)
  })
  const guarded = { 'x-dsh-updater': '1', 'content-type': 'application/json' }
  const started = JSON.parse((await invoke({ method: 'POST', url: '/dsh-updater/api/update', headers: guarded })).body)
  if (started.started !== true) {
    failed += 1
    process.stdout.write(`  FAIL 未能启动流水线：${started.error ?? '未知'}\n`)
  } else {
    const deadline = Date.now() + 40 * 60_000
    let runtimeState = null
    let since = 0
    while (Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 2000) })
      const parsed = JSON.parse((await invoke({ method: 'GET', url: `/dsh-updater/api/state?since=${since}` })).body)
      for (const entry of parsed.log ?? []) process.stdout.write(`    | ${entry.line}\n`)
      if (typeof parsed.seq === 'number') since = parsed.seq
      runtimeState = parsed
      if (parsed.phase === 'done' || parsed.phase === 'error' || parsed.phase === 'idle') break
    }
    if (runtimeState !== null && runtimeState.phase === 'done') {
      passed += 1
      process.stdout.write(`  ok   流水线完成，试运行通过；候选版本 ${runtimeState.runtime?.candidate?.version ?? '?'}\n`)
    } else {
      failed += 1
      process.stdout.write(`  FAIL 流水线结束状态：${runtimeState === null ? '超时' : runtimeState.phase}（${runtimeState?.error ?? ''}）\n`)
    }
  }

  if (!keep) {
    for (const name of ['a', 'b']) {
      const slot = path.join(stateDir, 'slots', name)
      if (existsSync(slot)) {
        try { execFileSync('git', ['-C', process.env.DSH_UPDATE_REPO, 'worktree', 'remove', '--force', slot], { stdio: 'ignore' }) } catch { /* 清不掉就 prune */ }
      }
    }
    try { execFileSync('git', ['-C', process.env.DSH_UPDATE_REPO, 'worktree', 'prune'], { stdio: 'ignore' }) } catch { /* 忽略 */ }
    rmSync(stateDir, { recursive: true, force: true })
  } else {
    process.stdout.write(`  现场保留在 ${stateDir}\n`)
  }
}

process.stdout.write(`\n== 最终：${passed} 通过，${failed} 失败 ==\n`)
process.exit(failed === 0 ? 0 : 1)
