/* Antigravity Quota Capsule v1.1.1 — Injected Composer Widget (Shadow DOM + Portal Popover) */
(() => {
  const VERSION = "1.1.1";

  // Clean up any prior injection cleanly (idempotent hot-reload safe)
  if (typeof window.__agQuotaCapsuleCleanup === "function") {
    try {
      window.__agQuotaCapsuleCleanup();
    } catch {
      // ignore
    }
  }

  const MODEL_RE =
    /(gemini|claude|gpt|opus|sonnet|haiku|neon|carbon|hydrogen|argon|helium|lithium|flash|pro|ultra|o1|o3|o4|选择模型|select\s+model)/i;
  const MODE_RE =
    /(极速|turbo|规划|planning|标准|standard|fast|review|strict|auto|agent|safe|permission|execution|自动|审查|严格)/i;
  const GEMINI_RE = /\b(gemini|neon|carbon|hydrogen|argon|helium|lithium|flash)\b|gemini/i;
  const CLAUDE_GPT_RE = /\b(claude|gpt|opus|sonnet|haiku|o1|o3|o4|chatgpt|openai|anthropic)\b/i;
  const QUOTA_HINT_RE = /(周限额|5\s*小时\s*限额|weekly\s*(?:limit|quota)|5\s*[- ]?\s*hour\s*(?:limit|quota))/i;
  const TRIGGER_RE = /(额度|限额|用量|quota|usage|credits|plan|pro|ultra|account|profile|账号|账户)/i;
  const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const state = {
    config: {
      enabled: true,
      language: "zh",
      density: "auto",
      openOnHover: false,
      autoSyncOnClick: true,
      showCountdownInPill: true,
      demoMode: false,
      customTriggerKeyword: "",
    },
    quota: {
      geminiWeekly: { remainingPercent: -1, resetAtMs: 0, rawResetText: "" },
      geminiFiveHour: { remainingPercent: -1, resetAtMs: 0, rawResetText: "" },
      claudeGptWeekly: { remainingPercent: -1, resetAtMs: 0, rawResetText: "" },
      claudeGptFiveHour: { remainingPercent: -1, resetAtMs: 0, rawResetText: "" },
      capturedAtMs: 0,
      source: "",
    },
    activeModelName: "",
    activeGroup: "unknown",
    popoverOpen: false,
    pinnedByClick: false,
    isSyncing: false,
    syncHint: "",
    listenUntilMs: 0,
    slotWidth: 260,
    isDark: true,
  };

  let pillHost = null;
  let pillShadow = null;
  let popoverHost = null;
  let popoverShadow = null;
  let hoverCloseTimer = null;
  let mountRaf = 0;
  let lastQuotaSignature = "";
  let lastMountReportMs = 0;
  let resizeObserver = null;
  let domObserver = null;
  let tickTimer = null;
  let passiveQuotaTimer = null;

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function emitToSidecar(obj) {
    try {
      if (typeof window.__agQuotaCapsuleEmit === "function") {
        window.__agQuotaCapsuleEmit(JSON.stringify(obj));
      }
    } catch {
      // ignore if binding not ready
    }
  }

  function detectDarkTheme() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor || "";
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const lum = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]);
        return lum < 128;
      }
    } catch {
      // fallback
    }
    return window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : true;
  }

  function classifyModelGroup(name) {
    if (!name) return "unknown";
    if (CLAUDE_GPT_RE.test(name)) return "claudeGpt";
    if (GEMINI_RE.test(name)) return "gemini";
    return "unknown";
  }

  function isValidMetric(m) {
    return Boolean(m && typeof m.remainingPercent === "number" && m.remainingPercent >= 0 && m.remainingPercent <= 100);
  }

  function hasAnyData(q) {
    return (
      q &&
      (isValidMetric(q.geminiWeekly) ||
        isValidMetric(q.geminiFiveHour) ||
        isValidMetric(q.claudeGptWeekly) ||
        isValidMetric(q.claudeGptFiveHour))
    );
  }

  function isNativeSyncedRecently() {
    const src = state.quota?.source || "";
    return (
      (src === "NativeRPC" || src === "Native") &&
      state.quota.capturedAtMs > 0 &&
      Date.now() - state.quota.capturedAtMs < 5 * 60 * 1000
    );
  }

  function getQuotaColor(pct, dimmed) {
    let hex = "#7c8492";
    if (pct === 0) hex = state.isDark ? "#525763" : "#b0b6c2";
    else if (pct > 0 && pct < 20) hex = "#e45c5c";
    else if (pct >= 20 && pct < 50) hex = "#e8ac3e";
    else if (pct >= 50) hex = "#5cb062";
    return dimmed ? `${hex}90` : hex;
  }

  function renderRingSvg(pct, size, stroke, dimmed) {
    const r = (size - stroke) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const circ = 2 * Math.PI * r;
    const validPct = pct > 0 ? Math.min(100, pct) : 0;
    const dashOffset = circ * (1 - validPct / 100);
    const track = state.isDark
      ? dimmed
        ? "rgba(92,98,112,0.35)"
        : "rgba(92,98,112,0.58)"
      : dimmed
        ? "rgba(180,188,200,0.45)"
        : "rgba(180,188,200,0.75)";
    const color = getQuotaColor(pct, dimmed);
    const arc =
      validPct > 0
        ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${dashOffset.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
        : "";
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;flex:0 0 auto;">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${track}" stroke-width="${stroke}"/>
      ${arc}
    </svg>`;
  }

  function formatShortReset(metric, nowMs, zh) {
    if (!metric || !metric.resetAtMs) return "";
    const diff = metric.resetAtMs - nowMs;
    if (diff <= 0) return zh ? "已重置" : "Reset";
    if (diff < 60000) return "<1m";
    const minsTotal = Math.ceil(diff / 60000);
    const d = Math.floor(minsTotal / 1440);
    const h = Math.floor((minsTotal % 1440) / 60);
    const m = minsTotal % 60;
    if (d > 0) return h > 0 ? `${d}d${h}h` : `${d}d`;
    if (h > 0) return m > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${h}h`;
    return `${m}m`;
  }

  function formatResetClockTag(resetAtMs, nowMs, zh) {
    if (!resetAtMs || resetAtMs <= nowMs) return "";
    const dt = new Date(resetAtMs);
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    const diffHours = (resetAtMs - nowMs) / 3600000;
    if (diffHours <= 24) {
      return `${hh}:${mm}`;
    }
    const dayLabel = zh ? WEEKDAYS_ZH[dt.getDay()] : WEEKDAYS_EN[dt.getDay()];
    return `${dayLabel} ${hh}:${mm}`;
  }

  function formatFullReset(metric, nowMs, zh) {
    if (!metric || !metric.resetAtMs) {
      return escapeHtml(metric?.rawResetText || (zh ? "等待同步..." : "Waiting for sync..."));
    }
    const diff = metric.resetAtMs - nowMs;
    if (diff <= 0) return zh ? "已到重置时间（自动同步中）" : "Reset reached (syncing...)";
    if (diff < 60000) return zh ? "不到 1 分钟 后重置" : "Resets in <1m";

    const minsTotal = Math.ceil(diff / 60000);
    const d = Math.floor(minsTotal / 1440);
    const h = Math.floor((minsTotal % 1440) / 60);
    const m = minsTotal % 60;
    const clockTag = formatResetClockTag(metric.resetAtMs, nowMs, zh);
    const suffix = clockTag ? ` · ${clockTag}` : "";

    if (zh) {
      if (d > 0) return (h > 0 ? `${d} 天 ${h} 小时 后重置` : `${d} 天 后重置`) + suffix;
      if (h > 0) return (m > 0 ? `${h} 小时 ${m} 分钟 后重置` : `${h} 小时 后重置`) + suffix;
      return `${m} 分钟 后重置` + suffix;
    }
    if (d > 0) return (h > 0 ? `Resets in ${d}d ${h}h` : `Resets in ${d}d`) + suffix;
    if (h > 0) return (m > 0 ? `Resets in ${h}h ${m}m` : `Resets in ${h}h`) + suffix;
    return `Resets in ${m}m` + suffix;
  }

  function formatFreshness(capturedAtMs, nowMs, zh) {
    if (!capturedAtMs) return zh ? "未同步" : "Not synced";
    const sec = Math.max(0, Math.floor((nowMs - capturedAtMs) / 1000));
    if (sec < 50) return zh ? "刚刚同步" : "Just synced";
    const mins = Math.floor(sec / 60);
    if (mins < 60) return zh ? `${mins} 分钟前` : `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return zh ? `${hrs} 小时前` : `${hrs}h ago`;
    return zh ? `${Math.floor(hrs / 24)} 天前` : `${Math.floor(hrs / 24)}d ago`;
  }

  /**
   * Smart ring indicator: surfaces critical exhaustion (<20% or 0%) across either 5h or Weekly,
   * otherwise reflects the active 5-hour rolling pool.
   */
  function pickPrimaryPercent(m5h, mW) {
    const v5 = isValidMetric(m5h) ? m5h.remainingPercent : -1;
    const vW = isValidMetric(mW) ? mW.remainingPercent : -1;
    if (v5 >= 0 && vW >= 0) {
      const minVal = Math.min(v5, vW);
      if (minVal < 20) return minVal;
      return v5;
    }
    return v5 >= 0 ? v5 : vW;
  }

  function configureTickInterval() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (document.hidden) return;
    const intervalMs = state.popoverOpen ? 1000 : 30000;
    tickTimer = setInterval(() => {
      if (document.hidden) return;
      if (state.popoverOpen) {
        renderPopover();
        positionPopover();
      } else if (hasAnyData(state.quota)) {
        renderPill();
      }
    }, intervalMs);
  }

  function ensureHosts() {
    if (!pillHost) {
      pillHost = document.createElement("div");
      pillHost.setAttribute("data-ag-quota-capsule", VERSION);
      pillHost.style.cssText =
        "display:inline-flex;align-items:center;justify-content:center;flex:0 1 auto;margin:0 auto;min-width:0;max-width:100%;overflow:hidden;user-select:none;";
      pillShadow = pillHost.attachShadow({ mode: "open" });
      pillShadow.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePopoverFromClick();
      });
      pillHost.addEventListener("mouseenter", () => {
        clearTimeout(hoverCloseTimer);
        if (state.config.openOnHover && !state.popoverOpen) {
          state.pinnedByClick = false;
          openPopover();
        }
      });
      pillHost.addEventListener("mouseleave", () => {
        if (state.config.openOnHover && state.popoverOpen && !state.pinnedByClick) {
          scheduleHoverClose();
        }
      });
    }

    if (!popoverHost) {
      popoverHost = document.createElement("div");
      popoverHost.setAttribute("data-ag-quota-popover", VERSION);
      popoverHost.style.cssText =
        "position:fixed;z-index:2147483000;pointer-events:none;left:-9999px;top:-9999px;";
      popoverShadow = popoverHost.attachShadow({ mode: "open" });
      popoverHost.addEventListener("mouseenter", () => {
        clearTimeout(hoverCloseTimer);
      });
      popoverHost.addEventListener("mouseleave", () => {
        if (state.config.openOnHover && state.popoverOpen && !state.pinnedByClick) {
          scheduleHoverClose();
        }
      });
      popoverShadow.addEventListener("click", (e) => {
        e.stopPropagation();
        const target = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
        if (!target) return;
        const action = target.getAttribute("data-action");
        if (action === "refresh") {
          emitToSidecar({ type: "requestNativeSync" });
          if (!isNativeSyncedRecently()) {
            attemptLiveSync();
          } else {
            state.syncHint = state.config.language !== "en" ? "✓ 已请求后台实时同步" : "✓ Syncing latest quota...";
            renderPopover();
            setTimeout(() => {
              state.syncHint = "";
              if (state.popoverOpen) renderPopover();
            }, 1800);
          }
        } else if (action === "close") {
          closePopover();
        }
      });
      document.body.appendChild(popoverHost);
    }
  }

  function scheduleHoverClose() {
    clearTimeout(hoverCloseTimer);
    hoverCloseTimer = setTimeout(() => {
      if (!state.pinnedByClick) {
        closePopover();
      }
    }, 220);
  }

  function openPopover() {
    state.popoverOpen = true;
    configureTickInterval();
    renderPopover();
    positionPopover();
  }

  function closePopover() {
    state.popoverOpen = false;
    state.pinnedByClick = false;
    configureTickInterval();
    if (popoverHost) {
      popoverHost.style.pointerEvents = "none";
      popoverHost.style.left = "-9999px";
      popoverHost.style.top = "-9999px";
    }
    if (popoverShadow) popoverShadow.innerHTML = "";
  }

  function togglePopoverFromClick() {
    if (state.popoverOpen && state.pinnedByClick) {
      closePopover();
      return;
    }
    state.pinnedByClick = true;
    openPopover();

    const stale = !state.quota.capturedAtMs || Date.now() - state.quota.capturedAtMs > 60 * 1000;
    if (!state.config.demoMode && state.config.autoSyncOnClick && stale) {
      emitToSidecar({ type: "requestNativeSync" });
      if (!isNativeSyncedRecently()) {
        attemptLiveSync();
      }
    }
  }

  function positionPopover() {
    if (!state.popoverOpen || !pillHost || !popoverHost) return;
    const pillRect = pillHost.getBoundingClientRect();
    if (pillRect.width === 0 || pillRect.height === 0) {
      closePopover();
      return;
    }
    const card = popoverShadow.querySelector(".card");
    if (!card) return;
    const cardW = card.offsetWidth || 352;
    const cardH = card.offsetHeight || 298;

    let left = Math.round(pillRect.left + pillRect.width / 2 - cardW / 2);
    left = Math.max(10, Math.min(window.innerWidth - cardW - 10, left));

    let top = Math.round(pillRect.top - cardH - 10);
    if (top < 10) {
      top = Math.round(pillRect.bottom + 10);
    }

    popoverHost.style.pointerEvents = "auto";
    popoverHost.style.left = `${left}px`;
    popoverHost.style.top = `${top}px`;
  }

  function renderPill() {
    if (!pillShadow || !pillHost) return;
    if (!state.config.enabled) {
      pillHost.style.display = "none";
      closePopover();
      return;
    }
    pillHost.style.display = "inline-flex";

    state.isDark = detectDarkTheme();
    const zh = state.config.language !== "en";
    const now = Date.now();
    const q = state.quota;
    const dataReady = hasAnyData(q);

    // Graceful responsive layout:
    // - "auto": adapts across both / active / compact based on true Model-to-Turbo pixel distance
    // - "both": ALWAYS keeps both Gemini & Claude/GPT visible (uses compact labels when space is tight)
    let mode = state.config.density || "auto";
    let compactBothLabels = false;
    if (mode === "auto") {
      if (state.slotWidth >= 285) mode = "both";
      else if (state.slotWidth >= 155) mode = "active";
      else mode = "compact";
    } else if (mode === "both") {
      if (state.slotWidth < 275) {
        compactBothLabels = true;
      }
    } else if (mode === "active" && state.slotWidth < 120) {
      mode = "compact";
    }

    const activeIsClaude = state.activeGroup === "claudeGpt";
    const active5h = activeIsClaude ? q.claudeGptFiveHour : q.geminiFiveHour;
    const activeW = activeIsClaude ? q.claudeGptWeekly : q.geminiWeekly;

    let innerHtml = "";
    if (state.isSyncing) {
      innerHtml = `${renderRingSvg(65, 13, 2, false)}<span class="txt">${zh ? "同步额度中..." : "Syncing..."}</span>`;
    } else if (!dataReady) {
      innerHtml = `${renderRingSvg(-1, 13, 2, false)}<span class="muted">${
        state.slotWidth >= 130 ? (zh ? "点击同步额度" : "Sync Quota") : zh ? "额度" : "Quota"
      }</span>`;
    } else if (mode === "both") {
      const gActive = state.activeGroup === "gemini" || state.activeGroup === "unknown";
      const cActive = state.activeGroup === "claudeGpt" || state.activeGroup === "unknown";
      const gPct = pickPrimaryPercent(q.geminiFiveHour, q.geminiWeekly);
      const cPct = pickPrimaryPercent(q.claudeGptFiveHour, q.claudeGptWeekly);
      const wTag = zh ? "周" : "W";
      const g5 = isValidMetric(q.geminiFiveHour) ? `${q.geminiFiveHour.remainingPercent}%` : "--";
      const gW = isValidMetric(q.geminiWeekly) ? `${q.geminiWeekly.remainingPercent}%` : "--";
      const c5 = isValidMetric(q.claudeGptFiveHour) ? `${q.claudeGptFiveHour.remainingPercent}%` : "--";
      const cW = isValidMetric(q.claudeGptWeekly) ? `${q.claudeGptWeekly.remainingPercent}%` : "--";

      const gText = compactBothLabels ? `G ${g5}/${gW}` : `G 5h ${g5} · ${wTag} ${gW}`;
      const cText = compactBothLabels ? `C ${c5}/${cW}` : `C/G 5h ${c5} · ${wTag} ${cW}`;

      innerHtml = `
        <span class="seg ${gActive ? "active" : "dim"}">
          ${renderRingSvg(gPct, 13, 2, !gActive)}
          <span>${gText}</span>
        </span>
        <span class="div"></span>
        <span class="seg ${cActive ? "active" : "dim"}">
          ${renderRingSvg(cPct, 13, 2, !cActive)}
          <span>${cText}</span>
        </span>`;
    } else if (mode === "active") {
      const p5 = isValidMetric(active5h) ? `${active5h.remainingPercent}%` : "--";
      const pW = isValidMetric(activeW) ? `${activeW.remainingPercent}%` : "--";
      const cd =
        state.config.showCountdownInPill && state.slotWidth >= 215 ? formatShortReset(active5h, now, zh) : "";
      const cdHtml = cd ? `<span class="cd">(${escapeHtml(cd)})</span>` : "";
      const wTag = zh ? "周" : "W";

      innerHtml = `
        <span class="seg active">
          ${renderRingSvg(active5h.remainingPercent, 13, 2, false)}
          <span>5h ${p5}</span>${cdHtml}
        </span>
        <span class="seg dim" style="margin-left:8px;">
          ${renderRingSvg(activeW.remainingPercent, 13, 2, false)}
          <span>${wTag} ${pW}</span>
        </span>`;
    } else {
      const pct = pickPrimaryPercent(active5h, activeW);
      innerHtml = `
        <span class="seg active">
          ${renderRingSvg(pct, 13, 2, false)}
          <span>${pct >= 0 ? `${pct}%` : "--"}</span>
        </span>`;
    }

    const bg = state.isDark ? "rgba(28, 30, 36, 0.85)" : "rgba(242, 245, 250, 0.92)";
    const bgHover = state.isDark ? "rgba(40, 44, 52, 0.96)" : "rgba(232, 237, 246, 0.98)";
    const border = state.isDark ? "rgba(255, 255, 255, 0.09)" : "rgba(15, 23, 42, 0.12)";
    const borderHover = state.isDark ? "rgba(255, 255, 255, 0.18)" : "rgba(15, 23, 42, 0.22)";
    const fg = state.isDark ? "#e2e6ee" : "#1f2430";
    const muted = state.isDark ? "#9aa1b0" : "#646d7e";
    const divColor = state.isDark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.14)";

    pillShadow.innerHTML = `
      <style>
        .pill {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 26px;
          padding: 0 10px;
          max-width: 100%;
          overflow: hidden;
          border-radius: 999px;
          background: ${bg};
          border: 1px solid ${border};
          color: ${fg};
          font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
          font-size: 11.5px;
          line-height: 1;
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
          cursor: pointer;
          transition: background 120ms ease, border-color 120ms ease;
          box-sizing: border-box;
        }
        .pill:hover {
          background: ${bgHover};
          border-color: ${borderHover};
        }
        .seg {
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .seg.active {
          color: ${fg};
          font-weight: 600;
        }
        .seg.dim, .muted {
          color: ${muted};
          font-weight: 400;
        }
        .cd {
          color: ${muted};
          font-weight: 400;
          font-size: 11px;
        }
        .div {
          width: 1px;
          height: 12px;
          background: ${divColor};
          margin: 0 4px;
          flex: 0 0 auto;
        }
      </style>
      <div class="pill" title="${zh ? "点击查看/固定实时完整额度" : "Click to view/pin live quotas"}">${innerHtml}</div>`;
  }

  function renderPopover() {
    if (!popoverShadow || !state.popoverOpen) return;
    state.isDark = detectDarkTheme();
    const zh = state.config.language !== "en";
    const now = Date.now();
    const q = state.quota;

    const bg = state.isDark ? "#16181c" : "#ffffff";
    const border = state.isDark ? "#2e323c" : "#d6dce6";
    const div = state.isDark ? "#252932" : "#e6eaf2";
    const titleFg = state.isDark ? "#eef1f6" : "#181c24";
    const primaryFg = state.isDark ? "#cbd1dc" : "#343a46";
    const mutedFg = state.isDark ? "#8d95a4" : "#707886";
    const btnBg = state.isDark ? "#242830" : "#f0f3f8";
    const btnBgHover = state.isDark ? "#313642" : "#e3e8f2";
    const btnBorder = state.isDark ? "#3f4554" : "#cbd3e0";
    const accent = state.isDark ? "#78b2ff" : "#266cda";
    const activeBg = state.isDark ? "rgba(92,176,98,0.22)" : "rgba(72,160,82,0.16)";
    const activeFg = state.isDark ? "#86da8c" : "#247e2e";

    const rowHtml = (label, metric) => {
      const pct = isValidMetric(metric) ? metric.remainingPercent : -1;
      const pctText = pct >= 0 ? (zh ? `${pct}% 剩余` : `${pct}% left`) : "--";
      return `
        <div class="row">
          <div class="col-left">
            <div class="row-label">${escapeHtml(label)}</div>
            <div class="row-reset">${formatFullReset(metric, now, zh)}</div>
          </div>
          <div class="col-right">
            <span class="pct">${pctText}</span>
            ${renderRingSvg(pct, 18, 2.3, false)}
          </div>
        </div>`;
    };

    const activeBadge = (isAct) =>
      isAct ? `<span class="badge">${zh ? "当前" : "Active"}</span>` : "";

    const rawFooter =
      state.syncHint ||
      (state.config.demoMode
        ? zh
          ? "演示模式 · 可在右侧 Quota Capsule 面板关闭"
          : "Demo Mode · Toggle in Quota Capsule side pane"
        : isNativeSyncedRecently()
          ? zh
            ? "✓ 原生级自动同步已就绪（切换模型或到期自动刷新）"
            : "✓ Native auto-sync active"
          : zh
            ? "点开 Antigravity 原生额度面板可自动无感同步"
            : "Opening Antigravity quota panel syncs automatically");

    popoverShadow.innerHTML = `
      <style>
        .card {
          width: 352px;
          border-radius: 12px;
          background: ${bg};
          border: 1px solid ${border};
          box-shadow: 0 12px 32px rgba(0, 0, 0, ${state.isDark ? "0.52" : "0.16"});
          padding: 14px 16px 12px;
          box-sizing: border-box;
          font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
          color: ${primaryFg};
        }
        .hdr {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 10px;
          border-bottom: 1px solid ${div};
          margin-bottom: 10px;
        }
        .hdr-left {
          display: flex;
          align-items: baseline;
          gap: 6px;
        }
        .hdr-title {
          font-size: 13px;
          font-weight: 700;
          color: ${titleFg};
        }
        .fresh {
          font-size: 11px;
          color: ${mutedFg};
        }
        .btn {
          border: 1px solid ${btnBorder};
          background: ${btnBg};
          color: ${state.isSyncing ? accent : primaryFg};
          border-radius: 999px;
          padding: 3px 10px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
        }
        .btn:hover { background: ${btnBgHover}; }
        .sec-title {
          display: flex;
          align-items: center;
          gap: 7px;
          font-size: 13px;
          font-weight: 700;
          color: ${titleFg};
          margin: 2px 0 6px;
        }
        .badge {
          font-size: 10px;
          font-weight: 700;
          padding: 1px 7px;
          border-radius: 999px;
          background: ${activeBg};
          color: ${activeFg};
        }
        .row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 6px 0;
        }
        .col-left { display: flex; flex-direction: column; gap: 2px; }
        .row-label { font-size: 12px; color: ${mutedFg}; }
        .row-reset { font-size: 11.5px; color: ${mutedFg}; opacity: 0.92; font-variant-numeric: tabular-nums; }
        .col-right { display: flex; align-items: center; gap: 9px; }
        .pct { font-size: 12.5px; color: ${primaryFg}; font-variant-numeric: tabular-nums; }
        .divider { height: 1px; background: ${div}; margin: 8px 0 10px; }
        .footer {
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid ${div};
          font-size: 11px;
          color: ${state.syncHint ? accent : mutedFg};
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      </style>
      <div class="card">
        <div class="hdr">
          <div class="hdr-left">
            <span class="hdr-title">${zh ? "实时额度" : "Live Quotas"}</span>
            <span class="fresh">· ${escapeHtml(formatFreshness(q.capturedAtMs, now, zh))}</span>
          </div>
          <button class="btn" data-action="refresh">${
            state.isSyncing ? (zh ? "同步中..." : "Syncing...") : zh ? "↻ 刷新" : "↻ Sync"
          }</button>
        </div>

        <div class="sec-title">${zh ? "Gemini 模型" : "Gemini Models"}${activeBadge(state.activeGroup === "gemini")}</div>
        ${rowHtml(zh ? "周限额" : "Weekly limit", q.geminiWeekly)}
        ${rowHtml(zh ? "5 小时限额" : "5-hour limit", q.geminiFiveHour)}

        <div class="divider"></div>

        <div class="sec-title">${zh ? "Claude 和 GPT 模型" : "Claude & GPT Models"}${activeBadge(state.activeGroup === "claudeGpt")}</div>
        ${rowHtml(zh ? "周限额" : "Weekly limit", q.claudeGptWeekly)}
        ${rowHtml(zh ? "5 小时限额" : "5-hour limit", q.claudeGptFiveHour)}

        <div class="footer">${escapeHtml(rawFooter)}</div>
      </div>`;
  }

  function getButtonLabel(el) {
    if (!el) return "";
    const parts = [
      el.getAttribute("aria-label") || "",
      el.getAttribute("title") || "",
      el.innerText || el.textContent || "",
    ]
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.join(" ");
  }

  function findComposerControls() {
    const winH = window.innerHeight;
    const minTop = Math.max(0, winH - 260);
    const nodes = document.querySelectorAll('button, [role="button"]');
    const bottomBtns = [];

    for (const el of nodes) {
      if (pillHost && pillHost.contains(el)) continue;
      if (popoverHost && popoverHost.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 16 || r.height > 56) continue;
      if (r.top < minTop || r.bottom > winH + 10) continue;
      bottomBtns.push({ el, rect: r, label: getButtonLabel(el) });
    }

    let bestModel = null;
    let bestScore = -1;
    for (const b of bottomBtns) {
      if (!b.label || !MODEL_RE.test(b.label)) continue;
      let score = 100;
      if (b.rect.width >= 80 && b.rect.width <= 380) score += 30;
      if (b.rect.top >= winH - 120) score += 25;
      if (score > bestScore) {
        bestScore = score;
        bestModel = b;
      }
    }
    if (!bestModel) return null;

    const modelMidY = bestModel.rect.top + bestModel.rect.height / 2;
    let explicitMode = null;
    let rightNeighbor = null;

    for (const b of bottomBtns) {
      if (b.el === bestModel.el) continue;
      const midY = b.rect.top + b.rect.height / 2;
      if (Math.abs(midY - modelMidY) > 16) continue;
      if (b.rect.left <= bestModel.rect.right + 16) continue;

      if (b.label && MODE_RE.test(b.label)) {
        if (!explicitMode || b.rect.left < explicitMode.rect.left) explicitMode = b;
      }
      if (!rightNeighbor || b.rect.left < rightNeighbor.rect.left) rightNeighbor = b;
    }

    const modeBtn = explicitMode || rightNeighbor;
    if (!modeBtn) return null;

    const ancestors = new Set();
    let cur = bestModel.el.parentElement;
    for (let i = 0; i < 6 && cur; i++) {
      ancestors.add(cur);
      cur = cur.parentElement;
    }
    let toolbar = null;
    cur = modeBtn.el.parentElement;
    for (let i = 0; i < 6 && cur; i++) {
      if (ancestors.has(cur)) {
        toolbar = cur;
        break;
      }
      cur = cur.parentElement;
    }
    if (!toolbar) return null;

    let leftChild = bestModel.el;
    while (leftChild.parentElement && leftChild.parentElement !== toolbar) {
      leftChild = leftChild.parentElement;
    }
    let rightChild = modeBtn.el;
    while (rightChild.parentElement && rightChild.parentElement !== toolbar) {
      rightChild = rightChild.parentElement;
    }
    if (leftChild === rightChild) return null;

    return {
      toolbar,
      leftChild,
      rightChild,
      modelBtn: bestModel,
      modeBtn,
    };
  }

  function mountOrUpdate() {
    if (document.hidden) return;
    ensureHosts();
    const found = findComposerControls();
    if (!found) {
      reportMountStatus(false);
      return;
    }

    const { toolbar, rightChild, modelBtn, modeBtn } = found;
    const prevModel = state.activeModelName;
    state.activeModelName = modelBtn.label;
    state.activeGroup = classifyModelGroup(modelBtn.label);

    if (pillHost.parentElement !== toolbar || pillHost.nextElementSibling !== rightChild) {
      toolbar.insertBefore(pillHost, rightChild);
      if (resizeObserver) resizeObserver.disconnect();
      if (typeof ResizeObserver === "function") {
        resizeObserver = new ResizeObserver(() => {
          const latest = findComposerControls();
          if (latest && measureSlotWidth(latest.modelBtn.el, latest.modeBtn.el)) {
            renderPill();
            if (state.popoverOpen) positionPopover();
          }
        });
        resizeObserver.observe(toolbar);
      }
    }

    const changedWidth = measureSlotWidth(modelBtn.el, modeBtn.el);
    if (changedWidth || prevModel !== state.activeModelName || !pillShadow.innerHTML) {
      renderPill();
    }

    reportMountStatus(true, prevModel !== state.activeModelName);
  }

  /**
   * Measures the TRUE pixel distance between the right edge of the Model Selector button
   * and the left edge of the Mode/Turbo button (immune to flex-grow wrapper containers).
   */
  function measureSlotWidth(modelBtnEl, modeBtnEl) {
    if (!modelBtnEl || !modeBtnEl) return false;
    const mr = modelBtnEl.getBoundingClientRect();
    const tr = modeBtnEl.getBoundingClientRect();
    const gap = Math.max(54, Math.floor(tr.left - mr.right - 16));
    if (Math.abs(gap - state.slotWidth) >= 6) {
      state.slotWidth = gap;
      return true;
    }
    return false;
  }

  function reportMountStatus(mounted, forceImmediate) {
    const now = Date.now();
    if (!forceImmediate && now - lastMountReportMs < 2000) return;
    lastMountReportMs = now;
    emitToSidecar({
      type: "mountStatus",
      mounted,
      slotWidth: state.slotWidth,
      activeModelName: state.activeModelName,
      activeGroup: state.activeGroup,
    });
  }

  /**
   * Fast, low-CPU DOM fallback scanner:
   * Skips scanning completely when NativeRPC is active (unless user explicitly clicked sync),
   * and prioritizes dialog/popover roots instead of walking long chat transcripts.
   */
  function scanVisibleQuotaPanel(forceScan) {
    if (document.hidden) return false;
    if (!forceScan && Date.now() >= state.listenUntilMs && isNativeSyncedRecently()) {
      return false;
    }

    const candidateRoots = document.querySelectorAll(
      '[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper], [class*="popover" i], [class*="modal" i]'
    );

    const rootsToCheck = candidateRoots.length > 0 ? candidateRoots : forceScan ? [document.body] : [];
    for (const root of rootsToCheck) {
      if ((pillHost && pillHost.contains(root)) || (popoverHost && popoverHost.contains(root))) continue;
      const r = root.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;

      const text = (root.innerText || "").trim();
      if (text.length < 30 || text.length > 3500) continue;
      if (!QUOTA_HINT_RE.test(text)) continue;

      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l.length <= 140);

      const sig = lines.join("|");
      if (sig === lastQuotaSignature && Date.now() - state.quota.capturedAtMs < 4000) {
        return true;
      }
      lastQuotaSignature = sig;
      emitToSidecar({ type: "quotaLines", lines });
      return true;
    }
    return false;
  }

  function findQuotaTriggerButton() {
    const custom = (state.config.customTriggerKeyword || "").trim().toLowerCase();
    const btns = document.querySelectorAll('button, [role="button"]');
    let fallback = null;
    for (const el of btns) {
      if ((pillHost && pillHost.contains(el)) || (popoverHost && popoverHost.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const label = getButtonLabel(el);
      if (!label) continue;
      if (custom && label.toLowerCase().includes(custom)) return el;
      if (TRIGGER_RE.test(label)) {
        if (/(quota|usage|额度|限额)/i.test(label)) return el;
        if (!fallback) fallback = el;
      }
    }
    return fallback;
  }

  async function attemptLiveSync() {
    if (state.isSyncing) return;
    const zh = state.config.language !== "en";

    if (scanVisibleQuotaPanel(true)) {
      state.syncHint = zh ? "✓ 已实时捕获最新额度" : "✓ Live quota captured";
      renderPill();
      renderPopover();
      setTimeout(() => {
        state.syncHint = "";
        if (state.popoverOpen) renderPopover();
      }, 2400);
      return;
    }

    state.isSyncing = true;
    state.listenUntilMs = Date.now() + 15000;
    renderPill();
    if (state.popoverOpen) renderPopover();

    const trigger = findQuotaTriggerButton();
    if (trigger) {
      try {
        trigger.click();
        let captured = false;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 160));
          if (scanVisibleQuotaPanel(true)) {
            captured = true;
            break;
          }
        }
        try {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
        } catch {
          // ignore
        }
        state.isSyncing = false;
        state.syncHint = captured
          ? zh
            ? "✓ 已实时同步最新额度"
            : "✓ Live quota synced"
          : zh
            ? "正在通过后台通道同步最新额度..."
            : "Syncing via background channel...";
        renderPill();
        if (state.popoverOpen) renderPopover();
        return;
      } catch {
        // fallback to listening hint
      }
    }

    state.isSyncing = false;
    state.syncHint = zh
      ? "请在 Antigravity 中点开一下额度面板，将自动瞬间捕获..."
      : "Open the quota panel in Antigravity to capture instantly...";
    emitToSidecar({ type: "syncStatus", message: state.syncHint });
    renderPill();
    if (state.popoverOpen) renderPopover();
  }

  function scheduleMount() {
    if (mountRaf || document.hidden) return;
    mountRaf = requestAnimationFrame(() => {
      mountRaf = 0;
      mountOrUpdate();
    });
  }

  function onGlobalClick(e) {
    if (!state.popoverOpen) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (path.includes(pillHost) || path.includes(popoverHost)) return;
    closePopover();
  }

  function onGlobalKeyDown(e) {
    if (e.key === "Escape" && state.popoverOpen) {
      closePopover();
    }
  }

  function onWindowBlur() {
    if (state.popoverOpen && !state.pinnedByClick) {
      closePopover();
    }
  }

  function onVisibilityChange() {
    configureTickInterval();
    if (!document.hidden) {
      mountOrUpdate();
      renderPill();
    }
  }

  window.__agQuotaCapsuleReceive = (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "state" && msg.payload) {
      if (msg.payload.config) state.config = { ...state.config, ...msg.payload.config };
      if (msg.payload.quota) state.quota = msg.payload.quota;
      if (hasAnyData(state.quota) && state.listenUntilMs > 0) {
        state.listenUntilMs = 0;
        state.syncHint = "";
      }
      renderPill();
      if (state.popoverOpen) {
        renderPopover();
        positionPopover();
      }
    } else if (msg.type === "triggerSync") {
      attemptLiveSync();
    }
  };

  window.__agQuotaCapsuleCleanup = () => {
    if (domObserver) domObserver.disconnect();
    if (resizeObserver) resizeObserver.disconnect();
    if (tickTimer) clearInterval(tickTimer);
    if (passiveQuotaTimer) clearInterval(passiveQuotaTimer);
    document.removeEventListener("click", onGlobalClick, true);
    document.removeEventListener("keydown", onGlobalKeyDown, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("resize", scheduleMount);
    window.removeEventListener("blur", onWindowBlur);
    if (pillHost && pillHost.parentElement) pillHost.parentElement.removeChild(pillHost);
    if (popoverHost && popoverHost.parentElement) popoverHost.parentElement.removeChild(popoverHost);
  };

  document.addEventListener("click", onGlobalClick, true);
  document.addEventListener("keydown", onGlobalKeyDown, true);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("resize", scheduleMount);
  window.addEventListener("blur", onWindowBlur);

  domObserver = new MutationObserver(() => {
    scheduleMount();
    if (Date.now() < state.listenUntilMs) {
      scanVisibleQuotaPanel(false);
    }
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  configureTickInterval();

  // Gentle fallback check every 2.5s ONLY when NativeRPC is not active
  passiveQuotaTimer = setInterval(() => {
    scanVisibleQuotaPanel(false);
  }, 2500);

  mountOrUpdate();
  emitToSidecar({ type: "requestState" });
})();
