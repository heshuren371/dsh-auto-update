# DSH 自动更新插件（@local/dsh-auto-update）

在 DSH Web 的 **设置 → 通用** 里加一行「DSH 更新」：检测
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
上游是否有新提交，点一下按钮就完成更新，不用再手敲
`cd ~/deepseek-harness && git pull && pnpm install && pnpm run build`。

## 它做了什么

| 位置 | 文件 | 说明 |
| --- | --- | --- |
| 宿主 | `lib/index.js` | 注册 `/dsh-updater` HTTP 路由；执行 git 检测与更新流水线 |
| 客户端 | `lib/client.js` | 在 `settings.general.item` 槽位注册一行设置（id 为 `auto-update`） |
| 装配 | `cordis.patch.yml` | bundle patch，`insert` 一行插件条目 |
| demo | `demo/` | 由 `scripts/build-demo.mjs` 从 `lib/client.js` 生成的动态插件代码 |

### 检测

`git fetch --prune origin` 后比较 `HEAD...origin/master`：

- 当前版本（`package.json`）、当前提交、分支
- 上游提交的短 hash 与标题
- 领先 / 落后提交数
- 工作区是否有未提交改动

检测结果会写到 `$DSH_HOME/dsh-auto-update-cache.json`，重启后在联网前也能先显示上次状态。

### 一键更新（后台流水线）

```
set -e
git branch -f dsh-rollback HEAD      # ① 记录回滚点
git stash push -u -m dsh-auto-update-<时间戳>   # ② 有改动才 stash
git pull --ff-only origin master     # ③ 只做快进合并，冲突就中止
pnpm install                         # ④
pnpm run build                       # ⑤
```

任一步失败立即中止，界面给出错误与回滚命令。整个过程在后台跑，输出按行推送到前端，
设置面板关掉也不会中断。

### 回滚

每次更新前都会把当时的 HEAD 记到 `dsh-rollback` 分支：

```sh
cd ~/deepseek-harness
git checkout dsh-rollback && pnpm install && pnpm run build
```

### 重启

更新完成后界面出现「重启生效」按钮（点两次确认）。它会脱离当前进程，
杀旧进程并用同一入口重新拉起 `dsh web`，日志写到
`<启动目录>/.dsh-updater-restart.log`。

## 安装

```sh
node scripts/install.mjs          # 写入 ~/.dsh/profiles/web/package.json
cd ~/.dsh/profiles/web && pnpm install
```

然后重启 `dsh web`。卸载就是把 `dsh.profile.bundles` 里的条目和依赖删掉再重启。

## 权限说明

插件以 dsh 宿主进程的身份运行，会执行 `git` / `pnpm` 命令，并对
harness 仓库（默认 `/Users/heshuren/deepseek-harness`）有读写权限。
这是「一键更新」必需的能力，请只在你自己的机器上使用。

仓库路径可覆盖：

```sh
export DSH_UPDATE_REPO=/path/to/deepseek-harness   # 重启 dsh 后生效
```

## 故障复盘：v0.1.0 第一次启用时把 dsh 弄挂了

**现象**：启用时用 `launchctl submit` 提交重启作业，旧进程被杀掉，新进程没起来，
dsh web 断了十几秒，只能手动 `dsh web` 拉回来。

**根因**：`launchctl submit` **不继承调用者的环境**。提交进去的作业只有 launchd 的
极简 `PATH`（`/usr/bin:/bin:/usr/sbin:/sbin`），而 `dsh` 是
`#!/usr/bin/env node` 脚本 —— 找不到 `node`，直接以 127 退出：

```
env: node: No such file or directory
```

脚本这边又是"先杀旧进程，再启新进程"，于是杀完就没人接手了。

**修法（v0.1.1）**：

1. **先预检，再杀进程**。预检会解析出 dsh 的 JS 入口并实跑一次
   `node <entry> --version`；预检不过就直接退出，绝不碰旧进程。
2. **完全不依赖 PATH**。启动命令固定用绝对路径的 `node` + 解析出的 JS 入口，
   绕开 `env node` 这个 shebang。
3. **杀不掉就不启第二个**。旧进程 kill 后仍在，直接中止，避免双实例抢端口。
4. 插件内的「重启生效」按钮同步加固：入口不存在就拒绝重启，
   并在杀进程前先 `launchctl remove dsh-web`，免得 launchd 又把旧作业拉起来。
5. 顺带修掉一个真 bug：`/api/restart` 之前无论成败都返回 `ok: true`，
   现在失败返回 500 + 真实错误。

**教训**：任何"先停服务再起服务"的动作，都要把"起得来"验证放在"停"之前。

## 安全审计（v0.1.2）

一次独立对抗审计 + 自审的结果。**H1 是真实存在、且当时正在生效的漏洞。**

### H1（高）路由完全没有鉴权 —— 已修

`webServer` 不做任何鉴权：cookie / Origin / Host 检查只发生在 harness 自己的
RPC 通道和静态首页里，**任何插件注册的 `webServer` 路由默认对任意来源开放**。
实测（无 cookie）：

```
GET  /                          -> 401    ← harness 自己的路由有栅栏
GET  /dsh-updater/api/state     -> 200    ← 我的路由没有，泄露仓库路径/HEAD/日志
POST /dsh-updater/api/cancel    -> 200    ← 带 Origin: http://evil.example + text/plain 也被接受
```

后果：用户只要访问任意一个恶意网页，那个页面就能 POST `/api/update`
（简单请求，无需预检）→ 在 harness 仓库里执行 `git pull && pnpm install && pnpm run build`
= 上游任意提交 / lockfile / postinstall 脚本造成的代码执行；还能 `/api/restart` 打死
dsh web，或读 `/api/state`。DNS rebinding 还能读到响应。

修法：handler 第一行复用 harness 自己的判定 ——

```js
const rejection = ctx.connection.requestRejection(req)   // Host 白名单 + 同源 + cookie
if (rejection !== undefined) { res.writeHead(rejection); res.end(...); return }
```

并把 `connection` 加进 `inject`（缺了它就拒绝加载，而不是裸奔）。

### 中危（全部已修）

| # | 问题 | 修法 |
| --- | --- | --- |
| M1 | `/api/update` 冲突时返回 `ok:true`（`publicState()` 覆盖了 `result.ok`） | 展开顺序改为 `{...publicState(), ...result}` |
| M2 | `check` 与 `update` 互斥只靠 `phase`，晚到的 `setPhase('idle')` 会抹掉正在跑的更新 | 两个入口都同时挡住 `checking` 与 `updating` |
| M3 | 取消后的收尾回调会覆盖新一轮状态，可导致两个流水线并发跑同一工作区 | 加 `runId` 代次，旧回调无权改写 |
| M4 | `state.running` 被**所有**子进程覆写，`/cancel` 会误杀一次普通 git 查询 | 拆出专用 `state.pipeline`，只杀它 |
| M5 | 流水线写死 `origin master`，与快照用的 `origin/HEAD` 不一致 | 用当前分支自己的 upstream，pull 显式指定分支 |
| M6 | 上游引用解析不出来时静默退化成 `behind:0`，永久显示"已是最新" | 解析失败即返回 `ok:false` + 明确原因 |
| M7 | stdout/stderr 混流，git 的 `fatal:` 文本被当成 sha / 分支名 | 分流采集；`isRepo` 改用 `rev-parse --is-inside-work-tree` 的退出码判定 |

### 低危（已修）

- `/api/restart` 丢掉启动参数（`--port` 等），现在复用 `process.argv` 原样重启
- 客户端把宿主的重启错误吞掉换成"连不上"，现在显示真实原因
- `resetLog()` 重置 `seq` 会让增量拉取永远拿不到内容 → seq 改为单调；客户端也加了游标回退保护
- 流水线无超时 → 加 30 分钟兜底；插件卸载时回收子进程（原先会留下孤儿构建）
- 缓存快照不做形状校验 → 严格校验 + 客户端取值防御（原先畸形缓存会让整行渲染崩掉且无法自愈）
- `install.mjs`：备份无限堆积 → 只留最近 3 个；校验 `name`；profile 形状异常不再抛未捕获异常
- `restart-web.sh`：缺 `lsof` 时会写出假的 `ready` → 预检直接失败；`$PATH`/`$LOG` 嵌入前转义
- 重启日志无限增长 → 超过 1MB 清空
- `package.json` 的 `files` 漏了 `scripts/`，打包安装后没有安装脚本

### 审计确认无问题的部分

`sh()` 是正确 POSIX 单引号转义，所有进 shell 的路径/引用都被它包住（无命令注入）；
commit subject 与 git ref 从不进 shell；前端无 DOM/URL 注入；提交行与 ahead/behind
解析正确；前缀匹配按路径段；路由 try/catch 与 JSON 形状正确；日志环形缓冲有界；
客户端槽位注册与同族插件一致。另外**实测否定**了一个疑似的孤儿进程问题：
SIGTERM 到 node 派生的 `bash -c` 会连同前台子树一起结束。

## 性能与进程管线（v0.1.3）

在受控进程里跑了泄漏、吞吐、时延和管线生命周期测试，抓到 **4 个真问题**并修复。

### 抓到的 4 个问题

| # | 问题 | 实测现象 | 修法 |
| --- | --- | --- | --- |
| P1 | `runBash` 行缓冲既无上限又是 O(n²)：每个数据块都对不断变长的 `pending` 做一次 `split('\n')` | 8MB 无换行输出 → **堆峰值 232.7MB**（约 29 倍放大）。pnpm / git 进度条只用 `\r` 不回 `\n`，正好踩这条 | 无换行的块走快路径直接累积；单行超 16KB 截断成一行 |
| P2 | 日志只限行数不限字节：400 行 × 单行上限 = 最坏 25MB 常驻，且每次 `/state` 都要序列化一遍 | `GET /state` 平均 **7.14ms**（客户端更新期间每 1.2s 轮询一次） | 增加 256KB 字节预算，行数与字节数双重封顶 |
| P3 | git 查询没有超时 | 一次挂住的 git（陈旧 `index.lock`、网络盘、超大仓库的 `status`）让 `readSnapshot` 永不返回 —— 而 `startUpdate` 已同步把 phase 置成 `updating`，**状态机永久卡死**，连取消都没进程可杀 | `GIT_TIMEOUT_MS = 20s` 覆盖所有快照查询 |
| P4 | 取消只 kill 直接子进程（`/bin/bash -c`），它拉起的 git / pnpm 孙进程活着继续攥着 stdio 管道 | Node 的 `close` 事件要等**所有** stdio 关闭，于是取消后 `phase` 一直停在 `updating` | 子进程 `detached` 起在独立进程组，取消时对负 pid 整组收；再加 `exit` 事件 2 秒宽限兜底 |

### 修复后实测

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 8MB 无换行输出的堆峰值 | 232.7MB | **15.9MB** |
| `GET /state` 平均时延 | 7.14ms | **1.07ms** |
| 20 万行 / 13MB 流水线输出 | — | 堆峰值 **8.1MB**，CPU 177ms，日志稳定 400 行 / 20KB |
| 取消后的状态机 | 卡在 `updating` | `idle`，句柄归零，无孤儿进程 |

（15.9MB 里剩下的部分是测试自身让 9 个子进程同时各吐 8MB 造成的流缓冲；真实 git 查询输出都是几十字节。反复 4 轮堆稳定在 4.6MB —— **不是泄漏**。）

### 确认无问题的部分

- **无内存泄漏**：4 轮 8MB 输出堆稳定在 4.6MB（每轮 +0.0MB）；120 次请求浸泡堆 5.0MB 持平
- **无句柄/描述符泄漏**：`activeHandles` 跑完回到基线；真实 dsh 进程 20 秒采样 fd 恒定 81、无子进程
- **spawn 失败路径不泄漏**：实测事件序列为 `error → close`，`state.children` 能自清
- **环形缓冲有效**：20 万行输出后日志仍是 400 行

> 附注：上一节写的"实测否定孤儿进程问题"只对**简单**形态成立。P4 证明
> `/bin/bash -c` 拉起的孙进程会活下来并攥住管道 —— 这条更严格的结论以 P4 为准。

## 开发

```sh
node --check lib/index.js
node --check lib/client.js
sh -n scripts/restart-web.sh
node scripts/build-demo.mjs        # 生成 demo/client.generated.js
```

`demo/client.generated.js` 与 `lib/client.js` 共享同一份 UI 源码，
差异只在三处标记区间（运行时定时器/样式、数据通道、inject 列表），
由 `scripts/build-demo.mjs` 做替换，避免两份界面各自漂移。
