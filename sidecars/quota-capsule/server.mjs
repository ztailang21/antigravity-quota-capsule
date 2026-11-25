// Antigravity Quota Capsule Sidecar Server v1.1.0 (Zero-dependency Node ESM)
// Launched & managed automatically by Antigravity 2.0 via sidecar.json

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CdpBridge } from "./cdp-bridge.mjs";
import { fetchFromSidecarLsEnv, parseNativeQuotaPayload } from "./native-quota-sync.mjs";
import {
  countValidMetrics,
  createEmptySnapshot,
  createSampleQuota,
  hasAnyQuotaData,
  mergeQuotaSnapshots,
  parseQuotaLines,
} from "./quota-parser.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WEB_PORT = Number.parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || process.env.PORT || "0", 10);

function resolveDataDir(overrideDir) {
  const dir =
    overrideDir ||
    process.env.ANTIGRAVITY_QUOTA_DATA_DIR ||
    join(
      process.platform === "win32"
        ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
        : join(homedir(), ".config"),
      "AntigravityQuotaCapsule"
    );
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function defaultConfig() {
  return {
    enabled: true,
    language: "zh",
    density: "auto", // auto | both | active | compact
    openOnHover: false,
    autoSyncOnClick: true,
    showCountdownInPill: true,
    demoMode: false,
    customTriggerKeyword: "",
  };
}

function quotaFingerprint(q) {
  if (!q) return "";
  return [
    q.geminiWeekly?.remainingPercent,
    q.geminiWeekly?.resetAtMs,
    q.geminiFiveHour?.remainingPercent,
    q.geminiFiveHour?.resetAtMs,
    q.claudeGptWeekly?.remainingPercent,
    q.claudeGptWeekly?.resetAtMs,
    q.claudeGptFiveHour?.remainingPercent,
    q.claudeGptFiveHour?.resetAtMs,
    q.source,
  ].join("|");
}

function loadPersistedState(stateFile) {
  try {
    if (existsSync(stateFile)) {
      const raw = readFileSync(stateFile, "utf8").replace(/^\uFEFF/, "");
      const parsed = JSON.parse(raw);
      return {
        config: { ...defaultConfig(), ...(parsed.config || {}) },
        quota: parsed.quota && hasAnyQuotaData(parsed.quota) ? parsed.quota : createEmptySnapshot(),
      };
    }
  } catch {
    // fallback to defaults
  }
  return {
    config: defaultConfig(),
    quota: createEmptySnapshot(),
  };
}

/**
 * Atomic write via temp file + rename to prevent JSON corruption on abrupt power loss / taskkill.
 */
function savePersistedStateAtomic(stateFile, state) {
  try {
    const tmpFile = `${stateFile}.tmp`;
    const json = JSON.stringify({ config: state.config, quota: state.quota }, null, 2);
    writeFileSync(tmpFile, json, "utf8");
    renameSync(tmpFile, stateFile);
  } catch {
    try {
      writeFileSync(stateFile, JSON.stringify({ config: state.config, quota: state.quota }, null, 2), "utf8");
    } catch {
      // ignore write errors
    }
  }
}

function isLoopbackHostHeader(hostHeader) {
  if (!hostHeader) return true;
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(hostHeader).trim());
}

function isAllowedOrigin(originHeader) {
  if (!originHeader || originHeader === "null") return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(originHeader).trim());
}

export function createSidecarApp(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const stateFile = join(dataDir, "state.json");
  const persisted = loadPersistedState(stateFile);
  const hasLsEnvInit = Boolean(process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN);

  const state = {
    config: persisted.config,
    quota: persisted.quota,
    activeModelName: "",
    activeGroup: "unknown",
    nativeSync: {
      hasLsEnv: hasLsEnvInit,
      envKeyNames: Object.keys(process.env).filter((k) => /^ANTIGRAVITY_/i.test(k)),
      lastNativeSyncAtMs: 0,
      lastNativeSource: "",
      endpointsTried: [],
    },
    widgetStatus: {
      mounted: false,
      slotWidth: 0,
      lastEventAtMs: 0,
      syncMessage: "",
    },
  };

  let nativePollTimer = null;
  let resetExpiryTimer = null;
  let pollInFlight = null;
  let lastDiskSaveMs = 0;
  let lastSavedFingerprint = quotaFingerprint(state.quota);

  const widgetScriptPath = join(__dirname, "injected-widget.js");
  const auxPanePath = join(__dirname, "aux-pane.html");

  const getEffectiveQuota = () => (state.config.demoMode ? createSampleQuota() : state.quota);

  const buildPayload = () => ({
    config: state.config,
    quota: getEffectiveQuota(),
    activeModelName: state.activeModelName,
    activeGroup: state.activeGroup,
    nativeSync: state.nativeSync,
    widgetStatus: state.widgetStatus,
    cdpStatus: bridge ? bridge.status : { connected: false },
    serverTimeMs: Date.now(),
  });

  // Schedule an exact wakeup poll right after the soonest quota window resets!
  const scheduleNextResetWakeup = () => {
    if (resetExpiryTimer) {
      clearTimeout(resetExpiryTimer);
      resetExpiryTimer = null;
    }
    if (options.disableNativePoll) return;

    const now = Date.now();
    const candidates = [
      state.quota.geminiWeekly?.resetAtMs,
      state.quota.geminiFiveHour?.resetAtMs,
      state.quota.claudeGptWeekly?.resetAtMs,
      state.quota.claudeGptFiveHour?.resetAtMs,
    ].filter((ms) => typeof ms === "number" && ms > now);

    if (candidates.length === 0) return;
    const soonestMs = Math.min(...candidates);
    const delayMs = Math.min(2147483000, Math.max(2500, soonestMs - now + 2500));
    resetExpiryTimer = setTimeout(() => {
      pollNativeLs();
    }, delayMs);
  };

  const applyFreshQuota = (parsed, sourceLabel) => {
    if (!parsed || !hasAnyQuotaData(parsed)) return false;
    const merged = mergeQuotaSnapshots(state.quota, { ...parsed, source: sourceLabel || parsed.source || "Native" });
    const nextFp = quotaFingerprint(merged);
    const dataChanged = nextFp !== lastSavedFingerprint;

    state.quota = merged;
    state.widgetStatus.syncMessage = "";
    if (state.config.demoMode) {
      state.config.demoMode = false;
    }

    const now = Date.now();
    if (dataChanged || now - lastDiskSaveMs > 5 * 60 * 1000) {
      lastSavedFingerprint = nextFp;
      lastDiskSaveMs = now;
      savePersistedStateAtomic(stateFile, state);
    }

    scheduleNextResetWakeup();
    if (bridge) bridge.setStatePayload(buildPayload());
    return true;
  };

  const pollNativeLs = async () => {
    if (options.disableNativePoll) return false;
    if (pollInFlight) return pollInFlight;

    pollInFlight = (async () => {
      try {
        const res = await fetchFromSidecarLsEnv();
        state.nativeSync.hasLsEnv = res.available;
        if (res.endpointsTried.length > 0) {
          state.nativeSync.endpointsTried = res.endpointsTried;
        }
        if (res.snapshot && hasAnyQuotaData(res.snapshot)) {
          state.nativeSync.lastNativeSyncAtMs = Date.now();
          state.nativeSync.lastNativeSource = "NativeRPC";
          // Disable unnecessary CDP Network buffering once NativeRPC resolves all 4 metrics!
          if (bridge && countValidMetrics(res.snapshot) >= 4) {
            bridge.setNetworkCaptureEnabled(false);
          }
          return applyFreshQuota(res.snapshot, "NativeRPC");
        }
      } catch {
        // ignore transient poll error
      } finally {
        pollInFlight = null;
      }
      return false;
    })();

    return pollInFlight;
  };

  const bridge = options.disableCdp
    ? null
    : new CdpBridge(() => readFileSync(widgetScriptPath, "utf8"), {
        enableNetworkCapture: !hasLsEnvInit,
      });

  if (bridge) {
    bridge.on("nativeQuotaPayload", (jsonPayload, url) => {
      const parsed = parseNativeQuotaPayload(jsonPayload, Date.now());
      if (hasAnyQuotaData(parsed)) {
        state.nativeSync.lastNativeSyncAtMs = Date.now();
        state.nativeSync.lastNativeSource = `CDP:${String(url || "").split("/").pop() || "Native"}`;
        applyFreshQuota(parsed, "Native");
      }
    });

    bridge.on("widgetMessage", (msg) => {
      if (!msg || typeof msg !== "object") return;
      state.widgetStatus.lastEventAtMs = Date.now();

      if (msg.type === "mountStatus") {
        const prevModel = state.activeModelName;
        state.widgetStatus.mounted = Boolean(msg.mounted);
        state.widgetStatus.slotWidth = Number(msg.slotWidth) || 0;
        if (typeof msg.activeModelName === "string") state.activeModelName = msg.activeModelName;
        if (typeof msg.activeGroup === "string") state.activeGroup = msg.activeGroup;
        // Refresh native quota promptly if user switched models and last poll was >15s ago
        if (
          prevModel &&
          state.activeModelName &&
          prevModel !== state.activeModelName &&
          Date.now() - state.nativeSync.lastNativeSyncAtMs > 15000
        ) {
          pollNativeLs();
        }
        return;
      }

      if (msg.type === "quotaLines" && Array.isArray(msg.lines)) {
        const parsed = parseQuotaLines(msg.lines, Date.now());
        applyFreshQuota(parsed, "DOM");
        return;
      }

      if (msg.type === "syncStatus") {
        state.widgetStatus.syncMessage = String(msg.message || "");
        return;
      }

      if (msg.type === "requestState") {
        bridge.setStatePayload(buildPayload());
        return;
      }

      if (msg.type === "requestNativeSync") {
        pollNativeLs();
      }
    });

    bridge.on("statusChanged", () => {
      if (bridge.status.connected) {
        bridge.setStatePayload(buildPayload());
      }
    });
  }

  const readJsonBody = (req) =>
    new Promise((resolve, reject) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 256) {
          reject(new Error("Payload too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!body.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });

  const sendJson = (res, code, obj) => {
    const data = JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(data);
  };

  const server = http.createServer(async (req, res) => {
    try {
      // Protect against DNS rebinding and cross-origin browser CSRF
      if (!isLoopbackHostHeader(req.headers.host)) {
        sendJson(res, 403, { ok: false, error: "Forbidden Host header" });
        return;
      }
      if (req.method === "POST" && !isAllowedOrigin(req.headers.origin)) {
        sendJson(res, 403, { ok: false, error: "Forbidden Origin header" });
        return;
      }

      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = url.pathname;

      if (req.method === "GET" && (pathname === "/" || pathname === "/aux-pane.html")) {
        const html = readFileSync(auxPanePath, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(html);
        return;
      }

      if (req.method === "GET" && pathname === "/api/state") {
        sendJson(res, 200, buildPayload());
        return;
      }

      if (req.method === "POST" && pathname === "/api/config") {
        const patch = await readJsonBody(req);
        const allowedKeys = Object.keys(defaultConfig());
        for (const k of allowedKeys) {
          if (Object.prototype.hasOwnProperty.call(patch, k)) {
            state.config[k] = patch[k];
          }
        }
        savePersistedStateAtomic(stateFile, state);
        if (bridge) bridge.setStatePayload(buildPayload());
        sendJson(res, 200, buildPayload());
        return;
      }

      if (req.method === "POST" && pathname === "/api/sync") {
        const syncedNative = await pollNativeLs();
        if (syncedNative) {
          sendJson(res, 200, { ok: true, triggered: true, source: "NativeRPC" });
          return;
        }
        if (bridge && bridge.status.connected) {
          bridge.triggerWidgetSync();
          sendJson(res, 200, { ok: true, triggered: true, source: "Widget" });
        } else {
          sendJson(res, 200, { ok: false, triggered: false, reason: "CDP_NOT_CONNECTED" });
        }
        return;
      }

      if (req.method === "POST" && pathname === "/api/ingest-lines") {
        const body = await readJsonBody(req);
        const parsed = parseQuotaLines(body.lines || [], Date.now());
        if (applyFreshQuota(parsed, "DOM")) {
          sendJson(res, 200, { ok: true, state: buildPayload() });
        } else {
          sendJson(res, 400, { ok: false, error: "No quota metrics parsed" });
        }
        return;
      }

      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message });
    }
  });

  return {
    server,
    bridge,
    start(port = WEB_PORT) {
      return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          const addr = server.address();
          scheduleNextResetWakeup();
          if (bridge) {
            bridge.setStatePayload(buildPayload());
            bridge.start();
          }
          if (!options.disableNativePoll) {
            pollNativeLs().then((ok) => {
              if (!ok && bridge) {
                bridge.setNetworkCaptureEnabled(true);
              }
            });
            nativePollTimer = setInterval(() => {
              pollNativeLs();
            }, 45000);
          }
          resolve(addr.port);
        });
      });
    },
    stop() {
      if (nativePollTimer) {
        clearInterval(nativePollTimer);
        nativePollTimer = null;
      }
      if (resetExpiryTimer) {
        clearTimeout(resetExpiryTimer);
        resetExpiryTimer = null;
      }
      if (bridge) bridge.stop();
      server.close();
    },
  };
}

// Run directly when launched by Antigravity sidecar host
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const app = createSidecarApp();
  app.start().then((boundPort) => {
    console.error(`[antigravity-quota-capsule v1.1.0] Sidecar listening on http://127.0.0.1:${boundPort}`);
  });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      app.stop();
      process.exit(0);
    });
  }
}
