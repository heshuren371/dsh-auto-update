# 官方自动更新实现对比（Desktop vs 本插件）

> 结论先说：**官方自动更新只存在于 Desktop 打包应用**（electron-updater + 内部 CDN feed + 签名安装包），
> web/CLI 的**源码构建**场景没有官方更新器（`apps/cli` 里没有任何 self-update）。
> 因此 electron-updater 本体无法复用；本插件**复用了它的判定与状态语义**，见文末「已采用」。

## 1. 官方 Desktop 更新器（代码出处）

| 文件 | 职责 |
| --- | --- |
| `apps/desktop/src/update-coordinator.ts` | 状态机与 electron-updater 封装：`autoDownload=false`、`autoInstallOnAppQuit=false`、`channel='nightly'`、`allowPrerelease=true`、`allowDowngrade=false` |
| `apps/desktop/src/update-schedule.ts` | 轮询：默认 600s，失败指数退避（上限 `max(interval, 3600s)`），±20% 抖动，单调时钟；周期/前台/resume/手动共用同一次 in-flight 检查 |
| `apps/desktop/src/update-http-executor.ts` | **空闲**超时（默认 60s，只在静默时计时），不是总时长；保留代理与登录事件 |
| `apps/desktop/src/update-journal.ts` | 白名单 JSONL 证据（phase/targetVersion/整数进度/failedOperation/固定错误码），0600，逐条 flush；不落原始错误文本 |
| `apps/desktop/src/mandatory-update-policy.ts`、`update-dialog/overlay/attention` | 强制更新策略与界面 |
| `apps/desktop/scripts/electron-builder-config.mjs` | 发布配置：`publish: [{ provider: 'generic', url: <内部 origin>, channel: 'nightly' }]` |
| `apps/desktop/scripts/desktop-auto-update-environment.mjs` | 环境：`DSH_DESKTOP_AUTO_UPDATE_ENV=test|production`，生产 origin 为 `https://download.deepseek.com`，通道元数据文件名 `nightly[-mac].yml` |

关键语义：

1. **版本判定不盲信 feed**：先 `valid(version)` 校验，再 `gt(feedVersion, app.getVersion())` 才认为有更新
   （`update-coordinator.ts:188-191`）。
2. **两次用户授权**：`check`（只看元数据）→ 用户确认 → `downloadUpdate` → 用户确认 → `quitAndInstall`；
   安装时再次校验 `version === this.candidate`，拒绝过期确认（`:129-131`）。
3. **状态机**：`idle → available → downloading → verifying → ready → installing`；失败带
   `failedOperation: 'check'|'download'|'install'` 与固定错误分类。
4. **网络判据是「静默」**：空闲超时按响应块刷新，慢但在推进的传输不会被杀。
5. 分发包是**签名安装包 + generic feed 元数据**（`nightly-mac.yml` 等），走内部 CDN。

## 2. 与本插件对比

| 维度 | 官方 Desktop | dsh-auto-update |
| --- | --- | --- |
| 更新对象 | Electron 应用包 | 源码 git checkout 构建出的 web/CLI 运行时 |
| 分发 | electron-updater generic feed（内部 CDN） | GitHub 仓库（`git fetch` + 本地 `pnpm install && pnpm run build`） |
| 通道 | 固定 `nightly` | `nightly`(默认)/`rc`/`alpha`/`stable`/`tag` |
| 版本判定 | `valid()` + `semver.gt` | nightly 用 `rev-list`；标签通道新增 `valid()` + `gt`（本次补齐） |
| 下载/安装授权 | 下载、安装两次确认 | 「立即更新」构建、「重启生效」切换两次确认 |
| 失败处理 | `failedOperation` + 固定错误码 journal | 失败分类 + 完整日志 + agent/CLI 修复（更强，但落原始日志） |
| 完整性校验 | 安装包签名 + checksum | 不适用（源码构建）→ 用**真实 profile 试运行 + 切换失败回滚**替代 |
| 轮询 | 10min + 指数退避 + 抖动 | 仅手动（未实现自动轮询） |

## 3. 已采用的官方设计（本次改动）

1. **通道语义对齐**：新增 `rc`/`alpha`/`stable` 通道（对应 `dsh-v*-rc.N`/`-alpha.N`/无 prerelease 标签），
   `master`/`branch` 归一为 `nightly`，保留历史 `tag` 通道；非法值回退 nightly。
2. **semver 判定**：新增零依赖 `lib/semver.js`；标签通道必须 `gt(目标, 运行版本)` 才允许构建，
   否则直接拒绝（不再可能出现降级或平级空转构建）。
3. **版本绑定切换**：`scripts/switch.mjs` 在摘 launchd/杀旧进程**之前**校验
   「磁盘上的目标版本 == 界面确认的版本」，不匹配就以 `failed` 退出且不碰正在运行的服务
   （对齐官方 `version !== candidate` 的拒绝逻辑）。
4. **空闲超时**：`runBash` 支持 `idleTimeoutMs`（有输出即重置），fetch 使用「空闲 60s / 总 120s」，
   对齐官方「静默才算卡死」的判据。
5. **调度与自动重启（v0.6）**：采用官方 `update-schedule.ts` 的思路做**后台预构建巡检**
   （默认 30 分钟 + ±20% 抖动，配置区间校验；发现新提交提前构建候选，不自动重启），
   并默认「更新完自动重启」（宿主直接落切换 job，`delayMs` 给界面 3s 提示）。
   与官方的差别：官方是「下载完等用户确认安装」，我们是「构建完自动切换」，
   由试运行 + 失败回滚兜底，因此自动重启是安全的。

## 4. 为什么不能直接用官方实现

- electron-updater 依赖 Electron 运行时、`app.isPackaged` 与资源目录里的 `app-update.yml`；
- 官方 feed 只发布**签名的 Desktop 安装包**（mac/win），没有可供源码构建消费的 artifact；
- 生产 feed origin 与凭据属于内部发布链路，第三方插件不应也不该接入；
- 本场景的「更新」本质是**源码构建**，其完整性保证只能靠「真实 profile 试运行 + 失败回滚」，而不是包签名。

## 5. 可选后续

- 失败退避：预构建巡检目前是固定间隔 + 抖动；官方在失败后指数退避，可补上；
- 白名单更新日志 `updates.jsonl`（phase/targetVersion/错误码），与现有失败报告并存；
- 若将来上游提供 npm/安装包分发，可增加 `official` 通道直接安装官方产物（而不是源码构建）。
