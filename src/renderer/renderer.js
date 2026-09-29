/* 灵鹊桌面 renderer（vanilla 无框架）：两视图切换 + 状态渲染 + 日志窗。
 * 全部数据来自 window.larkwire（preload contextBridge）——本文件不直连 node。 */
"use strict";

const api = window.larkwire;
if (!api) {
  document.getElementById("preload-fail").classList.remove("hidden");
} else {
  main(api);
}

function main(api) {
  const $ = (id) => document.getElementById(id);
  const els = {
    viewPair: $("view-pair"),
    viewMain: $("view-main"),
    // pair
    qr: $("qr"),
    qrWaiting: $("qr-waiting"),
    pairUrl: $("pair-url"),
    bridgeFp: $("bridge-fp"),
    fpPanel: $("fp-panel"),
    fpBridge: $("fp-bridge"),
    fpPhone: $("fp-phone"),
    fpPhoneName: $("fp-phone-name"),
    fpYes: $("fp-yes"),
    fpNo: $("fp-no"),
    pairError: $("pair-error"),
    pairErrorMsg: $("pair-error-msg"),
    pairRetry: $("pair-retry"),
    pairLog: $("pair-log"),
    // main
    connDot: $("conn-dot"),
    connText: $("conn-text"),
    phonesText: $("phones-text"),
    permBadge: $("perm-badge"),
    loginitemCb: $("loginitem-cb"),
    noticeBanner: $("notice-banner"),
    noticeMsg: $("notice-msg"),
    fatalBanner: $("fatal-banner"),
    fatalMsg: $("fatal-msg"),
    sessionsList: $("sessions-list"),
    sessionsCount: $("sessions-count"),
    sessionsEmpty: $("sessions-empty"),
    mainLog: $("main-log"),
    // guard
    guardBadge: $("guard-state-badge"),
    guardEnabledCb: $("guard-enabled-cb"),
    guardMeta: $("guard-meta"),
    guardSuspectsWrap: $("guard-suspects-wrap"),
    guardSuspects: $("guard-suspects"),
    guardEvents: $("guard-events"),
    guardEventsEmpty: $("guard-events-empty"),
  };

  const LOG_CAP = 500;

  function show(el, on) {
    el.classList.toggle("hidden", !on);
  }

  function appendLog(pre, line) {
    pre.textContent += line + "\n";
    // 封顶：按行截头（textContent 单字符串操作，500 行量级无性能问题）
    const lines = pre.textContent.split("\n");
    if (lines.length > LOG_CAP) pre.textContent = lines.slice(lines.length - LOG_CAP).join("\n");
    pre.scrollTop = pre.scrollHeight;
  }

  function relTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 45_000) return "刚刚";
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    if (sameDay) return d.toTimeString().slice(0, 5);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function renderState(st) {
    show(els.viewPair, st.view === "pair");
    show(els.viewMain, st.view === "main");
    if (st.view !== "main") return;

    const snap = st.snap;
    els.connDot.classList.toggle("on", !!(snap && snap.connected));
    els.connText.textContent = snap
      ? snap.connected
        ? `已连中继 ${snap.relay}`
        : "中继连接中…"
      : "桥未启动";
    els.phonesText.textContent = snap
      ? `${snap.onlinePhones}/${snap.pairedPhones} 台手机在线`
      : "— 台手机";
    const perms = snap ? snap.pendingPermissions : 0;
    show(els.permBadge, perms > 0);
    if (perms > 0) els.permBadge.textContent = `${perms} 张权限卡待答`;

    show(els.noticeBanner, !!st.notice);
    if (st.notice) els.noticeMsg.textContent = st.notice;

    show(els.fatalBanner, !!st.fatal);
    if (st.fatal) els.fatalMsg.textContent = st.fatal;

    if (els.loginitemCb.checked !== st.loginItem) els.loginitemCb.checked = st.loginItem;

    const sessions = snap ? snap.sessions : [];
    els.sessionsCount.textContent = sessions.length ? `（${sessions.length}）` : "";
    show(els.sessionsEmpty, sessions.length === 0);
    els.sessionsList.textContent = "";
    const sorted = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    for (const s of sorted) {
      const li = document.createElement("li");
      li.dataset.session = s.sessionId;

      const left = document.createElement("div");
      left.className = "s-left";
      const title = document.createElement("span");
      title.className = "s-title";
      title.textContent = s.title || s.project;
      const meta = document.createElement("span");
      meta.className = "s-meta dim";
      meta.textContent = `${s.project} · ${relTime(s.lastActiveAt)}`;
      left.append(title, meta);

      const actions = document.createElement("span");
      actions.className = "s-actions";
      const badge = buildOccupancy(s, actions); // 内部先挂按钮
      actions.prepend(badge); // 徽章永远在最左

      li.append(left, actions);
      els.sessionsList.appendChild(li);
    }

    renderGuard(st.guard);
  }

  /** 系统守护面板（#72）：开关 / 口径 / 可疑进程 / 处置记录 */
  function renderGuard(g) {
    if (!g) {
      els.guardBadge.textContent = "";
      return;
    }
    if (els.guardEnabledCb.checked !== g.enabled) els.guardEnabledCb.checked = g.enabled;

    if (g.enabled) {
      els.guardBadge.textContent = "看护中";
      els.guardBadge.className = "badge badge-ok";
    } else {
      els.guardBadge.textContent = "已停用";
      els.guardBadge.className = "badge badge-dim";
    }
    els.guardMeta.textContent =
      `看护 ${g.watching} 个进程 · 阈值 ${g.threshold}% · 持续 ${Math.round(g.sustainSecs / 60)} 分钟`;

    els.guardSuspects.textContent = "";
    show(els.guardSuspectsWrap, g.suspects.length > 0);
    for (const x of g.suspects) {
      const li = document.createElement("li");
      li.dataset.testid = "guard-suspect";
      li.textContent = `PID ${x.pid} · CPU ${x.cpu}% · 已持续约 ${Math.round(x.sustainedSecs)}s`;
      els.guardSuspects.appendChild(li);
    }

    els.guardEvents.textContent = "";
    show(els.guardEventsEmpty, g.events.length === 0);
    for (const ev of g.events) {
      const li = document.createElement("li");
      li.dataset.testid = "guard-event";
      const t = document.createElement("span");
      t.className = "guard-ts mono dim";
      t.textContent = ev.ts;
      const txt = document.createElement("span");
      txt.textContent = ev.text;
      li.append(t, txt);
      els.guardEvents.appendChild(li);
    }
  }

  /**
   * WP5 #49：占用徽章 + 按态出钮。
   * 💻别窗=可杀后接管（二次确认）；🖥终端共驾=无钮（手机发话直接注入，接管请去终端）；
   * 📱手机=先还回；空闲=直接终端接管。返回的徽章节点（按钮已挂在 actions 容器上）。
   */
  function buildOccupancy(s, actions) {
    const occ = s.occupancy || { state: "free", via: "none" };
    const badge = document.createElement("span");
    badge.className = `s-occ occ-${occ.state}`;
    badge.dataset.occupancy = occ.state;
    const mkBtn = (text, kind, testid, onClick) => {
      const b = document.createElement("button");
      b.className = `s-btn ${kind}`;
      b.textContent = text;
      b.dataset.testid = testid;
      b.addEventListener("click", onClick);
      actions.append(b);
      return b;
    };
    const note = (line) => appendLog(els.mainLog, line);

    if (occ.state === "desktop") {
      badge.textContent = `💻 PID ${occ.pid ?? "?"}`;
      badge.title = "另一个窗口（IDE 等）正在使用该会话";
      mkBtn("⚡ 关掉该窗口并接管", "danger", "btn-killopen", () => {
        if (!window.confirm(`将向 PID ${occ.pid ?? "?"} 发退出信号（SIGTERM，优雅退出不丢历史），然后在终端打开该会话。继续？`)) return;
        note(`正在关闭 PID ${occ.pid ?? "?"} 并接管 ${s.sessionId.slice(0, 8)}…`);
        void api.killOpen(s.sessionId).then((r) => {
          note(r.ok ? `✅ 已关闭旧窗口（PID ${r.pid}），终端已拉起` : `✗ ${r.reason ?? "接管失败"}`);
        });
      });
    } else if (occ.state === "terminal") {
      badge.textContent = occ.pid ? `🖥 终端 · PID ${occ.pid}` : "🖥 终端";
      badge.title = "终端共驾中：手机发话会直接注入该终端；想自己接管请去终端窗口操作";
      // 无按钮——terminal 态不做强杀（plan 明文：去终端里自己退出或用 tmux 共驾）
    } else if (occ.state === "phone") {
      badge.textContent = "📱 手机接管";
      badge.title = "手机正在持有该会话";
      mkBtn("↩ 还回", "", "btn-release", () => {
        void api.releaseSession(s.sessionId).then((went) => {
          note(went ? `已请手机还回 ${s.sessionId.slice(0, 8)}…` : "该会话当前没有手机持有（无需还回）");
        });
      });
    } else {
      badge.textContent = "空闲";
      mkBtn("▶ 终端接管", "primary", "btn-terminal", () => {
        note(`正在终端打开 ${s.sessionId.slice(0, 8)}…`);
        void api.openTerminal(s.sessionId).then((r) => {
          note(r.ok ? "✅ Terminal 已拉起，正在 resume…" : `✗ ${r.reason ?? "终端启动失败"}`);
        });
      });
    }
    return badge;
  }

  // ---- 事件接线 ----
  api.onState(renderState);
  api.onLog((line) => {
    appendLog(els.pairLog, line);
    appendLog(els.mainLog, line);
  });
  api.onPairUrl(({ dataUrl, pairUrl, bridgeFp }) => {
    els.qr.src = dataUrl;
    show(els.qr, true);
    show(els.qrWaiting, false);
    els.pairUrl.textContent = pairUrl;
    els.bridgeFp.textContent = bridgeFp;
  });
  api.onPairFp((ctx) => {
    els.fpBridge.textContent = ctx.bridgeFp;
    els.fpPhone.textContent = ctx.phoneFp;
    els.fpPhoneName.textContent = ctx.phoneName ? `（${ctx.phoneName}）` : "";
    show(els.fpPanel, true);
  });
  api.onPairError(({ message }) => {
    els.pairErrorMsg.textContent = message;
    show(els.pairError, true);
    show(els.fpPanel, false);
  });

  els.fpYes.addEventListener("click", () => {
    show(els.fpPanel, false);
    api.pairConfirm(true);
  });
  els.fpNo.addEventListener("click", () => {
    show(els.fpPanel, false);
    api.pairConfirm(false);
  });
  els.pairRetry.addEventListener("click", () => {
    show(els.pairError, false);
    els.qr.removeAttribute("src");
    show(els.qr, false);
    show(els.qrWaiting, true);
    api.pairRetry();
  });
  els.loginitemCb.addEventListener("change", () => {
    api.setLoginItem(els.loginitemCb.checked);
  });
  els.guardEnabledCb.addEventListener("change", () => {
    // 主进程 setEnabled 后会回推 state，renderGuard 同步最终态
    void api.setGuardEnabled(els.guardEnabledCb.checked);
  });

  // 首帧：拉一次全量状态（事件可能先于 JS 就绪到达）
  api.getState().then(renderState);
}
