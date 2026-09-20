import http from 'node:http';
import https from 'node:https';
import {domainToASCII} from 'node:url';

/**
 * Server-side redirect replay engine.
 *
 * Redirects are followed manually (never via a browser/client auto-follow) so
 * every hop's actually-sent headers and body can be inspected, snapshotted
 * immutably, and attributed a header-removal reason.
 */

export const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const DEFAULT_PORTS: Record<string, number> = {http: 80, https: 443, ws: 80, wss: 443};

/** Headers that only make sense while a body is attached. */
const BODY_HEADERS = ['content-length', 'content-type', 'transfer-encoding'];

export const DEFAULT_SENSITIVE_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];

export type HeaderMap = Record<string, string>;

export type RequestSpec = {
  method: string;
  url: string;
  headers?: HeaderMap;
  body?: string | null;
};

export type TransportRequest = {
  method: string;
  url: string;
  headers: HeaderMap;
  body: string | null;
};

export type TransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/** Injectable so tests can record exactly what each hop sends. */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export type RedirectPolicy = {
  maxRedirects: number;
  sensitiveHeaders: string[];
  /** When false, sensitive headers are withheld even on same-origin redirects. */
  forwardSensitiveOnSameOrigin: boolean;
};

export const DEFAULT_POLICY: RedirectPolicy = {
  maxRedirects: 20,
  sensitiveHeaders: DEFAULT_SENSITIVE_HEADERS,
  forwardSensitiveOnSameOrigin: true,
};

export type DropReason = 'cross_origin' | 'scheme_downgrade' | 'same_origin_policy' | 'body_dropped';

export type DroppedHeader = {name: string; reason: DropReason; detail: string};

export type HopSnapshot = Readonly<{
  index: number;
  request: Readonly<{method: string; url: string; headers: Readonly<HeaderMap>; body: string | null}>;
  response: Readonly<{status: number; headers: Readonly<HeaderMap>; body: string}> | null;
  /** Headers removed (with reasons) between the previous hop and this request. */
  droppedHeaders: readonly DroppedHeader[];
}>;

export type PendingRedirect = {status: number; location: string; resolvedUrl: string};

export type TerminalState =
  | {state: 'completed'; redirects: number}
  | {state: 'redirect_loop'; redirects: number; pendingRedirect: PendingRedirect}
  | {state: 'max_redirects_exceeded'; redirects: number; maxRedirects: number; pendingRedirect: PendingRedirect}
  | {state: 'transport_error'; redirects: number; message: string};

export type ReplayResult = {hops: readonly HopSnapshot[]; terminal: TerminalState};

// ---------------------------------------------------------------------------
// Origin normalization: scheme + canonical host + effective port.
// ---------------------------------------------------------------------------

/** Lowercase, de-dotted, IDN-to-punycode host. IPv6 literals keep no brackets. */
export function normalizeHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.includes(':')) return host; // IPv6 literal
  const ascii = domainToASCII(host);
  return ascii || host;
}

/** Port a URL effectively uses: explicit port, else the scheme default. */
export function effectivePort(scheme: string, port: string | number | null | undefined): number | null {
  if (port !== null && port !== undefined && port !== '') {
    const parsed = Number(port);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return DEFAULT_PORTS[scheme] ?? null;
}

export type Origin = {scheme: string; host: string; port: number | null};

export function originOf(url: URL): Origin {
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  return {scheme, host: normalizeHost(url.hostname), port: effectivePort(scheme, url.port)};
}

export function sameOrigin(a: URL, b: URL): boolean {
  const oa = originOf(a);
  const ob = originOf(b);
  return oa.scheme === ob.scheme && oa.host === ob.host && oa.port === ob.port;
}

/** host[:port] with default ports elided and IPv6 bracketed. */
function authorityOf(url: URL): string {
  const origin = originOf(url);
  const host = origin.host.includes(':') ? `[${origin.host}]` : origin.host;
  const port = origin.port !== null && origin.port !== DEFAULT_PORTS[origin.scheme] ? `:${origin.port}` : '';
  return host + port;
}

export function originKey(url: URL): string {
  return `${originOf(url).scheme}://${authorityOf(url)}`;
}

/** Canonical URL string used for loop detection and for sending requests. */
export function urlKey(url: URL): string {
  return `${originKey(url)}${url.pathname}${url.search}`;
}

/** Parse and canonicalize (default port, host case, punycode, fragment dropped). */
export function normalizeUrl(input: string | URL, base?: URL): URL {
  return new URL(urlKey(new URL(input, base)));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalHeaders(headers: HeaderMap | undefined): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.trim().toLowerCase();
    if (key) out[key] = String(value);
  }
  return out;
}

function flattenHeaders(headers: TransportResponse['headers']): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function firstHeader(headers: TransportResponse['headers'], name: string): string | undefined {
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export async function replayRedirects(
  spec: RequestSpec,
  options: {transport: Transport; policy?: Partial<RedirectPolicy>},
): Promise<ReplayResult> {
  const policy: RedirectPolicy = {
    ...DEFAULT_POLICY,
    ...options.policy,
    sensitiveHeaders: (options.policy?.sensitiveHeaders ?? DEFAULT_POLICY.sensitiveHeaders).map(name =>
      name.toLowerCase(),
    ),
  };
  const {transport} = options;

  let method = (spec.method || 'GET').toUpperCase();
  let url = normalizeUrl(spec.url);
  let headers = canonicalHeaders(spec.headers);
  let body = spec.body ?? null;

  const hops: HopSnapshot[] = [];
  const visited = new Set<string>([urlKey(url)]);
  let redirects = 0;
  let pendingDrops: DroppedHeader[] = [];

  for (;;) {
    // What is actually sent on this hop. Host and Content-Length are
    // (re)computed per hop so each snapshot reflects the wire exactly.
    const sendHeaders: HeaderMap = {...headers, host: authorityOf(url)};
    if (body !== null && sendHeaders['content-length'] === undefined) {
      sendHeaders['content-length'] = String(Buffer.byteLength(body));
    }
    const requestSnapshot = deepFreeze({method, url: url.toString(), headers: {...sendHeaders}, body});

    let response: TransportResponse;
    try {
      response = await transport({method, url: url.toString(), headers: {...sendHeaders}, body});
    } catch (error) {
      hops.push(deepFreeze({index: hops.length, request: requestSnapshot, response: null, droppedHeaders: pendingDrops}));
      return {hops, terminal: {state: 'transport_error', redirects, message: errorMessage(error)}};
    }

    hops.push(
      deepFreeze({
        index: hops.length,
        request: requestSnapshot,
        response: {status: response.status, headers: flattenHeaders(response.headers), body: response.body ?? ''},
        droppedHeaders: pendingDrops,
      }),
    );
    pendingDrops = [];

    const location = firstHeader(response.headers, 'location');
    if (!REDIRECT_STATUS.has(response.status) || !location) {
      // Final response (a redirect status without Location is terminal too).
      return {hops, terminal: {state: 'completed', redirects}};
    }

    let nextUrl: URL;
    try {
      nextUrl = normalizeUrl(location, url); // resolves relative Locations
    } catch {
      return {hops, terminal: {state: 'completed', redirects}};
    }

    const drops: DroppedHeader[] = [];

    // Method/body rewrite per status (fetch semantics): 303 rewrites anything
    // but GET/HEAD to GET; 301/302 rewrite POST to GET; 307/308 keep both.
    let nextMethod = method;
    let nextBody = body;
    const rewriteToGet =
      (response.status === 303 && method !== 'GET' && method !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) && method === 'POST');
    if (rewriteToGet) {
      nextMethod = 'GET';
      if (nextBody !== null) {
        nextBody = null;
        for (const name of BODY_HEADERS) {
          if (sendHeaders[name] !== undefined) {
            drops.push({
              name,
              reason: 'body_dropped',
              detail: `'${name}' removed: request body dropped on ${response.status} rewrite to GET`,
            });
          }
        }
      }
    }

    // The next request threads from what was actually sent — never from the
    // caller's original object — so stripped headers stay stripped even if the
    // chain later returns to the original origin.
    const nextHeaders: HeaderMap = {...sendHeaders};
    delete nextHeaders.host;
    for (const drop of drops) delete nextHeaders[drop.name];

    const from = originOf(url);
    const to = originOf(nextUrl);
    if (!sameOrigin(url, nextUrl)) {
      const downgrade = from.scheme === 'https' && to.scheme === 'http' && from.host === to.host;
      const reason: DropReason = downgrade ? 'scheme_downgrade' : 'cross_origin';
      const detail = downgrade
        ? `not forwarded on HTTPS→HTTP downgrade to ${originKey(nextUrl)}`
        : `not forwarded to cross-origin ${originKey(nextUrl)}`;
      for (const name of policy.sensitiveHeaders) {
        if (nextHeaders[name] !== undefined) {
          delete nextHeaders[name];
          drops.push({name, reason, detail: `'${name}' ${detail}`});
        }
      }
    } else if (!policy.forwardSensitiveOnSameOrigin) {
      for (const name of policy.sensitiveHeaders) {
        if (nextHeaders[name] !== undefined) {
          delete nextHeaders[name];
          drops.push({name, reason: 'same_origin_policy', detail: `'${name}' withheld: same-origin forwarding disabled by policy`});
        }
      }
    }

    const pendingRedirect: PendingRedirect = {status: response.status, location, resolvedUrl: nextUrl.toString()};

    if (visited.has(urlKey(nextUrl))) {
      return {hops, terminal: {state: 'redirect_loop', redirects, pendingRedirect}};
    }
    if (redirects >= policy.maxRedirects) {
      return {hops, terminal: {state: 'max_redirects_exceeded', redirects, maxRedirects: policy.maxRedirects, pendingRedirect}};
    }

    visited.add(urlKey(nextUrl));
    redirects += 1;
    method = nextMethod;
    url = nextUrl;
    headers = nextHeaders;
    body = nextBody;
    pendingDrops = drops;
  }
}

// ---------------------------------------------------------------------------
// Real transport (manual follow — redirects are never auto-followed).
// ---------------------------------------------------------------------------

export const nodeTransport: Transport = request =>
  new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {method: request.method, headers: request.headers}, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () =>
        resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}),
      );
    });
    req.on('error', reject);
    if (request.body !== null) req.write(request.body);
    req.end();
  });
