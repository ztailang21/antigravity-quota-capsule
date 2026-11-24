// Zero-dependency multilingual (ZH/EN) quota parser & countdown formatter

const GEMINI_SECTION_RE = /(?:^|\s)gemini\s*(?:模型|models?|series)?$/i;
const CLAUDE_GPT_SECTION_RE = /(claude\s*(?:和|&|and|\/)\s*gpt|claude\s*模型|gpt\s*模型|third[- ]party\s*models)/i;
const WEEKLY_LABEL_RE = /(周限额|每周限额|weekly\s*(?:limit|quota)|^weekly$)/i;
const FIVE_HOUR_LABEL_RE = /(5\s*小时\s*限额|5\s*[- ]?\s*hour\s*(?:limit|quota)|5h\s*(?:limit|quota))/i;
const PERCENT_RE = /(?<!\d)(100|[1-9]?\d)\s*%\s*(?:剩余|remaining|left)?/i;
const RESET_KW_RE = /(后重置|重置|resets?\s*in|refresh(?:es)?\s*in)/i;
const DAYS_RE = /(\d+)\s*(?:天|days?|d\b)/i;
const HOURS_RE = /(\d+)\s*(?:小时|时|hours?|hrs?|h\b)/i;
const MINS_RE = /(\d+)\s*(?:分钟|分|minutes?|mins?|m\b)/i;
const LESS_THAN_MIN_RE = /(不到\s*1\s*分钟|<\s*1\s*m|less\s+than\s+a?\s*minute|soon)/i;

export function createEmptyMetric() {
  return { remainingPercent: -1, resetAtMs: 0, rawResetText: "" };
}

export function createEmptySnapshot() {
  return {
    geminiWeekly: createEmptyMetric(),
    geminiFiveHour: createEmptyMetric(),
    claudeGptWeekly: createEmptyMetric(),
    claudeGptFiveHour: createEmptyMetric(),
    capturedAtMs: 0,
    source: "",
  };
}

export function isValidMetric(m) {
  return Boolean(m && typeof m.remainingPercent === "number" && m.remainingPercent >= 0 && m.remainingPercent <= 100);
}

export function hasAnyQuotaData(snap) {
  if (!snap) return false;
  return (
    isValidMetric(snap.geminiWeekly) ||
    isValidMetric(snap.geminiFiveHour) ||
    isValidMetric(snap.claudeGptWeekly) ||
    isValidMetric(snap.claudeGptFiveHour)
  );
}

export function countValidMetrics(snap) {
  if (!snap) return 0;
  let c = 0;
  if (isValidMetric(snap.geminiWeekly)) c++;
  if (isValidMetric(snap.geminiFiveHour)) c++;
  if (isValidMetric(snap.claudeGptWeekly)) c++;
  if (isValidMetric(snap.claudeGptFiveHour)) c++;
  return c;
}

export function parseResetDurationMs(text) {
  if (!text || typeof text !== "string") return null;
  if (LESS_THAN_MIN_RE.test(text)) return 45 * 1000;

  let days = 0;
  let hours = 0;
  let mins = 0;
  let matched = false;

  const dm = text.match(DAYS_RE);
  if (dm) {
    days = Number.parseInt(dm[1], 10) || 0;
    matched = true;
  }
  const hm = text.match(HOURS_RE);
  if (hm) {
    hours = Number.parseInt(hm[1], 10) || 0;
    matched = true;
  }
  const mm = text.match(MINS_RE);
  if (mm) {
    mins = Number.parseInt(mm[1], 10) || 0;
    matched = true;
  }

  if (!matched) return null;
  return ((days * 24 + hours) * 60 + mins) * 60 * 1000;
}

function attachPercentAndReset(line, metric, capturedAtMs) {
  if (!metric || !line) return;

  if (!isValidMetric(metric)) {
    const pm = line.match(PERCENT_RE);
    if (pm) {
      const pct = Number.parseInt(pm[1], 10);
      if (pct >= 0 && pct <= 100) {
        metric.remainingPercent = pct;
      }
    }
  }

  if (!metric.resetAtMs && RESET_KW_RE.test(line)) {
    metric.rawResetText = line.trim();
    const durMs = parseResetDurationMs(line);
    if (durMs !== null) {
      metric.resetAtMs = capturedAtMs + durMs;
    }
  }
}

export function parseQuotaLines(rawLines, capturedAtMs = Date.now()) {
  const snap = createEmptySnapshot();
  if (!Array.isArray(rawLines) || rawLines.length === 0) return snap;

  const tokens = [];
  for (const raw of rawLines) {
    if (typeof raw !== "string") continue;
    for (const part of raw.split(/\r?\n/)) {
      const t = part.trim();
      if (t.length > 0 && t.length <= 160) tokens.push(t);
    }
  }

  let currentGroup = "unknown";
  let currentMetric = null;

  for (const line of tokens) {
    if (CLAUDE_GPT_SECTION_RE.test(line)) {
      currentGroup = "claudeGpt";
      currentMetric = null;
      continue;
    }
    if (GEMINI_SECTION_RE.test(line) && !/claude/i.test(line)) {
      currentGroup = "gemini";
      currentMetric = null;
      continue;
    }

    const isWeekly = WEEKLY_LABEL_RE.test(line);
    const isFiveHour = FIVE_HOUR_LABEL_RE.test(line);

    if (isWeekly || isFiveHour) {
      if (currentGroup === "unknown") {
        const geminiSlotFree =
          (isWeekly && !isValidMetric(snap.geminiWeekly)) ||
          (isFiveHour && !isValidMetric(snap.geminiFiveHour));
        currentGroup = geminiSlotFree ? "gemini" : "claudeGpt";
      }

      if (currentGroup === "gemini") {
        currentMetric = isWeekly ? snap.geminiWeekly : snap.geminiFiveHour;
      } else {
        currentMetric = isWeekly ? snap.claudeGptWeekly : snap.claudeGptFiveHour;
      }

      attachPercentAndReset(line, currentMetric, capturedAtMs);
      continue;
    }

    if (currentMetric) {
      attachPercentAndReset(line, currentMetric, capturedAtMs);
    }
  }

  if (hasAnyQuotaData(snap)) {
    snap.capturedAtMs = capturedAtMs;
    snap.source = "DOM";
  }

  return snap;
}

export function mergeQuotaSnapshots(previous, incoming) {
  const base = previous ? structuredClone(previous) : createEmptySnapshot();
  if (!incoming || !hasAnyQuotaData(incoming)) return base;

  if (isValidMetric(incoming.geminiWeekly)) base.geminiWeekly = { ...incoming.geminiWeekly };
  if (isValidMetric(incoming.geminiFiveHour)) base.geminiFiveHour = { ...incoming.geminiFiveHour };
  if (isValidMetric(incoming.claudeGptWeekly)) base.claudeGptWeekly = { ...incoming.claudeGptWeekly };
  if (isValidMetric(incoming.claudeGptFiveHour)) base.claudeGptFiveHour = { ...incoming.claudeGptFiveHour };
  base.capturedAtMs = incoming.capturedAtMs || Date.now();
  base.source = incoming.source || "DOM";
  return base;
}

export function createSampleQuota(nowMs = Date.now()) {
  const H = 3600 * 1000;
  const M = 60 * 1000;
  const D = 24 * H;
  return {
    geminiWeekly: { remainingPercent: 83, resetAtMs: nowMs + 6 * D + 15 * H, rawResetText: "6 天 15 小时 后重置" },
    geminiFiveHour: { remainingPercent: 62, resetAtMs: nowMs + 1 * H + 45 * M, rawResetText: "1 小时 45 分钟 后重置" },
    claudeGptWeekly: { remainingPercent: 0, resetAtMs: nowMs + 3 * D + 14 * H, rawResetText: "3 天 14 小时 后重置" },
    claudeGptFiveHour: { remainingPercent: 100, resetAtMs: nowMs + 4 * H + 59 * M, rawResetText: "4 小时 59 分钟 后重置" },
    capturedAtMs: nowMs,
    source: "Demo",
  };
}

export function formatShortReset(metric, nowMs, zh = true) {
  if (!metric || !metric.resetAtMs) return "";
  const diffMs = metric.resetAtMs - nowMs;
  if (diffMs <= 0) return zh ? "已重置" : "Reset";
  if (diffMs < 60 * 1000) return "<1m";

  const totalMins = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMins / (24 * 60));
  const hours = Math.floor((totalMins % (24 * 60)) / 60);
  const mins = totalMins % 60;

  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h${String(mins).padStart(2, "0")}m` : `${hours}h`;
  return `${mins}m`;
}

export function formatFullReset(metric, nowMs, zh = true) {
  if (!metric || !metric.resetAtMs) {
    return metric?.rawResetText || (zh ? "等待同步..." : "Waiting for sync...");
  }
  const diffMs = metric.resetAtMs - nowMs;
  if (diffMs <= 0) return zh ? "已到重置时间（点击刷新）" : "Reset reached (click to sync)";
  if (diffMs < 60 * 1000) return zh ? "不到 1 分钟 后重置" : "Resets in <1m";

  const totalMins = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMins / (24 * 60));
  const hours = Math.floor((totalMins % (24 * 60)) / 60);
  const mins = totalMins % 60;

  if (zh) {
    if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时 后重置` : `${days} 天 后重置`;
    if (hours > 0) return mins > 0 ? `${hours} 小时 ${mins} 分钟 后重置` : `${hours} 小时 后重置`;
    return `${mins} 分钟 后重置`;
  }
  if (days > 0) return hours > 0 ? `Resets in ${days}d ${hours}h` : `Resets in ${days}d`;
  if (hours > 0) return mins > 0 ? `Resets in ${hours}h ${mins}m` : `Resets in ${hours}h`;
  return `Resets in ${mins}m`;
}
