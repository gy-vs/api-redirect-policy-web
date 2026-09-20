import {describe,expect,it} from 'vitest';
import {
  normalizeHost,
  normalizeUrl,
  replayRedirects,
  sameOrigin,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../src/server/redirects';

/**
 * Recording/scripting transport: the test adapter captures exactly what each
 * hop sends (method, URL, headers, body) and replies with scripted responses.
 */
class Script {
  readonly sent: TransportRequest[] = [];
  private readonly queue: Array<(request: TransportRequest) => TransportResponse> = [];
  respond(response: Partial<TransportResponse> & {status: number}): this {
    this.queue.push(() => ({headers: {}, body: '', ...response}));
    return this;
  }
  redirect(status: number, location: string): this {
    return this.respond({status, headers: {location}, body: ''});
  }
  ok(body = 'done'): this {
    return this.respond({status: 200, headers: {'content-type': 'text/plain'}, body});
  }
  readonly transport: Transport = async request => {
    this.sent.push(structuredClone(request));
    const next = this.queue.shift();
    if (!next) throw new Error(`unexpected request: ${request.method} ${request.url}`);
    return next(request);
  };
}

const url = (value: string) => new URL(value);

describe('origin normalization', () => {
  it('treats default ports as the same origin', () => {
    expect(sameOrigin(url('http://example.com/a'), url('http://example.com:80/b'))).toBe(true);
    expect(sameOrigin(url('https://example.com/a'), url('https://example.com:443/b'))).toBe(true);
    expect(sameOrigin(url('http://example.com/a'), url('http://example.com:8080/b'))).toBe(false);
  });
  it('treats host case and trailing dot as the same origin', () => {
    expect(sameOrigin(url('http://EXAMPLE.com/a'), url('http://example.com/b'))).toBe(true);
    expect(normalizeHost('Example.COM.')).toBe('example.com');
  });
  it('treats unicode and punycode IDN hosts as the same origin', () => {
    expect(normalizeHost('bücher.de')).toBe('xn--bcher-kva.de');
    expect(sameOrigin(url('http://bücher.de/a'), url('http://xn--bcher-kva.de/b'))).toBe(true);
  });
  it('treats scheme or port changes as different origins', () => {
    expect(sameOrigin(url('https://example.com/a'), url('http://example.com/b'))).toBe(false);
    expect(sameOrigin(url('http://example.com:8080/a'), url('http://example.com:9090/b'))).toBe(false);
  });
  it('canonicalizes URLs for comparison', () => {
    expect(normalizeUrl('HTTP://EXAMPLE.com:80/a/../b#frag').toString()).toBe('http://example.com/b');
  });
});

describe('redirect header policy', () => {
  it('keeps sensitive headers on same-origin redirects across default port, case and punycode forms', async () => {
    const script = new Script().redirect(302, 'http://example.com:80/next').ok();
    const result = await replayRedirects(
      {method: 'GET', url: 'http://EXAMPLE.com/start', headers: {Authorization: 'Bearer token'}},
      {transport: script.transport},
    );
    expect(result.terminal).toEqual({state: 'completed', redirects: 1});
    expect(script.sent[1].url).toBe('http://example.com/next');
    expect(script.sent[1].headers.authorization).toBe('Bearer token');
    expect(result.hops[1].droppedHeaders).toEqual([]);

    const idn = new Script().redirect(302, 'http://xn--bcher-kva.de/next').ok();
    const idnResult = await replayRedirects(
      {method: 'GET', url: 'http://bücher.de/start', headers: {authorization: 'Bearer token'}},
      {transport: idn.transport},
    );
    expect(idnResult.terminal.state).toBe('completed');
    expect(idn.sent[1].headers.authorization).toBe('Bearer token');
  });

  it('strips sensitive headers cross-origin and records the reason', async () => {
    const script = new Script().redirect(302, 'http://b.test/landing').ok();
    const result = await replayRedirects(
      {
        method: 'GET',
        url: 'http://a.test/start',
        headers: {authorization: 'Bearer token', cookie: 'session=1', 'x-trace': 'keep-me'},
      },
      {transport: script.transport},
    );
    expect(result.terminal.state).toBe('completed');
    const sent = script.sent[1].headers;
    expect(sent.authorization).toBeUndefined();
    expect(sent.cookie).toBeUndefined();
    expect(sent['x-trace']).toBe('keep-me');
    expect(result.hops[1].droppedHeaders).toEqual([
      {name: 'authorization', reason: 'cross_origin', detail: "'authorization' not forwarded to cross-origin http://b.test"},
      {name: 'cookie', reason: 'cross_origin', detail: "'cookie' not forwarded to cross-origin http://b.test"},
    ]);
  });

  it('strips sensitive headers when only the scheme changes (https→http downgrade)', async () => {
    const script = new Script().redirect(302, 'http://a.test/landing').ok();
    const result = await replayRedirects(
      {method: 'GET', url: 'https://a.test/start', headers: {authorization: 'Bearer token'}},
      {transport: script.transport},
    );
    expect(script.sent[1].headers.authorization).toBeUndefined();
    expect(result.hops[1].droppedHeaders).toEqual([
      {name: 'authorization', reason: 'scheme_downgrade', detail: "'authorization' not forwarded on HTTPS→HTTP downgrade to http://a.test"},
    ]);
  });

  it('strips sensitive headers when only the port changes', async () => {
    const script = new Script().redirect(302, 'http://a.test:9090/landing').ok();
    const result = await replayRedirects(
      {method: 'GET', url: 'http://a.test:8080/start', headers: {authorization: 'Bearer token'}},
      {transport: script.transport},
    );
    expect(script.sent[1].headers.authorization).toBeUndefined();
    expect(result.hops[1].droppedHeaders[0].reason).toBe('cross_origin');
  });

  it('withholds sensitive headers on same-origin redirects when policy disables forwarding', async () => {
    const script = new Script().redirect(302, '/next').ok();
    const result = await replayRedirects(
      {method: 'GET', url: 'http://a.test/start', headers: {authorization: 'Bearer token'}},
      {transport: script.transport, policy: {forwardSensitiveOnSameOrigin: false}},
    );
    expect(script.sent[1].headers.authorization).toBeUndefined();
    expect(result.hops[1].droppedHeaders[0].reason).toBe('same_origin_policy');
  });

  it('does not restore stripped headers when the chain returns to the original origin', async () => {
    const script = new Script()
      .redirect(302, 'http://b.test/middle')
      .redirect(302, 'http://a.test/back')
      .ok();
    const result = await replayRedirects(
      {method: 'GET', url: 'http://a.test/start', headers: {authorization: 'Bearer token'}},
      {transport: script.transport},
    );
    expect(result.terminal).toEqual({state: 'completed', redirects: 2});
    expect(script.sent[1].headers.authorization).toBeUndefined();
    expect(script.sent[2].headers.authorization).toBeUndefined();
    expect(result.hops[2].droppedHeaders).toEqual([]);
  });
});

describe('redirect semantics', () => {
  it('resolves relative and protocol-relative Locations against the current URL', async () => {
    const script = new Script()
      .redirect(302, '../next?x=1')
      .redirect(301, '//a.test/final')
      .ok();
    const result = await replayRedirects(
      {method: 'GET', url: 'http://a.test/dir/page', headers: {}},
      {transport: script.transport},
    );
    expect(result.terminal).toEqual({state: 'completed', redirects: 2});
    expect(script.sent.map(request => request.url)).toEqual([
      'http://a.test/dir/page',
      'http://a.test/next?x=1',
      'http://a.test/final',
    ]);
  });

  it('preserves method and body on 307, even cross-origin', async () => {
    const script = new Script().redirect(307, 'http://b.test/upload').ok();
    const result = await replayRedirects(
      {
        method: 'POST',
        url: 'http://a.test/upload',
        headers: {authorization: 'Bearer token', 'content-type': 'application/json'},
        body: '{"a":1}',
      },
      {transport: script.transport},
    );
    const sent = script.sent[1];
    expect(sent.method).toBe('POST');
    expect(sent.body).toBe('{"a":1}');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.headers['content-length']).toBe('7');
    expect(sent.headers.authorization).toBeUndefined();
    expect(result.hops[1].droppedHeaders.map(drop => drop.name)).toEqual(['authorization']);
  });

  it('rewrites POST to GET and drops the body on 303', async () => {
    const script = new Script().redirect(303, '/result').ok();
    const result = await replayRedirects(
      {
        method: 'POST',
        url: 'http://a.test/submit',
        headers: {'content-type': 'text/plain', authorization: 'Bearer token'},
        body: 'payload',
      },
      {transport: script.transport},
    );
    const sent = script.sent[1];
    expect(sent.method).toBe('GET');
    expect(sent.body).toBeNull();
    expect(sent.headers['content-type']).toBeUndefined();
    expect(sent.headers['content-length']).toBeUndefined();
    expect(sent.headers.authorization).toBe('Bearer token');
    expect(result.hops[1].droppedHeaders.map(drop => [drop.name, drop.reason])).toEqual([
      ['content-length', 'body_dropped'],
      ['content-type', 'body_dropped'],
    ]);
  });

  it('rewrites POST to GET on 302 but keeps other methods untouched', async () => {
    const post = new Script().redirect(302, '/next').ok();
    const postResult = await replayRedirects(
      {method: 'POST', url: 'http://a.test/a', headers: {}, body: 'x'},
      {transport: post.transport},
    );
    expect(post.sent[1].method).toBe('GET');
    expect(post.sent[1].body).toBeNull();
    expect(postResult.terminal).toEqual({state: 'completed', redirects: 1});

    const put = new Script().redirect(302, '/next').ok();
    await replayRedirects(
      {method: 'PUT', url: 'http://a.test/a', headers: {}, body: 'x'},
      {transport: put.transport},
    );
    expect(put.sent[1].method).toBe('PUT');
    expect(put.sent[1].body).toBe('x');
  });

  it('treats a redirect status without Location as the final response', async () => {
    const script = new Script().respond({status: 302});
    const result = await replayRedirects(
      {method: 'GET', url: 'http://a.test/a', headers: {}},
      {transport: script.transport},
    );
    expect(result.terminal).toEqual({state: 'completed', redirects: 0});
    expect(result.hops).toHaveLength(1);
  });
});

describe('terminal states', () => {
  it('reports redirect loops as their own terminal state without re-sending', async () => {
    const script = new Script().redirect(302, '/two').redirect(302, '/one');
    const result = await replayRedirects(
      {method: 'GET', url: 'http://a.test/one', headers: {}},
      {transport: script.transport},
    );
    expect(result.terminal).toEqual({
      state: 'redirect_loop',
      redirects: 1,
      pendingRedirect: {status: 302, location: '/one', resolvedUrl: 'http://a.test/one'},
    });
    expect(result.hops).toHaveLength(2);
    expect(script.sent).toHaveLength(2);
  });

  it('reports max redirects as a terminal state distinct from loops', async () => {
    const script = new Script().redirect(302, '/2').redirect(302, '/3').redirect(302, '/4');
    const result = await replayRedirects(
      {method: 'GET', url: 'http://a.test/1', headers: {}},
      {transport: script.transport, policy: {maxRedirects: 2}},
    );
    expect(result.terminal).toEqual({
      state: 'max_redirects_exceeded',
      redirects: 2,
      maxRedirects: 2,
      pendingRedirect: {status: 302, location: '/4', resolvedUrl: 'http://a.test/4'},
    });
    expect(result.hops).toHaveLength(3);
    expect(script.sent).toHaveLength(3);
  });

  it('reports transport errors with the sent request preserved', async () => {
    const failing: Transport = async () => {
      throw new Error('connection refused');
    };
    const result = await replayRedirects(
      {method: 'GET', url: 'http://a.test/a', headers: {}},
      {transport: failing},
    );
    expect(result.terminal).toEqual({state: 'transport_error', redirects: 0, message: 'connection refused'});
    expect(result.hops[0].response).toBeNull();
    expect(result.hops[0].request.url).toBe('http://a.test/a');
  });
});

describe('hop snapshots', () => {
  it('matches each snapshot to what the transport actually sent', async () => {
    const script = new Script().redirect(307, 'http://b.test/two').redirect(303, '/three').ok();
    const result = await replayRedirects(
      {method: 'POST', url: 'http://a.test/one', headers: {authorization: 'Bearer token'}, body: 'abc'},
      {transport: script.transport},
    );
    expect(result.hops).toHaveLength(3);
    for (const [index, hop] of result.hops.entries()) {
      expect(hop.request).toEqual(script.sent[index]);
    }
  });

  it('freezes every hop snapshot so earlier records cannot be mutated later', async () => {
    const script = new Script().redirect(302, 'http://b.test/two').ok();
    const inputHeaders = {authorization: 'Bearer token'};
    const result = await replayRedirects(
      {method: 'GET', url: 'http://a.test/one', headers: inputHeaders},
      {transport: script.transport},
    );
    const first = result.hops[0];
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.request)).toBe(true);
    expect(Object.isFrozen(first.request.headers)).toBe(true);
    expect(Object.isFrozen(first.response)).toBe(true);
    expect(() => {
      (first.request.headers as Record<string, string>).authorization = 'forged';
    }).toThrow(TypeError);
    // Mutating the caller's input after the run must not rewrite history.
    inputHeaders.authorization = 'changed-afterwards';
    expect(result.hops[0].request.headers.authorization).toBe('Bearer token');
    // The first hop kept the header; the cross-origin second hop dropped it.
    expect(result.hops[0].request.headers.authorization).toBe('Bearer token');
    expect(result.hops[1].request.headers.authorization).toBeUndefined();
  });
});
