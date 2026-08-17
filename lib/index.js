// dsh-auto-scheduler host plugin (ESM, zero dependencies).
// Scheduler + /api/dsh-auto-scheduler/* routes + silent preset sync.
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const name = "auto-scheduler";
const inject = ["apiProxy", "webServer", "agentPresets", "permissionPresets", "sessions", "systemPrompt"];

let VERSION = "0.1.0";
try {
  VERSION = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version || VERSION;
} catch (error) {}

const SILENT_PRESET_ID = "dsh-auto-scheduler-silent";
const STORE_VERSION = 1;
const TICK_MS = 20000;
const MAX_BODY_BYTES = 1024 * 1024;

const GUIDANCE = "本机已安装 dsh-auto-scheduler 插件（定时自动工作）：侧边栏「自动工作」面板可添加定时任务；到开始时间自动新建会话并发送任务，到停止时间中断 agent 并停止会话（会话保留可回看）。两种模式：静默模式（danger-full-access、不向用户提问、完成前不停止工作）与默认模式（允许提问、一切保留默认设置）。谷峰时段预设为北京时间 12:00-14:00、18:00-次日 9:00，面板按本机时区显示、内部以 UTC 存储。用户提到「定时任务 / 自动工作 / 定时开始 / 谷峰时段」时即指本插件。";

function dshHome() {
  const raw = process.env.DSH_HOME;
  if (raw && raw.trim()) {
    const h = raw.trim();
    if (h === "~") return homedir();
    if (h.startsWith("~/") || h.startsWith("~\\")) return join(homedir(), h.slice(2));
    return h;
  }
  return join(homedir(), ".dsh");
}

function storePath() {
  return join(dshHome(), "dsh-auto-scheduler.json");
}

function bundledPresetsRoot() {
  return fileURLToPath(new URL("../presets/", import.meta.url));
}

// ---------- preset sync ----------
function syncPreset(ctx) {
  const source = join(bundledPresetsRoot(), SILENT_PRESET_ID);
  const target = join(dshHome(), ".agent-presets", SILENT_PRESET_ID);
  try {
    mkdirSync(target, { recursive: true });
    const files = ["agent.cordis.yml", "preset.yml"];
    let changed = 0;
    for (const f of files) {
      const src = join(source, f);
      const dst = join(target, f);
      if (!existsSync(src)) continue;
      const data = readFileSync(src);
      if (existsSync(dst) && readFileSync(dst).equals(data)) continue;
      writeFileSync(dst, data);
      changed += 1;
    }
    if (changed > 0 && ctx.logger) ctx.logger.info("dsh-auto-scheduler: 静默预设已同步 (" + changed + " 个文件)");
  } catch (error) {
    if (ctx.logger) ctx.logger.warn("dsh-auto-scheduler: 预设同步失败: " + String(error && error.message ? error.message : error));
  }
}

// ---------- store ----------
let store = null;
let persistTimer = null;

function defaultStore() {
  return { version: STORE_VERSION, schedules: [] };
}

function loadStore() {
  try {
    const raw = readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === STORE_VERSION && Array.isArray(parsed.schedules)) return parsed;
  } catch (error) {}
  return defaultStore();
}

function persistNow() {
  try {
    mkdirSync(join(storePath(), ".."), { recursive: true });
    writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf8");
  } catch (error) {
    console.error("[dsh-auto-scheduler] persist failed: " + String(error && error.message ? error.message : error));
  }
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 250);
}

// ---------- schedule model ----------
function parseTime(value) {
  return Date.parse(value);
}

function normalizeSchedule(input, existing) {
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (goal === "") throw new Error("工作目标不能为空");
  if (goal.length > 20000) throw new Error("工作目标过长（超过 20000 字符）");
  const mode = input.mode === "silent" ? "silent" : "default";
  const startMs = parseTime(input.startAtUtc);
  const stopMs = parseTime(input.stopAtUtc);
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs)) throw new Error("时间格式无效，需要 UTC ISO 字符串");
  if (stopMs <= startMs) throw new Error("停止时间必须晚于开始时间");
  const repeat = input.repeat === "daily" ? "daily" : "once";
  const enabled = input.enabled !== false;
  const nowIso = new Date().toISOString();
  const startAtUtc = new Date(startMs).toISOString();
  const stopAtUtc = new Date(stopMs).toISOString();
  const schedule = {
    id: existing ? existing.id : ("sched-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)),
    goal: goal,
    mode: mode,
    startAtUtc: startAtUtc,
    stopAtUtc: stopAtUtc,
    repeat: repeat,
    enabled: enabled,
    clientTimeZone: typeof input.clientTimeZone === "string" ? input.clientTimeZone.slice(0, 64) : undefined,
    status: existing ? existing.status : "idle",
    sessionId: existing ? existing.sessionId : null,
    lastRunAt: existing ? existing.lastRunAt : null,
    lastFiredAt: existing && existing.startAtUtc === startAtUtc ? existing.lastFiredAt : null,
    lastError: existing ? existing.lastError : null,
    createdAt: existing ? existing.createdAt : nowIso,
    updatedAt: nowIso
  };
  return schedule;
}

function occurrenceFor(s, now) {
  const startMs = parseTime(s.startAtUtc);
  const stopMs = parseTime(s.stopAtUtc);
  const duration = stopMs - startMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(stopMs) || duration <= 0) return null;
  if (s.repeat === "once") {
    if (now < startMs || now >= stopMs) return null;
    return { start: startMs, stop: stopMs };
  }
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const todayStart = day.getTime() + (startMs % 86400000);
  const candidates = [todayStart - 86400000, todayStart, todayStart + 86400000];
  for (const start of candidates) {
    const stop = start + duration;
    if (now >= start && now < stop) return { start: start, stop: stop };
  }
  return null;
}

function nextRunAtFor(s, now) {
  if (s.status === "running") return null;
  const startMs = parseTime(s.startAtUtc);
  if (!Number.isFinite(startMs)) return null;
  if (s.repeat === "once") return now < startMs ? startMs : null;
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const todayStart = day.getTime() + (startMs % 86400000);
  return todayStart >= now ? todayStart : todayStart + 86400000;
}

// ---------- session driving (same path the Web GUI uses) ----------
let rpcCounter = 0;
function rpcId() {
  return "dsh-auto-scheduler-" + (++rpcCounter);
}

function rpcResult(resp) {
  return resp && resp.result ? resp.result : null;
}

function describeResult(result) {
  if (result && result.ok) return null;
  const err = result && result.error;
  return err ? (err.code + ": " + err.message) : "unknown error";
}

async function startSession(ctx, s) {
  const payload = {};
  if (s.mode === "silent") payload.agentPreset = SILENT_PRESET_ID;
  const createResp = await ctx.apiProxy.sessions.create({ rpcId: rpcId(), payload: payload });
  const createResult = rpcResult(createResp);
  if (!createResult || !createResult.ok) throw new Error("创建会话失败: " + describeResult(createResult));
  const sessionId = createResult.value.sessionId;
  s.sessionId = sessionId;
  if (s.mode === "silent") {
    const session = ctx.sessions.get(sessionId);
    if (session) {
      try {
        ctx.permissionPresets.set(session, "danger-full-access");
      } catch (error) {
        if (ctx.logger) ctx.logger.warn("dsh-auto-scheduler: 设置权限失败: " + String(error && error.message ? error.message : error));
      }
    } else if (ctx.logger) {
      ctx.logger.warn("dsh-auto-scheduler: 未找到会话 " + sessionId);
    }
  }
  try {
    await ctx.apiProxy.sessions.rename({
      rpcId: rpcId(),
      payload: { sessionId: sessionId, title: "[自动] " + s.goal.replace(/\s+/g, " ").slice(0, 60) }
    });
  } catch (error) {}
  const promptPayload = { sessionId: sessionId, mode: "queue", content: [{ type: "text", text: s.goal }] };
  if (s.clientTimeZone) promptPayload.clientTimeZone = s.clientTimeZone;
  const promptResp = await ctx.apiProxy.sessions.prompt({ rpcId: rpcId(), payload: promptPayload });
  const promptResult = rpcResult(promptResp);
  if (!promptResult || !promptResult.ok) throw new Error("发送任务失败: " + describeResult(promptResult));
  if (ctx.logger) ctx.logger.info("dsh-auto-scheduler: 任务已开始 [" + s.mode + "] " + s.goal.slice(0, 40) + " -> " + sessionId);
}

async function stopSession(ctx, s, reason) {
  if (!s.sessionId) return;
  try {
    const resp = await ctx.apiProxy.sessions.cancel({ rpcId: rpcId(), payload: { sessionId: s.sessionId } });
    const result = rpcResult(resp);
    if (!result || !result.ok) throw new Error(describeResult(result));
    if (ctx.logger) ctx.logger.info("dsh-auto-scheduler: 已停止会话 " + s.sessionId + "（" + reason + "）");
  } catch (error) {
    if (ctx.logger) ctx.logger.warn("dsh-auto-scheduler: 停止会话失败: " + String(error && error.message ? error.message : error));
  }
}

async function runNow(ctx, id) {
  const s = store.schedules.find((x) => x.id === id);
  if (!s) throw new Error("任务不存在: " + id);
  if (s.status === "running") throw new Error("任务正在运行");
  await startSession(ctx, s);
  s.lastRunAt = new Date().toISOString();
  s.status = "running";
  s.lastError = null;
  persistSoon();
}

// ---------- scheduler tick ----------
async function tick(ctx) {
  const now = Date.now();
  let changed = false;
  for (const s of store.schedules) {
    if (!s.enabled) continue;
    if (s.status === "running") {
      const startMs = parseTime(s.startAtUtc);
      const stopMs = parseTime(s.stopAtUtc);
      const lastRun = parseTime(s.lastRunAt);
      if (Number.isFinite(startMs) && Number.isFinite(stopMs) && Number.isFinite(lastRun)) {
        const stopAt = lastRun + (stopMs - startMs);
        if (now >= stopAt) {
          await stopSession(ctx, s, "到停止时间");
          s.status = "stopped";
          changed = true;
        }
      }
      continue;
    }
    if (s.status === "done" || s.status === "missed") continue;
    const occ = occurrenceFor(s, now);
    if (occ) {
      if (s.lastFiredAt === occ.start) continue;
      try {
        await startSession(ctx, s);
        s.lastFiredAt = occ.start;
        s.lastRunAt = new Date().toISOString();
        s.status = "running";
        s.lastError = null;
      } catch (error) {
        s.status = "error";
        s.lastError = String(error && error.message ? error.message : error);
      }
      changed = true;
      continue;
    }
    if (s.repeat === "once") {
      const stopMs = parseTime(s.stopAtUtc);
      const startMs = parseTime(s.startAtUtc);
      if (Number.isFinite(stopMs) && now >= stopMs && s.lastFiredAt !== startMs && s.status !== "missed") {
        s.status = "missed";
        changed = true;
      }
    }
  }
  if (changed) persistSoon();
}

// ---------- routes ----------
function isLoopbackRequest(request) {
  const address = request.socket && request.socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try { hostUrl = new URL("http://" + host); } catch (error) { return false; }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === hostUrl.host; } catch (error) { return false; }
}

function isTrustedHost(ctx, request) {
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostname;
  try { hostname = new URL("http://" + host).hostname; } catch (error) { return false; }
  try {
    const conn = ctx.get("connection");
    if (conn && Array.isArray(conn.trustedHosts) && conn.trustedHosts.includes(hostname)) return true;
  } catch (error) {}
  return false;
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer"
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buffer = chunk;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) return undefined;
      chunks.push(buffer);
    }
  } catch (error) { return undefined; }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch (error) { return undefined; }
}

function makeRoutes(ctx) {
  const guard = (req, res, method) => {
    if ((req.method || "GET") !== method) {
      writeJson(res, 405, { ok: false, error: "method not allowed" });
      return false;
    }
    if (isLoopbackRequest(req) || isTrustedHost(ctx, req)) return true;
    writeJson(res, 403, { ok: false, error: "forbidden: loopback or --trusted-host only" });
    return false;
  };
  return [
    {
      kind: "exact",
      path: "/api/dsh-auto-scheduler/health",
      handler: async (req, res) => {
        if (!guard(req, res, "GET")) return;
        let silentPresetReady = false;
        try {
          const list = await ctx.agentPresets.list();
          silentPresetReady = list.some((p) => p.id === SILENT_PRESET_ID && !p.broken);
        } catch (error) {}
        writeJson(res, 200, { ok: true, version: VERSION, nowUtc: new Date().toISOString(), silentPresetReady: silentPresetReady, scheduleCount: store.schedules.length });
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-auto-scheduler/schedules",
      handler: async (req, res) => {
        const method = req.method || "GET";
        if (!guard(req, res, method === "GET" ? "GET" : "POST")) return;
        if (method === "GET") {
          const now = Date.now();
          const items = store.schedules.map((s) => {
            const copy = Object.assign({}, s);
            const next = nextRunAtFor(s, now);
            copy.nextRunAtUtc = next ? new Date(next).toISOString() : null;
            return copy;
          });
          writeJson(res, 200, { ok: true, nowUtc: new Date().toISOString(), schedules: items });
          return;
        }
        const body = await readJsonBody(req);
        if (!body) { writeJson(res, 400, { ok: false, error: "invalid JSON body" }); return; }
        try {
          const existing = typeof body.id === "string" ? store.schedules.find((x) => x.id === body.id) : undefined;
          const normalized = normalizeSchedule(body, existing);
          if (existing) {
            const idx = store.schedules.indexOf(existing);
            store.schedules[idx] = normalized;
          } else {
            store.schedules.push(normalized);
          }
          persistSoon();
          writeJson(res, 200, { ok: true, schedule: normalized });
        } catch (error) {
          writeJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-auto-scheduler/delete",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body || typeof body.id !== "string") { writeJson(res, 400, { ok: false, error: "missing id" }); return; }
        const idx = store.schedules.findIndex((x) => x.id === body.id);
        if (idx < 0) { writeJson(res, 404, { ok: false, error: "任务不存在" }); return; }
        const s = store.schedules[idx];
        if (s.status === "running") await stopSession(ctx, s, "任务被删除");
        store.schedules.splice(idx, 1);
        persistSoon();
        writeJson(res, 200, { ok: true });
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-auto-scheduler/toggle",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body || typeof body.id !== "string") { writeJson(res, 400, { ok: false, error: "missing id" }); return; }
        const s = store.schedules.find((x) => x.id === body.id);
        if (!s) { writeJson(res, 404, { ok: false, error: "任务不存在" }); return; }
        s.enabled = body.enabled !== false;
        s.updatedAt = new Date().toISOString();
        persistSoon();
        writeJson(res, 200, { ok: true, schedule: s });
      }
    },
    {
      kind: "exact",
      path: "/api/dsh-auto-scheduler/run-now",
      handler: async (req, res) => {
        if (!guard(req, res, "POST")) return;
        const body = await readJsonBody(req);
        if (!body || typeof body.id !== "string") { writeJson(res, 400, { ok: false, error: "missing id" }); return; }
        try {
          await runNow(ctx, body.id);
          writeJson(res, 200, { ok: true });
        } catch (error) {
          writeJson(res, 400, { ok: false, error: String(error && error.message ? error.message : error) });
        }
      }
    }
  ];
}

// ---------- cordis plugin ----------
function apply(ctx, config) {
  store = loadStore();

  // Reconcile records left "running" by a previous process (old agent is gone;
  // the session itself remains for review).
  let reconciled = false;
  for (const s of store.schedules) {
    if (s.status === "running") { s.status = "stopped"; reconciled = true; }
  }
  if (reconciled) persistSoon();

  syncPreset(ctx);

  let disposeSection;
  try {
    disposeSection = ctx.systemPrompt.section({
      name: "plugin:dsh-auto-scheduler",
      order: 152,
      text: GUIDANCE
    });
  } catch (error) {}

  const routes = makeRoutes(ctx);
  ctx.effect(() => {
    const disposers = routes.map((r) => ctx.webServer.register(r));
    return () => { for (const d of disposers) d(); };
  }, "dsh-auto-scheduler: routes");

  const timer = setInterval(() => {
    tick(ctx).catch((error) => {
      if (ctx.logger) ctx.logger.warn("dsh-auto-scheduler: tick 失败: " + String(error && error.message ? error.message : error));
    });
  }, TICK_MS);
  tick(ctx).catch(() => {});

  ctx.effect(() => () => {
    clearInterval(timer);
    if (disposeSection) disposeSection();
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; persistNow(); }
  }, "dsh-auto-scheduler: timer");
}

export { apply, inject, name };
