import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mergeAllowances, readAllowances } from "./server/allowances";
import { defaultIndexPath } from "./server/index-store";
import { defaultRoots, UsageIndex } from "./server/indexer";
import { hostClientOpener, UsageMonitorBridge } from "./server/usage-monitor";
import { listAllowances, listUsage } from "./shared/contracts";

export default function contribute(server: PluginServerContext) {
  const index = new UsageIndex(defaultRoots(), defaultIndexPath());
  const monitor = new UsageMonitorBridge(hostClientOpener());
  // Start from the persistent index right away, so the first visit finds a fresh snapshot.
  index.snapshot();
  server.handle(listUsage, async ({ refresh, revision }) => {
    index.snapshot(refresh);
    await index.firstScan(1_500);
    return index.view(revision);
  });
  // Usage Monitor is always read with refresh: false; only Paseo's own report honours `refresh`.
  server.handle(listAllowances, async ({ refresh }, { paseo }) => {
    const [native, monitored] = await Promise.all([readAllowances(paseo, refresh), monitor.read()]);
    return mergeAllowances(native, monitored);
  });
  return async () => {
    index.dispose();
    await monitor.dispose();
  };
}
