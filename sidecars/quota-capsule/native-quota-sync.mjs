// Native-grade automatic quota synchronization for Antigravity 2.0 (v1.1.0)
// Supports:
//  1) Official Sidecar env Connect-RPC (ANTIGRAVITY_LS_ADDRESS + ANTIGRAVITY_CSRF_TOKEN)
//     with protocol caching & early-exit once all 4 metrics are resolved
//  2) Universal recursive JSON extractor for GetUserStatus / GetCommandModelConfigs / RetrieveUserQuotaSummary

import http from "node:http";
import https from "node:https";
import {
  countValidMetrics,
  createEmptySnapshot,
  hasAnyQuotaData,
  isValidMetric,
  mergeQuotaSnapshots,
} from "./quota-parser.mjs";

const GEMINI_RE = /\b(gemini|neon|carbon|hydrogen|argon|helium|lithium|flash|google)\b|gemini/i;
const CLAUDE_GPT_RE = /\b(claude|gpt|opus|sonnet|haiku|o1|o3|o4|chatgpt|openai|anthropic|third[_ -]?party)\b/i;
const WEEKLY_RE = /(week|weekly|7d|168h|604800)/i;
const FIVE_HOUR_RE = /(5h|5[_ -]?hour|five[_ -]?hour|session|short|18000)/i;

// Cache preferred TLS mode per LS address to avoid redundant failed socket attempts every poll
const preferredTlsByAddress = new Map();

function parseTimestampMs(val) {
  if (!val) return 0;
  if (typeof val === "number" && Number.isFinite(val)) {
    return val > 1e12 ? Math.round(val) : Math.round(val * 1000);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return n > 1e12 ? n : n * 1000;
    }
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof val === "object" && val.seconds !== undefined) {
    const sec = Number(val.seconds) || 0;
    const nanos = Number(val.nanos) || 0;
    return Math.round(sec * 1000 + nanos / 1e6);
  }
  return 0;
}

function parsePercentValue(obj) {
  if (!obj || typeof obj !== "object") return -1;

  const fracKeys = ["remainingFraction", "remaining_fraction", "quotaFraction", "fractionRemaining"];
  for (const k of fracKeys) {
    if (typeof obj[k] === "number" && Number.isFinite(obj[k])) {
      const v = obj[k];
      return Math.max(0, Math.min(100, Math.round(v <= 1.0001 ? v * 100 : v)));
    }
  }

  const pctKeys = ["remainingPercentage", "remaining_percentage", "remainingPercent", "percentRemaining"];
  for (const k of pctKeys) {
    if (typeof obj[k] === "number" && Number.isFinite(obj[k])) {
      return Math.max(0, Math.min(100, Math.round(obj[k])));
    }
  }

  const usedFracKeys = ["usedFraction", "used_fraction", "usageFraction"];
  for (const k of usedFracKeys) {
    if (typeof obj[k] === "number" && Number.isFinite(obj[k])) {
      const u = obj[k];
      const pctUsed = u <= 1.0001 ? u * 100 : u;
      return Math.max(0, Math.min(100, Math.round(100 - pctUsed)));
    }
  }

  // Proto3 omits numeric 0.0 fields on the wire; if resetTime is present in a quota object, remaining is 0%!
  if (obj.resetTime || obj.reset_time || obj.resetTimestamp || obj.reset_timestamp) {
    return 0;
  }

  return -1;
}

function classifyWindow(obj, hintText, resetAtMs, nowMs) {
  const combined = `${hintText || ""} ${obj?.windowType || ""} ${obj?.window || ""} ${obj?.period || ""} ${obj?.bucketType || ""} ${obj?.label || ""} ${obj?.name || ""}`;
  if (WEEKLY_RE.test(combined)) return "weekly";
  if (FIVE_HOUR_RE.test(combined)) return "fiveHour";

  const durSec = Number(obj?.windowDurationSeconds || obj?.durationSeconds || obj?.windowSeconds || 0);
  if (durSec >= 86400) return "weekly";
  if (durSec > 0 && durSec <= 43200) return "fiveHour";

  if (resetAtMs > nowMs) {
    const diffHours = (resetAtMs - nowMs) / 3600000;
    if (diffHours > 6.5) return "weekly";
    return "fiveHour";
  }
  return "fiveHour";
}

function classifyFamily(text) {
  if (!text) return "unknown";
  if (CLAUDE_GPT_RE.test(text)) return "claudeGpt";
  if (GEMINI_RE.test(text)) return "gemini";
  return "unknown";
}

function assignMetric(snap, family, winType, pct, resetAtMs) {
  if (pct < 0 || pct > 100) return;
  if (family !== "gemini" && family !== "claudeGpt") return;

  const targetKey =
    family === "gemini"
      ? winType === "weekly"
        ? "geminiWeekly"
        : "geminiFiveHour"
      : winType === "weekly"
        ? "claudeGptWeekly"
        : "claudeGptFiveHour";

  const existing = snap[targetKey];
  if (!isValidMetric(existing) || pct < existing.remainingPercent || (!existing.resetAtMs && resetAtMs > 0)) {
    snap[targetKey] = {
      remainingPercent: pct,
      resetAtMs: resetAtMs || existing.resetAtMs || 0,
      rawResetText: "",
    };
  }
}

export function parseNativeQuotaPayload(payload, nowMs = Date.now()) {
  const snap = createEmptySnapshot();
  if (!payload || typeof payload !== "object") return snap;

  // 1. Structured path: userStatus.cascadeModelConfigData.clientModelConfigs[]
  const modelConfigs =
    payload?.userStatus?.cascadeModelConfigData?.clientModelConfigs ||
    payload?.cascadeModelConfigData?.clientModelConfigs ||
    payload?.clientModelConfigs ||
    payload?.models;

  if (Array.isArray(modelConfigs)) {
    for (const cfg of modelConfigs) {
      if (!cfg || typeof cfg !== "object") continue;
      const label = [
        cfg.label,
        cfg.displayName,
        cfg.modelOrAlias?.model,
        cfg.modelOrAlias?.alias,
        cfg.modelId,
        cfg.id,
        cfg.name,
      ]
        .filter(Boolean)
        .join(" ");

      const family = classifyFamily(label);
      if (family === "unknown") continue;

      if (cfg.quotaInfo && typeof cfg.quotaInfo === "object") {
        const qi = cfg.quotaInfo;
        const resetAtMs = parseTimestampMs(qi.resetTime || qi.reset_time || qi.resetTimestamp);
        const pct = parsePercentValue(qi);
        const winType = classifyWindow(qi, label, resetAtMs, nowMs);
        assignMetric(snap, family, winType, pct, resetAtMs);
      }

      if (cfg.weeklyQuotaInfo && typeof cfg.weeklyQuotaInfo === "object") {
        const wq = cfg.weeklyQuotaInfo;
        assignMetric(
          snap,
          family,
          "weekly",
          parsePercentValue(wq),
          parseTimestampMs(wq.resetTime || wq.reset_time)
        );
      }
      if (cfg.fiveHourQuotaInfo && typeof cfg.fiveHourQuotaInfo === "object") {
        const fq = cfg.fiveHourQuotaInfo;
        assignMetric(
          snap,
          family,
          "fiveHour",
          parsePercentValue(fq),
          parseTimestampMs(fq.resetTime || fq.reset_time)
        );
      }
    }
  }

  // 2. Recursive generic extractor for RetrieveUserQuotaSummary / bucket-grouped quota payloads
  const visited = new Set();
  function walk(node, inheritedFamily, inheritedHint, depth) {
    if (!node || typeof node !== "object" || depth > 10 || visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, inheritedFamily, inheritedHint, depth + 1);
      }
      return;
    }

    const localLabels = [
      node.groupName,
      node.poolName,
      node.modelGroup,
      node.modelFamily,
      node.family,
      node.label,
      node.displayName,
      node.title,
      node.quotaPool,
      node.id,
      node.name,
    ]
      .filter((v) => typeof v === "string")
      .join(" ");

    let family = classifyFamily(localLabels);
    if (family === "unknown") family = inheritedFamily;

    const hint = `${inheritedHint} ${localLabels}`.trim();

    const hasQuotaFields =
      node.remainingFraction !== undefined ||
      node.remaining_fraction !== undefined ||
      node.remainingPercentage !== undefined ||
      node.remaining_percentage !== undefined ||
      node.remainingPercent !== undefined ||
      node.usedFraction !== undefined ||
      node.used_fraction !== undefined ||
      (node.resetTime !== undefined && /quota|limit|bucket|window|weekly|hour/i.test(hint));

    if (hasQuotaFields && family !== "unknown") {
      const resetAtMs = parseTimestampMs(
        node.resetTime || node.reset_time || node.resetTimestamp || node.reset_timestamp || node.nextResetTime
      );
      const pct = parsePercentValue(node);
      const winType = classifyWindow(node, hint, resetAtMs, nowMs);
      assignMetric(snap, family, winType, pct, resetAtMs);
    }

    for (const [key, val] of Object.entries(node)) {
      if (!val || typeof val !== "object") continue;
      const keyFamily = classifyFamily(key);
      const nextFamily = keyFamily !== "unknown" ? keyFamily : family;
      walk(val, nextFamily, `${hint} ${key}`, depth + 1);
    }
  }

  walk(payload, "unknown", "", 0);

  if (hasAnyQuotaData(snap)) {
    snap.capturedAtMs = nowMs;
    snap.source = "Native";
  }
  return snap;
}

function postConnectRpc(address, csrfToken, rpcPath, bodyObj, useTls = false, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const cleanAddr = address.replace(/^https?:\/\//i, "");
    const [host, portStr] = cleanAddr.split(":");
    const port = Number.parseInt(portStr, 10);
    if (!host || !port || (host !== "127.0.0.1" && host !== "localhost" && host !== "::1")) {
      reject(new Error(`Invalid loopback LS address: ${address}`));
      return;
    }

    const payload = JSON.stringify(bodyObj || {});
    const mod = useTls ? https : http;
    const req = mod.request(
      {
        host: "127.0.0.1",
        port,
        path: rpcPath,
        method: "POST",
        timeout: timeoutMs,
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": csrfToken,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
          if (data.length > 4 * 1024 * 1024) {
            req.destroy(new Error("RPC response exceeded 4MB cap"));
          }
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data || "{}"));
            } catch (err) {
              reject(err);
            }
          } else {
            reject(new Error(`RPC ${rpcPath} HTTP ${res.statusCode}`));
          }
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error(`RPC timeout: ${rpcPath}`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

export async function fetchFromSidecarLsEnv() {
  const address = process.env.ANTIGRAVITY_LS_ADDRESS || "";
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || "";
  if (!address || !csrf) {
    return { available: false, snapshot: null, endpointsTried: [] };
  }

  const endpoints = [
    { path: "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary", body: {} },
    {
      path: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
      body: { metadata: { ideName: "antigravity", extensionName: "antigravity" } },
    },
    {
      path: "/exa.language_server_pb.LanguageServerService/GetCommandModelConfigs",
      body: { metadata: { ideName: "antigravity", extensionName: "antigravity" } },
    },
  ];

  const cachedTls = preferredTlsByAddress.get(address);
  const tlsOrder =
    cachedTls === true ? [true, false] : cachedTls === false ? [false, true] : /^https:/i.test(address) ? [true, false] : [false, true];

  let combined = createEmptySnapshot();
  const endpointsTried = [];

  for (const ep of endpoints) {
    for (const useTls of tlsOrder) {
      try {
        const json = await postConnectRpc(address, csrf, ep.path, ep.body, useTls, 2200);
        preferredTlsByAddress.set(address, useTls);
        const parsed = parseNativeQuotaPayload(json, Date.now());
        endpointsTried.push(`${ep.path.split("/").pop()} (${useTls ? "https" : "http"}): ok`);
        if (hasAnyQuotaData(parsed)) {
          combined = mergeQuotaSnapshots(combined, parsed);
          combined.source = "NativeRPC";
        }
        break;
      } catch {
        // try alternate protocol or next endpoint
      }
    }
    // Early-exit once all 4 quota metrics (Gemini W+5h & Claude/GPT W+5h) are resolved
    if (countValidMetrics(combined) >= 4) {
      break;
    }
  }

  return {
    available: true,
    snapshot: hasAnyQuotaData(combined) ? combined : null,
    endpointsTried,
  };
}
