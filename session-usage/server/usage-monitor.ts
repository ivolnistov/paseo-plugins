import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AllowanceWindow, MonitorStatus, ProviderAllowance } from "../shared/allowance";
import { paseoHome } from "./paseo-home";

/**
 * Read-only bridge to the Usage Monitor plugin on the same daemon. It calls only
 * `usage.limits.read` with `refresh: false`: Usage Monitor's own service decides when a provider is
 * contacted, with its own credentials, so this plugin never copies a key or sends a vendor request.
 */
export interface RpcClient {
  connect(): Promise<void>;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}
export interface MonitorResult { status: MonitorStatus; fetchedAt: string | null; providers: ProviderAllowance[] }

export const CONNECT_TIMEOUT_MS = 4_000;
export const RPC_TIMEOUT_MS = 9_000;
// The surface refetches every five minutes; a short cache absorbs manual refreshes and other tabs.
const RESULT_CACHE_MS = 60_000;
const FAILURE_CACHE_MS = 30_000;

/**
 * Paseo exposes plugin RPC to another process only through `@getpaseo/client/internal/daemon-client`,
 * which the client's README calls an unsupported implementation detail. Enabled with the owner's
 * approval: when a Paseo update moves or changes it, the bridge reports `unavailable` and the cards
 * fall back to Paseo's own allowance report.
 */
export const HOST_CLIENT_TRANSPORT_ENABLED = true;

const Window = z.object({ label: z.string(), resetsAt: z.string().nullable(), durationMs: z.number().nullable() });
const Reading = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("quota"), id: z.string(), label: z.string(), unit: z.string(), percent: z.number().nullable(), used: z.number().nullable(), limit: z.number().nullable(), remaining: z.number().nullable(), window: Window.nullable() }),
  z.object({ kind: z.literal("balance"), id: z.string(), label: z.string(), unit: z.string(), remaining: z.number().nullable(), total: z.number().nullable(), currency: z.string().nullable() }),
  z.object({ kind: z.literal("rate"), id: z.string(), label: z.string(), state: z.string(), changesAt: z.string().nullable() }),
]);
// Only these fields are read; config paths, error text, notices, display and icon data are dropped.
const Provider = z.object({
  providerId: z.string(),
  label: z.string(),
  status: z.enum(["ok", "error", "disabled"]),
  readings: z.array(z.unknown()),
  fetchedAt: z.string().nullable(),
  notice: z.string().nullable(),
  error: z.string().nullable(),
  authRefreshCommand: z.string().nullable().optional(),
});

/**
 * Usage Monitor's Codex preset labels the account's weekly limit "Session" with a five-hour
 * duration. The window length is therefore unknown here: quota windows get neutral labels and no
 * span or pace is inferred.
 */
const UNVERIFIED_WINDOW_PROVIDERS = new Set(["codex"]);
export function neutralCodexLabel(id: string, label: string): string {
  if (id === "session" || /^session$/i.test(label)) return "Quota";
  if (id === "weekly" || /^weekly$/i.test(label)) return "Secondary quota";
  return label;
}

function toWindow(providerId: string, reading: z.infer<typeof Reading>): AllowanceWindow {
  if (reading.kind === "balance") {
    return { id: reading.id, label: reading.label, kind: "balance", unit: reading.unit, remaining: reading.remaining, total: reading.total, currency: reading.currency };
  }
  if (reading.kind === "rate") {
    return { id: reading.id, label: reading.label, kind: "rate", state: reading.state, resetsAt: reading.changesAt };
  }
  const trusted = !UNVERIFIED_WINDOW_PROVIDERS.has(providerId);
  const durationMs = reading.window?.durationMs ?? null;
  return {
    id: reading.id,
    label: trusted ? reading.label : neutralCodexLabel(reading.id, reading.label),
    kind: "quota",
    unit: reading.unit,
    usedPct: reading.percent,
    used: reading.used,
    limit: reading.limit,
    remaining: reading.remaining,
    resetsAt: reading.window?.resetsAt ?? null,
    windowSeconds: trusted && durationMs && durationMs > 0 ? durationMs / 1000 : null,
    ...(trusted ? {} : { durationTrusted: false }),
  };
}

/** Converts a `usage.limits.read` result; malformed providers and readings are dropped one by one. */
export function fromUsageMonitor(raw: unknown): ProviderAllowance[] {
  const providers = z.object({ providers: z.array(z.unknown()) }).safeParse(raw);
  if (!providers.success) return [];
  return providers.data.providers.flatMap((entry) => {
    const parsed = Provider.safeParse(entry);
    if (!parsed.success) return [];
    const p = parsed.data;
    const windows = p.readings.flatMap((reading) => {
      const r = Reading.safeParse(reading);
      return r.success ? [toWindow(p.providerId, r.data)] : [];
    });
    return [{
      providerId: p.providerId,
      displayName: p.label,
      status: p.status === "ok" ? "available" as const : p.status,
      planLabel: null,
      windows,
      source: "usage-monitor" as const,
      fetchedAt: p.fetchedAt,
      stale: p.notice !== null,
      problem: p.status === "disabled" ? "disabled" as const : p.status === "error" ? (p.authRefreshCommand ? "auth" as const : "error" as const) : null,
    }];
  });
}

class TimeoutError extends Error {}
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** One cached connection per plugin process (one host); a failed or slow call closes it so the next read reconnects. */
export class UsageMonitorBridge {
  private client: RpcClient | null = null;
  private pending: Promise<MonitorResult> | null = null;
  private cached: { until: number; result: MonitorResult } | null = null;
  private disposed = false;
  constructor(private readonly open: (() => RpcClient) | null, private readonly now: () => number = Date.now, private readonly limits = { connectMs: CONNECT_TIMEOUT_MS, rpcMs: RPC_TIMEOUT_MS }) {}

  read(): Promise<MonitorResult> {
    if (!this.open || this.disposed) return Promise.resolve({ status: "unavailable", fetchedAt: null, providers: [] });
    if (this.cached && this.now() < this.cached.until) return Promise.resolve(this.cached.result);
    this.pending ??= this.fetch().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async fetch(): Promise<MonitorResult> {
    let result: MonitorResult;
    try {
      const client = await this.connected();
      const raw = await withTimeout(client.invokePluginRpc("usage-monitor", "usage.limits.read", { refresh: false }), this.limits.rpcMs);
      result = { status: "ok", fetchedAt: new Date(this.now()).toISOString(), providers: fromUsageMonitor(raw) };
    } catch (error) {
      await this.reset();
      // A missing plugin and a refused connection look alike to the caller: no bridge readings.
      result = { status: error instanceof TimeoutError ? "timeout" : "error", fetchedAt: null, providers: [] };
    }
    if (!this.disposed) this.cached = { until: this.now() + (result.status === "ok" ? RESULT_CACHE_MS : FAILURE_CACHE_MS), result };
    return result;
  }

  private async connected(): Promise<RpcClient> {
    if (this.client) return this.client;
    const client = this.open!();
    try {
      await withTimeout(client.connect(), this.limits.connectMs);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    if (this.disposed) {
      await client.close().catch(() => {});
      throw new Error("Bridge disposed");
    }
    this.client = client;
    return client;
  }

  private async reset(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => {});
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cached = null;
    await this.pending?.catch(() => {});
    await this.reset();
  }
}

/** `ws://host:port/ws` for the daemon's TCP listener from Paseo's config.json; null for a socket or an unreadable config. */
export function daemonUrl(home = paseoHome()): string | null {
  try {
    const listen = (JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as { daemon?: { listen?: unknown } }).daemon?.listen;
    return typeof listen === "string" && /^[\w.-]+:\d+$/.test(listen) ? `ws://${listen}/ws` : null;
  } catch {
    return null;
  }
}

const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

type ClientClass = new (config: object) => RpcClient;
/**
 * The daemon's own installed client, resolved at run time through the plugin runtime's `require`:
 * it always matches the host's Paseo version, and esbuild bundles no second copy. The specifier is
 * built at run time so the bundler leaves it alone.
 */
function loadHostClient(): unknown {
  const specifier = ["@getpaseo/client", "internal", "daemon-client"].join("/");
  return (require(specifier) as { DaemonClient?: unknown }).DaemonClient;
}

/** Null, so Paseo's report is used alone, when disabled, without a TCP listener, or when the host client is missing or lacks the needed methods. */
export function hostClientOpener({ enabled = HOST_CLIENT_TRANSPORT_ENABLED, url = daemonUrl(), load = loadHostClient }: { enabled?: boolean; url?: string | null; load?: () => unknown } = {}): (() => RpcClient) | null {
  if (!enabled || !url) return null;
  let Client: unknown;
  try {
    Client = load();
  } catch {
    return null;
  }
  const proto = typeof Client === "function" ? (Client as { prototype?: Record<string, unknown> }).prototype : undefined;
  if (!proto || !["connect", "invokePluginRpc", "close"].every((method) => typeof proto[method] === "function")) return null;
  const DaemonClient = Client as ClientClass;
  return () => new DaemonClient({ url, clientId: `session-usage-bridge-${process.pid}`, clientType: "cli", logger: SILENT, connectTimeoutMs: CONNECT_TIMEOUT_MS, reconnect: { enabled: false } });
}
