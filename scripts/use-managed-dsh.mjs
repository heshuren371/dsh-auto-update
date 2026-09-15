#!/usr/bin/env node
/**
 * 让终端里的 `dsh` 跟随 dsh-auto-update 的受管版本。
 *
 *   node scripts/use-managed-dsh.mjs           安装/更新（默认写到 ~/.local/bin/dsh）
 *   node scripts/use-managed-dsh.mjs --check   只检查，不写文件
 *   node scripts/use-managed-dsh.mjs --remove  卸载
 *   node scripts/use-managed-dsh.mjs --dir <dir>  换安装目录（默认 ~/.local/bin）
 *
 * 原理：生成一个同名 shim：
 *   1. 先读 $DSH_HOME/dsh-auto-update/active-entry（由切换器维护），有就运行受管版本；
 *   2. 没有指针（或指针文件失效）时，回退到安装时解析到的原始 dsh。
 * ~/.local/bin 在这台机器的 PATH 里排在 nvm 前面，所以 `command dsh` 会命中 shim，
 * 不需要改 .zshrc。撤销：--remove。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const STATE_DIR = process.env.DSH_UPDATE_STATE ?? path.join(DSH_HOME, 'dsh-auto-update')
const MANAGED_ENTRY_FILE = path.join(STATE_DIR, 'active-entry')
const MARK = '由 dsh-auto-update 生成'

const args = process.argv.slice(2)
const remove = args.includes('--remove')
const check = args.includes('--check')
const dirFlag = args.indexOf('--dir')
const targetDir = dirFlag === -1 ? path.join(os.homedir(), '.local', 'bin') : args[dirFlag + 1]
if (typeof targetDir !== 'string' || targetDir.length === 0) {
  console.error('--dir 需要一个目录')
  process.exit(2)
}
const wrapperPath = path.join(targetDir, 'dsh')

function shellQuote(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'"
}

/** 在 PATH 上找真正的 dsh（跳过我们自己要写的 shim 以及已有的同款 shim）。 */
function findRealDsh() {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.length === 0) continue
    const candidate = path.join(dir, 'dsh')
    if (path.resolve(candidate) === path.resolve(wrapperPath)) continue
    try {
      if (!existsSync(candidate)) continue
      const text = readFileSync(candidate, 'utf8')
      if (text.includes(MARK)) continue // 上一版 shim：跳过，继续找真正的
      return realpathSync(candidate)
    } catch {
      // 读不了（二进制/权限）：当作真正的 dsh。
      return candidate
    }
  }
  return null
}

function isOurWrapper(file) {
  try {
    return statSync(file).isFile() && readFileSync(file, 'utf8').includes(MARK)
  } catch {
    return false
  }
}

const realEntry = findRealDsh()
const nodeBin = process.execPath

if (check) {
  console.log('shim 路径      :', wrapperPath, existsSync(wrapperPath) ? (isOurWrapper(wrapperPath) ? '(已安装)' : '(存在但不是本插件的)') : '(未安装)')
  console.log('node           :', nodeBin)
  console.log('回退 dsh 入口  :', realEntry ?? '(未在 PATH 上找到)')
  console.log('受管指针       :', MANAGED_ENTRY_FILE, existsSync(MANAGED_ENTRY_FILE) ? '-> ' + readFileSync(MANAGED_ENTRY_FILE, 'utf8').trim() : '(还没有)')
  process.exit(0)
}

if (remove) {
  if (!existsSync(wrapperPath)) {
    console.log('没有需要卸载的 shim：' + wrapperPath)
    process.exit(0)
  }
  if (!isOurWrapper(wrapperPath)) {
    console.error('这个文件不是本插件生成的，已拒绝删除：' + wrapperPath)
    process.exit(1)
  }
  copyFileSync(wrapperPath, wrapperPath + '.bak-' + Date.now())
  rmSync(wrapperPath, { force: true })
  console.log('已移除 ' + wrapperPath + '（备份留了一份 .bak-*）')
  process.exit(0)
}

if (realEntry === null || !existsSync(realEntry)) {
  console.error('没有在 PATH 上找到可回退的 dsh 入口，已放弃。')
  process.exit(1)
}
if (existsSync(wrapperPath) && !isOurWrapper(wrapperPath)) {
  console.error('目标已存在且不是本插件生成的，已拒绝覆盖：' + wrapperPath)
  process.exit(1)
}
mkdirSync(targetDir, { recursive: true })

const script = [
  '#!/bin/sh',
  `# ${MARK}（scripts/use-managed-dsh.mjs）；卸载：node scripts/use-managed-dsh.mjs --remove`,
  '# 优先运行运行指针里的受管版本；没有指针或指针失效时回退到安装时解析到的 dsh。',
  `MANAGED_ENTRY_FILE=${shellQuote(MANAGED_ENTRY_FILE)}`,
  `FALLBACK_ENTRY=${shellQuote(realEntry)}`,
  `NODE=${shellQuote(nodeBin)}`,
  'ENTRY=""',
  'if [ -f "$MANAGED_ENTRY_FILE" ]; then',
  '  ENTRY="$(cat "$MANAGED_ENTRY_FILE" 2>/dev/null || true)"',
  'fi',
  '[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null || true)"',
  '[ -n "$NODE" ] || { echo "dsh: 找不到 node" >&2; exit 127; }',
  'if [ -n "$ENTRY" ] && [ -f "$ENTRY" ]; then',
  '  exec "$NODE" "$ENTRY" "$@"',
  'fi',
  'exec "$NODE" "$FALLBACK_ENTRY" "$@"',
  '',
].join('\n')

writeFileSync(wrapperPath, script, { mode: 0o755 })
console.log('已安装受管 dsh shim：' + wrapperPath)
console.log('  受管指针：' + MANAGED_ENTRY_FILE)
console.log('  回退入口：' + realEntry)
console.log('新开一个终端（或 hash -r）后：dsh --version')
