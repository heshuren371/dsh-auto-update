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

## 开发

```sh
node --check lib/index.js
node --check lib/client.js
node scripts/build-demo.mjs        # 生成 demo/client.generated.js
```

`demo/client.generated.js` 与 `lib/client.js` 共享同一份 UI 源码，
差异只在三处标记区间（运行时定时器/样式、数据通道、inject 列表），
由 `scripts/build-demo.mjs` 做替换，避免两份界面各自漂移。
