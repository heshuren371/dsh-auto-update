    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState } = React;

    const NS = "dsh-auto-update";

    const createRuntime = (ctx) => ({
      schedulePolling: (tick) => ctx.interval(tick, 1200),
      mountStyles: () => styles.insert(CSS),
    });

    /** apply() 时绑定，供组件在渲染期使用。 */
    let runtime = null;

    const transport = {
      state: (since) => host.call("state", { since: since ?? 0 }),
      check: () => host.call("check", {}),
      update: (options) => host.call("update", options ?? {}),
      cancel: () => host.call("cancel", {}),
      restart: () => host.call("restart", {}),
      retryPlugins: () => host.call("retryPlugins", {}),
    };

    // 动态插件的 transport 由 scripts/build-demo.mjs 整体替换，不含上面两个方法；
    // 这里按环境补上，让生成的 demo 客户端也能走 Package RPC。
    if (typeof transport.failure !== "function") {
      transport.failure = () => host.call("failure", {})
    }
    if (typeof transport.assist !== "function") {
      transport.assist = () => host.call("assist", {})
    }
    if (typeof transport.desktopUpdate !== "function") {
      transport.desktopUpdate = () => host.call("desktop-update", {})
    }

    /**
     * 写剪贴板：优先 navigator.clipboard；权限被拒或环境没有它时，
     * 退回临时 textarea + document.execCommand("copy")。
     * 放在 transport 标记区间之外，生成的动态版客户端同样可用。
     */
    async function writeClipboard(text) {
      const api = typeof navigator !== "undefined" && navigator !== null ? navigator.clipboard : null
      if (api !== null && api !== undefined && typeof api.writeText === "function") {
        try {
          await api.writeText(text)
          return true
        } catch {
          // 非安全上下文 / 权限被拒：继续走下面的兜底路径。
        }
      }
      try {
        if (typeof document === "undefined" || document === null) return false
        const area = document.createElement("textarea")
        area.value = text
        area.setAttribute("readonly", "")
        area.style.position = "fixed"
        area.style.opacity = "0"
        document.body.appendChild(area)
        area.select()
        const ok = typeof document.execCommand === "function" && document.execCommand("copy") === true
        try { area.remove() } catch { /* 老浏览器没有 remove */ }
        return ok
      } catch {
        return false
      }
    }

    const zh = {
      "title": "DSH 更新",
      "loading": "正在读取版本信息…",
      "checking": "正在向 GitHub 检查上游提交…",
      "updating": "正在更新",
      "done": "新版本已通过真实 profile 试运行，可重启生效",
      "idle.latest": "已是最新版本",
      "idle.never": "尚未检测，点「检查更新」比对上游提交",
      "idle.migrate": "当前运行的不受更新管理；更新会先在副本里构建并试运行，通过后重启切换",
      "error.unknown": "更新出错了，请展开日志查看原因",
      // 注意：locale 字典的值必须是字符串，参数走 {占位符} 插值。
      // 写成 (n) => ... 只是在不传 params 时侥幸能用，传了就会炸。
      "idle.available": "发现 {count} 个新提交可更新",
      "meta": "当前 {version} · {short} · {branch}",
      "metaNoVersion": "当前 {short} · {branch}",
      "dirty": "主仓库有 {count} 项未提交改动（不影响更新：更新在副本里进行）",
      "remote": "上游 {short} · {subject}",
      "changes.count": "{count} 个提交",
      "changes.detail": "（{summary}）",
      "changes.toggle": "查看提交列表（{count}）",
      "changes.type.other": "其他",
      "elsewhere.current": "{channel} 通道已是最新",
      "elsewhere.currentUnknown": "当前通道已是最新",
      "elsewhere.tag": "；上游最新 {tag}",
      "elsewhere.ahead": "（{ref} 领先 {count} 提交）",
      "elsewhere.action": "，可直接更新到该版本",
      "runtime.mismatch": "当前入口不是受管版本；点「重启生效」切到试运行通过的副本",
      "runtime.ready": "新版本已通过试运行，点「重启生效」完成切换（失败会自动回滚）",
      "auto.hint": "已开启「更新完自动重启」：构建并试运行通过后会自动切换，本页稍后自动重连（DSH_UPDATE_AUTO_RESTART=0 可关）",
      "runtime.managed": "受管版本 {version} · {short}",
      "quarantined": "已临时禁用 {count} 个不兼容插件：{ids}",
      "switch.rolledback": "上次切换失败，已自动回滚到旧版本：{error}",
      "switch.failed": "上次切换失败：{error}",
      "switch.ready": "上次切换成功（端口 {port}）",
      "origin.bad": "origin 指向的不是预期仓库，更新会被拒绝：{url}",
      "action.check": "检查更新",
      "action.checking": "检查中…",
      "action.checkDesktop": "检查桌面版更新",
      "desktop.failed": "无法打开桌面版更新：{error}",
      "desktop.idle": "点「检查桌面版更新」查询应用更新（桌面版只更新到 rc 或正式版）",
      "desktop.needApp": "当前是桌面版托管的服务：浏览器里不能驱动桌面版的更新器，请到桌面版应用窗口里检查更新（或菜单「检查更新…」）",
      "action.checkDesktopBrowser": "请到桌面版应用检查",
      "desktop.checking": "正在检查桌面版更新…",
      "desktop.available": "发现桌面版新版本 {version}，正在交给应用更新器",
      "desktop.skipped": "桌面版只更新到 rc 或正式版；最新 {version} 是开发版，已跳过",
      "desktop.latest": "桌面版已是最新（{version}）",
      "desktop.detail": "桌面版 {version} · 通道 {channel}",
      "action.update": "立即更新",
      "action.updateOther": "更新到 {tag}",
      "action.updating": "更新中…",
      "action.cancel": "取消",
      "action.log": "查看日志",
      "action.logHide": "收起日志",
      "action.restart": "重启生效",
      "action.restartArmed": "确认重启？",
      "action.retryPlugins": "重新启用插件",
      "action.open": "打开 dsh web",
      "action.copyDiagnostics": "复制诊断报告",
      "action.assist": "让 dsh 帮忙修复",
      "action.assistArmed": "确认让 dsh 修复？",
      "restart.hint": "重启会中断当前正在跑的对话，请先确认。",
      "restart.pending": "正在重启，本页稍后会断开…",
      "restart.started": "重启指令已发出，页面稍后会自动重连。",
      "error.prefix": "出错了：",
      "error.network": "无法连接到 dsh 宿主进程",
      "step.snapshot": "记录回滚点",
      "step.fetch": "拉取上游提交",
      "step.stage": "准备试运行副本",
      "step.install": "安装依赖",
      "step.build": "构建产物",
      "step.canary": "试运行校验",
      "rollback.hint": "更新在独立副本里进行，正在运行的服务不受影响；如切换失败会自动回滚。",
      "copy.done": "已复制，可粘贴给任意 AI 代理修复",
      "copy.failed": "复制失败，请展开日志手动复制",
      "assist.pending": "正在启动 dsh 修复会话…",
      "assist.started": "dsh 修复会话已启动：日志 {logPath}",
      "assist.running": "dsh 修复会话运行中（pid {pid}）",
      "assist.log": "日志：{logPath}",
      "render.error": "界面渲染出错了：",
      "host.desktop": "当前是桌面版托管的 Host：dsh 运行时固定在应用包内，本插件不能原地切换。桌面版的 dsh 跟随应用更新；要用本插件，请在终端用 git 克隆跑 dsh web。",
      "host.desktopBridge": "点「检查桌面版更新」会打开应用自带的更新器（等同菜单「检查更新…」）。",
    };
    const en = {
      "title": "DSH Updates",
      "loading": "Reading version information…",
      "checking": "Checking upstream commits on GitHub…",
      "updating": "Updating",
      "done": "New build passed the real-profile canary — restart to apply",
      "idle.latest": "Up to date",
      "idle.never": "Not checked yet — click Check to compare with upstream",
      "idle.migrate": "Running build is unmanaged; updates are staged, canary-tested, then switched on restart",
      "error.unknown": "Update failed — expand the log for details",
      "idle.available": "{count} new commit(s) available",
      "meta": "{version} · {short} · {branch}",
      "metaNoVersion": "{short} · {branch}",
      "dirty": "{count} uncommitted change(s) in the main repo (updates run in a staging copy)",
      "remote": "upstream {short} · {subject}",
      "changes.count": "{count} commit(s)",
      "changes.detail": " ({summary})",
      "changes.toggle": "View commit list ({count})",
      "changes.type.other": "other",
      "elsewhere.current": "{channel} channel is up to date",
      "elsewhere.currentUnknown": "Current channel is up to date",
      "elsewhere.tag": "; upstream latest {tag}",
      "elsewhere.ahead": " ({count} commits ahead on {ref})",
      "elsewhere.action": ", update to it directly",
      "runtime.mismatch": "Current entry is not the managed build; click Restart to switch to the canary-tested copy",
      "runtime.ready": "New build passed the canary — click Restart to switch (auto-rollback on failure)",
      "auto.hint": "Auto-restart after update is on: the service switches as soon as the build passes the canary, and this page reconnects automatically (set DSH_UPDATE_AUTO_RESTART=0 to disable)",
      "runtime.managed": "Managed build {version} · {short}",
      "quarantined": "{count} incompatible plugin(s) temporarily disabled: {ids}",
      "switch.rolledback": "Previous switch failed and rolled back: {error}",
      "switch.failed": "Previous switch failed: {error}",
      "switch.ready": "Previous switch succeeded (port {port})",
      "origin.bad": "origin is not the expected repository; updates are refused: {url}",
      "action.check": "Check",
      "action.checking": "Checking…",
      "action.checkDesktop": "Check Desktop updates",
      "desktop.failed": "Could not open Desktop updates: {error}",
      "desktop.idle": "Click “Check Desktop updates” to query app updates (Desktop only takes rc or stable)",
      "desktop.needApp": "This page is served by the Desktop host: the browser cannot drive the Desktop updater. Check for updates in the Desktop window (or the “Check for Updates…” menu).",
      "action.checkDesktopBrowser": "Check in the Desktop app",
      "desktop.checking": "Checking Desktop updates…",
      "desktop.available": "Desktop update {version} found — handing over to the app updater",
      "desktop.skipped": "Desktop only updates to rc or stable; latest {version} is a development build and was skipped",
      "desktop.latest": "Desktop is up to date ({version})",
      "desktop.detail": "Desktop {version} · channel {channel}",
      "action.update": "Update now",
      "action.updateOther": "Update to {tag}",
      "action.updating": "Updating…",
      "action.cancel": "Cancel",
      "action.log": "Show log",
      "action.logHide": "Hide log",
      "action.restart": "Restart",
      "action.restartArmed": "Confirm restart?",
      "action.retryPlugins": "Re-enable plugins",
      "action.open": "Open dsh web",
      "action.copyDiagnostics": "Copy diagnostics",
      "action.assist": "Ask dsh to fix",
      "action.assistArmed": "Confirm dsh fix?",
      "restart.hint": "Restarting interrupts running conversations.",
      "restart.pending": "Restarting — this page will disconnect shortly…",
      "restart.started": "Restart requested; the page will reconnect shortly.",
      "error.prefix": "Error: ",
      "error.network": "Cannot reach the dsh host process",
      "step.snapshot": "Recording rollback point",
      "step.fetch": "Fetching upstream commits",
      "step.stage": "Preparing staging copy",
      "step.install": "Installing dependencies",
      "step.build": "Building artifacts",
      "step.canary": "Canary boot with real profile",
      "rollback.hint": "Updates run in a separate copy; the running service is untouched, and a failed switch rolls back automatically.",
      "copy.done": "Copied — paste it into any AI agent to fix",
      "copy.failed": "Copy failed — select the log manually",
      "assist.pending": "Starting dsh repair session…",
      "assist.started": "dsh repair session started: log {logPath}",
      "assist.running": "dsh repair session running (pid {pid})",
      "assist.log": "Log: {logPath}",
      "render.error": "Render error: ",
      "host.desktop": "This session is hosted by the Desktop app: its dsh runtime is fixed inside the app bundle, so this plugin cannot switch it in place. The Desktop dsh follows the app updater; to use this plugin, run dsh web from a git clone in a terminal.",
      "host.desktopBridge": " “Check Desktop updates” opens the app's own updater (same as the “Check for Updates…” menu item).",
    };

    /** 模块级翻译器，在 apply() 绑定 locale 之后可用。 */
    let translate = null;

    const CSS = `
.dsau-root { display: flex; flex-direction: column; padding: 16px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }
.dsau-row { display: flex; align-items: flex-start; gap: 16px; }
.dsau-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dsau-title { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
.dsau-desc { font-size: 12px; font-weight: 400; line-height: 18px; color: var(--dsw-alias-label-tertiary); display: flex; align-items: center; gap: 6px; }
.dsau-meta { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.dsau-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.dsau-err { color: var(--dsw-alias-state-error-primary); }
.dsau-warn { font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-primary); }
.dsau-actions { flex: none; display: flex; align-items: center; gap: 8px; padding-top: 2px; }
.dsau-btn { display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; border: none; border-radius: 18px; background: var(--dsw-alias-bg-module-platform); font: inherit; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsau-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsau-btn:disabled { opacity: 0.45; cursor: default; }
.dsau-btn-primary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
.dsau-btn-primary:hover:not(:disabled) { opacity: 0.9; background: var(--dsw-alias-brand-primary); }
.dsau-btn-danger { background: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-bg-base); }
.dsau-btn-danger:hover:not(:disabled) { opacity: 0.9; background: var(--dsw-alias-state-error-primary); }
.dsau-bar { margin-top: 10px; height: 3px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dsau-bar-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary); transition: width 0.4s ease; }
.dsau-log { margin-top: 10px; max-height: 176px; overflow: auto; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 17px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-all; }
.dsau-hint { margin-top: 6px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.dsau-changes { margin-top: 6px; }
.dsau-toggle { cursor: pointer; }
.dsau-list { margin: 4px 0 0; padding-left: 18px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
`;

    /** 步骤 → 进度百分比（构建最耗时，权重最大）。 */
    const STEP_PROGRESS = { snapshot: 5, fetch: 12, stage: 20, install: 40, build: 75, canary: 95, done: 100 };

    /** 状态点颜色：可用/成功用品牌色，失败用错误色。 */
    function dotStyle(tone) {
      if (tone === "brand") return { background: "var(--dsw-alias-brand-primary)" };
      if (tone === "ok") return { background: "var(--dsw-alias-state-success-primary)" };
      if (tone === "error") return { background: "var(--dsw-alias-state-error-primary)" };
      if (tone === "warn") return { background: "var(--dsw-alias-state-warn-primary)" };
      return undefined;
    }

    /** 取 state.runtime：字段都当不可信输入，形状不对就当它不存在。 */
    function runtimeOf(state) {
      if (state === null || typeof state !== "object") return null;
      const info = state.runtime;
      return info !== null && typeof info === "object" ? info : null;
    }

    /**
     * 可切换：宿主给了 canSwitch，或候选已试运行通过（candidateCanaryOk）
     * 且它不是当前正在运行的入口（candidateIsRunning 非 true）。
     * 字段都当不可信输入，只有 === true 才算数；describe() 与组件共用这一处判断。
     */
    function canSwitchRuntime(info) {
      return info !== null && (info.canSwitch === true
        || (info.candidateCanaryOk === true && info.candidateIsRunning !== true));
    }

    /**
     * 桌面版官方更新器的桥：preload 在 dsh-app://app 主框架上暴露的 globalThis.dshDesktop。
     * 普通浏览器和动态插件里拿不到完整 API，返回 null，调用方退回插件自己的 git 检查。
     * 字段一律当不可信输入：形状不对就当没有。
     */
    function desktopUpdatesBridge() {
      try {
        const carrier = globalThis.dshDesktop;
        if (carrier === null || typeof carrier !== "object" || carrier.protocolVersion !== 1) return null;
        const updates = carrier.updates;
        if (updates === null || typeof updates !== "object" || typeof updates.open !== "function") return null;
        return updates;
      } catch {
        return null;
      }
    }

    /** 需要一次迁移式更新：当前入口不受更新管理（例如 npm 全局安装）。 */
    function mustMigrateRuntime(info) {
      return info !== null && info.mustMigrate === true;
    }

    /**
     * 取 snapshot.changes：只在 updateAvailable 为 true 时展示，字段类型不对就当它没有。
     * 契约：{ total, shown, from, to, fromVersion, toVersion, summary, items }；
     * items 已由宿主截断（最多 30 条），summary 是「提交类型 → 条数」；
     * 类型 key 原样展示，只有宿主归到 other 的杂项按 changes.type.other 显示。
     */
    function changesOf(snapshot, t) {
      if (snapshot === null || typeof snapshot !== "object" || snapshot.updateAvailable !== true) return null;
      const raw = snapshot.changes;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      const items = (Array.isArray(raw.items) ? raw.items : [])
        .filter((item) => item !== null && typeof item === "object"
          && typeof item.short === "string" && item.short.length > 0)
        .map((item) => ({
          short: item.short,
          subject: typeof item.subject === "string" ? item.subject : "",
        }));
      const summary = [];
      const rawSummary = raw.summary !== null && typeof raw.summary === "object" && !Array.isArray(raw.summary)
        ? raw.summary : {};
      for (const key of Object.keys(rawSummary)) {
        const value = rawSummary[key];
        if (key.length > 0 && typeof value === "number" && Number.isFinite(value)) {
          const label = key === "other" ? t("changes.type.other") : key;
          summary.push(label + " " + String(value));
        }
      }
      const total = typeof raw.total === "number" && Number.isFinite(raw.total) ? raw.total : items.length;
      if (total <= 0 && items.length === 0 && summary.length === 0) return null;
      return {
        total,
        summary,
        items,
        from: typeof raw.fromVersion === "string" && raw.fromVersion.length > 0 ? raw.fromVersion : null,
        to: typeof raw.toVersion === "string" && raw.toVersion.length > 0 ? raw.toVersion : null,
      };
    }

    /**
     * 取 snapshot.elsewhere：当前通道没有更新、上游别处有更新时的提示。
     * 契约：{ newestTag, newestVersion, upstream, upstreamAhead, channel }；字段缺失或类型不符就省略对应片段。
     * newestTag 只在标签严格更新时才有值；只有 upstream 领先时它是 null，此时更新目标是分支。
     * channel 是这次一次性更新要用的通道，界面用它发起 /update。
     */
    function elsewhereOf(snapshot) {
      if (snapshot === null || typeof snapshot !== "object" || snapshot.updateAvailable === true) return null;
      const raw = snapshot.elsewhere;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      const asText = (value) => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
      const tag = asText(raw.newestTag) ?? asText(raw.newestVersion);
      // 没有可报的发布标签就等于没有目标：整块不显示（分支领先只是 nightly 日常提交）。
      if (tag === null) return null;
      const ref = asText(raw.upstream);
      return {
        // 当前通道：用于「{channel} 通道已是最新」。
        currentChannel: asText(snapshot.channel),
        // 目标通道：更新时传给 /update 的 channel。
        channel: asText(raw.channel),
        /** 提示行里的「上游最新 X」片段：只有发布标签值得这么写。 */
        tag: asText(raw.newestTag),
        /** 按钮要更新的目标：另一条发布线的标签。 */
        label: tag,
        ahead: typeof raw.upstreamAhead === "number" && Number.isFinite(raw.upstreamAhead) && raw.upstreamAhead > 0
          ? raw.upstreamAhead : null,
        ref,
      };
    }

    /** 提交说明截断到约 100 个字符，避免一行过长。 */
    function clipSubject(subject) {
      return subject.length > 100 ? subject.slice(0, 100) + "…" : subject;
    }

    /** 由宿主状态推导出这一行的文案与色调。 */
    function describe(state, t) {
      if (state === null) return { text: t("loading"), tone: "muted" };
      if (state.phase === "checking") return { text: t("checking"), tone: "muted" };
      if (state.phase === "updating") {
        // 只认已知步骤：t() 对未知 key 会原样返回 key，直接用会把 "step.xxx" 显示出来。
        const known = state.step !== null && state.step !== undefined
          && Object.prototype.hasOwnProperty.call(STEP_PROGRESS, state.step);
        const step = known ? t("step." + state.step) : "";
        return { text: step.length > 0 ? t("updating") + " · " + step : t("updating"), tone: "brand" };
      }
      if (state.phase === "done") return { text: t("done"), tone: "ok" };
      if (state.phase === "error") {
        return {
          text: typeof state.error === "string" && state.error.length > 0 ? state.error : t("error.unknown"),
          tone: "error",
          error: true,
        };
      }
      const snapshot = state.snapshot;
      const runtimeMustMigrate = mustMigrateRuntime(runtimeOf(state));
      if (snapshot === null || snapshot === undefined) {
        return runtimeMustMigrate
          ? { text: t("idle.migrate"), tone: "brand" }
          : { text: t("idle.never"), tone: "muted" };
      }
      // ok:false 表示宿主明确知道这份快照不可信（读不出仓库、上游引用解析不了），
      // 此时必须报错，绝不能显示"已是最新"。
      if (snapshot.ok === false) {
        return {
          text: typeof snapshot.error === "string" && snapshot.error.length > 0 ? snapshot.error : t("error.unknown"),
          tone: "error",
          error: true,
        };
      }
      if (snapshot.isRepo === false) return { text: snapshot.error ?? t("error.network"), tone: "error", error: true };
      if (snapshot.updateAvailable === true) {
        // 仓库已是最新、但当前入口不受管（例如 npm 全局安装）时，仍需要一次迁移式更新。
        if ((snapshot.mustMigrate === true || runtimeMustMigrate)
          && !(typeof snapshot.behind === "number" && snapshot.behind > 0)) {
          return { text: t("idle.migrate"), tone: "brand" };
        }
        return { text: t("idle.available", { count: snapshot.behind }), tone: "brand" };
      }
      if (canSwitchRuntime(runtimeOf(state))) return { text: t("done"), tone: "ok" };
      if (runtimeMustMigrate) return { text: t("idle.migrate"), tone: "brand" };
      return { text: t("idle.latest"), tone: "ok" };
    }

    /** 设置「通用」里的一行：版本信息 + 检查/更新/重启。 */
    function UpdaterRow() {
      const t = translate;
      const [state, setState] = useState(null);
      const [log, setLog] = useState([]);
      const [failed, setFailed] = useState(null);
      const [showLog, setShowLog] = useState(false);
      const [armed, setArmed] = useState(false);
      const [restartNote, setRestartNote] = useState(null);
      /** 本地在途标记：POST 还没回来时按钮也要立刻有反馈。 */
      const [pending, setPending] = useState(null);
      const sinceRef = useRef(0);
      const logBoxRef = useRef(null);
      /** 在途标记的同步副本：防止连点两次按钮发出两个并发请求。 */
      const pendingRef = useRef(null);
      /** 请求代次：POST 自增，让更早发出的 GET 响应作废（见 pull）。 */
      const requestGenRef = useRef(0);
      /** 「复制诊断报告」的结果提示：null 表示还没点过。 */
      const [copyNote, setCopyNote] = useState(null);
      /** 「让 dsh 帮忙修复」的二次确认位，与重启按钮同一 armed 模式。 */
      const [assistArmed, setAssistArmed] = useState(false);
      /** 修复会话请求的结果提示。 */
      const [assistNote, setAssistNote] = useState(null);
      /** 唤起桌面版自带更新失败时的提示。 */
      const [desktopNote, setDesktopNote] = useState(null);

      const absorb = useCallback((next) => {
        if (next === null || typeof next !== "object" || next.ok === false) {
          setFailed((next && typeof next.error === "string" && next.error.length > 0) ? next.error : t("error.network"));
          return;
        }
        setFailed(null);
        // 宿主在 POST 响应里也返回全量日志（since=0），按 seq 去重，
        // 否则每点一次按钮日志面板就会多一份重复内容。
        const seq = typeof next.seq === "number" ? next.seq : null;
        // 宿主进程重启后 seq 从 0 重新开始：必须丢弃旧游标，否则永远拉不到新内容。
        if (seq !== null && seq < sinceRef.current) sinceRef.current = 0;
        const incoming = (Array.isArray(next.log) ? next.log : []).filter(
          (entry) => entry !== null && typeof entry === "object"
            && typeof entry.seq === "number" && entry.seq > sinceRef.current,
        );
        if (incoming.length > 0) {
          setLog((prev) => {
            const merged = prev.concat(incoming);
            return merged.length > 300 ? merged.slice(merged.length - 300) : merged;
          });
        }
        // 游标只前进不回退；即使本次没有新行（例如被环形缓冲裁掉）也要跟上。
        if (seq !== null) sinceRef.current = Math.max(sinceRef.current, seq);
        setState(next);
      }, [t]);

      const pull = useCallback(async (since) => {
        // 记下请求代次：期间发过 POST 的话，这个响应就是过期数据，必须丢弃。
        // 否则迟到的 /state（更新前是 idle）会把 POST 之后的 updating 覆盖回去，
        // 界面从此不再轮询、看不到更新进度。
        const gen = requestGenRef.current;
        try {
          const next = await transport.state(since);
          if (gen !== requestGenRef.current) return;
          absorb(next);
        } catch (error) {
          // 过期的失败同理：POST 可能已经成功，别用"连不上"盖掉新状态。
          if (gen !== requestGenRef.current) return;
          setFailed(t("error.network"));
        }
      }, [absorb, t]);

      // 首次挂载读一次状态。
      useEffect(() => { void pull(0); }, [pull]);

      const updating = state !== null && state.phase === "updating";
      // 更新期间轮询增量日志；定时器由宿主环境提供，随组件卸载释放。
      useEffect(() => {
        if (!updating) return undefined;
        return runtime.schedulePolling(() => { void pull(sinceRef.current); });
      }, [updating, pull]);

      // 日志面板跟随滚动到底部。
      useEffect(() => {
        const box = logBoxRef.current;
        if (box !== null && box !== undefined) box.scrollTop = box.scrollHeight;
      }, [log]);

      /** arg 原样传给 transport[name]；update 用它指定本次更新的通道。 */
      const act = useCallback(async (name, arg) => {
        if (pendingRef.current !== null) return;
        pendingRef.current = name;
        setPending(name);
        // 使所有在途 GET 失效：本次 POST 的响应才是最新状态。
        requestGenRef.current += 1;
        try {
          absorb(await transport[name](arg));
        } catch (error) {
          setFailed(t("error.network"));
        } finally {
          pendingRef.current = null;
          setPending(null);
        }
      }, [absorb, t]);

      /** 唤起桌面版自带的更新器（与菜单「检查更新…」同一条路径）。 */
      const openDesktopUpdate = useCallback(() => {
        const updates = desktopUpdatesBridge();
        if (updates === null) return;
        setDesktopNote(null);
        Promise.resolve()
          .then(() => updates.open())
          .catch((error) => {
            const reason = error instanceof Error && error.message.length > 0 ? error.message : String(error);
            setDesktopNote(t("desktop.failed", { error: reason }));
          });
      }, [t]);

      /**
       * 桌面版检查更新：先查应用 feed 的版本与策略，只有「有新版本且是 rc/正式版」
       * 才把后续交给应用自带的更新器；alpha 或读不到版本时不驱动官方更新。
       */
      const runDesktopUpdate = useCallback(async () => {
        if (pendingRef.current !== null) return;
        pendingRef.current = "desktopUpdate";
        setPending("desktopUpdate");
        requestGenRef.current += 1;
        try {
          // 用应用当前选中的通道查 feed：界面里可能已经把默认值改成 stable。
          let channel = null;
          try {
            const carrier = desktopUpdatesBridge();
            const channels = carrier !== null && carrier.channels !== undefined ? carrier.channels : null;
            if (channels !== null && typeof channels.get === "function") {
              const current = await channels.get();
              if (current !== null && typeof current === "object" && typeof current.channel === "string") {
                channel = current.channel;
              }
            }
          } catch {
            // 读不到通道就用 app-update.yml 的默认值，不阻塞检查。
          }
          const result = await transport.desktopUpdate({ channel });
          if (result !== null && typeof result === "object") {
            absorb(result);
            const info = result.desktop !== null && typeof result.desktop === "object" ? result.desktop : null;
            if (info !== null && info.ok === true && info.newer === true && info.allowed === true) {
              openDesktopUpdate();
            }
          }
        } catch {
          setFailed(t("error.network"));
        } finally {
          pendingRef.current = null;
          setPending(null);
        }
      }, [absorb, openDesktopUpdate, t]);

      /**
       * 结构化失败包：只有 phase=error 且宿主给了对象才算数。
       * 字段一律当不可信输入处理。
       */
      const failure = state !== null && state.phase === "error"
        && state.failure !== null && typeof state.failure === "object"
        ? state.failure : null;

      /** 复制诊断报告：拉最新的 /api/failure，优先 agentPrompt，缺失时退化为整包 JSON。 */
      const copyDiagnostics = useCallback(async () => {
        if (pendingRef.current !== null) return;
        pendingRef.current = "copyFailure";
        setPending("copyFailure");
        let bundle = failure;
        try {
          const result = await transport.failure();
          if (result !== null && typeof result === "object"
            && result.failure !== null && typeof result.failure === "object") {
            bundle = result.failure;
          }
        } catch {
          // GET 失败就退回 /state 里的失败摘要，至少能复制出基本信息。
        }
        try {
          if (bundle === null) {
            setCopyNote(t("copy.failed"));
            return;
          }
          const payload = typeof bundle.agentPrompt === "string" && bundle.agentPrompt.length > 0
            ? bundle.agentPrompt
            : JSON.stringify(bundle);
          setCopyNote(await writeClipboard(payload) ? t("copy.done") : t("copy.failed"));
        } catch {
          setCopyNote(t("copy.failed"));
        } finally {
          pendingRef.current = null;
          setPending(null);
        }
      }, [failure, t]);

      /** 让 dsh 帮忙修复：POST /api/assist，成功后拉一次状态接上运行中横幅。 */
      const startAssist = useCallback(async () => {
        if (pendingRef.current !== null) return;
        pendingRef.current = "assist";
        setPending("assist");
        setAssistNote(t("assist.pending"));
        try {
          const result = await transport.assist();
          if (result !== null && result.ok === true) {
            const logPath = typeof result.logPath === "string" && result.logPath.length > 0
              ? result.logPath : "?";
            setAssistNote(t("assist.started", { logPath }));
            void pull(0);
          } else {
            // 宿主会给出具体原因（例如已有会话在跑），别用笼统的"连不上"盖掉它。
            const reason = result !== null && typeof result.error === "string" && result.error.length > 0
              ? result.error : t("error.network");
            setAssistNote(t("error.prefix") + reason);
          }
        } catch {
          setAssistNote(t("error.prefix") + t("error.network"));
        } finally {
          pendingRef.current = null;
          setPending(null);
        }
      }, [pull, t]);

      const info = describe(failed !== null && state === null ? null : state, t);
      const snapshot = state === null ? null : (state.snapshot ?? null);
      const busy = pending !== null
        || (state !== null && (state.phase === "checking" || state.phase === "updating"));
      const checking = pending === "check" || (state !== null && state.phase === "checking");
      // 运行指针 / 插件禁用 / 切换结果：字段都当作不可信输入处理，缺了就少显示。
      // 注意：变量名不能叫 runtime —— 那会遮住模块级的客户端运行时对象
      // （runtime.schedulePolling / runtime.mountStyles），"立即更新"时直接渲染崩溃。
      const runtimeInfo = runtimeOf(state);
      /** 宿主开启了「更新完自动重启」：页面会自己断开重连，提前给个提示。 */
      const autoRestart = state !== null && state.autoRestart === true;
      const runtimeMustMigrate = mustMigrateRuntime(runtimeInfo);
      // 桌面版（Electron Host）托管时宿主不允许原地换运行时：只展示信息，不给更新入口。
      const hostLocked = state !== null && state.environment !== null && typeof state.environment === "object"
        && state.environment.canSelfUpdate === false;
      // 宿主类型由服务端判定（Electron Host = 桌面版），不靠页面猜：
      // 桌面版托管的服务即使被浏览器打开，也不能走 git 原地切换。
      const hostDesktop = state !== null && state.environment !== null && typeof state.environment === "object"
        && state.environment.desktop === true;
      // 浏览器页面拿不到 preload 桥，只能提示去桌面版窗口操作。
      const desktopUpdates = desktopUpdatesBridge();
      const desktopMode = hostDesktop;
      const desktopDriveable = desktopMode && desktopUpdates !== null;
      const desktopInfo = state !== null && state.desktop !== null && typeof state.desktop === "object"
        ? state.desktop : null;
      const desktopPending = pending === "desktopUpdate";
      // 桌面版政策：feed 里有更新、但不是 rc/正式版时整条路都不走。
      const desktopAvailable = desktopInfo !== null && desktopInfo.ok === true
        && desktopInfo.newer === true && desktopInfo.allowed === true;
      const desktopSkipped = desktopInfo !== null && desktopInfo.ok === true
        && desktopInfo.newer === true && desktopInfo.allowed === false;
      const canUpdate = snapshot !== null && snapshot.ok !== false && snapshot.isRepo !== false
        && (snapshot.updateAvailable === true || runtimeMustMigrate) && !busy && !hostLocked;
      const showBar = updating;
      const finished = state !== null && state.phase === "done";

      // 桌面版只讲应用更新器：git 通道（含 alpha）属于 Web/CLI 端，不在这里混着展示。
      const desktopError = desktopMode && desktopInfo !== null && typeof desktopInfo.error === "string"
        && desktopInfo.error.length > 0 ? desktopInfo.error : null;
      const text = desktopMode
        ? failed !== null
          ? failed
          : desktopPending
            ? t("desktop.checking")
            : desktopError !== null
              ? desktopError
              : !desktopDriveable
                ? t("desktop.needApp")
                : desktopInfo === null
                  ? t("desktop.idle")
                : desktopSkipped
                  ? t("desktop.skipped", { version: desktopInfo.feedVersion ?? "?" })
                  : desktopAvailable
                    ? t("desktop.available", { version: desktopInfo.feedVersion ?? "?" })
                    : t("desktop.latest", { version: desktopInfo.appVersion ?? "?" })
        : (failed !== null ? failed : info.text);
      const tone = desktopMode
        ? (failed !== null || desktopError !== null ? "error"
          : desktopSkipped || (desktopMode && !desktopDriveable) ? "warn"
            : desktopAvailable ? "brand" : "ok")
        : (failed !== null ? "error" : info.tone);
      const errored = desktopMode
        ? failed !== null || desktopError !== null
        : (info.error === true || failed !== null);

      const detail = desktopMode
        ? (desktopInfo !== null && typeof desktopInfo.appVersion === "string" && desktopInfo.appVersion.length > 0
          ? t("desktop.detail", { version: desktopInfo.appVersion, channel: desktopInfo.channel ?? "?" })
          : null)
        : (() => {
          if (snapshot === null || snapshot.isRepo === false) return null;
          // 缓存/宿主数据形状异常时也不能在这里抛错：宁可少显示一行。
          const head = snapshot.head !== null && typeof snapshot.head === "object" ? snapshot.head : null;
          const short = head !== null && typeof head.short === "string" ? head.short : "?";
          const branch = typeof snapshot.branch === "string" ? snapshot.branch : "?";
          const version = typeof snapshot.version === "string" ? snapshot.version : null;
          return version === null
            ? t("metaNoVersion", { short, branch })
            : t("meta", { version, short, branch });
        })();

      // 更新内容：区间版本 + 条数 + 类型分布；缺哪段就省哪段。
      const changes = changesOf(snapshot, t);
      const changesLine = changes === null ? null : (() => {
        let line = changes.from !== null && changes.to !== null
          ? changes.from + " → " + changes.to + " · " : "";
        line += t("changes.count", { count: changes.total });
        if (changes.summary.length > 0) {
          line += t("changes.detail", { summary: changes.summary.join(" · ") });
        }
        return line;
      })();
      // 当前通道没有更新、上游别处有更新时的提示。
      const elsewhere = elsewhereOf(snapshot);
      const elsewhereLine = elsewhere === null ? null : (() => {
        let line = elsewhere.currentChannel !== null
          ? t("elsewhere.current", { channel: elsewhere.currentChannel })
          : t("elsewhere.currentUnknown");
        if (elsewhere.tag !== null) line += t("elsewhere.tag", { tag: elsewhere.tag });
        if (elsewhere.ahead !== null) line += t("elsewhere.ahead", { count: elsewhere.ahead, ref: elsewhere.ref ?? "upstream" });
        return line + t("elsewhere.action");
      })();
      // 契约：宿主只在当前通道没有更新时给 elsewhere；channel 是这次更新要用的通道。
      // 通道或更新目标缺失、正在检查或更新时不显示该入口。
      const elsewhereUpdatable = elsewhere !== null && elsewhere.channel !== null && elsewhere.label !== null
        && !updating && !hostLocked && !(state !== null && state.phase === "checking");

      const quarantined = state !== null && Array.isArray(state.quarantined) ? state.quarantined : [];
      const switchInfo = state !== null && typeof state.switch === "object" && state.switch !== null ? state.switch : null;
      const runtimeSwitchable = canSwitchRuntime(runtimeInfo);
      const runtimeMismatch = runtimeInfo !== null && runtimeInfo.matchesActive === false;
      const restartReady = !busy && !hostLocked && (finished || runtimeSwitchable);
      const switchError = switchInfo !== null && typeof switchInfo.error === "string" && switchInfo.error.length > 0
        ? switchInfo.error : "?";
      // 桌面版不支持原地切换：上一版留下的切换记录在这里没有可操作性，只展示原因。
      const switchWarn = hostLocked || switchInfo === null
        ? null
        : switchInfo.phase === "ready"
          ? (switchInfo.rolledBack === true ? t("switch.rolledback", { error: switchError }) : null)
          : switchInfo.phase === "failed"
            ? t("switch.failed", { error: switchError })
            : null;
      const switchUrl = !hostLocked && switchInfo !== null && switchInfo.phase === "ready"
        && typeof switchInfo.url === "string" && switchInfo.url.length > 0
        ? switchInfo.url : null;
      // 失败包提示与 AI 修复会话：字段当不可信输入，缺了就少显示。
      const failureHint = failure !== null && typeof failure.hint === "string" && failure.hint.length > 0
        ? failure.hint : null;
      const assistInfo = state !== null && state.assist !== null && typeof state.assist === "object"
        ? state.assist : null;
      const assistRunning = assistInfo !== null && assistInfo.running === true;
      const assistLogPath = assistRunning && typeof assistInfo.logPath === "string" && assistInfo.logPath.length > 0
        ? assistInfo.logPath : null;
      const assistPid = assistRunning && assistInfo.pid !== null && assistInfo.pid !== undefined
        ? String(assistInfo.pid) : "?";

      return h("div", { className: "dsau-root" },
        h("div", { className: "dsau-row" },
          h("div", { className: "dsau-text" },
            h("div", { className: "dsau-title" }, t("title")),
            h("div", { className: "dsau-desc" },
              h("span", { className: "dsau-dot", style: dotStyle(tone) }),
              h("span", { className: errored ? "dsau-err" : null }, text),
            ),
            detail !== null ? h("div", { className: "dsau-meta" }, detail) : null,
            !desktopMode && snapshot !== null && snapshot.updateAvailable === true && snapshot.remote !== null
              && typeof snapshot.remote === "object" && typeof snapshot.remote.short === "string"
              ? h("div", { className: "dsau-meta" }, t("remote", {
                short: snapshot.remote.short,
                subject: typeof snapshot.remote.subject === "string" ? snapshot.remote.subject : "",
              }))
              : null,
            !desktopMode && changesLine !== null ? h("div", { className: "dsau-meta" }, changesLine) : null,
            !desktopMode && changes !== null && changes.items.length > 0
              ? h("details", { className: "dsau-changes" },
                h("summary", { className: "dsau-hint dsau-toggle" },
                  t("changes.toggle", { count: changes.items.length })),
                h("ul", { className: "dsau-list" },
                  changes.items.map((item, index) => h("li", { key: String(index), className: "dsau-meta" },
                    item.subject.length > 0 ? item.short + " · " + clipSubject(item.subject) : item.short))))
              : null,
            !desktopMode && elsewhereLine !== null ? h("div", { className: "dsau-hint" }, elsewhereLine) : null,
            hostLocked
              ? h("div", { className: "dsau-warn" },
                t("host.desktop") + (desktopDriveable ? t("host.desktopBridge") : ""))
              : null,
            !desktopMode && snapshot !== null && snapshot.dirty === true
              ? h("div", { className: "dsau-warn" }, t("dirty", { count: snapshot.dirtyCount }))
              : null,
            // origin 指向别处时明确警告：这决定了会从哪儿拉代码。
            !desktopMode && snapshot !== null && snapshot.originOk === false
              ? h("div", { className: "dsau-warn" }, t("origin.bad", { url: snapshot.originUrl ?? "?" }))
              : null,
            !desktopMode && runtimeMismatch ? h("div", { className: "dsau-warn" }, t("runtime.mismatch")) : null,
            !desktopMode && runtimeSwitchable && !runtimeMismatch
              ? h("div", { className: "dsau-hint" }, t("runtime.ready"))
              : null,
            quarantined.length > 0
              ? h("div", { className: "dsau-warn" }, t("quarantined", { count: quarantined.length, ids: quarantined.join(", ") }))
              : null,
            switchWarn !== null ? h("div", { className: "dsau-warn" }, switchWarn) : null,
            switchUrl !== null
              ? h("div", { className: "dsau-hint" },
                h("a", { href: switchUrl, target: "_blank", rel: "noreferrer" }, t("action.open")))
              : null,
            // 失败提示 / 修复会话状态 / 复制与修复的结果提示：只在对应状态出现。
            failureHint !== null ? h("div", { className: "dsau-warn" }, failureHint) : null,
            assistRunning ? h("div", { className: "dsau-hint" }, t("assist.running", { pid: assistPid })) : null,
            assistLogPath !== null ? h("div", { className: "dsau-hint" }, t("assist.log", { logPath: assistLogPath })) : null,
            copyNote !== null ? h("div", { className: "dsau-hint" }, copyNote) : null,
            assistNote !== null ? h("div", { className: "dsau-hint" }, assistNote) : null,
            desktopNote !== null ? h("div", { className: "dsau-warn" }, desktopNote) : null,
            restartNote !== null ? h("div", { className: "dsau-hint" }, restartNote) : null,
            autoRestart && !hostLocked && restartNote === null
              ? h("div", { className: "dsau-hint" }, t("auto.hint"))
              : null,
          ),
          h("div", { className: "dsau-actions" },
            h("button", {
              type: "button",
              className: "dsau-btn",
              disabled: busy || (desktopMode && !desktopDriveable),
              onClick: () => {
                if (desktopMode) {
                  if (desktopDriveable) void runDesktopUpdate();
                  return;
                }
                void act("check");
              },
            }, desktopMode
              ? (!desktopDriveable
                ? t("action.checkDesktopBrowser")
                : (desktopPending ? t("action.checking") : t("action.checkDesktop")))
              : (checking ? t("action.checking") : t("action.check"))),
            updating
              ? h("button", {
                type: "button",
                className: "dsau-btn",
                disabled: pending !== null,
                onClick: () => { void act("cancel"); },
              }, t("action.cancel"))
              : hostLocked
                ? null
                : h("button", {
                  type: "button",
                  className: "dsau-btn dsau-btn-primary",
                  disabled: !canUpdate,
                  onClick: () => { void act("update"); },
                }, t("action.update")),
            elsewhereUpdatable
              ? h("button", {
                type: "button",
                className: "dsau-btn dsau-btn-primary",
                disabled: pending !== null,
                onClick: () => { void act("update", { channel: elsewhere.channel }); },
              }, t("action.updateOther", { tag: elsewhere.label }))
              : null,
            quarantined.length > 0
              ? h("button", {
                type: "button",
                className: "dsau-btn",
                disabled: pending !== null,
                onClick: () => { void act("retryPlugins"); },
              }, t("action.retryPlugins"))
              : null,
            restartReady
              ? h("button", {
                type: "button",
                className: armed ? "dsau-btn dsau-btn-danger" : "dsau-btn dsau-btn-primary",
                onMouseLeave: () => { setArmed(false); },
                onClick: () => {
                  if (!armed) { setArmed(true); return; }
                  setArmed(false);
                  setRestartNote(t("restart.pending"));
                  void (async () => {
                    try {
                      const result = await transport.restart();
                      if (result !== null && result.ok === true) {
                        setRestartNote(t("restart.started"));
                      } else {
                        // 宿主预检失败时给出的是具体原因，别用笼统的"连不上"盖掉它。
                        const reason = result !== null && typeof result.error === "string" && result.error.length > 0
                          ? result.error
                          : t("error.network");
                        setRestartNote(t("error.prefix") + reason);
                      }
                    } catch {
                      setRestartNote(t("error.prefix") + t("error.network"));
                    }
                  })();
                },
              }, armed ? t("action.restartArmed") : t("action.restart"))
              : null,
            // 失败可交付给 AI 代理：复制完整诊断报告 / 启动 dsh 修复会话。
            failure !== null
              ? h("button", {
                type: "button",
                className: "dsau-btn",
                disabled: pending !== null,
                onClick: () => { void copyDiagnostics(); },
              }, t("action.copyDiagnostics"))
              : null,
            failure !== null && !hostLocked
              ? h("button", {
                type: "button",
                className: assistArmed ? "dsau-btn dsau-btn-danger" : "dsau-btn",
                disabled: pending !== null || assistRunning,
                onMouseLeave: () => { setAssistArmed(false); },
                onClick: () => {
                  if (pendingRef.current !== null || assistRunning) return;
                  if (!assistArmed) { setAssistArmed(true); return; }
                  setAssistArmed(false);
                  void startAssist();
                },
              }, assistArmed ? t("action.assistArmed") : t("action.assist"))
              : null,
          ),
        ),
        showBar
          ? h("div", { className: "dsau-bar" },
            h("div", {
              className: "dsau-bar-fill",
              style: { width: String(STEP_PROGRESS[state.step] ?? 4) + "%" },
            }))
          : null,
        finished ? h("div", { className: "dsau-hint" }, t("rollback.hint")) : null,
        log.length > 0
          ? h("div", { className: "dsau-hint dsau-log-toggle" },
            h("button", {
              type: "button",
              className: "dsau-btn",
              style: { height: "28px", fontSize: "12px", marginTop: "8px" },
              onClick: () => { setShowLog((value) => !value); },
            }, showLog ? t("action.logHide") : t("action.log")))
          : null,
        showLog && log.length > 0
          ? h("pre", { className: "dsau-log", ref: logBoxRef },
            log.map((entry) => entry.line).join("\n"))
          : null,
      );
    }

    /** 渲染错误必须以可见文字呈现，不能白屏。 */
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error) {
        console.error("[dsh-auto-update] row render error:", error);
      }
      render() {
        if (this.state.error !== null) {
          const t = translate;
          return h("div", { className: "dsau-root" },
            h("div", { className: "dsau-err" },
              t("render.error"),
              this.state.error instanceof Error ? this.state.error.message : String(this.state.error)),
          );
        }
        return h(UpdaterRow);
      }
    }

    const inject = ["slots", "locale", "timer"];
    function apply(ctx) {
      runtime = createRuntime(ctx);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "auto-update: dictionaries");
      translate = ctx.locale.bind(NS);
      // 样式随插件生命周期挂载/卸载，不污染全局。
      ctx.effect(() => runtime.mountStyles(), "auto-update: styles");
      // 用自有 id 注册，避免占用其他插件的行。
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "auto-update",
        order: 30,
        locale: NS,
        inject: () => ({}),
      }, ErrorBoundary));
    }


    return { apply, inject };
