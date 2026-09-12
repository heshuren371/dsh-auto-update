#!/usr/bin/env node
/**
 * 把本插件接入 dsh 的 web profile。
 *
 * 做三件事（都是幂等的）：
 *   1. 备份 ~/.dsh/profiles/web/package.json
 *   2. dependencies 里加 "@local/dsh-auto-update": "link:<本目录>"
 *   3. dsh.profile.bundles 里加 "@local/dsh-auto-update"（顺序决定装配层）
 *
 * 之后需要：cd ~/.dsh/profiles/web && pnpm install && 重启 dsh web
 *
 * 加 --remove 参数可反向卸载。
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const pkg = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
const packageName = pkg.name

const profileDir = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'web')
const profileFile = path.join(profileDir, 'package.json')
const remove = process.argv.includes('--remove')

if (!existsSync(profileFile)) {
  console.error(`找不到 profile：${profileFile}`)
  process.exit(1)
}

const profile = JSON.parse(readFileSync(profileFile, 'utf8'))
const dependencies = profile.dependencies ?? (profile.dependencies = {})
const bundles = ((profile.dsh ?? (profile.dsh = {})).profile ?? (profile.dsh.profile = {})).bundles
  ?? (profile.dsh.profile.bundles = [])

copyFileSync(profileFile, `${profileFile}.bak-auto-update-${Date.now()}`)

if (remove) {
  delete dependencies[packageName]
  const at = bundles.indexOf(packageName)
  if (at !== -1) bundles.splice(at, 1)
} else {
  dependencies[packageName] = `link:${pluginDir}`
  if (!bundles.includes(packageName)) bundles.push(packageName)
}

writeFileSync(profileFile, `${JSON.stringify(profile, null, 2)}\n`)

console.log(`${remove ? '已卸载' : '已接入'} ${packageName} → ${profileFile}`)
console.log('bundles:', bundles.join(', '))
console.log('\n下一步：')
console.log(`  cd ${profileDir} && pnpm install`)
console.log('  然后重启 dsh web')
