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
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canaryBoot } from '../lib/probe.js'
import {
  checkDesktopUpdate,
  desktopVersionAllowed,
  feedFileName,
  normalizeDesktopChannel,
  parseFeedVersion,
  readAppUpdateConfig,
  readAppVersion,
} from '../lib/desktop.js'
import {
  findFreePort,
  hostFacts,
  httpStatus,
  isArchivedEntry,
  normalizeWebArgs,
  parseLoaderConflicts,
  parsePort,
  quarantinePatchText,
  restartArgsFrom,
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

// -- restartArgsFrom：Desktop（Electron）宿主的 argv 不能当 launcher 参数用
const APPBUNDLE = '/Applications/DeepSeek Harness.app/Contents/Resources'
equal('restartArgsFrom 常规 dsh web 原样保留', restartArgsFrom(['node', '/s/dsh/apps/cli/lib/bin.js', 'web', '--port', '3080']), ['web', '--port', '3080'])
equal('restartArgsFrom Desktop 宿主退回 web', restartArgsFrom([
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  `${APPBUNDLE}/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`,
  `${APPBUNDLE}/app.asar/dsh`,
  '/Users/heshuren/.dsh/profiles/desktop',
  `${APPBUNDLE}/runtime/primary-runtime`,
]), ['web'])
equal('restartArgsFrom 非数组退回 web', restartArgsFrom(null), ['web'])

// -- hostFacts：Desktop（Electron）托管的进程不能原地换运行时
const desktopArgv = [
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  `${APPBUNDLE}/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`,
  `${APPBUNDLE}/app.asar/dsh`,
  '/Users/heshuren/.dsh/profiles/desktop',
]
equal('hostFacts 普通 node CLI 可自我更新', hostFacts({ argv: ['node', '/s/dsh/apps/cli/lib/bin.js', 'web'], versions: {} }), {
  kind: 'node', desktop: false, electron: false, archived: false, entry: '/s/dsh/apps/cli/lib/bin.js', canSelfUpdate: true,
})
const desktopHost = hostFacts({ argv: desktopArgv, versions: { electron: '39.0.0' } })
equal('hostFacts 桌面版 Host 判定为 desktop', [desktopHost.kind, desktopHost.desktop, desktopHost.canSelfUpdate], ['desktop', true, false])
equal('hostFacts 只看 Electron 也拒绝', hostFacts({ argv: ['/x/electron', '/s/bin.js'], versions: { electron: '1' } }).canSelfUpdate, false)
equal('hostFacts 入口在 asar 里也拒绝', hostFacts({ argv: ['/x/node', `${APPBUNDLE}/app.asar/dsh/apps/cli/lib/bin.js`], versions: {} }).canSelfUpdate, false)
check('isArchivedEntry 只认 .asar 路径', isArchivedEntry(`${APPBUNDLE}/app.asar/dsh/x.js`) === true
  && isArchivedEntry('/s/slots/abc/apps/cli/lib/bin.js') === false && isArchivedEntry(null) === false)

// -- restart-web.sh：active-entry 是 app.asar 入口时不能交给普通 node
if (process.platform !== 'win32') {
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-check-'))
  try {
    const binDir = path.join(sandbox, 'bin')
    mkdirSync(binDir)
    writeFileSync(path.join(binDir, 'dsh'), '#!/usr/bin/env node\nprocess.stdout.write("0.0.0-test\\n")\n', { mode: 0o755 })
    const stateDir = path.join(sandbox, 'dsh-auto-update')
    mkdirSync(stateDir)
    writeFileSync(path.join(stateDir, 'active-entry'), `${APPBUNDLE}/app.asar/dsh/apps/cli/lib/bin.js\n`)
    const run = spawnSync('sh', [path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'restart-web.sh'), '--check'], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: sandbox,
        DSH_HOME: path.join(sandbox, '.dsh'),
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        NODE_BIN: process.execPath,
      },
    })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    check('restart-web.sh 跳过 app.asar 入口', run.status === 0 && output.includes('预检通过') && !output.includes('app.asar'), output.trim().slice(-300))
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

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

// index.js 在导入时冻结 STATE_DIR / SLOTS_DIR，所以加载它之前必须先把状态目录隔离到
// 临时位置，否则后面的 --pipeline 会写到真实状态目录（曾经真的写进去过）。
const implicitStateDir = process.env.DSH_UPDATE_STATE === undefined || process.env.DSH_UPDATE_STATE.length === 0
const isolatedStateDir = implicitStateDir
  ? mkdtempSync(path.join(os.tmpdir(), 'dsh-update-state-'))
  : process.env.DSH_UPDATE_STATE
process.env.DSH_UPDATE_STATE = isolatedStateDir
// 自检绝不能触发真实重启：关掉自动重启与后台预构建（否则 --pipeline 会去切 3080）。
process.env.DSH_UPDATE_AUTO_RESTART = '0'
process.env.DSH_UPDATE_AUTO_CHECK = '0'

// -- 失败分类与 agent 修复提示词（v0.4：失败要能直接交给模型/agent）
const { __testing } = await import('../lib/index.js')
equal(
  'MISSING_EXPORT 归为 stale-build-artifacts',
  __testing.classifyFailure('ERROR Error: Build failed with 1 error: [MISSING_EXPORT] "SettingsProvider" is not exported').kind,
  'stale-build-artifacts',
)
equal(
  'Cannot find entry 归为 stale-build-artifacts',
  __testing.classifyFailure('[@deepseek-ai/dsh-root] Cannot find entry: ["lib/types/{index,invariant,startup}.js"]').kind,
  'stale-build-artifacts',
)
equal('SSL 失败归为 network', __testing.classifyFailure('fatal: unable to access: LibreSSL SSL_connect: SSL_ERROR_SYSCALL').kind, 'network')
equal('Xcode 许可归为 toolchain', __testing.classifyFailure('You have not agreed to the Xcode license agreements').kind, 'toolchain')
equal('loader entry 归为 plugin-conflict', __testing.classifyFailure('failed to apply loader entry music-player (@local/dsh-music-player): x').kind, 'plugin-conflict')
equal('未分类文本归为 unknown', __testing.classifyFailure('something completely different').kind, 'unknown')
const agentPrompt = __testing.buildAgentPrompt({
  kind: 'network', hint: '检查网络', step: 'fetch', error: 'fetch 失败', repo: '/repo', slot: '/slot',
  target: { ref: 'origin/master', sha: 'abc123', version: '1.0.0', channel: 'master' },
  running: { version: '0.9.0', root: '/active' },
  env: { node: 'v24.0.0', platform: 'darwin', arch: 'arm64', git: '/usr/bin/git' },
  reproduce: ['cd /slot', 'pnpm install', 'pnpm run build'],
  logTail: ['line-1', 'line-2'], logPath: '/logs/latest.log',
})
check('agentPrompt 含复现命令与目标信息', agentPrompt.includes('cd /slot') && agentPrompt.includes('origin/master') && agentPrompt.includes('abc123'))
check('agentPrompt 含安全约束', agentPrompt.includes('不要重启') && agentPrompt.includes('3080'))
check('agentPrompt 含日志尾部', agentPrompt.includes('line-2') && agentPrompt.includes('/logs/latest.log'))

// -- git 代理：代理没开时 fetch 改直连重试
const proxyConfig = 'http.proxy http://127.0.0.1:7897\nhttps.proxy http://127.0.0.1:7897'
equal('代理键解析', __testing.proxyKeys(proxyConfig), ['http.proxy', 'https.proxy'])
equal('代理键去重', __testing.proxyKeys('http.proxy a\nhttp.proxy b'), ['http.proxy'])
equal('无代理时不给覆盖参数', __testing.proxyBypassArgs(''), [])
equal('代理覆盖为空值', __testing.proxyBypassArgs(proxyConfig), ['-c', 'http.proxy=', '-c', 'https.proxy='])
equal(
  'URL 作用域代理也覆盖',
  __testing.proxyBypassArgs('http.https://github.com.proxy http://127.0.0.1:7897'),
  ['-c', 'http.https://github.com.proxy='],
)
equal('日志里的代理地址', __testing.proxyAddress(proxyConfig), 'http://127.0.0.1:7897')
equal(
  '回环代理连不上算代理故障',
  __testing.isProxyFailure("fatal: unable to access 'https://github.com/x': Failed to connect to 127.0.0.1 port 7897 after 0 ms: Couldn't connect to server", proxyConfig),
  true,
)
equal(
  '对端连不上不算代理故障',
  __testing.isProxyFailure("Failed to connect to github.com port 443 after 75001 ms: Couldn't connect to server", proxyConfig),
  false,
)
equal('代理解析失败算代理故障', __testing.isProxyFailure('fatal: unable to access: Could not resolve proxy: fake.proxy', ''), true)
equal('SSL 错误不归代理', __testing.isProxyFailure('LibreSSL SSL_connect: SSL_ERROR_SYSCALL', proxyConfig), false)
equal('非回环非代理地址不重试', __testing.isProxyFailure('Failed to connect to 10.0.0.5 port 3128', proxyConfig), false)

// -- semver 与通道（对齐官方 Desktop updater：valid() + semver.gt 才认为有更新）
const sv = await import('../lib/semver.js')
equal('semver 合法性', [
  sv.isValidVersion('0.2.0-rc.1'), sv.isValidVersion('1.2.3+build'), sv.isValidVersion('v1.2.3'), sv.isValidVersion('abc'),
], [true, true, false, false])
equal('semver 0.2.0-rc.1 > 0.1.7-rc.2', sv.compareVersions('0.2.0-rc.1', '0.1.7-rc.2'), 1)
equal('semver rc 数字按数值比较', sv.compareVersions('0.1.7-rc.10', '0.1.7-rc.2'), 1)
equal('semver 正式版大于预发布', sv.compareVersions('1.0.0', '1.0.0-rc.1'), 1)
equal('semver 字母序', sv.compareVersions('1.0.0-alpha.1', '1.0.0-beta.1'), -1)
equal('semver 相等', sv.compareVersions('0.2.0-rc.1', '0.2.0-rc.1'), 0)
check('非法版本的 gt 判定为 false', sv.isGreaterVersion('x', '1.0.0') === false)

const previousChannel = process.env.DSH_UPDATE_CHANNEL
const channelCases = [
  [undefined, 'nightly'], ['master', 'nightly'], ['nightly', 'nightly'], ['', 'nightly'],
  ['tag', 'tag'], ['rc', 'rc'], ['alpha', 'alpha'], ['stable', 'stable'], ['RELEASE', 'stable'], ['bogus', 'nightly'],
]
const channelResults = []
for (const [value] of channelCases) {
  if (value === undefined) delete process.env.DSH_UPDATE_CHANNEL
  else process.env.DSH_UPDATE_CHANNEL = value
  channelResults.push(__testing.updateChannel())
}
equal('通道别名归一', channelResults, channelCases.map(([, expected]) => expected))

// -- 后台预构建轮询配置（对齐官方 update-schedule 的区间校验）
const autoDefaults = __testing.resolveAutoCheckConfig({})
equal('预构建默认 30 分钟 / 20% 抖动', [autoDefaults.intervalMs, autoDefaults.jitter], [1_800_000, 0.2])
check('预构建间隔下界被拒', (() => {
  try { __testing.resolveAutoCheckConfig({ DSH_UPDATE_AUTO_CHECK_INTERVAL_MS: '59999' }); return false } catch { return true }
})())
check('预构建抖动越界被拒', (() => {
  try { __testing.resolveAutoCheckConfig({ DSH_UPDATE_AUTO_CHECK_JITTER: '2' }); return false } catch { return true }
})())
check('预构建自定义值生效', (() => {
  const config = __testing.resolveAutoCheckConfig({ DSH_UPDATE_AUTO_CHECK_INTERVAL_MS: '600000', DSH_UPDATE_AUTO_CHECK_JITTER: '0' })
  return config.intervalMs === 600_000 && config.jitter === 0
})())
if (previousChannel === undefined) delete process.env.DSH_UPDATE_CHANNEL
else process.env.DSH_UPDATE_CHANNEL = previousChannel

// -- 更新内容与可切换判定
const changeLine = __testing.parseChangeLine(
  'a1a43cbb4e\u001ftest(web): restore access mode\u001f2026-10-09T16:07:04+08:00\u001fTurtle',
)
equal('解析变更行', [changeLine.short, changeLine.subject, changeLine.author], ['a1a43cbb4e', 'test(web): restore access mode', 'Turtle'])
equal('空变更行返回 null', __testing.parseChangeLine(''), null)
equal('提交类型统计', __testing.summarizeCommitTypes(['feat: a', 'fix(x): b', 'docs: c', 'plain subject']), {
  feat: 1, fix: 1, docs: 1, other: 1,
})
// 候选就绪但当前入口就是 active 时，早期实现判定为不可切换，把「重启生效」按钮藏掉了。
equal('候选可切换：当前入口是 active 也要给按钮', __testing.computeCanSwitch({
  canaryOk: true, candidateEntry: '/s/new/bin.js', currentEntry: '/s/old/bin.js', entryExists: true,
}), true)
equal('候选可切换：候选就是当前入口时为 false', __testing.computeCanSwitch({
  canaryOk: true, candidateEntry: '/s/new/bin.js', currentEntry: '/s/new/bin.js', entryExists: true,
}), false)
equal('候选可切换：未通过试运行 / 入口不存在时为 false', [
  __testing.computeCanSwitch({ canaryOk: false, candidateEntry: '/s/new/bin.js', currentEntry: '/s/old/bin.js', entryExists: true }),
  __testing.computeCanSwitch({ canaryOk: true, candidateEntry: '/s/new/bin.js', currentEntry: '/s/old/bin.js', entryExists: false }),
], [false, false])
check('空入口判等返回 false', __testing.isSameEntry(null, '/x') === false && __testing.isSameEntry('/x', undefined) === false)
equal('通道归一：别名/大小写/非法值', [
  __testing.normalizeChannel('alpha'), __testing.normalizeChannel(' NIGHTLY '), __testing.normalizeChannel('release'),
  __testing.normalizeChannel('bogus'), __testing.normalizeChannel(''), __testing.normalizeChannel(null), __testing.normalizeChannel(42),
], ['alpha', 'nightly', 'stable', null, null, null, null])
equal('标签归属发布线', [
  __testing.channelOfTag('dsh-v0.2.1-alpha.3'), __testing.channelOfTag('dsh-v0.2.0-rc.2'),
  __testing.channelOfTag('dsh-v0.2.0'), __testing.channelOfTag('dsh-v0.2.1'), __testing.channelOfTag('x'), __testing.channelOfTag(null),
], ['alpha', 'rc', 'stable', 'stable', 'tag', null])
// 「别处有更新」的目标：只有另一条发布线的标签严格更新才算，分支领先不算。
equal('别处目标：标签严格更新走标签线', __testing.elsewhereTarget({
  newestTag: 'dsh-v0.2.1-alpha.4', newestVersion: '0.2.1-alpha.4', runningVersion: '0.2.1-alpha.3',
  upstream: 'origin/master', upstreamAhead: 3,
}), {
  newestTag: 'dsh-v0.2.1-alpha.4', newestVersion: '0.2.1-alpha.4', upstream: 'origin/master', upstreamAhead: 3, channel: 'alpha',
})
equal('别处目标：标签等于运行版本时不给目标（只有 master 领先）', __testing.elsewhereTarget({
  newestTag: 'dsh-v0.2.1-alpha.3', newestVersion: '0.2.1-alpha.3', runningVersion: '0.2.1-alpha.3',
  upstream: 'origin/master', upstreamAhead: 10,
}), null)
equal('别处目标：标签比运行版本旧时为 null', __testing.elsewhereTarget({
  newestTag: 'dsh-v0.2.0-rc.2', newestVersion: '0.2.0-rc.2', runningVersion: '0.2.1-alpha.3',
  upstream: 'origin/master', upstreamAhead: 0,
}), null)
equal('别处目标：没有标签、只有分支领先时为 null', __testing.elsewhereTarget({
  newestTag: null, newestVersion: null, runningVersion: '0.2.1-alpha.3', upstream: 'origin/master', upstreamAhead: 4,
}), null)

// -- 空闲端口
const port = await findFreePort()
check('findFreePort 返回合法端口', Number.isInteger(port) && port > 0 && port < 65536, String(port))
const status = await httpStatus('http://127.0.0.1:1/', { timeoutMs: 800 })
check('httpStatus 失败返回 null', status === null || typeof status === 'number')

// -- 桌面版：只接受 rc/正式版，feed 检查不依赖更新器
equal('桌面版版本策略：正式版与 rc 允许', ['0.2.2', '0.2.2-rc.3', '0.3.0'].map(desktopVersionAllowed), [true, true, true])
equal('桌面版版本策略：alpha/beta 与非法值拒绝', ['0.2.3-alpha.1', '0.2.3-beta.2', 'abc', ''].map(desktopVersionAllowed), [false, false, false, false])
equal('feed 版本行解析', [
  parseFeedVersion('version: 0.2.2-rc.2\nfiles: []'),
  parseFeedVersion("version: '0.3.0-rc.1'"),
  parseFeedVersion('files:\n  - url: x'),
], ['0.2.2-rc.2', '0.3.0-rc.1', null])
equal('桌面版通道只认 nightly/stable', ['nightly', 'stable', 'alpha', '', null].map(normalizeDesktopChannel), ['nightly', 'stable', null, null, null])
equal('feed 文件名按平台与架构', [
  feedFileName('nightly', 'darwin'), feedFileName('stable', 'win32'),
  feedFileName('nightly', 'linux', 'x64'), feedFileName('nightly', 'linux', 'arm64'),
], ['nightly-mac.yml', 'stable.yml', 'nightly-linux.yml', 'nightly-linux-arm64.yml'])

const appDir = mkdtempSync(path.join(os.tmpdir(), 'dsau-app-'))
try {
  writeFileSync(path.join(appDir, 'app-update.yml'), 'provider: generic\nurl: https://example.test/feeds/mac-arm64/\nchannel: nightly\n')
  mkdirSync(path.join(appDir, 'app.asar'))
  writeFileSync(path.join(appDir, 'app.asar', 'package.json'), JSON.stringify({ version: '0.2.2-rc.2' }))
  const config = readAppUpdateConfig({ resourcesPath: appDir, execPath: '/nonexistent/node' })
  equal('app-update.yml 解析', [config?.url, config?.channel], ['https://example.test/feeds/mac-arm64/', 'nightly'])
  equal('应用版本从 app.asar 读取', readAppVersion({ env: {}, resourcesPath: appDir }), '0.2.2-rc.2')
  equal('应用版本优先环境变量', readAppVersion({ env: { DSH_CLIENT_VERSION: '9.9.9' }, resourcesPath: appDir }), '9.9.9')

  const fakeFeed = (version) => async (url) => {
    check('桌面版 feed URL 拼装', url === 'https://example.test/feeds/mac-arm64/nightly-mac.yml', url)
    return { ok: true, status: 200, text: async () => `version: ${version}\n` }
  }
  const rc = await checkDesktopUpdate({ installedVersion: '0.2.2-rc.2', resourcesPath: appDir, execPath: '/nonexistent/node', fetchImpl: fakeFeed('0.2.3-rc.1') })
  equal('桌面版 feed：rc 有新版且允许', [rc.ok, rc.newer, rc.allowed, rc.feedVersion], [true, true, true, '0.2.3-rc.1'])
  const alpha = await checkDesktopUpdate({ installedVersion: '0.2.2-rc.2', resourcesPath: appDir, execPath: '/nonexistent/node', fetchImpl: fakeFeed('0.2.3-alpha.1') })
  equal('桌面版 feed：alpha 有新版但拒绝', [alpha.ok, alpha.newer, alpha.allowed], [true, true, false])
  const same = await checkDesktopUpdate({ installedVersion: '0.2.3-rc.1', resourcesPath: appDir, execPath: '/nonexistent/node', fetchImpl: fakeFeed('0.2.3-rc.1') })
  equal('桌面版 feed：同版本不算更新', [same.ok, same.newer, same.allowed], [true, false, true])
  const missing = await checkDesktopUpdate({ installedVersion: '0.2.2-rc.2', resourcesPath: appDir, execPath: '/nonexistent/node', fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }) })
  check('桌面版 feed：HTTP 失败带原因', missing.ok === false && /404/.test(missing.error ?? ''), missing.error)
  const broken = await checkDesktopUpdate({ installedVersion: '0.2.2-rc.2', resourcesPath: appDir, execPath: '/nonexistent/node', fetchImpl: async () => { throw new Error('timeout') } })
  check('桌面版 feed：网络失败带原因', broken.ok === false && /timeout/.test(broken.error ?? ''), broken.error)
  let stableUrl = null
  const stable = await checkDesktopUpdate({
    installedVersion: '0.2.2',
    channel: 'stable',
    resourcesPath: appDir,
    execPath: '/nonexistent/node',
    fetchImpl: async (url) => { stableUrl = url; return { ok: true, status: 200, text: async () => 'version: 0.3.0\n' } },
  })
  check('桌面版通道覆盖默认 feed', stableUrl === 'https://example.test/feeds/mac-arm64/stable-mac.yml', String(stableUrl))
  equal('桌面版 stable 通道判定', [stable.ok, stable.channel, stable.feedVersion, stable.newer, stable.allowed], [true, 'stable', '0.3.0', true, true])
  const noConfig = await checkDesktopUpdate({ installedVersion: '0.2.2-rc.2', resourcesPath: path.join(appDir, 'missing'), execPath: '/nonexistent/node' })
  check('桌面版 feed：没有配置时不驱动更新', noConfig.ok === false && /app-update\.yml/.test(noConfig.error ?? ''), noConfig.error)
} finally {
  rmSync(appDir, { recursive: true, force: true })
}

// -- 宿主判定接线：桌面版拒绝更新与重启，普通 node 不受影响
{
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'dsh-host-'))
  try {
    const indexUrl = new URL('../lib/index.js', import.meta.url).href
    const hostScript = `
      const mod = await import(process.env.DSAU_INDEX)
      let handler = null
      const ctx = {
        effect(fn) { const dispose = fn(); return () => {} },
        webServer: { register(spec) { handler = spec.handler; return () => {} } },
        connection: { requestRejection() { return undefined } },
      }
      process.argv = [process.execPath, process.env.DSAU_ENTRY, ...JSON.parse(process.env.DSAU_ARGS ?? '[]')]
      mod.apply(ctx)
      const invoke = (method, url) => new Promise((resolve) => {
        const res = {
          statusCode: 0,
          writeHead(code) { this.statusCode = code },
          end(body) { resolve({ status: this.statusCode, body: String(body ?? '') }) },
        }
        Promise.resolve(handler({ method, url, headers: { 'x-dsh-updater': '1', 'content-type': 'application/json' } }, res))
      })
      const state = JSON.parse((await invoke('GET', '/dsh-updater/api/state')).body)
      if (process.env.DSAU_UPDATE === '0') {
        process.stdout.write(JSON.stringify({ environment: state.environment, phase: state.phase }))
      } else {
        const update = JSON.parse((await invoke('POST', '/dsh-updater/api/update')).body)
        const restart = JSON.parse((await invoke('POST', '/dsh-updater/api/restart')).body)
        const desktop = JSON.parse((await invoke('POST', '/dsh-updater/api/desktop-update')).body)
        process.stdout.write(JSON.stringify({ environment: state.environment, phase: state.phase, update, restart, desktop }))
      }
    `
    const runHost = (entry, argv, update = true) => {
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', hostScript], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          DSAU_INDEX: indexUrl,
          DSAU_ENTRY: entry,
          DSAU_ARGS: JSON.stringify(argv),
          DSH_UPDATE_STATE: sandbox,
          DSH_UPDATE_REPO: sandbox,
          DSH_UPDATE_AUTO_CHECK: '0',
          DSH_UPDATE_AUTO_RESTART: '0',
          DSAU_UPDATE: update ? '1' : '0',
        },
      })
      try { return JSON.parse(run.stdout ?? '') } catch { return null }
    }

    const desktop = runHost(
      `${APPBUNDLE}/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`,
      [`${APPBUNDLE}/app.asar/dsh`, '/Users/x/.dsh/profiles/desktop'],
    )
    check('桌面版宿主：接口返回可解析', desktop !== null)
    if (desktop !== null) {
      equal('桌面版宿主：environment 标记不可自我更新', [desktop.environment.desktop, desktop.environment.canSelfUpdate], [true, false])
      check('桌面版宿主：/api/update 被拒绝', desktop.update.ok === false && /桌面版/.test(desktop.update.error ?? ''), desktop.update.error)
      check('桌面版宿主：/api/restart 被拒绝', desktop.restart.ok === false && /桌面版/.test(desktop.restart.error ?? ''), desktop.restart.error)
      const desktopCheck = desktop.desktop !== null && typeof desktop.desktop === 'object'
        ? desktop.desktop.desktop : null
      check('桌面版宿主：/api/desktop-update 读不到配置时给出原因',
        desktopCheck !== null && desktopCheck.ok === false
          && /app-update\.yml/.test(desktopCheck.error ?? ''), JSON.stringify(desktopCheck ?? null))
      equal('桌面版宿主：拒绝后仍处于闲置态', desktop.phase, 'idle')
    }

    // 对照组：普通 node 跑 CLI 时不能被这道闸门误伤（只读状态，避免真的去构建主仓库）。
    const cli = runHost(fileURLToPath(new URL('./selftest.mjs', import.meta.url)), ['web'], false)
    check('普通 node：接口返回可解析', cli !== null)
    if (cli !== null) {
      equal('普通 node：environment 允许自我更新', [cli.environment.desktop, cli.environment.canSelfUpdate], [false, true])
      equal('普通 node：没有拒绝理由', cli.environment.reason, null)
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}

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
  // 复用上面已经隔离好的状态目录（index.js 已按它冻结路径）。
  const stateDir = process.env.DSH_UPDATE_STATE
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
    // v0.4 起副本目录名是 <sha7>-<时间戳>，逐个摘掉注册再删状态目录。
    const slotsDir = path.join(stateDir, 'slots')
    if (existsSync(slotsDir)) {
      for (const name of readdirSync(slotsDir)) {
        const slot = path.join(slotsDir, name)
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
// 非 --pipeline 路径也要清掉临时状态目录（--pipeline 已清过，force 幂等）。
if (implicitStateDir && !process.argv.includes('--keep')) {
  rmSync(isolatedStateDir, { recursive: true, force: true })
}
process.exit(failed === 0 ? 0 : 1)
