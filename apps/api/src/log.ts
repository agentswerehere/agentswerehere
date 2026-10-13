/** Structured logs. Callers must not pass raw IPs, bodies, tokens, or signatures. */
export function log(
  level: "info" | "error",
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  const {
    ip: _ip,
    body: _body,
    authorization: _authorization,
    signature: _signature,
    ...safe
  } = fields;
  console.log(
    JSON.stringify({
      level,
      msg,
      time: new Date().toISOString(),
      ...safe,
    }),
  );
}
