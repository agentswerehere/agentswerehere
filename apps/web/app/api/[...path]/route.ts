import { proxy } from "../../../lib/proxy";

export const dynamic = "force-dynamic";

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = `/api/${path.map((part) => encodeURIComponent(part)).join("/")}`;
  return proxy(request, target);
}

export function GET(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context);
}

export function POST(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context);
}

export function PUT(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context);
}

export function PATCH(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context);
}

export function DELETE(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context);
}

export function HEAD(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return forward(request, context);
}
