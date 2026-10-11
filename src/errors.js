export class BrokerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function failure(code, msg) {
  // Preserve the Go response status mapping, including 40500 -> HTTP 400.
  const status = code >= 50000 ? 500 : code >= 40400 && code < 40500 ? 404 : code >= 40000 ? 400 : 200;
  return Response.json({ code, msg }, { status });
}
