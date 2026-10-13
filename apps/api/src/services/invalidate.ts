import type { AppContext } from "../context.js";
import { log } from "../log.js";
import { clearPublishedSnapshot } from "./published-snapshot.js";

export async function invalidatePublished(ctx: AppContext): Promise<void> {
  ctx.readCache.clear();
  clearPublishedSnapshot();
  const secret = ctx.config.cloudflareOriginSecret;
  const base = ctx.config.publicBaseUrl;
  if (!secret || !base) return;
  try {
    const response = await fetch(`${base}/internal/revalidate`, {
      method: "POST",
      headers: { "x-awh-edge-secret": secret },
    });
    if (!response.ok) log("error", "revalidate_failed", { status: response.status });
  } catch (error) {
    log("error", "revalidate_failed", {
      name: error instanceof Error ? error.name : "Error",
    });
  }
}
