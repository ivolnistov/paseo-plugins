import { AllowanceWindowSchema, ProviderAllowanceSchema, type Allowances, type ProviderAllowance } from "../shared/allowance";
import { object } from "./parser";
import { neutralCodexLabel, type MonitorResult } from "./usage-monitor";

/**
 * Paseo's own Codex report names the account's weekly limit "Session" too, without a length. Its
 * window length is not trusted from either source.
 */
function verifiedWindows(provider: ProviderAllowance): ProviderAllowance {
  if (provider.providerId !== "codex") return provider;
  return { ...provider, windows: provider.windows.map((window) => window.windowSeconds || (window.kind ?? "quota") !== "quota" ? window : { ...window, label: neutralCodexLabel(window.id, window.label), durationTrusted: false }) };
}

/**
 * Usage Monitor readings take a provider's place when they are current; Paseo's report stays the
 * fallback for providers Usage Monitor lacks or cannot read, and when the bridge is unavailable.
 * Providers are matched by identical ID only: an API balance (e.g. GLM) is not a subscription quota.
 */
export function mergeAllowances(native: Allowances, monitor: MonitorResult): Allowances {
  const fromMonitor = new Map(monitor.providers.map((provider) => [provider.providerId, provider]));
  const providers: ProviderAllowance[] = [];
  for (const own of native.providers) {
    const theirs = fromMonitor.get(own.providerId);
    fromMonitor.delete(own.providerId);
    const ownUsable = own.status === "available" && own.windows.length > 0;
    if (!theirs || (theirs.status !== "available" && ownUsable)) {
      providers.push(verifiedWindows({ ...own, source: "paseo", fetchedAt: own.fetchedAt ?? native.fetchedAt }));
      continue;
    }
    // Paseo's measured window lengths and plan label survive when Usage Monitor lacks them.
    const lengths = new Map(own.windows.filter((window) => window.windowSeconds).map((window) => [window.id, window.windowSeconds]));
    providers.push(verifiedWindows({
      ...theirs,
      planLabel: theirs.planLabel ?? own.planLabel ?? null,
      windows: theirs.windows.map((window) => lengths.has(window.id) ? { ...window, windowSeconds: lengths.get(window.id), durationTrusted: true } : window),
    }));
  }
  providers.push(...[...fromMonitor.values()].map(verifiedWindows));
  return { ...native, providers, monitor: { status: monitor.status, fetchedAt: monitor.fetchedAt } };
}

type UsageLister = { listUsage?: (options?: { forceRefresh?: boolean }) => Promise<unknown> };

/**
 * Subscription allowances as Paseo reports them. Paseo's daemon queries the provider accounts and
 * caches the result; this plugin never contacts a provider. Invalid entries are dropped one by one.
 */
export async function readAllowances(paseo: { providers: object }, refresh: boolean): Promise<Allowances> {
  // `listUsage` is newer than the published client typings.
  const providers = paseo.providers as UsageLister;
  if (typeof providers.listUsage !== "function") return { fetchedAt: null, providers: [], error: "Update Paseo to show subscription allowances." };
  try {
    const result = object(await providers.listUsage.call(paseo.providers, { forceRefresh: refresh }));
    const list = Array.isArray(result.providers) ? result.providers : [];
    return {
      fetchedAt: typeof result.fetchedAt === "string" ? result.fetchedAt : null,
      providers: list.flatMap((raw) => {
        const entry = object(raw);
        const windows = (Array.isArray(entry.windows) ? entry.windows : []).flatMap((window) => {
          const parsed = AllowanceWindowSchema.safeParse(window);
          return parsed.success ? [parsed.data] : [];
        });
        const parsed = ProviderAllowanceSchema.safeParse({ ...entry, windows });
        return parsed.success ? [parsed.data] : [];
      }),
      error: null,
    };
  } catch (error) {
    return { fetchedAt: null, providers: [], error: `Paseo could not report subscription allowances: ${error instanceof Error ? error.message : String(error)}` };
  }
}
