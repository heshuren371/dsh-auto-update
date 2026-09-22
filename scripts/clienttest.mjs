#!/usr/bin/env node
/**
 * dsh-auto-update 客户端渲染回归测试（不需要真实浏览器）。
 *
 * 背景：lib/client.js 只在设置页里跑，过去没有测试。曾出过一次事故：
 * 组件里的局部变量 runtime 遮蔽了模块级运行时对象，点「立即更新」进入 updating 后
 * useEffect 调 runtime.schedulePolling 抛错，界面显示
 * 「界面渲染出错了：runtime.schedulePolling is not a function」。
 *
 * 做法：
 *   1. window.__ModuleLoader__.load 捕获 factory，间接 eval 加载 lib/client.js；
 *   2. React stub：createElement / useState / useEffect / useRef / useCallback / Component。
 *      useState 按调用顺序消费预设值队列（可以把 phase=updating 这类状态直接喂进去），
 *      useEffect 在渲染后按顺序执行一次，useRef 返回稳定对象；
 *   3. ctx stub：effect / slots / locale，locale.bind 带 {占位符} 插值（与宿主行为一致）；
 *   4. 对若干宿主状态各渲染一次并执行 effect，断言不抛错、关键文案与按钮出现；
 *      另有六组特殊用例：点「立即更新」进入 updating 的完整回归、
 *      迟到的 /state 响应不得覆盖 POST 状态的竞态、错误边界兜底、
 *      复制诊断报告（agentPrompt 与整包 JSON 退化）、
 *      剪贴板被拒时退回 execCommand、让 dsh 帮忙修复的两次确认。
 *
 * 全程不联网、不起进程、不碰 ~/.dsh 状态目录（也不读它）。
 * 用法：node scripts/clienttest.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/* ---------- 断言与报告 ---------- */

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) {
    passed += 1
    process.stdout.write(`  ok   ${label}\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL ${label}${detail === undefined || detail === '' ? '' : ' — ' + detail}\n`)
  }
}
function preview(value) {
  const flat = String(value).replace(/\s+/g, ' ').trim()
  return flat.length > 260 ? flat.slice(0, 260) + '…' : flat
}
function expectText(text, needle) {
  check(`出现「${needle}」`, typeof text === 'string' && text.includes(needle), preview(text))
}
function expectAbsent(text, needle) {
  check(`不出现「${needle}」`, typeof text === 'string' && !text.includes(needle), preview(text))
}
function formatError(error) {
  if (error instanceof Error) return error.name + ': ' + error.message
  return String(error)
}

// Promise 里的异常不能被吞掉：记下来，最后统一判失败。
const rejections = []
process.on('unhandledRejection', (error) => { rejections.push(error) })

/* ---------- 浏览器环境 stub ---------- */

const styleTags = []
// createElement 既服务 runtime.mountStyles 的 <style>，也服务剪贴板兜底的 <textarea>；
// createdElements 记录所有创建过的元素，用来断言 execCommand 兜底拿到了哪段文本。
const createdElements = []
globalThis.document = {
  createElement: (tagName) => {
    const element = {
      tagName,
      dataset: {},
      style: {},
      textContent: '',
      value: '',
      setAttribute() {},
      select() {},
      remove() {},
    }
    createdElements.push(element)
    return element
  },
  head: { appendChild: (tag) => { styleTags.push(tag) } },
  body: { appendChild: () => {}, removeChild: () => {} },
  execCommand: () => false,
}

// Node 24 的 navigator 是不可直接赋值的全局属性，用 defineProperty 换成可控 stub；
// clipboard.ok=false 模拟权限被拒，用来验证 execCommand 兜底路径。
const clipboard = { text: null, ok: true }
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: {
      writeText: async (text) => {
        if (clipboard.ok !== true) throw new Error('clipboard denied')
        clipboard.text = text
      },
    },
  },
})
// 用假定时器：既避免进程被真实 interval 拖住，也能确认轮询真的被调度了。
// lastTick 保存最后一次轮询回调，竞态用例用它手动触发一次真实轮询。
const timers = { scheduled: 0, cleared: 0, lastTick: null }
globalThis.setInterval = (tick) => { timers.scheduled += 1; timers.lastTick = tick; return timers.scheduled }
globalThis.clearInterval = () => { timers.cleared += 1 }

/* ---------- 加载 lib/client.js ---------- */

let spec = null
globalThis.window = { __ModuleLoader__: { load: (value) => { spec = value } } }
// 间接 eval：让源码在全局作用域里跑，看到 window / document。
const loadScript = eval
loadScript(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8'))
if (spec === null || typeof spec.factory !== 'function') {
  process.stdout.write('  FAIL lib/client.js 没有调用 window.__ModuleLoader__.load\n')
  process.exit(1)
}

/* ---------- React stub + 极简渲染器 ---------- */
// world 是「一次场景」的全部状态：组件实例（hooks 值/ref/effect）、按钮、边界标记。

let world = null

class ComponentStub {
  constructor(props) { this.props = props ?? {}; this.state = {} }
  setState(next) {
    const patch = typeof next === 'function' ? next(this.state) : next
    this.state = Object.assign({}, this.state, patch ?? {})
  }
}

const React = {
  createElement(type, props, ...children) {
    const merged = Object.assign({}, props ?? {})
    merged.children = children.length === 0 ? undefined : (children.length === 1 ? children[0] : children)
    return { type, props: merged }
  },
  // 依赖数组在测试里不做 diff，返回原函数即可。
  useCallback: (fn) => fn,
  useEffect(fn) { world.active.effects.push(fn) },
  useRef(initial) {
    const inst = world.active
    const index = inst.hookIndex++
    if (!(index in inst.refs)) inst.refs[index] = { current: initial }
    return inst.refs[index]
  },
  useState(initial) {
    const inst = world.active
    const index = inst.hookIndex++
    // 预设值队列按 useState 调用顺序消费；只有首次渲染才取预设，
    // 之后由 setter 维护，便于「先渲染 idle 再点按钮」的多轮用例。
    if (inst.filled[index] !== true) {
      inst.filled[index] = true
      inst.values[index] = inst.queue.length > 0
        ? inst.queue.shift()
        : (typeof initial === 'function' ? initial() : initial)
    }
    const set = (next) => {
      inst.values[index] = typeof next === 'function' ? next(inst.values[index]) : next
      inst.updates.push(index)
      inst.history.push({ index, value: inst.values[index] })
    }
    return [inst.values[index], set]
  },
  Component: ComponentStub,
}

/** 取（或建）某个函数组件的实例；第一个函数组件吃掉场景的预设值队列。 */
function instanceOf(type) {
  let inst = world.instances.get(type)
  if (inst === undefined) {
    inst = {
      hookIndex: 0,
      refs: {},
      filled: {},
      values: [],
      effects: [],
      cleanups: [],
      updates: [],
      history: [],
      queue: world.queueTaken ? [] : world.queue,
    }
    world.queueTaken = true
    world.instances.set(type, inst)
  }
  return inst
}

/** 走一遍 createElement 树：返回可见文本，顺带记录按钮和错误边界是否兜底。 */
function renderNode(node) {
  if (node === null || node === undefined || node === true || node === false) return ''
  if (Array.isArray(node)) return node.map(renderNode).join('')
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  const type = node.type
  if (typeof type === 'string') {
    const children = renderNode(node.props.children)
    if (type === 'button') {
      world.buttons.push({ label: children, disabled: node.props.disabled === true, onClick: node.props.onClick })
    }
    return children
  }
  if (typeof type === 'function') {
    const isClass = typeof type.prototype === 'object' && type.prototype !== null && typeof type.prototype.render === 'function'
    if (isClass) {
      const inst = new type(node.props)
      const previous = world.active
      world.active = null
      try {
        return renderNode(inst.render())
      } catch (error) {
        // 模拟 React 错误边界：getDerivedStateFromError 后重渲染一次。
        if (typeof type.getDerivedStateFromError !== 'function') throw error
        world.boundary = true
        inst.state = Object.assign({}, inst.state, type.getDerivedStateFromError(error))
        return renderNode(inst.render())
      } finally {
        world.active = previous
      }
    }
    const inst = instanceOf(type)
    inst.hookIndex = 0
    inst.effects = []
    const previous = world.active
    world.active = inst
    try {
      return renderNode(type(node.props))
    } finally {
      world.active = previous
    }
  }
  throw new Error('无法渲染的节点类型：' + typeof type)
}

/* ---------- ctx stub + apply ---------- */

const dicts = { ns: null, zh: null, en: null }
const registered = []

/** 与宿主 locale 一致：先查字典，再做 {占位符} 插值，缺 key 就原样返回 key。 */
function interpolate(template, params) {
  if (params === null || params === undefined) return template
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) => {
    const value = params[name]
    return value === undefined || value === null ? match : String(value)
  })
}
function translateZh(key, params) {
  const dict = dicts.zh ?? {}
  const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : String(key)
  return interpolate(template, params)
}

const ctx = {
  effect(fn) { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {} },
  slots: {
    inject(name, callback) { callback() },
    register(payload, component) { registered.push({ payload, component }) },
  },
  locale: {
    register(ns, value) { dicts.ns = ns; dicts.zh = value.zh; dicts.en = value.en },
    bind(ns) { return (key, params) => translateZh(key, params) },
  },
}

const client = spec.factory((id) => {
  if (id === 'react') return React
  throw new Error('未知依赖：' + id)
})

/* ---------- 宿主状态夹具（形状对齐 lib/index.js 的 state 接口） ---------- */

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

function snapshot(overrides) {
  return Object.assign({
    ok: true,
    isRepo: true,
    branch: 'main',
    version: '0.2.1',
    head: { sha: SHA_A, short: 'abc1234', subject: 'baseline' },
    remote: { sha: SHA_B, short: 'def5678', subject: 'upstream work' },
    behind: 0,
    ahead: 0,
    dirty: false,
    dirtyCount: 0,
    originOk: true,
    originUrl: 'git@github.com:heshuren371/dsh-auto-update.git',
    mustMigrate: false,
    updateAvailable: false,
  }, overrides)
}

function runtimeInfo(overrides) {
  return Object.assign({
    currentEntry: '/opt/homebrew/lib/node_modules/dsh/lib/index.js',
    matchesActive: true,
    mustMigrate: false,
    canSwitch: false,
    active: { version: '0.2.1', entry: '/opt/dsh/index.js', commit: SHA_A, short: 'abc1234' },
    candidate: null,
    candidateCanaryOk: false,
    channel: 'master',
  }, overrides)
}

function hostState(overrides) {
  return Object.assign({
    ok: true,
    repo: '/Users/x/dsh',
    upstream: 'master',
    phase: 'idle',
    step: null,
    error: null,
    seq: 3,
    log: [],
    snapshot: snapshot(),
    canary: null,
    quarantined: [],
    runtime: runtimeInfo(),
    switch: null,
  }, overrides)
}

/** publicState.failure 的摘要形状（只有标量，界面只用 hint）。 */
function failureInfo(overrides) {
  return Object.assign({
    at: '2025-09-17T10:00:00Z',
    kind: 'stale-build-artifacts',
    hint: '旧构建产物残留导致构建失败，需要清理后重试',
    step: 'build',
    error: 'MISSING_EXPORT: SettingsProvider',
    logPath: '/Users/x/.dsh/dsh-auto-update/failures/latest.log',
  }, overrides)
}

/** GET /api/failure 返回的完整 FailureBundle。 */
function failureBundle(overrides) {
  return Object.assign({
    at: '2025-09-17T10:00:00Z',
    kind: 'stale-build-artifacts',
    hint: '旧构建产物残留导致构建失败，需要清理后重试',
    step: 'build',
    error: 'MISSING_EXPORT: SettingsProvider',
    repo: '/Users/x/dsh',
    slot: 'b',
    target: { ref: 'master', sha: SHA_B, version: '0.4.0', channel: 'master' },
    running: { version: '0.3.0', commit: SHA_A, root: '/Users/x/dsh' },
    env: { node: 'v24.18.0', pnpm: '10.0.0', platform: 'darwin', arch: 'arm64', git: 'git version 2.39.5' },
    reproduce: ['cd /Users/x/dsh', 'pnpm install', 'pnpm run build'],
    logTail: ['MISSING_EXPORT: SettingsProvider'],
    logPath: '/Users/x/.dsh/dsh-auto-update/failures/latest.log',
    attempts: [],
    agentPrompt: '# 修复任务\n清理旧构建产物后重新构建。',
  }, overrides)
}

/**
 * 组件的 useState 调用顺序：state / log / failed / showLog / armed / restartNote / pending。
 * 复制与 AI 修复新增的 useState 排在 useRef 之后、默认取初始值，前 7 项保持不变。
 */
function queueFor(state, overrides) {
  const base = [state, Array.isArray(state?.log) ? state.log : [], null, false, false, null, null]
  if (overrides !== undefined) Object.assign(base, overrides)
  return base
}

/* ---------- 场景骨架 ---------- */

let routes = {}
let fetchCalls = []
// 记录方法/头，供「变更类接口必须带守卫头」的断言使用。
let fetchRequests = []
function routeKey(url) {
  const pathOnly = String(url).split('?')[0]
  return pathOnly.slice(pathOnly.lastIndexOf('/') + 1)
}
globalThis.fetch = async (url, options) => {
  const key = routeKey(url)
  fetchCalls.push(String(url))
  fetchRequests.push({
    url: String(url),
    key,
    method: options !== null && options !== undefined && typeof options.method === 'string' ? options.method : 'GET',
    headers: options !== null && options !== undefined && options.headers !== undefined ? options.headers : null,
  })
  const route = Object.prototype.hasOwnProperty.call(routes, key) ? routes[key] : { ok: true }
  // 路由值可以是函数，函数也可以返回 Promise：竞态用例靠它把某个响应挂起，
  // 手动决定它和 POST 响应的到达顺序。
  const body = await (typeof route === 'function' ? route() : route)
  const text = JSON.stringify(body ?? null)
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body ?? null),
  }
}

function startScenario(queue) {
  world = { instances: new Map(), queue: queue.slice(), queueTaken: false, active: null, buttons: [], boundary: false }
}

function renderRoot() {
  world.buttons = []
  world.boundary = false
  let text = ''
  const errors = []
  try {
    text = renderNode(React.createElement(registered[0].component))
  } catch (error) {
    errors.push(error)
  }
  return { text, errors, boundary: world.boundary === true, buttons: world.buttons }
}

/** 渲染后按顺序执行一次 effect；执行前先跑上一轮 cleanup（模拟重渲染）。 */
function runEffects() {
  const errors = []
  for (const inst of world.instances.values()) {
    for (const cleanup of inst.cleanups.splice(0)) {
      try { cleanup() } catch (error) { errors.push(error) }
    }
  }
  for (const inst of world.instances.values()) {
    for (const effect of inst.effects.splice(0)) {
      try {
        const cleanup = effect()
        if (typeof cleanup === 'function') inst.cleanups.push(cleanup)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  return errors
}

function currentInstance() {
  return world.instances.values().next().value
}

function currentValues() {
  const inst = currentInstance()
  return inst === undefined ? [] : inst.values
}

/** 让事件循环把在途的 fetch Promise 全部落地（两轮宏任务足够覆盖 .then 链）。 */
async function settle() {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

function findButton(label) {
  return world.buttons.find((button) => button.label === label)
}

/* ---------- apply() 注册契约 ---------- */

process.stdout.write('== 插件注册 ==\n')
client.apply(ctx)
check('exports.apply 是函数', typeof client.apply === 'function')
check('exports.inject 声明 slots/locale', JSON.stringify(client.inject) === JSON.stringify(['slots', 'locale']), JSON.stringify(client.inject))
check('locale 注册了一次字典', dicts.ns === 'dsh-auto-update' && dicts.zh !== null && dicts.en !== null)
check('ctx.effect 在 apply 时挂载了样式', styleTags.length === 1 && typeof styleTags[0]?.textContent === 'string' && styleTags[0].textContent.includes('.dsau-root'))
check('注册到 settings.general.item', registered.length === 1 && registered[0].payload?.name === 'settings.general.item')
check('使用自有 id，不占用别的插件的行', registered[0]?.payload?.id === 'auto-update', JSON.stringify(registered[0]?.payload ?? null))
check('组件注册的是错误边界', registered[0] !== undefined && typeof registered[0].component === 'function')

/* ---------- 各宿主状态渲染 ---------- */

const realLog = [{ seq: 1, line: '[1] snapshot ok' }, { seq: 2, line: '[2] fetch ok' }]

const scenarios = [
  {
    name: 'state=null 读取中',
    state: null,
    expect: ['正在读取版本信息…', '检查更新'],
    absent: ['已是最新版本'],
    buttons: { '检查更新': false, '立即更新': true },
  },
  {
    name: 'idle 已是最新',
    state: hostState(),
    expect: ['已是最新版本', '当前 0.2.1 · abc1234 · main'],
    buttons: { '立即更新': true, '检查更新': false },
  },
  {
    name: 'idle 有 3 个可更新提交',
    state: hostState({ snapshot: snapshot({ updateAvailable: true, behind: 3, remote: { sha: SHA_B, short: 'def5678', subject: 'fix: 修复已知问题' } }) }),
    expect: ['发现 3 个新提交可更新', '上游 def5678 · fix: 修复已知问题'],
    buttons: { '立即更新': false },
  },
  {
    name: 'checking 检查中',
    state: hostState({ phase: 'checking' }),
    expect: ['检查中…'],
    buttons: { '检查中…': true, '立即更新': true },
  },
  {
    name: 'updating=build（runtime.schedulePolling 事故回归）',
    state: hostState({ phase: 'updating', step: 'build', snapshot: snapshot({ updateAvailable: true, behind: 3 }) }),
    expect: ['正在更新 · 构建产物', '取消'],
    absent: ['step.build'],
    buttons: { '取消': false, '检查更新': true },
    extra: () => {
      check('updating 时调度了轮询定时器', timers.scheduled >= 1, 'scheduled=' + timers.scheduled)
    },
  },
  {
    name: 'done 候选已试运行通过',
    state: hostState({
      phase: 'done',
      step: 'done',
      snapshot: snapshot({ mustMigrate: true, updateAvailable: true }),
      runtime: runtimeInfo({ matchesActive: false, mustMigrate: true, canSwitch: true, candidateCanaryOk: true, candidate: { version: '0.2.2', entry: '/opt/dsh-b/index.js', commit: SHA_B, short: 'def5678' } }),
    }),
    expect: ['新版本已通过真实 profile 试运行，可重启生效', '更新在独立副本里进行，正在运行的服务不受影响'],
    buttons: { '重启生效': false },
  },
  {
    name: 'canary 失败 phase=error（无失败包时不出现新按钮）',
    state: hostState({ phase: 'error', step: 'canary', error: '试运行未通过：候选进程起不来' }),
    expect: ['试运行未通过：候选进程起不来'],
    absent: ['已是最新版本', '正在更新', '复制诊断报告', '让 dsh 帮忙修复', 'dsh 修复会话'],
  },
  {
    name: 'phase=error 且有失败包（AI 修复入口）',
    state: hostState({
      phase: 'error',
      step: 'build',
      error: '构建失败',
      failure: failureInfo(),
    }),
    expect: [
      '构建失败',
      '旧构建产物残留导致构建失败，需要清理后重试',
      '复制诊断报告',
      '让 dsh 帮忙修复',
    ],
    buttons: { '复制诊断报告': false, '让 dsh 帮忙修复': false },
  },
  {
    name: 'assist.running 时显示修复会话运行中',
    state: hostState({
      phase: 'error',
      step: 'build',
      error: '构建失败',
      failure: failureInfo(),
      assist: {
        running: true,
        pid: 4242,
        logPath: '/Users/x/.dsh/dsh-auto-update/assist/latest.log',
        startedAt: '2025-09-17T10:01:00Z',
        error: null,
      },
    }),
    expect: [
      'dsh 修复会话运行中（pid 4242）',
      '日志：/Users/x/.dsh/dsh-auto-update/assist/latest.log',
    ],
    buttons: { '让 dsh 帮忙修复': true },
  },
  {
    name: 'runtime.canSwitch=true（闲置态也可重启）',
    state: hostState({
      snapshot: snapshot({ updateAvailable: false }),
      runtime: runtimeInfo({ matchesActive: false, canSwitch: true, candidateCanaryOk: true, candidate: { version: '0.2.2' } }),
    }),
    expect: ['新版本已通过真实 profile 试运行，可重启生效', '当前入口不是受管版本；点「重启生效」切到试运行通过的副本'],
    buttons: { '重启生效': false },
  },
  {
    name: 'quarantined 非空',
    state: hostState({ quarantined: ['music-player', 'dsh-bad-plugin'] }),
    expect: ['已临时禁用 2 个不兼容插件：music-player, dsh-bad-plugin'],
    buttons: { '重新启用插件': false },
  },
  {
    name: 'switch 已回滚',
    state: hostState({ switch: { phase: 'ready', at: '2025-09-17T00:00:00Z', port: null, newPid: null, url: null, error: 'EADDRINUSE: 3080 被占用', message: null, rolledBack: true } }),
    expect: ['上次切换失败，已自动回滚到旧版本：EADDRINUSE: 3080 被占用'],
  },
  {
    name: 'switch 成功并带入口链接',
    state: hostState({ switch: { phase: 'ready', at: '2025-09-17T00:00:00Z', port: 3081, newPid: 42, url: 'http://127.0.0.1:3081', error: null, message: null, rolledBack: false } }),
    expect: ['打开 dsh web'],
    absent: ['上次切换失败'],
  },
  {
    name: 'switch 失败未回滚',
    state: hostState({ switch: { phase: 'failed', at: '2025-09-17T00:00:00Z', port: null, newPid: null, url: null, error: '切换超时', message: null, rolledBack: false } }),
    expect: ['上次切换失败：切换超时'],
  },
  {
    name: '仓库告警 + 日志面板',
    state: hostState({
      snapshot: snapshot({ updateAvailable: true, behind: 1, dirty: true, dirtyCount: 2, originOk: false, originUrl: 'git@github.com:other/repo.git' }),
      log: realLog,
    }),
    queue: { 1: realLog, 3: true },
    expect: [
      '主仓库有 2 项未提交改动',
      'origin 指向的不是预期仓库，更新会被拒绝：git@github.com:other/repo.git',
      '发现 1 个新提交可更新',
      '[1] snapshot ok',
      '[2] fetch ok',
      '收起日志',
    ],
    buttons: { '收起日志': false },
  },
]

for (const item of scenarios) {
  process.stdout.write(`\n== 场景：${item.name} ==\n`)
  startScenario(queueFor(item.state, item.queue))
  routes = { state: item.state }
  fetchCalls = []
  const result = renderRoot()
  const effectErrors = result.errors.length === 0 && result.boundary !== true ? runEffects() : []
  const errors = result.errors.concat(effectErrors)
  check('渲染与 effect 不抛错', errors.length === 0, errors.map(formatError).join(' | '))
  check('未触发错误边界', result.boundary !== true)
  for (const needle of item.expect ?? []) expectText(result.text, needle)
  for (const needle of item.absent ?? []) expectAbsent(result.text, needle)
  for (const [label, disabled] of Object.entries(item.buttons ?? {})) {
    const button = findButton(label)
    if (button === undefined) {
      check(`按钮「${label}」存在`, false, '实际按钮：' + world.buttons.map((b) => b.label).join(' / '))
    } else {
      check(`按钮「${label}」${disabled ? '禁用' : '可点'}`, button.disabled === disabled)
    }
  }
  check('无未插值占位符', !/\{[a-zA-Z][a-zA-Z0-9_]*\}/.test(result.text), preview(result.text))
  if (item.extra !== undefined) item.extra(result)
}

/* ---------- 回归：点「立即更新」→ updating ---------- */

process.stdout.write('\n== 场景：点「立即更新」→ updating（事故原路径）==\n')
{
  const idle = hostState({ snapshot: snapshot({ updateAvailable: true, behind: 3 }) })
  const updating = hostState({ phase: 'updating', step: 'build', seq: 9, snapshot: snapshot({ updateAvailable: true, behind: 3 }) })
  // 真实宿主：收到 /update 之后 /state 也会返回 updating，所以这里用一个可变开关模拟。
  const host = { phase: 'idle' }
  startScenario(queueFor(idle))
  routes = { state: () => (host.phase === 'idle' ? idle : updating), update: updating }
  fetchCalls = []
  const first = renderRoot()
  check('首屏渲染不抛错', first.errors.length === 0, first.errors.map(formatError).join(' | '))
  const firstEffects = runEffects()
  check('首屏 effect 不抛错', firstEffects.length === 0, firstEffects.map(formatError).join(' | '))
  check('首次挂载通过 /state 读取宿主状态', fetchCalls.some((url) => routeKey(url) === 'state'), fetchCalls.join(', '))

  const updateButton = findButton('立即更新')
  check('「立即更新」按钮存在且可点', updateButton !== undefined && updateButton.disabled === false)
  let clickError = null
  host.phase = 'updating'
  try { updateButton.onClick() } catch (error) { clickError = error }
  check('点击「立即更新」不抛错', clickError === null, formatError(clickError))

  await settle()
  const inst = currentInstance()
  const values = currentValues()
  check('POST /update 已发出', fetchCalls.some((url) => routeKey(url) === 'update'), fetchCalls.join(', '))
  check(
    'POST /update 的响应被吸收为 updating',
    inst.history.some((entry) => entry.index === 0 && entry.value !== null && entry.value !== undefined && entry.value.phase === 'updating'),
    `phase=${values[0]?.phase} failed=${values[2]} pending=${values[6]}`,
  )
  // 挂载时那次 /state 的响应晚于 POST 落地（transport.state 的 .then 链多一跳）：
  // 请求代次守卫必须把它丢掉，否则槽位会被覆盖回 idle。
  check('迟到的挂载 /state 没有覆盖 updating', values[0]?.phase === 'updating', `phase=${values[0]?.phase}`)

  const scheduledBefore = timers.scheduled
  const second = renderRoot()
  const secondEffects = second.errors.length === 0 && second.boundary !== true ? runEffects() : []
  // 旧事故：组件里的局部 runtime 遮蔽模块级 runtime，这里会
  // TypeError: runtime.schedulePolling is not a function。
  check('updating 重渲染与 effect 不抛错（runtime.schedulePolling 可用）', second.errors.length === 0 && secondEffects.length === 0, second.errors.concat(secondEffects).map(formatError).join(' | '))
  check('未触发错误边界', second.boundary !== true)
  check('updating 时重新调度了轮询', timers.scheduled > scheduledBefore)
  expectText(second.text, '正在更新 · 构建产物')
  check('updating 时显示取消按钮', findButton('取消') !== undefined, world.buttons.map((b) => b.label).join(' / '))
  check('无未插值占位符', !/\{[a-zA-Z][a-zA-Z0-9_]*\}/.test(second.text), preview(second.text))
}

/* ---------- 回归：迟到的 /state 响应不得覆盖 POST 后的状态 ---------- */

process.stdout.write('\n== 场景：迟到的 /state 响应不得覆盖 updating ==\n')
{
  const idle = hostState({ snapshot: snapshot({ updateAvailable: true, behind: 3 }) })
  const updating = hostState({ phase: 'updating', step: 'build', seq: 9, snapshot: snapshot({ updateAvailable: true, behind: 3 }) })
  // 宿主重启或下一轮检测后的新状态：用来证明代次守卫没有把正常轮询一起吞掉。
  const afterNextPoll = hostState({ seq: 1, snapshot: snapshot({ version: '0.9.9' }) })
  // 首次 GET /state 先挂起，等 POST 落地后再放行：明确构造"迟到响应"。
  let releaseFirstGet = null
  const firstGetGate = new Promise((resolve) => { releaseFirstGet = resolve })
  let stateCalls = 0
  startScenario(queueFor(idle))
  routes = {
    state: () => {
      stateCalls += 1
      return stateCalls === 1 ? firstGetGate.then(() => idle) : afterNextPoll
    },
    update: updating,
  }
  fetchCalls = []
  const first = renderRoot()
  check('首屏渲染不抛错', first.errors.length === 0, first.errors.map(formatError).join(' | '))
  const firstEffects = runEffects()
  check('首屏 effect 不抛错', firstEffects.length === 0, firstEffects.map(formatError).join(' | '))
  check('首次 /state 已发出并挂起', stateCalls === 1, 'stateCalls=' + stateCalls)

  const updateButton = findButton('立即更新')
  check('「立即更新」按钮可点', updateButton !== undefined && updateButton.disabled === false)
  updateButton?.onClick()
  await settle()
  check('POST /update 后状态为 updating', currentValues()[0]?.phase === 'updating', `phase=${currentValues()[0]?.phase}`)

  // 放行迟到的那次 GET：它带的是更新前的 idle 快照。
  releaseFirstGet()
  await settle()
  check('迟到的 /state 响应被丢弃，phase 仍为 updating', currentValues()[0]?.phase === 'updating', `phase=${currentValues()[0]?.phase}`)

  const second = renderRoot()
  const secondEffects = second.errors.length === 0 && second.boundary !== true ? runEffects() : []
  check('updating 渲染与 effect 不抛错', second.errors.length === 0 && secondEffects.length === 0, second.errors.concat(secondEffects).map(formatError).join(' | '))
  expectText(second.text, '正在更新 · 构建产物')
  check('updating 时显示取消按钮', findButton('取消') !== undefined, world.buttons.map((b) => b.label).join(' / '))
  check('无未插值占位符', !/\{[a-zA-Z][a-zA-Z0-9_]*\}/.test(second.text), preview(second.text))

  // 代次守卫只作废 POST 之前发出的 GET：POST 之后的新请求必须照常生效。
  check('updating 时已调度轮询回调', typeof timers.lastTick === 'function')
  timers.lastTick()
  await settle()
  check('POST 之后新发出的 GET 仍被吸收', currentValues()[0]?.snapshot?.version === '0.9.9', `phase=${currentValues()[0]?.phase} version=${currentValues()[0]?.snapshot?.version}`)
  check('轮询请求确实发出', stateCalls >= 3, 'stateCalls=' + stateCalls)
}

/* ---------- 回归：渲染崩溃时错误边界兜底 ---------- */

process.stdout.write('\n== 场景：渲染崩溃时错误边界给出可见文案 ==\n')
{
  const broken = hostState()
  // 故意让 describe/组件读 runtime 字段时抛错，验证不白屏。
  broken.runtime = {
    mustMigrate: false,
    matchesActive: false,
    active: { version: '0.2.1' },
    candidateCanaryOk: false,
    get canSwitch() { throw new Error('boom: 候选校验爆炸') },
  }
  startScenario(queueFor(broken))
  routes = { state: broken }
  const result = renderRoot()
  check('错误边界捕获渲染异常', result.boundary === true)
  check('错误边界输出可见文案', result.text.includes('界面渲染出错了：') && result.text.includes('boom: 候选校验爆炸'), preview(result.text))
  check('错误边界不返回白屏', result.text.trim().length > 0)
}

/* ---------- 回归：复制诊断报告 ---------- */

process.stdout.write('\n== 场景：复制诊断报告（agentPrompt 与 JSON 退化）==\n')
{
  const prompt = '# 修复任务\n请清理旧构建产物后重新构建。'
  const failedState = hostState({
    phase: 'error',
    step: 'build',
    error: '构建失败',
    failure: failureInfo(),
  })

  startScenario(queueFor(failedState))
  routes = { state: failedState, failure: { ok: true, failure: failureBundle({ agentPrompt: prompt }) } }
  fetchCalls = []
  fetchRequests = []
  clipboard.text = null
  clipboard.ok = true
  const first = renderRoot()
  const firstEffects = runEffects()
  check('失败态渲染与 effect 不抛错', first.errors.length === 0 && firstEffects.length === 0,
    first.errors.concat(firstEffects).map(formatError).join(' | '))
  const copyButton = findButton('复制诊断报告')
  check('「复制诊断报告」按钮存在且可点', copyButton !== undefined && copyButton.disabled === false)
  copyButton?.onClick()
  await settle()
  const failureRequest = fetchRequests.filter((request) => request.key === 'failure').pop()
  check('GET /api/failure 已发出且是 GET', failureRequest !== undefined && failureRequest.method === 'GET',
    JSON.stringify(failureRequest ?? null))
  check('剪贴板收到 agentPrompt', clipboard.text === prompt, preview(clipboard.text))
  expectText(renderRoot().text, '已复制，可粘贴给任意 AI 代理修复')

  // 失败包没有 agentPrompt（或老版本宿主）时退化为整包 JSON，仍能交给代理。
  startScenario(queueFor(failedState))
  routes = { state: failedState, failure: { ok: true, failure: failureBundle({ agentPrompt: undefined }) } }
  fetchCalls = []
  clipboard.text = null
  const second = renderRoot()
  check('退化用例渲染不抛错', second.errors.length === 0, second.errors.map(formatError).join(' | '))
  findButton('复制诊断报告')?.onClick()
  await settle()
  let parsed = null
  try { parsed = JSON.parse(clipboard.text) } catch { parsed = null }
  check(
    '无 agentPrompt 时剪贴板收到整包 JSON',
    parsed !== null && parsed.kind === 'stale-build-artifacts' && parsed.error === 'MISSING_EXPORT: SettingsProvider',
    preview(clipboard.text),
  )
}

/* ---------- 回归：剪贴板被拒时退回 execCommand ---------- */

process.stdout.write('\n== 场景：navigator.clipboard 被拒时退回 execCommand ==\n')
{
  const prompt = '# 修复任务\n兜底路径'
  const failedState = hostState({
    phase: 'error',
    step: 'build',
    error: '构建失败',
    failure: failureInfo(),
  })
  clipboard.ok = false
  let execText = null
  document.execCommand = (command) => {
    if (command !== 'copy') return false
    const areas = createdElements.filter((element) => element.tagName === 'textarea')
    execText = areas.length > 0 ? areas[areas.length - 1].value : null
    return true
  }
  startScenario(queueFor(failedState))
  routes = { state: failedState, failure: { ok: true, failure: failureBundle({ agentPrompt: prompt }) } }
  clipboard.text = null
  const result = renderRoot()
  check('渲染不抛错', result.errors.length === 0, result.errors.map(formatError).join(' | '))
  findButton('复制诊断报告')?.onClick()
  await settle()
  check('execCommand 兜底拿到 agentPrompt', execText === prompt, preview(execText))
  expectText(renderRoot().text, '已复制，可粘贴给任意 AI 代理修复')
  clipboard.ok = true
  document.execCommand = () => false
}

/* ---------- 回归：让 dsh 帮忙修复 ---------- */

process.stdout.write('\n== 场景：让 dsh 帮忙修复（两次确认）==\n')
{
  const assistLog = '/Users/x/.dsh/dsh-auto-update/assist/latest.log'
  const failedState = hostState({
    phase: 'error',
    step: 'build',
    error: '构建失败',
    failure: failureInfo(),
  })

  startScenario(queueFor(failedState))
  routes = {
    state: failedState,
    assist: { ok: true, pid: 4321, logPath: assistLog, profile: 'default' },
  }
  fetchCalls = []
  fetchRequests = []
  const first = renderRoot()
  const firstEffects = runEffects()
  check('失败态渲染与 effect 不抛错', first.errors.length === 0 && firstEffects.length === 0,
    first.errors.concat(firstEffects).map(formatError).join(' | '))
  const assistButton = findButton('让 dsh 帮忙修复')
  check('「让 dsh 帮忙修复」按钮存在且可点', assistButton !== undefined && assistButton.disabled === false)
  assistButton?.onClick()
  await settle()
  check('第一次点击只进入确认态、不发请求', !fetchCalls.some((url) => routeKey(url) === 'assist'), fetchCalls.join(', '))
  renderRoot()
  const armedButton = findButton('确认让 dsh 修复？')
  check('出现二次确认按钮', armedButton !== undefined, world.buttons.map((b) => b.label).join(' / '))
  armedButton?.onClick()
  await settle()
  const assistRequest = fetchRequests.filter((request) => request.key === 'assist').pop()
  check(
    'POST /api/assist 已发出且带 JSON content-type 与 x-dsh-updater 头',
    assistRequest !== undefined && assistRequest.method === 'POST'
      && assistRequest.headers !== null && assistRequest.headers['content-type'] === 'application/json'
      && assistRequest.headers['x-dsh-updater'] === '1',
    JSON.stringify(assistRequest ?? null),
  )
  expectText(renderRoot().text, 'dsh 修复会话已启动：日志 ' + assistLog)

  // 宿主失败时原样显示具体原因，不吞成「连不上」。
  startScenario(queueFor(failedState))
  routes = { state: failedState, assist: { ok: false, error: '已有修复会话在运行' } }
  fetchCalls = []
  renderRoot()
  findButton('让 dsh 帮忙修复')?.onClick()
  await settle()
  renderRoot()
  findButton('确认让 dsh 修复？')?.onClick()
  await settle()
  expectText(renderRoot().text, '出错了：已有修复会话在运行')
}

/* ---------- 字典一致性 ---------- */

process.stdout.write('\n== 字典一致性 ==\n')
{
  const zhKeys = Object.keys(dicts.zh ?? {}).sort()
  const enKeys = Object.keys(dicts.en ?? {}).sort()
  const missingEn = zhKeys.filter((key) => !Object.prototype.hasOwnProperty.call(dicts.en ?? {}, key))
  const missingZh = enKeys.filter((key) => !Object.prototype.hasOwnProperty.call(dicts.zh ?? {}, key))
  check(
    'zh/en 字典 key 集合完全一致',
    missingEn.length === 0 && missingZh.length === 0 && zhKeys.length === enKeys.length,
    `zh 独有：${missingEn.join(',') || '无'}；en 独有：${missingZh.join(',') || '无'}`,
  )
  const allValues = [...Object.values(dicts.zh ?? {}), ...Object.values(dicts.en ?? {})]
  const nonString = allValues.filter((value) => typeof value !== 'string')
  // 值写成 (n) => ... 的函数时，不传 params 侥幸能用、传了就炸，这里直接拦掉。
  check('字典值都是字符串', nonString.length === 0, '非字符串值 ' + nonString.length + ' 个')
  const placeholders = (dict) => [...new Set(Object.values(dict ?? {}).flatMap((value) => typeof value === 'string'
    ? [...value.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1])
    : []))].sort()
  const zhPlaceholders = placeholders(dicts.zh)
  const enPlaceholders = placeholders(dicts.en)
  check('zh/en 占位符集合一致', JSON.stringify(zhPlaceholders) === JSON.stringify(enPlaceholders), `zh ${zhPlaceholders.join(',')} / en ${enPlaceholders.join(',')}`)
}

/* ---------- 收尾 ---------- */

await new Promise((resolve) => { setTimeout(resolve, 0) })
check('没有未处理的 Promise 拒绝', rejections.length === 0, rejections.map(formatError).join(' | '))

process.stdout.write(`\n== 最终：${passed} 通过，${failed} 失败 ==\n`)
process.exit(failed === 0 ? 0 : 1)
