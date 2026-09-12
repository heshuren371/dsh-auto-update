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
import { copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const pkg = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
const packageName = pkg.name
// 名字不对就往 profile 里写 `"undefined": "link:…"`，先把这类事故挡在前面。
if (typeof packageName !== 'string' || packageName.length === 0) {
  console.error(`package.json 里的 name 不合法：${JSON.stringify(packageName)}`)
  process.exit(1)
}

const profileDir = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', 'web')
const profileFile = path.join(profileDir, 'package.json')
const remove = process.argv.includes('--remove')

if (!existsSync(profileFile)) {
  console.error(`找不到 profile：${profileFile}`)
  process.exit(1)
}

const profile = JSON.parse(readFileSync(profileFile, 'utf8'))
if (typeof profile !== 'object' || profile === null) {
  console.error(`profile 不是对象，已放弃：${profileFile}`)
  process.exit(1)
}
const dependencies = profile.dependencies ?? (profile.dependencies = {})
profile.dsh ?? (profile.dsh = {})
profile.dsh.profile ?? (profile.dsh.profile = {})
// bundles 存在但不是数组时直接重建：往下走 .includes/.push 会抛错，宁可覆盖。
if (!Array.isArray(profile.dsh.profile.bundles)) profile.dsh.profile.bundles = []
const bundles = profile.dsh.profile.bundles

copyFileSync(profileFile, `${profileFile}.bak-auto-update-${Date.now()}`)
// 每次安装都留一个备份会无限堆积，只保留最近 3 个。
const backups = readdirSync(profileDir)
  .filter((name) => name.startsWith('package.json.bak-auto-update-'))
  .sort()
  .reverse()
for (const stale of backups.slice(3)) {
  try {
    unlinkSync(path.join(profileDir, stale))
  } catch {
    // 删不掉就算了，不影响这次安装。
  }
}

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
