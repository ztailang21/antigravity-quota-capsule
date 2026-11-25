// Zero-dependency Windows DevToolsActivePort discovery & RFC6455 loopback CDP bridge (v1.1.0)

import { randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WS_BUFFER_BYTES = 8 * 1024 * 1024; // 8 MiB hard safety cap

/**
 * Minimal, standards-compliant RFC6455 WebSocket client for 127.0.0.1 CDP targets.
 * Uses only node:net + node:crypto so it runs on any Node version bundled with Antigravity.
 */
export class LoopbackWebSocket extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.url = new URL(wsUrl);
    this.socket = null;
    this.handshakeDone = false;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragmentChunks = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
  }

  connect(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const host = this.url.hostname;
      if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
        reject(new Error(`Refusing non-loopback CDP host: ${host}`));
        return;
      }

      const port = Number(this.url.port) || 80;
      const path = `${this.url.pathname}${this.url.search || ""}`;
      const key = randomBytes(16).toString("base64");
      const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");

      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.close();
          reject(new Error("WebSocket handshake timeout"));
        }
      }, timeoutMs);

      const sock = net.createConnection({ host: "127.0.0.1", port });
      sock.setNoDelay(true);
      this.socket = sock;

      sock.once("connect", () => {
        const req = [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n");
        sock.write(req);
      });

      sock.on("data", (chunk) => {
        if (this.buffer.length + chunk.length > MAX_WS_BUFFER_BYTES) {
          this.close();
          return;
        }
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

        if (!this.handshakeDone) {
          const headerEnd = this.buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;

          const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
          this.buffer = this.buffer.subarray(headerEnd + 4);

          const statusOk = /^HTTP\/1\.1\s+101\b/i.test(headerText);
          const acceptMatch = headerText.match(/sec-websocket-accept:\s*([^\r\n]+)/i);
          const acceptVal = acceptMatch ? acceptMatch[1].trim() : "";

          if (!statusOk || acceptVal !== expectedAccept) {
            clearTimeout(timer);
            if (!settled) {
              settled = true;
              this.close();
              reject(new Error("Invalid WebSocket 101 handshake response"));
            }
            return;
          }

          this.handshakeDone = true;
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
        }
        this._drainFrames();
      });

      sock.on("error", (err) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          this.emit("error", err);
        }
      });

      sock.on("close", () => {
        clearTimeout(timer);
        if (!this.closed) {
          this.closed = true;
          this.emit("close");
        }
      });
    });
  }

  sendText(text) {
    if (this.closed || !this.socket || !this.handshakeDone) return;
    const payload = Buffer.from(text, "utf8");
    this._writeFrame(0x1, payload);
  }

  _writeFrame(opcode, payload) {
    const maskKey = randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(6);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | len;
      maskKey.copy(header, 2);
    } else if (len < 65536) {
      header = Buffer.alloc(8);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
      maskKey.copy(header, 4);
    } else {
      header = Buffer.alloc(14);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
      maskKey.copy(header, 10);
    }

    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payload[i] ^ maskKey[i & 3];
    }
    this.socket.write(Buffer.concat([header, masked]));
  }

  _drainFrames() {
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const isMasked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        const bigLen = this.buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_WS_BUFFER_BYTES)) {
          this.close();
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_WS_BUFFER_BYTES) {
        this.close();
        return;
      }

      const maskBytes = isMasked ? 4 : 0;
      if (this.buffer.length < offset + maskBytes + payloadLen) return;

      let payload = this.buffer.subarray(offset + maskBytes, offset + maskBytes + payloadLen);
      if (isMasked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ mask[i & 3];
        }
        payload = unmasked;
      } else {
        // Copy out slice so the underlying receive buffer can be GC'd promptly
        payload = Buffer.from(payload);
      }
      this.buffer =
        this.buffer.length === offset + maskBytes + payloadLen
          ? Buffer.alloc(0)
          : this.buffer.subarray(offset + maskBytes + payloadLen);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this._writeFrame(0x0a, payload);
        continue;
      }
      if (opcode === 0x0a) {
        continue;
      }

      if (opcode === 0x0) {
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > MAX_WS_BUFFER_BYTES) {
          this.close();
          return;
        }
        this.fragmentChunks.push(payload);
        if (fin && this.fragmentOpcode === 0x1) {
          const msg = Buffer.concat(this.fragmentChunks).toString("utf8");
          this.fragmentChunks = [];
          this.fragmentBytes = 0;
          this.fragmentOpcode = 0;
          this.emit("message", msg);
        }
      } else if (!fin) {
        this.fragmentOpcode = opcode;
        this.fragmentChunks = [payload];
        this.fragmentBytes = payload.length;
      } else if (opcode === 0x1) {
        this.emit("message", payload.toString("utf8"));
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    this.fragmentChunks = [];
    this.fragmentBytes = 0;
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.emit("close");
  }
}

export function getCandidateDevToolsPortFiles() {
  const candidates = [];
  if (process.env.ANTIGRAVITY_DEVTOOLS_PORT_FILE) {
    candidates.push(process.env.ANTIGRAVITY_DEVTOOLS_PORT_FILE);
  }
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const home = homedir();

  candidates.push(
    join(appData, "Antigravity", "DevToolsActivePort"),
    join(localAppData, "Antigravity", "DevToolsActivePort"),
    join(appData, "Google Antigravity", "DevToolsActivePort"),
    join(localAppData, "Google Antigravity", "DevToolsActivePort"),
    join(appData, "antigravity-desktop", "DevToolsActivePort"),
    join(home, ".gemini", "antigravity", "DevToolsActivePort"),
    join(home, "Library", "Application Support", "Antigravity", "DevToolsActivePort"),
    join(home, ".config", "Antigravity", "DevToolsActivePort")
  );

  return [...new Set(candidates)];
}

export function discoverDebugEndpoints() {
  const found = [];
  for (const filePath of getCandidateDevToolsPortFiles()) {
    try {
      if (!existsSync(filePath)) continue;
      const content = readFileSync(filePath, "utf8").trim();
      const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const port = Number.parseInt(lines[0], 10);
      if (port > 0 && port < 65536) {
        const mtimeMs = statSync(filePath).mtimeMs;
        found.push({ port, filePath, mtimeMs });
      }
    } catch {
      // ignore unreadable candidate
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const envPort = Number.parseInt(process.env.ANTIGRAVITY_CDP_PORT || "", 10);
  if (envPort > 0 && envPort < 65536 && !found.some((f) => f.port === envPort)) {
    found.push({ port: envPort, filePath: "ENV:ANTIGRAVITY_CDP_PORT", mtimeMs: 0 });
  }
  // Only probe fallback:9222 if no DevToolsActivePort file was found
  if (found.length === 0) {
    found.push({ port: 9222, filePath: "fallback:9222", mtimeMs: 0 });
  }
  return found;
}

function httpGetJson(port, path, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        data += c;
        if (data.length > 2 * 1024 * 1024) {
          req.destroy(new Error("JSON list too large"));
        }
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("HTTP timeout"));
    });
    req.on("error", reject);
  });
}

function isAntigravityRendererTarget(target) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) return false;
  const url = String(target.url || "");
  const title = String(target.title || "");
  if (url.startsWith("devtools://") || url.startsWith("chrome-extension://") || url === "about:blank") {
    return false;
  }
  // Never inject into our own Aux Pane iframe if listed as a target
  if (url.includes("/aux-pane.html")) return false;
  if (/antigravity|agy/i.test(title) || /antigravity|index\.html|file:\/\/|app:\/\/|vscode-file/i.test(url)) {
    return true;
  }
  return false;
}

/**
 * Manages CDP connections to Antigravity 2.0 renderer page(s),
 * injects the Shadow DOM composer widget, and relays bidirectional events.
 */
export class CdpBridge extends EventEmitter {
  constructor(widgetScriptProvider, options = {}) {
    super();
    this.widgetScriptProvider = widgetScriptProvider;
    this.sessions = new Map();
    this.pollTimer = null;
    this.pollingInFlight = false;
    this.stopped = false;
    this.latestStatePayload = null;
    this.networkCaptureEnabled = options.enableNetworkCapture !== false;
    this.status = {
      connected: false,
      port: 0,
      portFile: "",
      targetCount: 0,
      targets: [],
      lastInjectedAtMs: 0,
      lastError: "Waiting for Antigravity with --remote-debugging-port=0",
    };
  }

  start() {
    this.stopped = false;
    this._scheduleNextPoll(50);
  }

  stop() {
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    for (const s of this.sessions.values()) {
      s.ws.close();
    }
    this.sessions.clear();
    this._refreshStatus();
  }

  /**
   * Dynamically enables or disables CDP Network response buffering.
   * Disabling Network capture when Sidecar NativeRPC is active avoids Chromium DevTools memory overhead.
   */
  setNetworkCaptureEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.networkCaptureEnabled === next) return;
    this.networkCaptureEnabled = next;
    for (const session of this.sessions.values()) {
      if (next) {
        this._sendCdp(session, "Network.enable", {
          maxPostDataSize: 0,
          maxResourceBufferSize: 262144,
          maxTotalBufferSize: 524288,
        }).catch(() => {});
      } else {
        session.quotaRequests.clear();
        this._sendCdp(session, "Network.disable", {}).catch(() => {});
      }
    }
  }

  setStatePayload(payload) {
    this.latestStatePayload = payload;
    this.broadcastToWidgets({ type: "state", payload });
  }

  triggerWidgetSync() {
    this.broadcastToWidgets({ type: "triggerSync" });
  }

  broadcastToWidgets(messageObj) {
    const serialized = JSON.stringify(messageObj);
    const expr = `if (typeof window.__agQuotaCapsuleReceive === "function") { window.__agQuotaCapsuleReceive(${serialized}); }`;
    for (const session of this.sessions.values()) {
      this._sendCdp(session, "Runtime.evaluate", { expression: expr, silent: true }).catch(() => {});
    }
  }

  _scheduleNextPoll(delayMs) {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      await this._poll();
      // Adaptive backoff: 2.5s while searching for Antigravity, 18s once connected (to detect extra windows)
      const nextDelay = this.sessions.size > 0 ? 18000 : 2500;
      this._scheduleNextPoll(nextDelay);
    }, delayMs);
  }

  async _poll() {
    if (this.stopped || this.pollingInFlight) return;
    this.pollingInFlight = true;
    try {
      const candidates = discoverDebugEndpoints();
      let matchedEndpoint = null;
      let rendererTargets = [];

      for (const ep of candidates) {
        try {
          const list = await httpGetJson(ep.port, "/json/list", 1200);
          if (!Array.isArray(list)) continue;
          const pages = list.filter(isAntigravityRendererTarget);
          if (pages.length > 0) {
            matchedEndpoint = ep;
            rendererTargets = pages;
            break;
          }
        } catch {
          // port not listening or stale DevToolsActivePort
        }
      }

      if (!matchedEndpoint) {
        if (this.sessions.size === 0) {
          this.status.connected = false;
          this.status.port = 0;
          this.status.portFile = "";
          this.status.targetCount = 0;
          this.status.targets = [];
          this.status.lastError =
            "未检测到 Antigravity CDP 调试端口。请确认已运行 install.ps1 并通过更新后的快捷方式重启 Antigravity。";
        }
        return;
      }

      this.status.port = matchedEndpoint.port;
      this.status.portFile = matchedEndpoint.filePath;
      this.status.lastError = "";

      for (const target of rendererTargets) {
        if (this.sessions.has(target.id)) {
          // Keep cached title fresh
          this.sessions.get(target.id).target = target;
          continue;
        }
        await this._attachTarget(target).catch((err) => {
          this.status.lastError = `CDP attach error: ${err.message}`;
        });
      }

      this._refreshStatus();
    } finally {
      this.pollingInFlight = false;
    }
  }

  async _attachTarget(target) {
    const ws = new LoopbackWebSocket(target.webSocketDebuggerUrl);
    await ws.connect(3500);

    const session = {
      ws,
      target,
      idSeq: 1,
      pending: new Map(),
      quotaRequests: new Map(),
    };
    this.sessions.set(target.id, session);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.id && session.pending.has(msg.id)) {
          const { resolve, reject } = session.pending.get(msg.id);
          session.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || "CDP error"));
          else resolve(msg.result);
          return;
        }

        if (msg.method === "Runtime.bindingCalled" && msg.params?.name === "__agQuotaCapsuleEmit") {
          try {
            const eventData = JSON.parse(msg.params.payload);
            this.emit("widgetMessage", eventData, target.id);
          } catch {
            // ignore malformed payload
          }
          return;
        }

        if (this.networkCaptureEnabled && msg.method === "Network.responseReceived") {
          const reqId = msg.params?.requestId;
          const url = String(msg.params?.response?.url || "");
          const status = Number(msg.params?.response?.status || 0);
          if (
            reqId &&
            status >= 200 &&
            status < 300 &&
            /(GetUserStatus|RetrieveUserQuotaSummary|GetCommandModelConfigs|UserQuota|QuotaSummary)/i.test(url)
          ) {
            session.quotaRequests.set(reqId, url);
            if (session.quotaRequests.size > 24) {
              const firstKey = session.quotaRequests.keys().next().value;
              session.quotaRequests.delete(firstKey);
            }
          }
          return;
        }

        if (this.networkCaptureEnabled && msg.method === "Network.loadingFinished") {
          const reqId = msg.params?.requestId;
          if (reqId && session.quotaRequests.has(reqId)) {
            const url = session.quotaRequests.get(reqId);
            session.quotaRequests.delete(reqId);
            this._sendCdp(session, "Network.getResponseBody", { requestId: reqId })
              .then((res) => {
                if (!res || !res.body) return;
                const text = res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
                const parsed = JSON.parse(text);
                this.emit("nativeQuotaPayload", parsed, url);
              })
              .catch(() => {});
          }
        }
      } catch {
        // ignore non-JSON frame
      }
    });

    ws.on("close", () => {
      for (const p of session.pending.values()) {
        p.reject(new Error("CDP socket closed"));
      }
      session.pending.clear();
      session.quotaRequests.clear();
      this.sessions.delete(target.id);
      this._refreshStatus();
      // If last window closed or reloaded, wake up fast reconnect polling immediately
      if (this.sessions.size === 0 && !this.stopped) {
        this._scheduleNextPoll(800);
      }
    });

    ws.on("error", () => {
      // handled on close
    });

    await this._sendCdp(session, "Runtime.enable", {});
    await this._sendCdp(session, "Page.enable", {});
    if (this.networkCaptureEnabled) {
      await this._sendCdp(session, "Network.enable", {
        maxPostDataSize: 0,
        maxResourceBufferSize: 262144,
        maxTotalBufferSize: 524288,
      }).catch(() => {});
    }
    await this._sendCdp(session, "Runtime.addBinding", { name: "__agQuotaCapsuleEmit" });

    const script = this.widgetScriptProvider();
    await this._sendCdp(session, "Page.addScriptToEvaluateOnNewDocument", { source: script });
    await this._sendCdp(session, "Runtime.evaluate", { expression: script, awaitPromise: false });

    this.status.lastInjectedAtMs = Date.now();
    this._refreshStatus();

    if (this.latestStatePayload) {
      this.broadcastToWidgets({ type: "state", payload: this.latestStatePayload });
    }
  }

  _sendCdp(session, method, params) {
    return new Promise((resolve, reject) => {
      const id = session.idSeq++;
      const timer = setTimeout(() => {
        if (session.pending.has(id)) {
          session.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 4000);

      session.pending.set(id, {
        resolve: (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      session.ws.sendText(JSON.stringify({ id, method, params }));
    });
  }

  _refreshStatus() {
    this.status.targetCount = this.sessions.size;
    this.status.connected = this.sessions.size > 0;
    this.status.targets = [...this.sessions.values()].map((s) => ({
      id: s.target.id,
      title: s.target.title || "Antigravity",
      url: s.target.url || "",
    }));
    this.emit("statusChanged", { ...this.status });
  }
}
