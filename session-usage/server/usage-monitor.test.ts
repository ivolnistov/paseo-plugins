import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowancePace, allowanceProviders, AllowancesSchema, attributedScope, formatAmount, providerNotice, quotaCounts, windowSpan, type Allowances } from "../shared/allowance";
import { mergeAllowances } from "./allowances";
import { daemonUrl, fromUsageMonitor, hostClientOpener, UsageMonitorBridge, type RpcClient } from "./usage-monitor";
import { fixture } from "./model.test";

const NOW = Date.parse("2026-10-06T08:00:00Z");
const quota = (id: string, label: string, unit: string, percent: number | null, window: object | null, extra: object = {}) => ({ kind: "quota", id, label, group: null, unit, percent, used: null, limit: null, remaining: null, window, ...extra });
const balance = (id: string, label: string, remaining: number | null, currency: string | null, unit = "usd") => ({ kind: "balance", id, label, group: null, unit, remaining, total: null, percentRemaining: null, currency });
const provider = (providerId: string, label: string, readings: object[], extra: object = {}) => ({
  providerId, label, description: null, unverified: false, live: false, status: "ok", readings, error: null, fetchedAt: "2026-10-06T07:55:00.000Z", notice: null, authRefreshCommand: null, display: { secret: "DISPLAY" }, icon: null, ...extra,
});
/** The shape of the six configured Usage Monitor providers, with values like the live host's. */
const SIX = {
  configPath: "/Users/someone/.paseo/plugin-data/usage-monitor/usage-limits.json",
  providers: [
    provider("claude", "Claude", [
      quota("session", "Session", "percent", 13, { label: "Session", resetsAt: "2026-10-06T09:10:00Z", durationMs: 18_000_000 }),
      quota("weekly", "Weekly", "percent", 24, { label: "Weekly", resetsAt: "2026-10-07T07:00:00Z", durationMs: 604_800_000 }),
      quota("scoped-weekly-scoped", "Weekly · Fable", "percent", 20, { label: "Weekly", resetsAt: "2026-10-07T07:00:00Z", durationMs: 604_800_000 }),
    ], { notice: "Anthropic rate-limited https://api.example/v1/usage?key=sk-SECRET; showing cached" }),
    provider("codex", "Codex", [
      quota("session", "Session", "percent", 34, { label: "Session", resetsAt: "2026-10-11T16:24:37.000Z", durationMs: 18_000_000 }),
      quota("weekly", "Weekly", "percent", null, { label: "Weekly", resetsAt: null, durationMs: 604_800_000 }),
      balance("credits", "Credits", 0, null),
    ]),
    provider("deepseek", "DeepSeek", [balance("balance", "Balance", 4.29, "USD"), balance("granted", "Granted", 0, "USD")]),
    provider("glm", "GLM", [balance("available", "Available API balance", 58.97800451, null)]),
    provider("kimi", "Kimi", [quota("session", "5-hour usage", "percent", 0, { label: "Session", resetsAt: "2026-10-06T12:00:00Z", durationMs: 18_000_000 })]),
    provider("minimax", "MiniMax", [quota("interval-general", "Interval · general", "requests", 3, { label: "Interval", resetsAt: "2026-10-06T10:00:00Z", durationMs: null }, { used: 0, limit: 0 })]),
  ],
};
const NATIVE: Allowances = {
  fetchedAt: "2026-10-06T07:58:00.000Z", error: null, providers: [
    { providerId: "claude", displayName: "Claude", status: "error", windows: [] },
    { providerId: "codex", displayName: "Codex", status: "available", planLabel: "pro", windows: [{ id: "session", label: "Session", usedPct: 34, remainingPct: 66, resetsAt: "2026-10-11T16:24:37.000Z" }] },
    { providerId: "copilot", displayName: "Copilot", status: "unavailable", windows: [] },
    { providerId: "kimi", displayName: "Kimi", status: "unavailable", windows: [] },
    { providerId: "zai", displayName: "Z.AI", status: "unavailable", windows: [] },
  ],
};

test("Usage Monitor readings convert without config paths, notices, error text or display data", () => {
  const providers = fromUsageMonitor(SIX);
  assert.deepEqual(providers.map((p) => p.providerId), ["claude", "codex", "deepseek", "glm", "kimi", "minimax"]);
  const text = JSON.stringify(providers);
  for (const secret of ["sk-SECRET", "api.example", "usage-limits.json", "DISPLAY", "rate-limited"]) assert.ok(!text.includes(secret), secret);
  assert.equal(providers[0].stale, true);
  assert.equal(providers[1].stale, false);
  assert.deepEqual(providers[0].windows[1], { id: "weekly", label: "Weekly", kind: "quota", unit: "percent", usedPct: 24, used: null, limit: null, remaining: null, resetsAt: "2026-10-07T07:00:00Z", windowSeconds: 604_800 });
  assert.deepEqual(fromUsageMonitor({ providers: [{ providerId: 1 }, provider("x", "X", [{ kind: "quota", id: 3 }, balance("b", "B", 1, "EUR")])] }).map((p) => [p.providerId, p.windows.length]), [["x", 1]]);
  assert.deepEqual(fromUsageMonitor("nonsense"), []);
});

test("Codex windows from the preset keep their reset but lose the mislabelled 5-hour length", () => {
  const [, codex] = fromUsageMonitor(SIX);
  const [primary, secondary] = codex.windows;
  assert.equal(primary.label, "Quota");
  assert.equal(secondary.label, "Secondary quota");
  assert.equal(primary.durationTrusted, false);
  assert.equal(primary.windowSeconds, null);
  assert.equal(windowSpan(primary, NOW), null);
  assert.deepEqual(allowancePace(primary, windowSpan(primary, NOW), NOW), { kind: "unknown" });
  assert.ok(!/5h|session/i.test(JSON.stringify(codex.windows.map((w) => w.label))));
});

test("errors, auth failures and disabled providers stay visible with a reason", () => {
  const raw = { providers: [
    provider("a", "A", [], { status: "error", error: "401 for https://x?token=SECRET", authRefreshCommand: "codex login" }),
    provider("b", "B", [], { status: "error", error: "boom" }),
    provider("c", "C", [], { status: "disabled" }),
  ] };
  const providers = fromUsageMonitor(raw);
  assert.deepEqual(providers.map((p) => [p.status, p.problem]), [["error", "auth"], ["error", "error"], ["disabled", "disabled"]]);
  assert.deepEqual(providers.map(providerNotice), ["Sign-in needed; no current readings", "Readings unavailable", "Disabled in Usage Monitor"]);
  assert.ok(!JSON.stringify(providers).includes("SECRET"));
  assert.deepEqual(allowanceProviders({ fetchedAt: null, error: null, providers }).length, 3);
});

test("merge shows all six providers, keeps Paseo's plan label and hides unconfigured ones", () => {
  const merged = mergeAllowances(NATIVE, { status: "ok", fetchedAt: "2026-10-06T08:00:00.000Z", providers: fromUsageMonitor(SIX) });
  assert.ok(AllowancesSchema.safeParse(merged).success);
  // Paseo's order first, then providers only Usage Monitor knows.
  assert.deepEqual(allowanceProviders(merged).map((p) => [p.providerId, p.source]), [
    ["claude", "usage-monitor"], ["codex", "usage-monitor"], ["kimi", "usage-monitor"], ["deepseek", "usage-monitor"], ["glm", "usage-monitor"], ["minimax", "usage-monitor"],
  ]);
  const codex = merged.providers.find((p) => p.providerId === "codex")!;
  assert.equal(codex.planLabel, "pro");
  assert.equal(codex.windows.length, 3);
  // Only quota windows lose their length; a balance has none.
  assert.deepEqual(codex.windows.map((w) => w.durationTrusted), [false, false, undefined]);
  // The GLM API balance does not stand in for the Z.AI subscription.
  assert.equal(merged.providers.find((p) => p.providerId === "zai")?.status, "unavailable");
  assert.deepEqual(merged.monitor, { status: "ok", fetchedAt: "2026-10-06T08:00:00.000Z" });
});

test("without the bridge Paseo's report is the fallback, with Codex's length still unverified", () => {
  for (const status of ["unavailable", "error", "timeout"] as const) {
    const merged = mergeAllowances(NATIVE, { status, fetchedAt: null, providers: [] });
    assert.deepEqual(allowanceProviders(merged).map((p) => [p.providerId, p.status]), [["claude", "error"], ["codex", "available"]]);
    const codex = merged.providers.find((p) => p.providerId === "codex")!;
    assert.equal(codex.source, "paseo");
    assert.equal(codex.windows[0].label, "Quota");
    assert.equal(windowSpan(codex.windows[0], NOW), null);
    assert.equal(merged.monitor?.status, status);
  }
  // A failing Usage Monitor provider does not replace Paseo's current readings.
  const failing = fromUsageMonitor({ providers: [provider("codex", "Codex", [], { status: "error", error: "x" })] });
  const merged = mergeAllowances(NATIVE, { status: "ok", fetchedAt: null, providers: failing });
  assert.equal(merged.providers.find((p) => p.providerId === "codex")?.source, "paseo");
  // A verified length reported by Paseo is kept.
  const measured: Allowances = { ...NATIVE, providers: [{ ...NATIVE.providers[1], windows: [{ ...NATIVE.providers[1].windows[0], windowSeconds: 604_800 }] }] };
  const kept = mergeAllowances(measured, { status: "ok", fetchedAt: null, providers: fromUsageMonitor(SIX) }).providers.find((p) => p.providerId === "codex")!;
  assert.equal(kept.windows[0].windowSeconds, 604_800);
  assert.equal(kept.windows[0].durationTrusted, true);
  assert.equal(windowSpan(kept.windows[0], NOW)?.end, Date.parse("2026-10-11T16:24:37.000Z"));
});

test("balances read as money or credits, never as a percentage; unknown capacity is not 0/0", () => {
  const [, codex, deepseek, glm, , minimax] = fromUsageMonitor(SIX);
  assert.equal(formatAmount(deepseek.windows[0].remaining, deepseek.windows[0].unit, deepseek.windows[0].currency), "$4.29");
  assert.equal(formatAmount(glm.windows[0].remaining, glm.windows[0].unit, glm.windows[0].currency), "$58.98");
  assert.equal(formatAmount(codex.windows[2].remaining, codex.windows[2].unit, codex.windows[2].currency), "$0.00");
  assert.equal(formatAmount(2, "credits"), "2 credits");
  assert.equal(formatAmount(12.5, "eur", "eur"), "12.50 EUR");
  assert.equal(formatAmount(null, "usd"), null);
  assert.equal(windowSpan(deepseek.windows[0], NOW), null);
  assert.equal(minimax.windows[0].usedPct, 3);
  assert.equal(quotaCounts(minimax.windows[0]), null);
  assert.equal(quotaCounts({ id: "q", label: "Q", used: 120, limit: 500, unit: "requests" }), "120 / 500 requests");
});

test("providers without their own local sessions are not attributed OpenCode activity", () => {
  const [claude, , , , kimi] = fromUsageMonitor(SIX);
  const sessions = [fixture("claude-session"), fixture("opencode-session", "opencode")];
  assert.deepEqual(attributedScope(kimi.windows[0], "kimi", sessions), { kind: "unattributed" });
  assert.deepEqual(attributedScope(claude.windows[1], "claude", sessions), { kind: "all" });
});

class FakeClient implements RpcClient {
  static opened: FakeClient[] = [];
  connects = 0; calls = 0; closed = 0;
  constructor(private behaviour: { connect?: "hang" | "fail"; rpc?: "hang" | "fail" | unknown }) { FakeClient.opened.push(this); }
  connect() { this.connects++; return this.behaviour.connect === "hang" ? new Promise<void>(() => {}) : this.behaviour.connect === "fail" ? Promise.reject(new Error("ECONNREFUSED")) : Promise.resolve(); }
  invokePluginRpc(pluginId: string, method: string, input: unknown) {
    this.calls++;
    assert.deepEqual([pluginId, method, input], ["usage-monitor", "usage.limits.read", { refresh: false }]);
    const r = this.behaviour.rpc;
    return r === "hang" ? new Promise<unknown>(() => {}) : r === "fail" ? Promise.reject(new Error("nope")) : Promise.resolve(r ?? SIX);
  }
  close() { this.closed++; return Promise.resolve(); }
}
const limits = { connectMs: 20, rpcMs: 20 };

test("the bridge reuses one connection, caches briefly and shares concurrent reads", async () => {
  FakeClient.opened = [];
  let now = NOW;
  const bridge = new UsageMonitorBridge(() => new FakeClient({}), () => now, limits);
  const [a, b] = await Promise.all([bridge.read(), bridge.read()]);
  assert.equal(a, b);
  assert.equal(a.status, "ok");
  assert.equal(a.providers.length, 6);
  assert.equal(FakeClient.opened.length, 1);
  assert.equal(FakeClient.opened[0].calls, 1);
  await bridge.read();
  assert.equal(FakeClient.opened[0].calls, 1);
  now += 61_000;
  await bridge.read();
  assert.equal(FakeClient.opened.length, 1);
  assert.equal(FakeClient.opened[0].calls, 2);
  await bridge.dispose();
  assert.equal(FakeClient.opened[0].closed, 1);
  assert.equal((await bridge.read()).status, "unavailable");
});

test("connect and RPC timeouts close the client, report timeout and reconnect later", async () => {
  FakeClient.opened = [];
  let now = NOW;
  const hang = new UsageMonitorBridge(() => new FakeClient({ connect: "hang" }), () => now, limits);
  assert.deepEqual(await hang.read(), { status: "timeout", fetchedAt: null, providers: [] });
  assert.equal(FakeClient.opened[0].closed, 1);
  const slow = new UsageMonitorBridge(() => new FakeClient({ rpc: "hang" }), () => now, limits);
  assert.equal((await slow.read()).status, "timeout");
  assert.equal(FakeClient.opened[1].closed, 1);
  // Failures are cached briefly, then a new connection is tried.
  await slow.read();
  assert.equal(FakeClient.opened.length, 2);
  now += 31_000;
  await slow.read();
  assert.equal(FakeClient.opened.length, 3);
  const refused = new UsageMonitorBridge(() => new FakeClient({ connect: "fail" }), () => now, limits);
  assert.equal((await refused.read()).status, "error");
  const broken = new UsageMonitorBridge(() => new FakeClient({ rpc: "fail" }), () => now, limits);
  assert.equal((await broken.read()).status, "error");
  for (const client of FakeClient.opened) assert.ok(client.closed >= 1);
  await Promise.all([hang.dispose(), slow.dispose(), refused.dispose(), broken.dispose()]);
});

test("the host client opener falls back to Paseo's report unless the host client fits", async () => {
  assert.deepEqual(await new UsageMonitorBridge(null).read(), { status: "unavailable", fetchedAt: null, providers: [] });
  const url = "ws://127.0.0.1:6767/ws";
  class Fits { constructor(readonly config: Record<string, unknown>) {} connect() { return Promise.resolve(); } invokePluginRpc() { return Promise.resolve(SIX); } close() { return Promise.resolve(); } }
  class Older { connect() {} close() {} }
  assert.equal(hostClientOpener({ enabled: false, url, load: () => Fits }), null);
  assert.equal(hostClientOpener({ url: null, load: () => Fits }), null);
  assert.equal(hostClientOpener({ url, load: () => { throw new Error("Cannot find module"); } }), null);
  assert.equal(hostClientOpener({ url, load: () => undefined }), null);
  // A client without plugin RPC (another Paseo version) is not used.
  assert.equal(hostClientOpener({ url, load: () => Older }), null);
  const open = hostClientOpener({ url, load: () => Fits })!;
  const client = open() as unknown as Fits;
  assert.deepEqual({ ...client.config, logger: typeof client.config.logger, clientId: typeof client.config.clientId },
    { url, clientId: "string", clientType: "cli", logger: "object", connectTimeoutMs: 4000, reconnect: { enabled: false } });
  const bridge = new UsageMonitorBridge(open);
  assert.equal((await bridge.read()).providers.length, 6);
  await bridge.dispose();
});

test("the daemon URL comes from a TCP listen address only", async () => {
  const home = await mkdtemp(join(tmpdir(), "session-usage-home-"));
  try {
    assert.equal(daemonUrl(home), null);
    await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "127.0.0.1:6767" } }));
    assert.equal(daemonUrl(home), "ws://127.0.0.1:6767/ws");
    await writeFile(join(home, "config.json"), JSON.stringify({ daemon: { listen: "/tmp/paseo.sock" } }));
    assert.equal(daemonUrl(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
