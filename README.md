# dsh-auto-update

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）用的更新插件：
在 **设置 → 通用** 里加一行「DSH 更新」，有上游提交时点一下按钮就更新完，
不用再手敲 `cd ~/deepseek-harness && git pull && pnpm install && pnpm run build`。

![设置 → 通用 里的 DSH 更新](docs/settings-general.png)

## 功能

- **检测更新**：`git fetch` 后比对上游，显示当前版本 / 提交 / 分支，以及落后几个提交
- **一键更新**：后台跑「记录回滚点 → stash → `git pull` → `pnpm install` → `pnpm run build`」，
  带进度条和实时日志，关掉面板也不中断
- **一键回滚**：每次更新前把当时的 HEAD 记到 `dsh-rollback` 分支
- **重启生效**：更新完成后点按钮重启 dsh web（点两次确认）

## 环境要求

- 已经能跑 `dsh web`（`dsh` 命令可用）
- 本地有一份 **git 克隆** 的 deepseek-harness（不是 npm 安装的包）
- `git` 与 `pnpm` 在 PATH 上

## 安装

```sh
# 1) 克隆到任意位置
git clone https://github.com/heshuren371/dsh-auto-update.git ~/dsh-auto-update

# 2) 接进 web profile（幂等，会先备份 profile 的 package.json）
node ~/dsh-auto-update/scripts/install.mjs

# 3) 装依赖
cd ~/.dsh/profiles/web && pnpm install
```

然后**重启 dsh web**，打开 **设置 → 通用**，最下面就是「DSH 更新」。

> 重启不好找？`sh ~/dsh-auto-update/scripts/restart-web.sh 5` 会重启 dsh web。
> 它带预检 —— 确认新进程真能起来才杀旧进程；加 `--check` 则只预检不重启。

## 更新插件本身

```sh
cd ~/dsh-auto-update && git pull
# 重启 dsh web 生效
```

## 卸载

```sh
node ~/dsh-auto-update/scripts/install.mjs --remove
cd ~/.dsh/profiles/web && pnpm install
# 重启 dsh web
```

卸载后那一行设置和 `/dsh-updater` 路由都会消失，不留后台进程。

## 说明

- 仓库路径自动探测（从 dsh 的 CLI 入口向上找），探测不到就假设 `~/deepseek-harness`。
  也可以显式指定：启动 dsh 前 `export DSH_UPDATE_REPO=/path/to/deepseek-harness`
- 只跟随 `deepseek-ai/deepseek-harness`；`origin` 指向别处时会拒绝更新。
  确认无误才需要 `export DSH_UPDATE_ALLOW_ANY_ORIGIN=1`
- 更新会在仓库里执行 `pnpm install && pnpm run build`，也就是会运行上游代码 ——
  这是「更新 dsh」本身要求的权限，请只在你自己的机器上使用
- 更新前先知道怎么回滚：
  `cd ~/deepseek-harness && git checkout dsh-rollback && pnpm install && pnpm run build`

## 开发

```sh
node --check lib/index.js          # 宿主半
node --check lib/client.js         # 客户端半
sh -n scripts/restart-web.sh
node scripts/build-demo.mjs        # 生成 demo/ 下的动态插件预览代码
```

设计细节、安全审计与性能测试记录见 [docs/DESIGN.md](docs/DESIGN.md)。

## License

[MIT](LICENSE)
