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
      update: () => host.call("update", {}),
      cancel: () => host.call("cancel", {}),
      restart: () => host.call("restart", {}),
    };

    const zh = {
      "title": "DSH 更新",
      "loading": "正在读取版本信息…",
      "checking": "正在向 GitHub 检查上游提交…",
      "updating": "正在更新",
      "done": "更新完成，重启 dsh web 后生效",
      "idle.latest": "已是最新版本",
      "idle.never": "尚未检测，点「检查更新」比对上游提交",
      "error.unknown": "更新出错了，请展开日志查看原因",
      // 注意：locale 字典的值必须是字符串，参数走 {占位符} 插值。
      // 写成 (n) => ... 只是在不传 params 时侥幸能用，传了就会炸。
      "idle.available": "发现 {count} 个新提交可更新",
      "meta": "当前 {version} · {short} · {branch}",
      "metaNoVersion": "当前 {short} · {branch}",
      "dirty": "工作区有 {count} 项未提交改动（更新前会自动 stash）",
      "remote": "上游 {short} · {subject}",
      "origin.bad": "origin 指向的不是预期仓库，更新会被拒绝：{url}",
      "action.check": "检查更新",
      "action.checking": "检查中…",
      "action.update": "立即更新",
      "action.updating": "更新中…",
      "action.cancel": "取消",
      "action.log": "查看日志",
      "action.logHide": "收起日志",
      "action.restart": "重启生效",
      "action.restartArmed": "确认重启？",
      "restart.hint": "重启会中断当前正在跑的对话，请先确认。",
      "restart.pending": "正在重启，本页稍后会断开…",
      "restart.started": "重启指令已发出，页面稍后会自动重连。",
      "error.prefix": "出错了：",
      "error.network": "无法连接到 dsh 宿主进程",
      "step.snapshot": "记录回滚点",
      "step.pull": "拉取上游提交",
      "step.install": "安装依赖",
      "step.build": "构建产物",
      "rollback.hint": "如需回滚：git checkout dsh-rollback && pnpm install && pnpm run build",
      "render.error": "界面渲染出错了：",
    };
    const en = {
      "title": "DSH Updates",
      "loading": "Reading version information…",
      "checking": "Checking upstream commits on GitHub…",
      "updating": "Updating",
      "done": "Update finished — restart dsh web to apply",
      "idle.latest": "Up to date",
      "idle.never": "Not checked yet — click Check to compare with upstream",
      "error.unknown": "Update failed — expand the log for details",
      "idle.available": "{count} new commit(s) available",
      "meta": "{version} · {short} · {branch}",
      "metaNoVersion": "{short} · {branch}",
      "dirty": "{count} uncommitted change(s) — stashed automatically before updating",
      "remote": "upstream {short} · {subject}",
      "origin.bad": "origin is not the expected repository; updates are refused: {url}",
      "action.check": "Check",
      "action.checking": "Checking…",
      "action.update": "Update now",
      "action.updating": "Updating…",
      "action.cancel": "Cancel",
      "action.log": "Show log",
      "action.logHide": "Hide log",
      "action.restart": "Restart",
      "action.restartArmed": "Confirm restart?",
      "restart.hint": "Restarting interrupts running conversations.",
      "restart.pending": "Restarting — this page will disconnect shortly…",
      "restart.started": "Restart requested; the page will reconnect shortly.",
      "error.prefix": "Error: ",
      "error.network": "Cannot reach the dsh host process",
      "step.snapshot": "Recording rollback point",
      "step.pull": "Pulling upstream commits",
      "step.install": "Installing dependencies",
      "step.build": "Building artifacts",
      "rollback.hint": "To roll back: git checkout dsh-rollback && pnpm install && pnpm run build",
      "render.error": "Render error: ",
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
`;

    /** 步骤 → 进度百分比（构建最耗时，权重最大）。 */
    const STEP_PROGRESS = { snapshot: 8, pull: 22, install: 42, build: 84, done: 100 };

    /** 状态点颜色：可用/成功用品牌色，失败用错误色。 */
    function dotStyle(tone) {
      if (tone === "brand") return { background: "var(--dsw-alias-brand-primary)" };
      if (tone === "ok") return { background: "var(--dsw-alias-state-success-primary)" };
      if (tone === "error") return { background: "var(--dsw-alias-state-error-primary)" };
      if (tone === "warn") return { background: "var(--dsw-alias-state-warn-primary)" };
      return undefined;
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
      if (snapshot === null || snapshot === undefined) return { text: t("idle.never"), tone: "muted" };
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
        return { text: t("idle.available", { count: snapshot.behind }), tone: "brand" };
      }
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
        try {
          absorb(await transport.state(since));
        } catch (error) {
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

      const act = useCallback(async (name) => {
        if (pendingRef.current !== null) return;
        pendingRef.current = name;
        setPending(name);
        try {
          absorb(await transport[name]());
        } catch (error) {
          setFailed(t("error.network"));
        } finally {
          pendingRef.current = null;
          setPending(null);
        }
      }, [absorb, t]);

      const info = describe(failed !== null && state === null ? null : state, t);
      const snapshot = state === null ? null : (state.snapshot ?? null);
      const busy = pending !== null
        || (state !== null && (state.phase === "checking" || state.phase === "updating"));
      const checking = pending === "check" || (state !== null && state.phase === "checking");
      const canUpdate = snapshot !== null && snapshot.ok !== false && snapshot.isRepo !== false
        && snapshot.updateAvailable === true && !busy;
      const showBar = updating;
      const finished = state !== null && state.phase === "done";

      const text = failed !== null ? failed : info.text;
      const tone = failed !== null ? "error" : info.tone;

      const detail = (() => {
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

      return h("div", { className: "dsau-root" },
        h("div", { className: "dsau-row" },
          h("div", { className: "dsau-text" },
            h("div", { className: "dsau-title" }, t("title")),
            h("div", { className: "dsau-desc" },
              h("span", { className: "dsau-dot", style: dotStyle(tone) }),
              h("span", { className: info.error === true || failed !== null ? "dsau-err" : null }, text),
            ),
            detail !== null ? h("div", { className: "dsau-meta" }, detail) : null,
            snapshot !== null && snapshot.updateAvailable === true && snapshot.remote !== null
              && typeof snapshot.remote === "object" && typeof snapshot.remote.short === "string"
              ? h("div", { className: "dsau-meta" }, t("remote", {
                short: snapshot.remote.short,
                subject: typeof snapshot.remote.subject === "string" ? snapshot.remote.subject : "",
              }))
              : null,
            snapshot !== null && snapshot.dirty === true
              ? h("div", { className: "dsau-warn" }, t("dirty", { count: snapshot.dirtyCount }))
              : null,
            // origin 指向别处时明确警告：这决定了会从哪儿拉代码。
            snapshot !== null && snapshot.originOk === false
              ? h("div", { className: "dsau-warn" }, t("origin.bad", { url: snapshot.originUrl ?? "?" }))
              : null,
            restartNote !== null ? h("div", { className: "dsau-hint" }, restartNote) : null,
          ),
          h("div", { className: "dsau-actions" },
            h("button", {
              type: "button",
              className: "dsau-btn",
              disabled: busy,
              onClick: () => { void act("check"); },
            }, checking ? t("action.checking") : t("action.check")),
            updating
              ? h("button", {
                type: "button",
                className: "dsau-btn",
                disabled: pending !== null,
                onClick: () => { void act("cancel"); },
              }, t("action.cancel"))
              : h("button", {
                type: "button",
                className: "dsau-btn dsau-btn-primary",
                disabled: !canUpdate,
                onClick: () => { void act("update"); },
              }, t("action.update")),
            finished
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
