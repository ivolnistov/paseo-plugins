import { z } from "zod";
import { dateRange, hourBound, type Filters } from "./model";
import type { Session } from "./schema";

/** The subset of Paseo's provider usage report that the allowance cards use. */
export const AllowanceWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPct: z.number().finite().nullable().optional(),
  remainingPct: z.number().finite().nullable().optional(),
  resetsAt: z.string().nullable().optional(),
  // Not sent by Paseo today; preferred over the inferred length when present.
  windowSeconds: z.number().finite().positive().nullable().optional(),
  tone: z.enum(["default", "ok", "warning", "danger"]).optional(),
  // The fields below come from Usage Monitor readings; Paseo's own report omits them.
  /** A quota is consumed toward a limit, a balance is money or credits left, a rate is a state. Default quota. */
  kind: z.enum(["quota", "balance", "rate"]).optional(),
  /** `percent`, `tokens`, `requests`, `credits`, `usd`, … */
  unit: z.string().nullable().optional(),
  used: z.number().finite().nullable().optional(),
  limit: z.number().finite().nullable().optional(),
  remaining: z.number().finite().nullable().optional(),
  total: z.number().finite().nullable().optional(),
  currency: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  /** False when the window's length is unverified: no span, chart or pace is inferred from its name. */
  durationTrusted: z.boolean().optional(),
});
export type AllowanceWindow = z.infer<typeof AllowanceWindowSchema>;
export const ProviderAllowanceSchema = z.object({
  providerId: z.string(),
  displayName: z.string(),
  status: z.enum(["available", "unavailable", "error", "disabled"]),
  planLabel: z.string().nullable().optional(),
  windows: z.array(AllowanceWindowSchema),
  /** Which report the windows come from; Paseo when absent. */
  source: z.enum(["paseo", "usage-monitor"]).optional(),
  fetchedAt: z.string().nullable().optional(),
  /** The source served cached readings, e.g. after the provider throttled its quota endpoint. */
  stale: z.boolean().optional(),
  /** Why the provider has no current readings. Never the provider's own error text. */
  problem: z.enum(["auth", "error", "disabled"]).nullable().optional(),
});
export type ProviderAllowance = z.infer<typeof ProviderAllowanceSchema>;
export const MonitorStatusSchema = z.enum(["ok", "unavailable", "error", "timeout"]);
export type MonitorStatus = z.infer<typeof MonitorStatusSchema>;
export const AllowancesSchema = z.object({
  fetchedAt: z.string().nullable(),
  providers: z.array(ProviderAllowanceSchema),
  error: z.string().nullable(),
  /** The Usage Monitor bridge: `unavailable` when it is not installed or not enabled. */
  monitor: z.object({ status: MonitorStatusSchema, fetchedAt: z.string().nullable() }).optional(),
});
export type Allowances = z.infer<typeof AllowancesSchema>;

const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/**
 * Every configured provider, in report order, whether or not it has local sessions: Usage Monitor
 * providers always (an error or disabled state stays visible), Paseo providers with windows or an
 * error. Paseo lists every known provider as `unavailable` when it is not configured; those stay hidden.
 */
export function allowanceProviders(allowances: Allowances | undefined): ProviderAllowance[] {
  return (allowances?.providers ?? []).filter((provider) => provider.source === "usage-monitor" || provider.status === "error"
    || (provider.status === "available" && provider.windows.length > 0));
}

/** A provider's activity is attributable only when local sessions carry its provider ID; harness sessions (e.g. OpenCode) are not billing providers. */
export function attributedScope(window: AllowanceWindow, providerId: string, sessions: Session[]): AllowanceScope {
  const scope = windowScope(window);
  return scope.kind !== "unattributed" && !sessions.some((session) => session.provider === providerId) ? { kind: "unattributed" } : scope;
}

/** `$4.29` for US dollars, `58.98 EUR` for another currency, `2 credits` otherwise; null when unknown. */
export function formatAmount(value: number | null | undefined, unit: string | null | undefined, currency?: string | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const code = (currency ?? (unit?.toLowerCase() === "usd" ? "USD" : null))?.toUpperCase();
  if (code === "USD") return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
  if (code) return `${value.toFixed(2)} ${code}`;
  if (unit === "percent") return `${Math.round(value)}%`;
  const amount = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return unit ? `${amount} ${unit}` : amount;
}

/** `120 / 500 requests` when both counts are reported and the limit is positive; never `0/0` for an unknown capacity. */
export function quotaCounts(window: AllowanceWindow): string | null {
  if (typeof window.used !== "number" || typeof window.limit !== "number" || window.limit <= 0) return null;
  return `${window.used.toLocaleString("en-US")} / ${window.limit.toLocaleString("en-US")}${window.unit && window.unit !== "percent" ? ` ${window.unit}` : ""}`;
}

/** A short status line for a provider card, or null when its readings are current. */
export function providerNotice(provider: ProviderAllowance): string | null {
  if (provider.status === "disabled" || provider.problem === "disabled") return "Disabled in Usage Monitor";
  if (provider.problem === "auth") return "Sign-in needed; no current readings";
  if (provider.status === "error" || provider.problem === "error") return provider.windows.length ? "Last readings; the latest check failed" : "Readings unavailable";
  if (provider.stale) return "Cached readings; the provider limited refreshes";
  if (!provider.windows.length) return "No readings reported";
  return null;
}

export function usedPercent(window: AllowanceWindow): number | null {
  if (typeof window.usedPct === "number") return window.usedPct;
  return typeof window.remainingPct === "number" ? 100 - window.remainingPct : null;
}

function monthBefore(time: number): number {
  const date = new Date(time);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0)).getUTCDate();
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, Math.min(date.getUTCDate(), last), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds());
}

export interface WindowSpan { start: number; end: number; hourly: boolean }
/**
 * Paseo reports when a window resets but not how long it is. The length comes from the window's
 * name (session and five-hour windows are 5 h), and is lengthened to the shortest of 5 h, 24 h,
 * 7 d or one month that covers the time left when the name is missing or too short for it.
 */
export function windowSpan(window: AllowanceWindow, now: number): WindowSpan | null {
  if ((window.kind ?? "quota") !== "quota" || window.durationTrusted === false) return null;
  const end = Date.parse(window.resetsAt ?? "");
  if (!Number.isFinite(end)) return null;
  const span = (length: number): WindowSpan => ({ start: end - length, end, hourly: length <= DAY });
  if (window.windowSeconds) return span(window.windowSeconds * 1000);
  const month = end - monthBefore(end);
  const lengths = [5 * HOUR, DAY, 7 * DAY, month];
  const text = `${window.id} ${window.label}`.toLowerCase();
  const named = /five[\s_-]?hour|\b5[\s_-]?h\b|\bsession\b/.test(text) ? 5 * HOUR
    : /\bdaily\b|\bday\b|\b24[\s_-]?h\b/.test(text) ? DAY
    : /week|seven[\s_-]?day/.test(text) ? 7 * DAY
    : /month/.test(text) ? month : 0;
  const left = end - now;
  if (named >= left) return span(named);
  const length = lengths.find((candidate) => candidate >= left);
  return length ? span(length) : null;
}

export type AllowanceScope = { kind: "all" } | { kind: "model"; name: string } | { kind: "unattributed" };
const PERIOD_WORDS = /^(session|five[\s_-]?hour|daily|weekly|monthly|interval)$/i;
/** Which local activity counts toward a window: all of the provider's, one model family's, or none that can be told apart. */
export function windowScope(window: AllowanceWindow): AllowanceScope {
  if (/^(five_hour|session|daily|weekly|monthly|monthly_usage|monthly_credits)$/.test(window.id)) return { kind: "all" };
  if (window.id.startsWith("weekly_surface_")) return { kind: "unattributed" };
  const parts = window.label.split("·").map((part) => part.trim()).filter(Boolean);
  const name = parts.length > 1 ? parts.find((part) => !PERIOD_WORDS.test(part)) : undefined;
  if (name) return { kind: "model", name };
  const modelId = /^weekly_model_(.+)$/.exec(window.id)?.[1];
  return modelId ? { kind: "model", name: modelId } : { kind: "unattributed" };
}
/** `Fable` matches `claude-fable-5-1` but not `fablesque`. */
export function modelInScope(model: string, name: string): boolean {
  const escaped = name.toLowerCase().replace(/[_\s]+/g, "-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(model.toLowerCase());
}

export interface AllowanceSlot {
  /** Filter bound: `YYYY-MM-DD` or `YYYY-MM-DD HH:00`, UTC. */
  key: string;
  start: number;
  future: boolean;
  inputTokens: number;
  uncachedTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  /** Sessions whose activity in this slot has token measurements. */
  measured: number;
}
export interface AllowanceSeries {
  slots: AllowanceSlot[];
  /** Models of this provider that belong to a model-scoped window; empty for provider-wide windows. */
  models: string[];
  /** Whether any of the provider's local records carry token usage. */
  hasTokens: boolean;
  maxInput: number;
  maxOutput: number;
}
/** Token totals per UTC hour (windows up to a day) or UTC day across the whole window, including future slots. */
export function allowanceSeries(sessions: Session[], providerId: string, scope: AllowanceScope, span: WindowSpan, now: number): AllowanceSeries {
  const step = span.hourly ? HOUR : DAY;
  const slots = new Map<string, AllowanceSlot>();
  for (let start = Math.floor(span.start / step) * step; start < span.end; start += step) {
    const iso = new Date(start).toISOString();
    const key = span.hourly ? hourBound(iso.slice(0, 10), start / HOUR % 24) : iso.slice(0, 10);
    slots.set(key, { key, start, future: start > now, inputTokens: 0, uncachedTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, estimatedCostUsd: 0, measured: 0 });
  }
  const models = new Set<string>();
  let hasTokens = false;
  for (const session of sessions) {
    if (session.provider !== providerId) continue;
    const measuredSlots = new Set<AllowanceSlot>();
    for (const bucket of session.buckets) {
      if (bucket.metrics.inputTokens !== null || bucket.metrics.outputTokens !== null) hasTokens = true;
      if (scope.kind === "model") {
        if (!modelInScope(bucket.model, scope.name)) continue;
        models.add(bucket.model);
      }
      if (bucket.day === "unknown" || (span.hourly && (bucket.hour ?? null) === null)) continue;
      const slot = slots.get(span.hourly ? hourBound(bucket.day, bucket.hour!) : bucket.day);
      if (!slot) continue;
      const m = bucket.metrics;
      slot.inputTokens += m.inputTokens ?? 0;
      slot.uncachedTokens += m.uncachedTokens ?? 0;
      slot.cacheReadTokens += m.cacheReadTokens ?? 0;
      slot.cacheWriteTokens += m.cacheWriteTokens ?? 0;
      slot.outputTokens += m.outputTokens ?? 0;
      slot.estimatedCostUsd += m.estimatedCostUsd ?? 0;
      if (m.inputTokens !== null || m.outputTokens !== null) measuredSlots.add(slot);
    }
    for (const slot of measuredSlots) slot.measured++;
  }
  const list = [...slots.values()];
  return {
    slots: list, models: [...models].sort(), hasTokens,
    maxInput: Math.max(0, ...list.map((slot) => slot.inputTokens)),
    maxOutput: Math.max(0, ...list.map((slot) => slot.outputTokens)),
  };
}

export type Pace =
  | { kind: "unknown" }
  | { kind: "resetting" }
  | { kind: "exhausted"; resetInMs: number }
  | { kind: "idle"; resetInMs: number }
  | { kind: "early"; resetInMs: number }
  | { kind: "lasts"; resetInMs: number; projectedPct: number }
  | { kind: "runsOut"; inMs: number; beforeResetMs: number };
/**
 * Extrapolates the share used so far over the elapsed part of the window. Token counts are not
 * used: how they map to the allowance is unknown.
 */
export function allowancePace(window: AllowanceWindow, span: WindowSpan | null, now: number): Pace {
  const used = usedPercent(window);
  if (used === null || !span) return { kind: "unknown" };
  const resetInMs = span.end - now;
  if (resetInMs <= 0) return { kind: "resetting" };
  if (used >= 100) return { kind: "exhausted", resetInMs };
  const elapsed = now - span.start;
  if (used <= 0) return { kind: "idle", resetInMs };
  if (elapsed < 5 * MINUTE) return { kind: "early", resetInMs };
  const rate = used / elapsed;
  const inMs = (100 - used) / rate;
  return inMs >= resetInMs ? { kind: "lasts", resetInMs, projectedPct: used + rate * resetInMs } : { kind: "runsOut", inMs, beforeResetMs: resetInMs - inMs };
}

/** At most two units; minutes only below ten hours. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 600) return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes / 60}h`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** Short enough for a narrow card; the reset time is shown beside the usage bar. */
export type PaceLine = { text: string; strong?: boolean }[];
export function paceLines(pace: Pace): PaceLine[] {
  switch (pace.kind) {
    case "unknown": return [];
    case "resetting": return [[{ text: "Resetting" }]];
    case "exhausted": return [[{ text: "Used up" }]];
    case "idle": return [[{ text: "Unused" }]];
    case "early": return [[{ text: "Too early to project" }]];
    case "lasts": return [
      [{ text: "Lasts " }, { text: formatDuration(pace.resetInMs), strong: true }],
      [{ text: `${Math.round(pace.projectedPct)}%`, strong: true }, { text: " at reset" }],
    ];
    case "runsOut": return [
      [{ text: "Runs out in " }, { text: formatDuration(pace.inMs), strong: true }],
      [{ text: formatDuration(pace.beforeResetMs), strong: true }, { text: " before reset" }],
    ];
  }
}

export function isSlotSelected(filters: Filters, providerId: string, slot: AllowanceSlot, models: string[]): boolean {
  const range = dateRange(filters);
  return !range.error && range.from === slot.key && range.to === slot.key
    && filters.providers.length === 1 && filters.providers[0] === providerId
    && filters.models.length === models.length && models.every((model) => filters.models.includes(model));
}
/** Focuses the report on a slot's provider, model scope and period; the selected slot clears the period again. */
export function toggleAllowanceSlot(filters: Filters, providerId: string, slot: AllowanceSlot, models: string[]): Filters {
  if (isSlotSelected(filters, providerId, slot, models)) return { ...filters, period: "all", from: "", to: "" };
  return { ...filters, period: "custom", from: slot.key, to: slot.key, providers: [providerId], models };
}
