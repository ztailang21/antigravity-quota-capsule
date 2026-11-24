// Antigravity Quota Capsule Sidecar Server (Zero-dependency Node ESM)
// Launched & managed automatically by Antigravity 2.0 via sidecar.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CdpBridge } from "./cdp-bridge.mjs";
import { fetchFromSidecarLsEnv, parseNativeQuotaPayload } from "./native-quota-sync.mjs";
import {
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

function savePersistedState(stateFile, state) {
  try {
    writeFileSync(stateFile, JSON.stringify({ config: state.config, quota: state.quota }, null, 2), "utf8");
  } catch {
    // ignore write errors
  }
}

export function createSidecarApp(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const stateFile = join(dataDir, "state.json");
  const persisted = loadPersistedState(stateFile);
  const state = {
    config: persisted.config,
    quota: persisted.quota,
    activeModelName: "",
    activeGroup: "unknown",
    nativeSync: {
      hasLsEnv: Boolean(process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN),
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

  const applyFreshQuota = (parsed, sourceLabel) => {
    if (!parsed || !hasAnyQuotaData(parsed)) return false;
    state.quota = mergeQuotaSnapshots(state.quota, { ...parsed, source: sourceLabel || parsed.source || "Native" });
    state.widgetStatus.syncMessage = "";
    if (state.config.demoMode) {
      state.config.demoMode = false;
    }
    savePersistedState(stateFile, state);
    if (bridge) bridge.setStatePayload(buildPayload());
    return true;
  };

  const pollNativeLs = async () => {
    if (options.disableNativePoll) return false;
    try {
      const res = await fetchFromSidecarLsEnv();
      state.nativeSync.hasLsEnv = res.available;
      if (res.endpointsTried.length > 0) {
        state.nativeSync.endpointsTried = res.endpointsTried;
      }
      if (res.snapshot && hasAnyQuotaData(res.snapshot)) {
        state.nativeSync.lastNativeSyncAtMs = Date.now();
        state.nativeSync.lastNativeSource = "NativeRPC";
        return applyFreshQuota(res.snapshot, "NativeRPC");
      }
    } catch {
      // ignore transient poll error
    }
    return false;
  };

  const bridge =
    options.disableCdp
      ? null
      : new CdpBridge(() => readFileSync(widgetScriptPath, "utf8"));

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
        state.widgetStatus.mounted = Boolean(msg.mounted);
        state.widgetStatus.slotWidth = Number(msg.slotWidth) || 0;
        if (typeof msg.activeModelName === "string") state.activeModelName = msg.activeModelName;
        if (typeof msg.activeGroup === "string") state.activeGroup = msg.activeGroup;
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
    });
    res.end(data);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = url.pathname;

      if (req.method === "GET" && (pathname === "/" || pathname === "/aux-pane.html")) {
        const html = readFileSync(auxPanePath, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
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
        savePersistedState(stateFile, state);
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
          if (bridge) {
            bridge.setStatePayload(buildPayload());
            bridge.start();
          }
          if (!options.disableNativePoll) {
            pollNativeLs();
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
      if (bridge) bridge.stop();
      server.close();
    },
  };
}

// Run directly when launched by Antigravity sidecar host
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
  const app = createSidecarApp();
  app.start().then((boundPort) => {
    console.error(`[antigravity-quota-capsule] Sidecar listening on http://127.0.0.1:${boundPort}`);
  });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      app.stop();
      process.exit(0);
    });
  }
}
