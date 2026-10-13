import type { MetadataRoute } from "next";
import { publicOrigin } from "../lib/api";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/write/submit"],
    },
    sitemap: `${publicOrigin()}/sitemap.xml`,
  };
}
