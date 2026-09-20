import {describeOrigin, sameOrigin} from './origin';
import type {FetchAdapter, HeaderMap} from './adapter';

export type {FetchAdapter, FetchAdapterRequest, FetchAdapterResponse, HeaderMap} from './adapter';
export {createNodeFetchAdapter, createScriptedAdapter} from './adapter';
export type {ScriptedRoute} from './adapter';

export type ReplayRequest = {
  method: string;
  url: string;
  headers?: HeaderMap;
  body?: string | null;
};

export type RedirectPolicy = {
  /** Maximum number of requests sent before giving up. */
  maxHops: number;
  /** Headers stripped whenever a redirect crosses an origin boundary. */
  sensitiveHeaders: string[];
};

export const DEFAULT_SENSITIVE_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];

export const DEFAULT_POLICY: RedirectPolicy = {
  maxHops: 20,
  sensitiveHeaders: DEFAULT_SENSITIVE_HEADERS,
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Headers describing a message body; dropped when a redirect rewrites the method to GET. */
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length', 'transfer-encoding'];

export type HeaderRemoval = {name: string; reason: string};

export type RequestSnapshot = {
  method: string;
  url: string;
  origin: string;
  headers: HeaderMap;
  body: string | null;
};

export type ResponseSnapshot = {
  status: number;
  headers: HeaderMap;
  body: string;
};

export type HopSnapshot = {
  index: number;
  /** Immutable copy of the request exactly as sent on this hop. */
  request: RequestSnapshot;
  /** Immutable copy of the response, or null when the transport failed. */
  response: ResponseSnapshot | null;
  /** Headers removed while building this hop's request, with the reason for each removal. */
  removedHeaders: HeaderRemoval[];
  error: string | null;
};

export type TerminalState =
  | {kind: 'completed'; status: number}
  | {kind: 'loop_detected'; url: string; firstSeenAt: number}
  | {kind: 'max_hops_exceeded'; maxHops: number}
  | {kind: 'invalid_redirect'; location: string}
  | {kind: 'transport_error'; message: string};

export type ReplayResult = {
  terminal: TerminalState;
  hops: HopSnapshot[];
};

type WorkingRequest = {
  method: string;
  url: string;
  headers: HeaderMap;
  body: string | null;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function normalizeHeaders(headers: HeaderMap | undefined): HeaderMap {
  const normalized: HeaderMap = {};
  for (const [name, value] of Object.entries(headers ?? {})) normalized[name.toLowerCase()] = String(value);
  return normalized;
}

/** Fetch-spec method rewrite: 303 → GET unless GET/HEAD; 301/302 → GET only from POST; 307/308 preserve. */
function shouldRewriteToGet(status: number, method: string): boolean {
  if (status === 303) return method !== 'GET' && method !== 'HEAD';
  if (status === 301 || status === 302) return method === 'POST';
  return false;
}

type Transition = {
  next: WorkingRequest | null;
  invalidLocation: string | null;
  removals: HeaderRemoval[];
};

function computeTransition(status: number, location: string, current: WorkingRequest, sensitiveHeaders: string[]): Transition {
  let target: URL;
  try {
    target = new URL(location, current.url); // resolves relative Locations against the current URL
  } catch {
    return {next: null, invalidLocation: location, removals: []};
  }
  target.hash = ''; // fragments are never sent to the server

  const headers = {...current.headers};
  const removals: HeaderRemoval[] = [];
  const drop = (name: string, reason: string) => {
    if (headers[name] !== undefined) {
      delete headers[name];
      removals.push({name, reason});
    }
  };

  let method = current.method;
  let body = current.body;
  if (shouldRewriteToGet(status, method)) {
    const reason = `method rewritten ${method} → GET (${status}); body dropped`;
    method = 'GET';
    body = null;
    for (const name of BODY_HEADERS) drop(name, reason);
  }

  if (!sameOrigin(current.url, target)) {
    const reason = `cross-origin redirect ${describeOrigin(current.url)} → ${describeOrigin(target)}`;
    for (const name of sensitiveHeaders) drop(name, reason);
  }

  const currentAuthority = new URL(current.url).host;
  if (currentAuthority !== target.host) drop('host', `target authority changed ${currentAuthority} → ${target.host}`);

  return {next: {method, url: target.href, headers, body}, invalidLocation: null, removals};
}

/**
 * Follows a redirect chain one hop at a time through the given adapter.
 *
 * Origins are compared by (scheme, normalized host, effective port); sensitive
 * headers are stripped on cross-origin hops and never restored, even if the
 * chain later returns to the original origin. Every hop snapshot is a deep
 * frozen copy, so records of earlier hops can never change retroactively.
 */
export async function replayRedirects(
  initial: ReplayRequest,
  policy: Partial<RedirectPolicy> = {},
  adapter: FetchAdapter,
): Promise<ReplayResult> {
  const maxHops = Math.max(0, Math.floor(policy.maxHops ?? DEFAULT_POLICY.maxHops));
  const sensitiveHeaders = (policy.sensitiveHeaders ?? DEFAULT_POLICY.sensitiveHeaders).map((name) => name.toLowerCase());

  const initialUrl = new URL(initial.url); // throws on invalid input — callers map this to a 400
  initialUrl.hash = '';
  let current: WorkingRequest = {
    method: (initial.method || 'GET').toUpperCase(),
    url: initialUrl.href,
    headers: normalizeHeaders(initial.headers),
    body: initial.body ?? null,
  };
  if (current.method === 'GET' || current.method === 'HEAD') current.body = null;

  const hops: HopSnapshot[] = [];
  const visited = new Map<string, number>();
  let removals: HeaderRemoval[] = [];
  let terminal: TerminalState | null = null;

  for (let index = 0; ; index += 1) {
    const loopKey = `${current.method} ${current.url}`;
    const firstSeenAt = visited.get(loopKey);
    if (firstSeenAt !== undefined) {
      terminal = {kind: 'loop_detected', url: current.url, firstSeenAt};
      break;
    }
    if (index >= maxHops) {
      terminal = {kind: 'max_hops_exceeded', maxHops};
      break;
    }
    visited.set(loopKey, index);

    const requestSnapshot = deepFreeze(structuredClone({...current, origin: describeOrigin(current.url)}));
    let responseSnapshot: ResponseSnapshot | null = null;
    let error: string | null = null;
    try {
      const response = await adapter(structuredClone(current));
      responseSnapshot = deepFreeze({
        status: response.status,
        headers: normalizeHeaders(response.headers),
        body: response.body ?? '',
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    hops.push(deepFreeze({index, request: requestSnapshot, response: responseSnapshot, removedHeaders: structuredClone(removals), error}));

    if (responseSnapshot === null) {
      terminal = {kind: 'transport_error', message: error ?? 'transport error'};
      break;
    }

    const location = responseSnapshot.headers['location'];
    if (!REDIRECT_STATUSES.has(responseSnapshot.status) || location === undefined) {
      terminal = {kind: 'completed', status: responseSnapshot.status};
      break;
    }

    const transition = computeTransition(responseSnapshot.status, location, current, sensitiveHeaders);
    if (transition.next === null) {
      terminal = {kind: 'invalid_redirect', location: transition.invalidLocation ?? location};
      break;
    }
    current = transition.next;
    removals = transition.removals;
  }

  return deepFreeze({terminal: terminal!, hops});
}
