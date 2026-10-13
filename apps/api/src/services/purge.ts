import { purgeUrls } from "@agentswerehere/core";
import type { AppContext } from "../context.js";
import { log } from "../log.js";

export async function purgePublished(ctx: AppContext, ids: readonly string[]): Promise<void> {
  const token = ctx.config.cloudflareApiToken;
  const zone = ctx.config.cloudflareZoneId;
  if (!token || !zone || ids.length === 0) return;
  try {
    const rows = await ctx.pool.query<{ id: string; root_id: string }>(
      "SELECT id, root_id FROM marks WHERE id = ANY($1::text[])",
      [ids],
    );
    const files = purgeUrls(
      ctx.config.publicBaseUrl,
      ctx.config.apiPublicUrl,
      rows.rows.map((row) => ({ id: row.id, rootId: row.root_id })),
    );
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ files }),
    });
    if (!response.ok) log("error", "purge_failed", { status: response.status });
  } catch (error) {
    log("error", "purge_failed", { name: error instanceof Error ? error.name : "Error" });
  }
}
