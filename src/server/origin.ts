/**
 * Origin normalization shared by the redirect replay engine.
 *
 * An origin is the triple (scheme, normalized host, effective port):
 * - the WHATWG URL parser lowercases the host and IDNA-encodes it (punycode),
 *   so `EXAMPLE.com`, `example.com` and `bücher.de` / `xn--bcher-kva.de`
 *   normalize to the same host;
 * - the effective port is the explicit port, or the scheme's default port
 *   when none is given (`http://example.com` ≡ `http://example.com:80`).
 */

const DEFAULT_PORTS: Record<string, number> = {
  http: 80,
  https: 443,
  ws: 80,
  wss: 443,
  ftp: 21,
};

export type Origin = {
  scheme: string;
  host: string;
  port: number | null;
};

export function parseOrigin(input: string | URL): Origin | null {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  const host = url.hostname;
  if (!scheme || !host) return null;
  const port = url.port === '' ? (DEFAULT_PORTS[scheme] ?? null) : Number(url.port);
  return {scheme, host, port};
}

export function originKey(origin: Origin): string {
  return `${origin.scheme}://${origin.host}:${origin.port ?? ''}`;
}

export function sameOrigin(a: string | URL, b: string | URL): boolean {
  const originA = parseOrigin(a);
  const originB = parseOrigin(b);
  if (!originA || !originB) return false;
  return originKey(originA) === originKey(originB);
}

/** Human-readable origin; default ports are omitted. */
export function describeOrigin(input: string | URL): string {
  const origin = parseOrigin(input);
  if (!origin) return 'invalid-origin';
  const isDefaultPort = origin.port !== null && origin.port === DEFAULT_PORTS[origin.scheme];
  const port = origin.port === null || isDefaultPort ? '' : `:${origin.port}`;
  return `${origin.scheme}://${origin.host}${port}`;
}
