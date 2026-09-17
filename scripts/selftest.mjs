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
import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canaryBoot } from '../lib/probe.js'
import {
  findFreePort,
  httpStatus,
  normalizeWebArgs,
  parseLoaderConflicts,
  parsePort,
  quarantinePatchText,
  stripPortArgs,
  tailLines,
  withCanaryArgs,
  withQuarantineArg,
} from '../lib/probe.js'
import { ERROR_LINE_RE, createLineBuffer, isProcessAlive, makeLinePump, readJson, resolveGitBin, sh, writeJsonAtomic } from '../lib/util.js'

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
equal('parsePort 上界 65535', parsePort(['--port=65535'], 3080), 65535)
equal('parsePort 端口 0 合法', parsePort(['--port', '0'], 3080), 0)
equal('parsePort 越界回落', parsePort(['--port', '65536'], 3080), 3080)
equal('parsePort 等号越界回落', parsePort(['--port=70000'], 3080), 3080)
equal('parsePort 负数回落', parsePort(['--port', '-1'], 3080), 3080)
equal('parsePort 非数字回落', parsePort(['--port', 'abc'], 3080), 3080)
equal('parsePort 空值回落', parsePort(['--port='], 3080), 3080)
equal('parsePort 裸 --port 结尾回落', parsePort(['web', '--port'], 3080), 3080)
equal('parsePort 取第一个命中', parsePort(['--port=4000', '--port=5000'], 3080), 4000)
equal('parsePort 自定义 fallback', parsePort([], 9999), 9999)
equal('stripPortArgs', stripPortArgs(['web', '--port', '9000', '--host', 'x']), ['web', '--host', 'x'])
equal('stripPortArgs 剥掉尾部裸 --port', stripPortArgs(['web', '--port']), ['web'])
equal('stripPortArgs 多处端口全剥掉', stripPortArgs(['web', '--port=1', '--port', '2', '--host', 'h']), ['web', '--host', 'h'])
equal('withCanaryArgs', withCanaryArgs(['web', '--port=9000'], 1234), ['web', '--port', '1234', '--no-open'])
equal('withCanaryArgs 保留其余参数', withCanaryArgs(['web', '--port', '9000', '--host', '0.0.0.0'], 1234), ['web', '--host', '0.0.0.0', '--port', '1234', '--no-open'])
equal('withCanaryArgs 无旧端口', withCanaryArgs([], 1234), ['--port', '1234', '--no-open'])
equal('withQuarantineArg 把 web 规范成 --profile web', withQuarantineArg(['web'], '/q.yml'), ['--patch', '/q.yml', '--profile', 'web'])
equal('withQuarantineArg 保留已有 --profile', withQuarantineArg(['--profile', 'web', '--no-open'], '/q.yml'), ['--patch', '/q.yml', '--profile', 'web', '--no-open'])
equal('withQuarantineArg 无文件', withQuarantineArg(['web'], null), ['web'])
equal('withQuarantineArg 空文件名不加 --patch', withQuarantineArg(['web'], ''), ['web'])
equal('withQuarantineArg 保留端口等参数', withQuarantineArg(['web', '--port', '1'], '/q.yml'), ['--patch', '/q.yml', '--profile', 'web', '--port', '1'])

// -- normalizeWebArgs：要加 --patch 时 web 子命令必须改写成等价的 --profile web
equal('normalizeWebArgs 改写 web 子命令', normalizeWebArgs(['web', '--no-open']), ['--profile', 'web', '--no-open'])
equal('normalizeWebArgs 只有 web', normalizeWebArgs(['web']), ['--profile', 'web'])
equal('normalizeWebArgs 已是 --profile 不变', normalizeWebArgs(['--profile', 'web', '--no-open']), ['--profile', 'web', '--no-open'])
equal('normalizeWebArgs 不误伤 webserver', normalizeWebArgs(['webserver']), ['webserver'])
equal('normalizeWebArgs 非数组返回空', normalizeWebArgs(null), [])

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
equal('core 包判定 @deepseek-ai/*', parseLoaderConflicts('failed to apply loader entry my-thing (@deepseek-ai/dsh-host-x): boom').map((c) => [c.id, c.core]), [['my-thing', true]])
equal('core 包判定 cordis:*', parseLoaderConflicts('failed to import loader entry foo (cordis:include): x').map((c) => [c.id, c.core]), [['foo', true]])
equal('core 包判定 dsh-*', parseLoaderConflicts('failed to import loader entry foo (dsh-plugin-x): x').map((c) => [c.id, c.core]), [['foo', true]])
equal('内核条目 id 判定', parseLoaderConflicts('failed to apply loader entry timer: x').map((c) => c.core), [true])
equal('去重保留首次出现顺序', parseLoaderConflicts([pluginError, importError, pluginError].join('\n')).map((c) => c.id), ['music-player', 'bad-plugin-test'])
equal('120 字符 id 在允许边界内', parseLoaderConflicts('failed to apply loader entry ' + 'a'.repeat(120) + ': x').length, 1)
equal('121 字符 id 被拒', parseLoaderConflicts('failed to apply loader entry ' + 'a'.repeat(121) + ': x').length, 0)
equal('带 scope 的合法 id', parseLoaderConflicts('failed to apply loader entry @scope/name-x (pkg): x').map((c) => c.id), ['@scope/name-x'])
equal('空文本返回空', parseLoaderConflicts(''), [])
equal('连续调用互不污染（lastIndex 复位）', [parseLoaderConflicts(pluginError).length, parseLoaderConflicts(pluginError).length], [1, 1])

// -- 隔离 patch 文本
const patch = quarantinePatchText(['music-player', "o'brien"])
check('patch 使用 disabled: true', patch.includes("- id: 'music-player'\n  disabled: true"))
check('patch 拒绝带引号的非法 id', !patch.includes("o'brien"))
check('patch 拒绝非法 id', !quarantinePatchText(['bad id']).includes('bad id'))
const patchEmpty = quarantinePatchText([])
check('patch 空名单只留表头', (patchEmpty.match(/- id: /g) ?? []).length === 0 && patchEmpty.includes('dsh-auto-update'))
const patchScope = quarantinePatchText(['@local/x.y', 'bad id', "o'brien", 'a\nb', 'a'.repeat(121)])
check('patch 接纳 @scope/name 与点号', patchScope.includes("- id: '@local/x.y'\n  disabled: true"))
check('patch 丢弃换行注入的 id', patchScope.includes('a\nb') === false)
check('patch 丢弃超长 id', patchScope.includes('a'.repeat(121)) === false)
check('patch 只保留一个合法 id', (patchScope.match(/- id: /g) ?? []).length === 1 && (patchScope.match(/disabled: true/g) ?? []).length === 1)

// -- 行缓冲
const lines = []
const pump = makeLinePump((line) => lines.push(line), { maxPending: 8 })
pump.push('abc')
pump.push('def\nghi\n')
pump.flush()
equal('makeLinePump 分行', lines, ['abcdef', 'ghi'])
const leftover = []
const pumpTail = makeLinePump((line) => leftover.push(line), { maxPending: 8 })
pumpTail.push('one\ntwo\nthr')
pumpTail.flush()
equal('makeLinePump flush 吐出无换行的残行', leftover, ['one', 'two', 'thr'])
const truncated = []
const pump2 = makeLinePump((line) => truncated.push(line), { maxPending: 4 })
pump2.push('0123456789')
check('makeLinePump 截断超长行', truncated.length === 1 && truncated[0].includes('已截断'))
const truncated2 = []
const pump3 = makeLinePump((line) => truncated2.push(line), { maxPending: 4 })
pump3.push('0123456789')
pump3.push('ok\n')
equal('makeLinePump 截断后仍能继续分行', truncated2, ['0123 …（单行过长，已截断 6 字符）', 'ok'])
const truncated3 = []
const pump4 = makeLinePump((line) => truncated3.push(line))
pump4.push('x'.repeat(20 * 1024))
check('makeLinePump 默认上限 16KB', truncated3.length === 1 && truncated3[0].includes('已截断 4096 字符'), String(truncated3.length))

// -- 有界行缓冲（pnpm/build 能刷几万行，只留关键错误行）
const bounded = createLineBuffer({ maxLines: 3 })
for (const line of ['a', 'b', 'c']) bounded.push(line)
equal('createLineBuffer 未超限全保留', bounded.lines, ['a', 'b', 'c'])
bounded.push('d')
equal('createLineBuffer 溢出淘汰最旧普通行', bounded.lines, ['b', 'c', 'd'])
const bounded2 = createLineBuffer({ maxLines: 3 })
for (const line of ['error: boom', 'noise-1', 'noise-2', 'noise-3']) bounded2.push(line)
equal('createLineBuffer 溢出优先保留错误行', bounded2.lines, ['error: boom', 'noise-2', 'noise-3'])
const bounded3 = createLineBuffer({ maxLines: 2 })
for (const line of ['error: one', 'error: two', 'error: three']) bounded3.push(line)
equal('createLineBuffer 全是关键行时丢最旧', bounded3.lines, ['error: two', 'error: three'])
const bounded4 = createLineBuffer({ maxLines: 2, priorityRe: null })
for (const line of ['error: one', 'noise', 'error: two']) bounded4.push(line)
equal('createLineBuffer 关闭优先级时严格保留末尾', bounded4.lines, ['noise', 'error: two'])
check('ERROR_LINE_RE 认得 fatal/license', ERROR_LINE_RE.test('fatal: not a git repository') && ERROR_LINE_RE.test('You have not agreed to the Xcode license'))

// -- 截尾输出
equal('tailLines 取末尾 N 行', tailLines([1, 2, 3, 4, 5], 2), [4, 5])
equal('tailLines 非数组返回空', tailLines('nope'), [])

// -- git 解析：必须返回一个真能跑 --version 的可执行文件（/usr/bin/git 可能是 Xcode 许可 shim）
const gitBin = resolveGitBin()
check('resolveGitBin 返回存在的文件', gitBin !== 'git' && existsSync(gitBin), gitBin === 'git' ? '未找到可用 git，退回 PATH 上的 git' : gitBin)
let gitRuns = false
try {
  accessSync(gitBin, constants.X_OK)
  gitRuns = spawnSync(gitBin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).status === 0
} catch { /* 不存在 / 不可执行 */ }
check('resolveGitBin --version 退出 0', gitRuns, gitBin)
equal('resolveGitBin 结果被缓存', resolveGitBin(), gitBin)

// -- 进程存活探测（切换器判断旧进程是否退出全靠它）
check('isProcessAlive 当前进程为真', isProcessAlive(process.pid) === true)
check('isProcessAlive 非法 pid 为假', isProcessAlive(0) === false && isProcessAlive(-1) === false && isProcessAlive(null) === false && isProcessAlive('123') === false)

// -- 原子 JSON 读写
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dsh-updater-selftest-'))
writeJsonAtomic(path.join(tmp, 'x.json'), { a: 1 })
equal('writeJsonAtomic/readJson 往返', readJson(path.join(tmp, 'x.json')), { a: 1 })
writeJsonAtomic(path.join(tmp, 'deep/nested.json'), { s: "a'b\n中文", list: [1, null, true] })
equal('writeJsonAtomic 自动建目录且往返', readJson(path.join(tmp, 'deep/nested.json')), { s: "a'b\n中文", list: [1, null, true] })
check('JSON 文件以换行结尾', readFileSync(path.join(tmp, 'x.json'), 'utf8').endsWith('}\n'))
writeJsonAtomic(path.join(tmp, 'mode.json'), { token: 'secret' }, { mode: 0o600 })
check('writeJsonAtomic 支持 mode（runtime.json 含 token，必须 0600）', (statSync(path.join(tmp, 'mode.json')).mode & 0o777) === 0o600)
check('readJson 文件不存在返回 null', readJson(path.join(tmp, 'missing.json')) === null)
const brokenJson = path.join(tmp, 'broken.json')
writeFileSync(brokenJson, '{ not json')
check('readJson 坏 JSON 返回 null', readJson(brokenJson) === null)
writeFileSync(brokenJson, '123')
check('readJson 标量返回 null', readJson(brokenJson) === null)
writeFileSync(brokenJson, 'null')
check('readJson null 返回 null', readJson(brokenJson) === null)
rmSync(tmp, { recursive: true, force: true })

// -- 客户端不能遮蔽模块级 runtime（否则 useEffect 里的 runtime.schedulePolling 会崩）
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const shadowed = /(?:const|let|var)\s+runtime\s*=/.test(
  clientSource.replace('let runtime = null', ''),
)
check('client 不遮蔽模块级 runtime', shadowed === false)

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
