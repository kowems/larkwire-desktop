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
    pairCancel: $("pair-cancel"),
    pairCancelError: $("pair-cancel-error"),
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
    // phones
    phonesDetails: $("phones-details"),
    phonesBadge: $("phones-badge"),
    phonesList: $("phones-list"),
    phonesEmpty: $("phones-empty"),
    pairAddBtn: $("pair-add-btn"),
    // #76 导航
    navItems: document.querySelectorAll(".nav-item"),
    tabs: document.querySelectorAll(".tab"),
    navBadges: document.querySelectorAll("[data-nav-badge]"),
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

  /** #77 项目组展开态：renderer 本地数组（口径同手机 sessions.vue），跨状态渲染保持 */
  const expandedProjects = [];

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
    renderSessionGroups(sessions);

    renderPhones(st, snap);
    renderGuard(st.guard);
    renderNav(snap, st);
  }

  /**
   * #77 会话按项目分组渲染（口径对齐手机 sessions.vue）：默认全收起，
   * 组头 ▸/▾ + 项目名 + N 个 · 最近时间；展开态跨渲染按 expandedProjects 恢复。
   */
  function renderSessionGroups(sessions) {
    const sorted = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const byProject = new Map();
    for (const s of sorted) {
      const key = s.project || "未分组";
      const items = byProject.get(key);
      if (items) items.push(s);
      else byProject.set(key, [s]);
    }
    const groups = [...byProject.entries()]
      .map(([project, items]) => ({ project, items, latest: items[0]?.lastActiveAt ?? 0 }))
      .sort((a, b) => {
        // 「未分组」永远最后；其余按组内最新活跃倒序，同值按项目名字典序防抖跳
        const ua = a.project === "未分组" ? 0 : 1;
        const ub = b.project === "未分组" ? 0 : 1;
        return ub - ua || b.latest - a.latest || a.project.localeCompare(b.project);
      });

    for (const g of groups) {
      const isOpen = expandedProjects.includes(g.project);

      const li = document.createElement("li");
      li.className = "session-group";

      const head = document.createElement("button");
      head.type = "button";
      head.className = "group-head";
      head.dataset.testid = "group-head";
      const arrow = document.createElement("span");
      arrow.className = "group-arrow";
      arrow.textContent = isOpen ? "▾" : "▸";
      const name = document.createElement("span");
      name.className = "group-name";
      name.textContent = g.project;
      const meta = document.createElement("span");
      meta.className = "group-meta";
      meta.textContent = `${g.items.length} 个 · ${relTime(g.latest)}`;
      head.append(arrow, name, meta);
      head.addEventListener("click", () => {
        const i = expandedProjects.indexOf(g.project);
        if (i >= 0) expandedProjects.splice(i, 1);
        else expandedProjects.push(g.project);
        itemsEl.classList.toggle("hidden", i >= 0); // i>=0 = 原展开→收起
        arrow.textContent = i >= 0 ? "▸" : "▾";
      });

      const itemsEl = document.createElement("ul");
      itemsEl.className = "group-items";
      if (!isOpen) itemsEl.classList.add("hidden");
      for (const s of g.items) itemsEl.appendChild(buildSessionRow(s));

      li.append(head, itemsEl);
      els.sessionsList.appendChild(li);
    }
  }

  /** #77 会话行（重构前平铺渲染的单行原样抽出）：标题/项目 + 占用徽章与动作按钮 */
  function buildSessionRow(s) {
    const row = document.createElement("li");
    row.dataset.session = s.sessionId;

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

    row.append(left, actions);
    return row;
  }

  /** #76 左栏导航角标：会话数 / 手机在线 / 守护状态 */
  function renderNav(snap, st) {
    const set = (key, text, extraClass = "") => {
      const el = [...els.navBadges].find((b) => b.dataset.navBadge === key);
      if (!el) return;
      el.textContent = text;
      el.className = `nav-badge ${extraClass}`;
    };
    const sessions = snap ? snap.sessions.length : 0;
    set("sessions", sessions > 0 ? String(sessions) : "");
    const online = snap ? snap.onlinePhones : 0;
    const total = (st.paired || []).length;
    set("phones", total > 0 ? `${online}/${total}` : "", online > 0 ? "badge-ok" : "badge-dim");
    set("guard", st.guard ? (st.guard.enabled ? "看护中" : "已停用") : "",
      st.guard && st.guard.enabled ? "badge-ok" : "badge-dim");
  }

  /** #76 tab 切换：纯 renderer 本地状态，不进 StatePayload */
  function switchTab(tab) {
    for (const item of els.navItems) item.classList.toggle("active", item.dataset.tab === tab);
    for (const t of els.tabs) t.classList.toggle("hidden", t.id !== `tab-${tab}` && t.id !== `${tab}-details`);
  }

  /** 我的手机面板：配对名单（config 名字）+ 在线数徽章；离线时引导按下方按钮重配 */
  function renderPhones(st, snap) {
    const online = snap ? snap.onlinePhones : 0;
    const paired = st.paired || [];
    if (online > 0) {
      els.phonesBadge.textContent = `${online}/${paired.length} 在线`;
      els.phonesBadge.className = "badge badge-ok";
    } else {
      els.phonesBadge.textContent = "全部离线";
      els.phonesBadge.className = "badge badge-dim";
    }
    els.phonesList.textContent = "";
    show(els.phonesEmpty, paired.length === 0);
    // 底部按钮：一台都没有时是首配入口，已有手机时是追加
    els.pairAddBtn.textContent = paired.length === 0 ? "配对手机" : "＋ 添加手机";
    for (const p of paired) {
      const li = document.createElement("li");
      li.dataset.testid = "paired-phone";
      const left = document.createElement("span");
      left.textContent = `📱 ${p.name}`;
      const actions = document.createElement("span");
      actions.className = "phone-actions";
      const repairBtn = document.createElement("button");
      repairBtn.type = "button";
      repairBtn.className = "s-btn";
      repairBtn.dataset.testid = "phone-repair";
      repairBtn.textContent = "重新配对";
      repairBtn.addEventListener("click", () => {
        if (!confirm(`将解除与「${p.name}」的绑定并显示二维码——同一台手机或新手机扫码即可完成替换。继续？`)) return;
        repairBtn.disabled = true;
        api.pairRevoke(p.deviceId).then((ok) => {
          if (!ok) {
            repairBtn.disabled = false;
            alert("解绑失败：桥未启动或该手机已不在列表");
            return;
          }
          // 旧配对已清（手机侧会收到撤销弹窗），紧接着亮码接新扫码
          api.pairStart();
        });
      });
      const unpairBtn = document.createElement("button");
      unpairBtn.type = "button";
      unpairBtn.className = "s-btn danger";
      unpairBtn.dataset.testid = "phone-unpair";
      unpairBtn.textContent = "解除绑定";
      unpairBtn.addEventListener("click", () => {
        if (!confirm(`确定解除与「${p.name}」的绑定？解绑后这台手机将无法连接本机。`)) return;
        unpairBtn.disabled = true;
        api.pairRevoke(p.deviceId).then((ok) => {
          if (!ok) {
            unpairBtn.disabled = false;
            alert("解绑失败：桥未启动或该手机已不在列表");
          }
        });
      });
      actions.appendChild(repairBtn);
      actions.appendChild(unpairBtn);
      li.appendChild(left);
      li.appendChild(actions);
      els.phonesList.appendChild(li);
    }
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
  for (const item of els.navItems) {
    item.addEventListener("click", () => switchTab(item.dataset.tab));
  }
  api.onState(renderState);
  api.onLog((line) => {
    appendLog(els.pairLog, line);
    appendLog(els.mainLog, line);
  });
  // 配对帧处理：实时事件与启动快照回补走同一份函数（避免两路口径漂移）
  const handlePairUrl = ({ dataUrl, pairUrl, bridgeFp }) => {
    els.qr.src = dataUrl;
    show(els.qr, true);
    show(els.qrWaiting, false);
    els.pairUrl.textContent = pairUrl;
    els.bridgeFp.textContent = bridgeFp;
  };
  const handlePairFp = (ctx) => {
    els.fpBridge.textContent = ctx.bridgeFp;
    els.fpPhone.textContent = ctx.phoneFp;
    els.fpPhoneName.textContent = ctx.phoneName ? `（${ctx.phoneName}）` : "";
    show(els.fpPanel, true);
  };
  const handlePairError = ({ message }) => {
    els.pairErrorMsg.textContent = message;
    show(els.pairError, true);
    show(els.fpPanel, false);
  };
  // 配对视图复位：主进程 startPairFlow 统一发（进视图/重试）——QR/指纹/错误全回初态
  const handlePairReset = () => {
    show(els.pairError, false);
    els.qr.removeAttribute("src");
    show(els.qr, false);
    show(els.qrWaiting, true);
    els.fpPanel.classList.add("hidden");
  };
  api.onPairUrl(handlePairUrl);
  api.onPairFp(handlePairFp);
  api.onPairError(handlePairError);
  api.onPairReset(handlePairReset);

  els.fpYes.addEventListener("click", () => {
    show(els.fpPanel, false);
    api.pairConfirm(true);
  });
  els.fpNo.addEventListener("click", () => {
    show(els.fpPanel, false);
    api.pairConfirm(false);
  });
  els.pairRetry.addEventListener("click", () => {
    api.pairRetry();
  });
  els.pairCancel.addEventListener("click", () => api.pairCancel());
  els.pairCancelError.addEventListener("click", () => api.pairCancel());
  els.pairAddBtn.addEventListener("click", () => {
    if (!window.confirm("将暂停桥并显示配对二维码，手机扫码配对后自动恢复。继续？")) return;
    api.pairStart();
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

  // 配对帧同理：握手极快时 pair:url 可能早于上面的监听器注册，主进程只留不重放。
  // 监听器全部就位后拉一次最近配对帧回补——无快照（已进主界面）则什么都不做。
  api.getPairSnapshot().then((frame) => {
    if (!frame) return;
    if (frame.phase === "reset") handlePairReset();
    else if (frame.phase === "url") handlePairUrl(frame.data);
    else if (frame.phase === "fp") handlePairFp(frame.data);
    else if (frame.phase === "error") handlePairError(frame.data);
  });
}
