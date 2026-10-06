import assert from "node:assert/strict";
import { test } from "node:test";
import { allowancePace, allowanceProviders, allowanceSeries, formatDuration, isSlotSelected, modelInScope, paceLines, toggleAllowanceSlot, windowScope, windowSpan, type AllowanceWindow } from "../shared/allowance";
import { EMPTY_FILTERS, filterSessions } from "../shared/model";
import { emptyMetrics, type Bucket } from "../shared/schema";
import { readAllowances } from "./allowances";
import { fixture } from "./model.test";

const NOW = Date.parse("2026-09-17T12:30:00Z");
const HOUR = 3_600_000, DAY = 24 * HOUR;
const window = (id: string, label: string, resetsAt: string, usedPct: number | null = 50): AllowanceWindow => ({ id, label, usedPct, resetsAt });
const bucket = (day: string, hour: number | null, model: string, input: number | null, output: number | null): Bucket => ({ day, hour, model, metrics: { ...emptyMetrics(), inputTokens: input, uncachedTokens: input === null ? null : input / 10, cacheReadTokens: input === null ? null : input / 2, outputTokens: output, estimatedCostUsd: input === null ? null : 0.5 }, tools: {} });

test("window lengths come from their names and grow to cover the time left", () => {
  const span = (w: AllowanceWindow) => { const s = windowSpan(w, NOW); return s && { length: (s.end - s.start) / HOUR, hourly: s.hourly }; };
  assert.deepEqual(span(window("five_hour", "Session", "2026-09-17T15:10:00.475566+00:00")), { length: 5, hourly: true });
  assert.deepEqual(span(window("daily", "Daily", "2026-09-18T08:00:00Z")), { length: 24, hourly: true });
  assert.deepEqual(span(window("weekly_model_fable", "Weekly · Fable", "2026-09-21T11:00:00Z")), { length: 168, hourly: false });
  // Codex names its only window "Session" even when it resets in two days.
  assert.deepEqual(span(window("session", "Session", "2026-09-19T08:11:11Z")), { length: 168, hourly: false });
  // Unnamed billing cycle: one calendar month, 2026-09-14 13:39:50 to 2026-10-14 13:39:50.
  assert.deepEqual(span(window("cursor_models", "Cursor Models", "2026-10-14T13:39:50Z")), { length: 720, hourly: false });
  // A cycle ending 31 March starts on the clamped day a month earlier, 28 February.
  assert.deepEqual(span(window("monthly_usage", "Monthly usage", "2026-03-31T00:00:00Z")), { length: 31 * 24, hourly: false });
  assert.deepEqual(span({ ...window("custom", "Custom", "2026-09-17T13:30:00Z"), windowSeconds: 7200 }), { length: 2, hourly: true });
  assert.equal(span(window("five_hour", "Session", "not a date")), null);
  assert.equal(span(window("yearly", "Yearly", "2027-09-17T00:00:00Z")), null);
});

test("window scopes separate provider-wide, model and unattributable limits", () => {
  assert.deepEqual(windowScope(window("weekly", "Weekly", "")), { kind: "all" });
  assert.deepEqual(windowScope(window("five_hour", "Session", "")), { kind: "all" });
  assert.deepEqual(windowScope(window("weekly_model_fable", "Weekly · Fable", "")), { kind: "model", name: "Fable" });
  assert.deepEqual(windowScope(window("weekly_model_fable_pro", "", "")), { kind: "model", name: "fable_pro" });
  assert.deepEqual(windowScope(window("interval_MiniMax-M2.7", "MiniMax-M2.7 · Interval", "")), { kind: "model", name: "MiniMax-M2.7" });
  assert.deepEqual(windowScope(window("weekly_surface_design", "Weekly · Design", "")), { kind: "unattributed" });
  assert.deepEqual(windowScope(window("code_review", "Code review", "")), { kind: "unattributed" });
  assert.deepEqual(windowScope(window("cursor_models", "Cursor Models", "")), { kind: "unattributed" });
  assert.equal(modelInScope("claude-fable-5-1", "Fable"), true);
  assert.equal(modelInScope("anthropic/claude-fable-5", "Fable"), true);
  assert.equal(modelInScope("claude-fablesque-1", "Fable"), false);
  assert.equal(modelInScope("claude-fable-pro-2", "fable_pro"), true);
  assert.equal(modelInScope("minimax/minimax-m2.7", "MiniMax-M2.7"), true);
  assert.equal(modelInScope("minimax-m2x7", "MiniMax-M2.7"), false);
});

test("series sum input and output per slot for the provider and scoped models only", () => {
  const claude = fixture("claude-session");
  claude.buckets = [
    bucket("2026-09-17", 8, "claude-opus-5", 1000, 10), // Hour of the window start (08:10).
    bucket("2026-09-17", 7, "claude-opus-5", 5000, 50), // Before the window.
    bucket("2026-09-17", 12, "claude-fable-5-1", 300, 3),
    bucket("2026-09-17", 12, "claude-opus-5", 200, 2),
    bucket("2026-09-17", null, "claude-opus-5", 7000, 70), // No hour: not in an hourly chart.
    bucket("2026-09-16", 12, "claude-fable-5", 40, null),
  ];
  const other = fixture("other-claude");
  other.buckets = [bucket("2026-09-17", 12, "claude-fable-5-1", 5, 1)];
  const codex = fixture("codex-session", "codex");
  codex.buckets = [bucket("2026-09-17", 12, "gpt-6", 999_999, 999)];
  const span = windowSpan(window("five_hour", "Session", "2026-09-17T13:10:00Z"), NOW)!;
  const all = allowanceSeries([claude, other, codex], "claude", { kind: "all" }, span, NOW);
  assert.deepEqual(all.slots.map((s) => [s.key, s.inputTokens, s.outputTokens, s.measured, s.future]), [
    ["2026-09-17 08:00", 1000, 10, 1, false], ["2026-09-17 09:00", 0, 0, 0, false], ["2026-09-17 10:00", 0, 0, 0, false],
    ["2026-09-17 11:00", 0, 0, 0, false], ["2026-09-17 12:00", 505, 6, 2, false], ["2026-09-17 13:00", 0, 0, 0, true],
  ]);
  assert.deepEqual([all.maxInput, all.maxOutput, all.models, all.hasTokens], [1000, 10, [], true]);
  assert.deepEqual([all.slots[4].uncachedTokens, all.slots[4].cacheReadTokens, all.slots[4].estimatedCostUsd], [50.5, 252.5, 1.5]);

  const weekly = windowSpan(window("weekly_model_fable", "Weekly · Fable", "2026-09-21T11:00:00Z"), NOW)!;
  const fable = allowanceSeries([claude, other, codex], "claude", windowScope(window("weekly_model_fable", "Weekly · Fable", "")), weekly, NOW);
  assert.equal(fable.slots.length, 8);
  assert.deepEqual(fable.slots.filter((s) => s.inputTokens || s.outputTokens).map((s) => [s.key, s.inputTokens, s.outputTokens]), [["2026-09-16", 40, 0], ["2026-09-17", 305, 4]]);
  assert.deepEqual(fable.models, ["claude-fable-5", "claude-fable-5-1"]);

  const cursor = fixture("cursor-session", "cursor");
  cursor.buckets = [bucket("2026-09-17", 12, "cursor-grok", null, null)];
  assert.equal(allowanceSeries([cursor], "cursor", { kind: "all" }, span, NOW).hasTokens, false);
});

test("pace extrapolates the share used over the elapsed part of the window", () => {
  const span = { start: NOW - 2.5 * HOUR, end: NOW + 2.5 * HOUR, hourly: true };
  const pace = (usedPct: number | null, s = span) => allowancePace({ id: "five_hour", label: "Session", usedPct }, s, NOW);
  assert.deepEqual(pace(50), { kind: "lasts", resetInMs: 2.5 * HOUR, projectedPct: 100 });
  assert.deepEqual(pace(25), { kind: "lasts", resetInMs: 2.5 * HOUR, projectedPct: 50 });
  assert.deepEqual(pace(80), { kind: "runsOut", inMs: 0.625 * HOUR, beforeResetMs: 1.875 * HOUR });
  assert.deepEqual(pace(0), { kind: "idle", resetInMs: 2.5 * HOUR });
  assert.deepEqual(pace(100), { kind: "exhausted", resetInMs: 2.5 * HOUR });
  assert.deepEqual(pace(null), { kind: "unknown" });
  assert.deepEqual(pace(10, { start: NOW - 60_000, end: NOW + 5 * HOUR, hourly: true }), { kind: "early", resetInMs: 5 * HOUR });
  assert.deepEqual(pace(10, { start: NOW - 5 * HOUR, end: NOW, hourly: true }), { kind: "resetting" });
  assert.deepEqual(allowancePace({ id: "weekly", label: "Weekly", remainingPct: 52 }, { start: NOW - 3 * DAY, end: NOW + 4 * DAY, hourly: false }, NOW), { kind: "runsOut", inMs: 3.25 * DAY, beforeResetMs: 0.75 * DAY });
  const lines = (p: ReturnType<typeof pace>) => paceLines(p).map((line) => line.map((part) => part.strong ? `*${part.text}*` : part.text).join(""));
  assert.deepEqual(lines(pace(80)), ["Runs out in *38m*", "*1h 53m* before reset"]);
  assert.deepEqual(lines(pace(25)), ["Lasts *2h 30m*", "*50%* at reset"]);
  assert.deepEqual([lines(pace(0)), lines(pace(100)), lines(pace(null))], [["Unused"], ["Used up"], []]);
  assert.deepEqual([formatDuration(59_000), formatDuration(3 * HOUR), formatDuration(9 * HOUR + 59 * 60_000), formatDuration(14 * HOUR + 59 * 60_000), formatDuration(23.6 * HOUR), formatDuration(3.25 * DAY), formatDuration(2 * DAY)], ["1m", "3h", "9h 59m", "15h", "1d", "3d 6h", "2d"]);
});

test("choosing a slot focuses the report and choosing it again clears only the period", () => {
  const span = windowSpan(window("five_hour", "Session", "2026-09-17T13:10:00Z"), NOW)!;
  const session = fixture("s");
  session.buckets = [bucket("2026-09-17", 12, "claude-fable-5", 300, 3), bucket("2026-09-17", 11, "claude-fable-5", 1, 1), bucket("2026-09-17", 12, "claude-opus-5", 20, 2)];
  const scope = windowScope(window("weekly_model_fable", "Weekly · Fable", ""));
  const series = allowanceSeries([session], "claude", scope, span, NOW);
  const slot = series.slots.find((s) => s.key === "2026-09-17 12:00")!;
  const start = { ...EMPTY_FILTERS, providers: ["codex"], projects: ["p"], models: ["gpt-6"] };
  const focused = toggleAllowanceSlot(start, "claude", slot, series.models);
  assert.deepEqual(focused, { ...start, period: "custom", from: "2026-09-17 12:00", to: "2026-09-17 12:00", providers: ["claude"], models: ["claude-fable-5"] });
  assert.equal(filterSessions([session], focused)[0].metrics.inputTokens, 300);
  assert.equal(isSlotSelected(focused, "claude", slot, series.models), true);
  assert.equal(isSlotSelected(focused, "claude", slot, []), false);
  assert.deepEqual(toggleAllowanceSlot(focused, "claude", slot, series.models), { ...focused, period: "all", from: "", to: "" });
  const provider = toggleAllowanceSlot(focused, "claude", slot, []);
  assert.deepEqual([provider.models, provider.from], [[], "2026-09-17 12:00"]);
});

test("allowances come from Paseo's provider usage, validated entry by entry", async () => {
  const paseo = (listUsage?: (options?: { forceRefresh?: boolean }) => Promise<unknown>) => ({ providers: { listUsage } });
  let forced: boolean | undefined;
  const result = await readAllowances(paseo(async (options) => {
    forced = options?.forceRefresh;
    return {
      requestId: "r", fetchedAt: "2026-09-17T12:00:00Z",
      providers: [
        { providerId: "claude", displayName: "Claude", status: "available", planLabel: "Max", windows: [{ id: "five_hour", label: "Session", usedPct: 15, remainingPct: 85, resetsAt: "2026-09-17T13:10:00Z", tone: "ok" }, { id: "broken", label: 7 }], balances: [{ id: "credits" }], details: [{ id: "x", label: "Token", value: "SECRET" }] },
        { providerId: "codex", displayName: "Codex", status: "later" },
      ],
    };
  }), true);
  assert.equal(forced, true);
  assert.deepEqual(result, { fetchedAt: "2026-09-17T12:00:00Z", error: null, providers: [{ providerId: "claude", displayName: "Claude", status: "available", planLabel: "Max", windows: [{ id: "five_hour", label: "Session", usedPct: 15, remainingPct: 85, resetsAt: "2026-09-17T13:10:00Z", tone: "ok" }] }] });
  // Configured providers show whether or not this host has their sessions.
  assert.deepEqual(allowanceProviders(result).map((p) => p.providerId), ["claude"]);
  assert.deepEqual(allowanceProviders({ ...result, providers: [...result.providers, { providerId: "copilot", displayName: "Copilot", status: "unavailable", windows: [] }] }).map((p) => p.providerId), ["claude"]);

  assert.deepEqual(await readAllowances(paseo(), false), { fetchedAt: null, providers: [], error: "Update Paseo to show subscription allowances." });
  assert.deepEqual(await readAllowances(paseo(() => Promise.reject(new Error("Update the host to list provider usage."))), false), { fetchedAt: null, providers: [], error: "Paseo could not report subscription allowances: Update the host to list provider usage." });
});
