#!/usr/bin/env node
/**
 * 从唯一源（lib/client.js）生成动态 Cordis 插件用的客户端代码。
 *
 * 为什么需要它：持久化插件（lib/client.js）与临时动态插件（cordis_define）
 * 共享同一份界面代码，但运行环境不同：
 *   - 持久化：window.__ModuleLoader__ 包装、require("react")、document、setInterval、fetch
 *   - 动态：React 是内置全局，无 document / fetch / setInterval，
 *           定时器走 ctx 的 timer 服务，样式走 styles.insert，数据走 host.call
 * 用一份源码 + 三处标记区间替换，避免两份 UI 各自漂移。
 *
 * 用法：node scripts/build-demo.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

/** 用 replacement 整体替换 `/* @dsh-updater:<tag>-start/end *\/` 之间的内容。 */
function replaceRegion(text, tag, replacement) {
  const start = `/* @dsh-updater:${tag}-start */`
  const end = `/* @dsh-updater:${tag}-end */`
  const from = text.indexOf(start)
  const to = text.indexOf(end)
  if (from === -1 || to === -1) throw new Error(`缺少标记区间：${tag}`)
  return text.slice(0, from) + replacement.trim() + text.slice(to + end.length)
}

// 1. 抽取 factory 主体（包装层之外的部分）。
const bodyStart = source.indexOf('    var exports = module.exports;')
const bodyEnd = source.indexOf('    exports.apply = apply;')
if (bodyStart === -1 || bodyEnd === -1) throw new Error('client.js 结构已变化，无法抽取主体')
let body = source.slice(bodyStart + '    var module = { exports: {} };\n'.length, bodyEnd)

// 2. React 在动态客户端是内置全局，不需要 require。
body = body.replace('    const React = require("react");\n', '')

// 3. 运行环境差异：定时器 / 样式。
body = replaceRegion(body, 'runtime', `
    const createRuntime = (ctx) => ({
      schedulePolling: (tick) => ctx.interval(tick, 1200),
      mountStyles: () => styles.insert(CSS),
    });
`)

// 4. 数据通道差异：动态插件走 Package 私有 RPC。
body = replaceRegion(body, 'transport', `
    const transport = {
      state: (since) => host.call("state", { since: since ?? 0 }),
      check: () => host.call("check", {}),
      update: () => host.call("update", {}),
      cancel: () => host.call("cancel", {}),
      restart: () => host.call("restart", {}),
      retryPlugins: () => host.call("retryPlugins", {}),
    };
`)

// 5. 动态插件用 inject 声明硬依赖，并 return Plugin 对象。
body = replaceRegion(body, 'inject', '    const inject = ["slots", "locale", "timer"];')
body += '\n    return { apply, inject };\n'

process.stdout.write(`${body.trimEnd()}\n`)