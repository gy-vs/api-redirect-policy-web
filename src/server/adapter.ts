/** Pluggable transport used by the redirect replay engine. */

export type HeaderMap = Record<string, string>;

export type FetchAdapterRequest = {
  method: string;
  url: string;
  headers: HeaderMap;
  body: string | null;
};

export type FetchAdapterResponse = {
  status: number;
  headers: HeaderMap;
  body: string;
};

export type FetchAdapter = (request: FetchAdapterRequest) => Promise<FetchAdapterResponse>;

/**
 * Production adapter: one real HTTP request per hop via global fetch with
 * `redirect: 'manual'`, so the replay engine — never the browser or undici —
 * decides how each redirect is followed and which headers survive.
 */
export function createNodeFetchAdapter(): FetchAdapter {
  return async (request) => {
    const method = request.method.toUpperCase();
    const canSendBody = method !== 'GET' && method !== 'HEAD' && request.body !== null && request.body !== '';
    const response = await fetch(request.url, {
      method,
      headers: request.headers,
      body: canSendBody ? request.body : undefined,
      redirect: 'manual',
    });
    const headers: HeaderMap = {};
    for (const [name, value] of response.headers.entries()) {
      if (name === 'set-cookie') continue;
      headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
    }
    const getSetCookie = (response.headers as {getSetCookie?: () => string[]}).getSetCookie;
    if (typeof getSetCookie === 'function') {
      const cookies = getSetCookie.call(response.headers);
      if (cookies.length > 0) headers['set-cookie'] = cookies.join('\n');
    }
    return {status: response.status, headers, body: await response.text()};
  };
}

export type ScriptedRoute =
  | FetchAdapterResponse
  | ((request: FetchAdapterRequest) => FetchAdapterResponse | Promise<FetchAdapterResponse>);

/**
 * Test adapter: serves scripted responses keyed by normalized URL and records
 * every request exactly as received, so tests can assert the headers and body
 * actually sent on each hop.
 */
export function createScriptedAdapter(routes: Record<string, ScriptedRoute>) {
  const requests: FetchAdapterRequest[] = [];
  const table = new Map<string, ScriptedRoute>();
  for (const [url, route] of Object.entries(routes)) table.set(new URL(url).href, route);
  const adapter: FetchAdapter = async (request) => {
    requests.push(structuredClone(request));
    const route = table.get(new URL(request.url).href);
    if (!route) throw new Error(`no scripted route for ${request.method} ${request.url}`);
    const response = typeof route === 'function' ? await route(request) : route;
    return structuredClone(response);
  };
  return {adapter, requests};
}
