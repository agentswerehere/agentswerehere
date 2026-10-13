import { proxy } from "../../lib/proxy";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return proxy(request, "/write");
}
