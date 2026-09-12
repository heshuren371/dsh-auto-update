/**
 * 动态 Cordis 插件（demo）宿主半。
 * 只用宿主 Builtin（ctx / harness / console）+ shell 服务，不依赖 node 模块。
 * 与持久化插件 lib/index.js 行为一致，差别仅在于运行命令的方式。
 */
const REPO = '/Users/heshuren/deepseek-harness'
const UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness'
const MAX_LOG = 400
const FETCH_TIMEOUT_MS = 120000

const STEP_LABEL = { snapshot: '记录回滚点', pull: '拉取上游提交', install: '安装依赖', build: '构建产物' }

function q(value) {
  return "'" + String(value).replaceAll("'", "'\\''") + "'"
}

function apply(ctx) {
  const state = {
    phase: 'idle',
    step: null,
    error: null,
    log: [],
    seq: 0,
    snapshot: null,
    checkedAt: null,
    proc: null,
    startedAt: null,
    finishedAt: null,
  }

  function push(line) {
    const text = String(line).replace(/\s+$/, '')
    if (text.length === 0) return
    state.seq += 1
    state.log.push({ seq: state.seq, line: text })
    while (state.log.length > MAX_LOG) state.log.shift()
  }

  function reset() {
    state.log = []
    state.seq = 0
  }

  function shellService() {
    const shell = ctx.get('shell')
    if (shell === undefined) throw new Error('当前部署未挂载 shell 服务')
    return shell
  }

  /** 全权限策略：更新必须能写 workspace 之外的 harness 仓库。 */
  function specFor(script, timeoutMs) {
    return shellService().resolve({
      command: 'cd ' + q(REPO) + ' && ' + script,
      workdir: REPO,
      // shell 服务要求 timeoutMs 为正有限值；后台进程实际不套用超时。
      timeoutMs: timeoutMs === undefined ? 86400000 : timeoutMs,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: REPO },
    })
  }

  async function capture(script, timeoutMs) {
    const result = await shellService().run(specFor(script, timeoutMs))
    const out = String(result.stdout === undefined ? '' : result.stdout.text)
      + String(result.stderr === undefined ? '' : result.stderr.text)
    return { code: result.exitCode === null ? -1 : result.exitCode, out: out }
  }

  async function git(args) {
    const result = await capture('git ' + args)
    return result.out.trim()
  }

  function parseCommit(line) {
    if (line.length === 0) return null
    const parts = line.split('\u001f')
    if (parts.length < 2 || parts[0].length === 0) return null
    return { short: parts[0], subject: parts[1], date: parts[2] === undefined ? '' : parts[2] }
  }

  async function readSnapshot() {
    const refLine = await git('symbolic-ref --short refs/remotes/origin/HEAD')
    const ref = refLine.length > 0 ? refLine : 'origin/master'
    const results = await Promise.all([
      git('rev-parse --abbrev-ref HEAD'),
      git('rev-parse HEAD'),
      git("log -1 --format='%h%x1f%s%x1f%cI'"),
      git("log -1 --format='%h%x1f%s%x1f%cI' " + q(ref)),
      git('status --porcelain'),
      git('rev-list --left-right --count HEAD...' + q(ref)),
      capture("node -e \"process.stdout.write(require('./package.json').version)\""),
    ])
    const branch = results[0]
    const headSha = results[1]
    const head = parseCommit(results[2])
    const remote = parseCommit(results[3])
    const dirty = results[4].split('\n').filter(function (line) { return line.trim().length > 0 })
    const counts = results[5].split(/\s+/).filter(function (part) { return part.length > 0 })
    const ahead = Number.parseInt(counts[0] === undefined ? '0' : counts[0], 10) || 0
    const behind = Number.parseInt(counts[1] === undefined ? '0' : counts[1], 10) || 0
    const version = results[6].out.trim()
    if (headSha.length === 0) {
      return { repo: REPO, upstream: UPSTREAM, ref: ref, isRepo: false, error: '不是 git 仓库或 git 不可用：' + REPO }
    }
    return {
      repo: REPO,
      upstream: UPSTREAM,
      ref: ref,
      isRepo: true,
      branch: branch.length > 0 ? branch : 'HEAD',
      version: version.length > 0 ? version : null,
      head: head === null ? { short: headSha.slice(0, 8), subject: '', date: '' } : head,
      remote: remote,
      behind: behind,
      ahead: ahead,
      dirty: dirty.length > 0,
      dirtyCount: dirty.length,
      updateAvailable: behind > 0,
      checkedAt: state.checkedAt,
    }
  }

  function payload(since) {
    const from = since === undefined || since === null ? 0 : since
    return {
      ok: true,
      repo: REPO,
      upstream: UPSTREAM,
      phase: state.phase,
      step: state.step,
      error: state.error,
      checkedAt: state.checkedAt,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      seq: state.seq,
      log: state.log.filter(function (entry) { return entry.seq > from }),
      snapshot: state.snapshot,
    }
  }

  async function check() {
    if (state.phase === 'updating') return
    state.phase = 'checking'
    push('· 正在检测更新：git fetch origin（' + REPO + '）')
    const result = await capture('git fetch --prune origin', FETCH_TIMEOUT_MS)
    for (const line of result.out.split('\n')) push(line)
    state.checkedAt = new Date().toISOString()
    state.snapshot = await readSnapshot()
    if (result.code !== 0) {
      state.phase = 'error'
      state.error = 'git fetch 失败，请检查网络或仓库权限'
      push('· 检测失败（退出码 ' + String(result.code) + '）')
      return
    }
    state.phase = 'idle'
    state.error = null
    push(state.snapshot.updateAvailable
      ? '· 发现 ' + String(state.snapshot.behind) + ' 个新提交（本地 ' + state.snapshot.head.short + ' → 上游 ' + (state.snapshot.remote === null ? '?' : state.snapshot.remote.short) + '）'
      : '· 已是最新版本')
  }

  const PIPELINE = [
    'set -e',
    'echo "::step::snapshot"',
    'git rev-parse HEAD',
    'git branch -f dsh-rollback HEAD && echo "回滚点已记为分支 dsh-rollback（$(git rev-parse --short HEAD)）"',
    'if [ -n "$(git status --porcelain)" ]; then echo "工作区有未提交改动，先 stash 起来"; git stash push -u -m "dsh-auto-update-$(date +%Y%m%d-%H%M%S)"; fi',
    'echo "::step::pull"',
    'git pull --ff-only origin master',
    'echo "::step::install"',
    'pnpm install',
    'echo "::step::build"',
    'pnpm run build',
    'echo "::step::done"',
  ].join('\n')

  function absorb(line) {
    const marker = /^::step::(.+)$/.exec(String(line).trim())
    if (marker !== null) {
      const id = marker[1]
      state.step = id === 'done' ? null : id
      push('--- ' + (STEP_LABEL[id] === undefined ? id : STEP_LABEL[id]) + ' ---')
      return
    }
    push(line)
  }

  async function pump() {
    const proc = state.proc
    if (proc === null) return
    const read = proc.readOutput()
    if (read.delta.length > 0) {
      for (const line of read.delta.split('\n')) absorb(line)
    }
    if (proc.status !== 'running') {
      const code = proc.exitCode === null ? -1 : proc.exitCode
      state.proc = null
      state.finishedAt = new Date().toISOString()
      if (code === 0) {
        push('=== 更新完成，重启 dsh web 后生效 ===')
        state.snapshot = await readSnapshot()
        state.checkedAt = new Date().toISOString()
        state.phase = 'done'
        state.step = null
        state.error = null
      } else {
        push('=== 更新失败（退出码 ' + String(code) + '）===')
        push('回滚方式：git checkout dsh-rollback && pnpm install && pnpm run build')
        state.phase = 'error'
        state.step = null
        state.error = '更新流水线失败，详见日志'
      }
    }
  }

  function startUpdate() {
    if (state.phase === 'updating') return { ok: false, error: '更新正在进行中' }
    reset()
    state.phase = 'updating'
    state.error = null
    state.step = null
    state.startedAt = new Date().toISOString()
    state.finishedAt = null
    push('=== 开始更新 ===')
    push('提示：构建需要几分钟，进度会持续刷新。')
    try {
      state.proc = shellService().start(specFor(PIPELINE, 0))
    } catch (error) {
      state.phase = 'error'
      state.error = error instanceof Error ? error.message : String(error)
      push('无法启动更新进程：' + state.error)
      return { ok: false, error: state.error }
    }
    return { ok: true, started: true }
  }

  ctx.effect(() => harness.handle('state', async (args) => {
    await pump()
    const since = args === null || typeof args !== 'object' ? 0 : args.since
    return payload(since)
  }), 'auto-update demo: state')

  ctx.effect(() => harness.handle('check', async () => {
    await check()
    return payload(0)
  }), 'auto-update demo: check')

  ctx.effect(() => harness.handle('update', async () => {
    const started = startUpdate()
    return Object.assign({}, payload(0), started)
  }), 'auto-update demo: update')

  ctx.effect(() => harness.handle('cancel', async () => {
    if (state.proc !== null) {
      push('· 用户取消了更新')
      try { state.proc.kill() } catch (error) { /* 已退出 */ }
      state.proc = null
    }
    state.phase = 'idle'
    state.step = null
    return payload(0)
  }), 'auto-update demo: cancel')

  ctx.effect(() => harness.handle('restart', async () => {
    return { ok: false, error: '演示版不执行重启，正式插件里这个按钮会真正重启 dsh web' }
  }), 'auto-update demo: restart')

  push('插件已加载（演示版），仓库：' + REPO)
  push('点击「检查更新」即可比对上游提交。')
}

return { apply }
