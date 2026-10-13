import { proxy } from "../../../lib/proxy";

export const dynamic = "force-dynamic";

export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return context.params.then((params) =>
    proxy(request, `/status/${encodeURIComponent(params.id)}`),
  );
}
