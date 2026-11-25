import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LoopbackWebSocket } from "../sidecars/quota-capsule/cdp-bridge.mjs";
import { parseNativeQuotaPayload } from "../sidecars/quota-capsule/native-quota-sync.mjs";
import {
  formatFullReset,
  formatShortReset,
  mergeQuotaSnapshots,
  parseQuotaLines,
} from "../sidecars/quota-capsule/quota-parser.mjs";
import { createSidecarApp } from "../sidecars/quota-capsule/server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(__dirname);

async function testManifests() {
  const pluginJson = JSON.parse(readFileSync(join(rootDir, "plugin.json"), "utf8"));
  assert.equal(pluginJson.name, "antigravity-quota-capsule");
  assert.equal(pluginJson.version, "1.1.0");
  assert.ok(pluginJson.displayName);

  const sidecarJson = JSON.parse(
    readFileSync(join(rootDir, "sidecars", "quota-capsule", "sidecar.json"), "utf8")
  );
  assert.equal(sidecarJson.command, "powershell.exe");
  assert.ok(sidecarJson.args.includes("launch.ps1"));
  assert.equal(sidecarJson.has_web_ui, true);
  assert.equal(sidecarJson.ui_config.views[0].entrypoint, "SIDECAR_UI_ENTRYPOINT_AUX_PANE");
  console.log("[PASS] Manifest schema validation (plugin.json v1.1.0 + sidecar.json)");
}

async function testQuotaParser() {
  const t0 = Date.UTC(2026, 10, 24, 12, 0, 0);

  const zhCols = [
    "Gemini 模型",
    "周限额",
    "6 天 15 小时 后重置",
    "83% 剩余",
    "5 小时限额",
    "1 小时 45 分钟 后重置",
    "62% 剩余",
    "Claude 和 GPT 模型",
    "周限额",
    "3 天 14 小时 后重置",
    "0% 剩余",
    "5 小时限额",
    "4 小时 59 分钟 后重置",
    "100% 剩余",
  ];
  const s1 = parseQuotaLines(zhCols, t0);
  assert.equal(s1.geminiWeekly.remainingPercent, 83);
  assert.equal(s1.geminiFiveHour.remainingPercent, 62);
  assert.equal(s1.claudeGptWeekly.remainingPercent, 0);
  assert.equal(s1.claudeGptFiveHour.remainingPercent, 100);
  assert.equal(formatFullReset(s1.geminiWeekly, t0, true), "6 天 15 小时 后重置");
  assert.equal(formatShortReset(s1.geminiFiveHour, t0 + 30 * 60000, true), "1h15m");
  assert.equal(formatShortReset(s1.geminiFiveHour, t0 + 3 * 3600000, true), "已重置");

  const enRows = [
    "Gemini models",
    "Weekly limit",
    "75% remaining",
    "Resets in 5d 8h",
    "5-hour limit",
    "40% remaining",
    "Resets in 2h 10m",
    "Claude and GPT models",
    "Weekly limit",
    "12% remaining",
    "Resets in 1d 2h",
    "5-hour limit",
    "95% remaining",
    "Resets in 45m",
  ];
  const s2 = parseQuotaLines(enRows, t0);
  assert.equal(s2.geminiWeekly.remainingPercent, 75);
  assert.equal(s2.geminiFiveHour.remainingPercent, 40);
  assert.equal(s2.claudeGptWeekly.remainingPercent, 12);
  assert.equal(s2.claudeGptFiveHour.remainingPercent, 95);
  assert.equal(formatFullReset(s2.claudeGptFiveHour, t0, false), "Resets in 45m");

  const partial = parseQuotaLines(["Gemini 模型", "5 小时限额", "55% 剩余", "1 小时 20 分钟 后重置"], t0 + 60000);
  const merged = mergeQuotaSnapshots(s1, partial);
  assert.equal(merged.geminiFiveHour.remainingPercent, 55);
  assert.equal(merged.geminiWeekly.remainingPercent, 83);
  assert.equal(merged.claudeGptFiveHour.remainingPercent, 100);

  console.log("[PASS] QuotaParser ZH/EN + countdown + partial merge");
}

async function testNativeQuotaPayloadParser() {
  const now = Date.UTC(2026, 10, 24, 12, 0, 0);
  // Test Carbon/Hydrogen naming without explicit "Gemini" prefix + proto3 omitted 0%
  const sampleRpc = {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: "Carbon High",
            quotaInfo: {
              remainingFraction: 0.62,
              resetTime: new Date(now + 105 * 60000).toISOString(),
            },
            weeklyQuotaInfo: {
              remainingFraction: 0.5,
              resetTime: new Date(now + (5 * 24 + 14) * 3600000).toISOString(),
            },
          },
          {
            label: "Hydrogen",
            quotaInfo: {
              remainingFraction: 0.93,
              resetTime: new Date(now + 120 * 60000).toISOString(),
            },
          },
          {
            label: "Claude Sonnet 4.5",
            quotaInfo: {
              remainingFraction: 1.0,
              resetTime: new Date(now + 299 * 60000).toISOString(),
            },
            weeklyQuotaInfo: {
              resetTime: new Date(now + (3 * 24 + 14) * 3600000).toISOString(),
            },
          },
        ],
      },
    },
  };

  const parsed = parseNativeQuotaPayload(sampleRpc, now);
  assert.equal(parsed.geminiWeekly.remainingPercent, 50);
  assert.equal(parsed.geminiFiveHour.remainingPercent, 62); // most constrained across Carbon/Hydrogen pool
  assert.equal(parsed.claudeGptWeekly.remainingPercent, 0);
  assert.equal(parsed.claudeGptFiveHour.remainingPercent, 100);
  console.log("[PASS] Native Connect-RPC parser (Carbon/Hydrogen + proto3 0% + pool min)");
}

async function testLoopbackWebSocket() {
  const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  const server = http.createServer();

  const encodeServerFrame = (text) => {
    const payload = Buffer.from(text, "utf8");
    if (payload.length < 126) {
      return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    }
    const hdr = Buffer.alloc(4);
    hdr[0] = 0x81;
    hdr[1] = 126;
    hdr.writeUInt16BE(payload.length, 2);
    return Buffer.concat([hdr, payload]);
  };

  const sockets = new Set();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n")
    );

    socket.on("data", (buf) => {
      const b1 = buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        len = buf.readUInt16BE(2);
        off = 4;
      }
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.alloc(len);
      for (let i = 0; i < len; i++) data[i] = buf[off + 4 + i] ^ mask[i & 3];
      const msg = JSON.parse(data.toString("utf8"));
      const reply = JSON.stringify({ id: msg.id, result: { ok: true, pad: "x".repeat(300) } });
      socket.write(encodeServerFrame(reply));
    });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const ws = new LoopbackWebSocket(`ws://127.0.0.1:${port}/devtools/page/test`);
  await ws.connect(2000);

  const received = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("WS echo timeout")), 2000);
    ws.once("message", (m) => {
      clearTimeout(t);
      resolve(JSON.parse(m));
    });
    ws.sendText(JSON.stringify({ id: 42, method: "Runtime.enable" }));
  });

  assert.equal(received.id, 42);
  assert.equal(received.result.ok, true);
  assert.equal(received.result.pad.length, 300);

  ws.close();
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
  console.log("[PASS] Pure-JS RFC6455 LoopbackWebSocket client");
}

async function testSidecarHttpApiAndSecurity() {
  const tmpData = mkdtempSync(join(tmpdir(), "ag-quota-test-"));
  const app = createSidecarApp({ disableCdp: true, disableNativePoll: true, dataDir: tmpData });
  const port = await app.start(0);

  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const htmlRes = await fetch(`http://127.0.0.1:${port}/aux-pane.html`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get("x-content-type-options"), "nosniff");
    const html = await htmlRes.text();
    assert.ok(html.includes("v1.1.0"));

    // Verify cross-origin CSRF rejection on POST /api/config
    const csrfBlocked = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(csrfBlocked.status, 403);

    // Verify DNS rebinding Host header rejection
    const dnsRebindStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/state",
          method: "GET",
          headers: { Host: "attacker.example.com" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(dnsRebindStatus, 403);

    const ingestRes = await fetch(`http://127.0.0.1:${port}/api/ingest-lines`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: [
          "Gemini 模型",
          "周限额",
          "83% 剩余",
          "6 天 15 小时 后重置",
          "5 小时限额",
          "62% 剩余",
          "1 小时 45 分钟 后重置",
        ],
      }),
    }).then((r) => r.json());

    assert.equal(ingestRes.ok, true);
    assert.equal(ingestRes.state.quota.geminiWeekly.remainingPercent, 83);
    assert.equal(ingestRes.state.quota.geminiFiveHour.remainingPercent, 62);

    const cfgRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ density: "both", openOnHover: true }),
    }).then((r) => r.json());
    assert.equal(cfgRes.config.density, "both");
    assert.equal(cfgRes.config.openOnHover, true);

    console.log("[PASS] Sidecar HTTP API + CSRF/DNS-rebinding security + atomic persistence");
  } finally {
    app.stop();
    rmSync(tmpData, { recursive: true, force: true });
  }
}

await testManifests();
await testQuotaParser();
await testNativeQuotaPayloadParser();
await testLoopbackWebSocket();
await testSidecarHttpApiAndSecurity();
console.log("\nALL ANTIGRAVITY QUOTA CAPSULE v1.1.0 TESTS PASSED!");
