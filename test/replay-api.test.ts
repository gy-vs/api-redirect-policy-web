import {afterEach,describe,expect,it} from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {createApp} from '../src/server/index';

type Echo = {method: string; url: string; headers: http.IncomingHttpHeaders; body: string};

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address() as AddressInfo;
  return {server, base: `http://127.0.0.1:${port}`};
}

function echo(): {handler: http.RequestListener; seen: Echo[]} {
  const seen: Echo[] = [];
  return {
    seen,
    handler(req, res) {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk as Buffer));
      req.on('end', () => {
        seen.push({method: req.method ?? '', url: req.url ?? '', headers: {...req.headers}, body: Buffer.concat(chunks).toString()});
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify(seen[seen.length - 1]));
      });
    },
  };
}

describe('replay endpoint', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  it('follows a same-origin redirect server-side and keeps sensitive headers', async () => {
    const target = echo();
    const redirected = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, {location: '/end'});
        res.end();
      } else {
        target.handler(req, res);
      }
    });
    servers.push(redirected.server);
    const app = createApp();
    const response = await request(app)
      .post('/api/scenarios/alpha/replay')
      .send({method: 'GET', url: `${redirected.base}/start`, headers: {authorization: 'Bearer token'}})
      .expect(200);
    expect(response.body.terminal).toEqual({state: 'completed', redirects: 1});
    expect(response.body.hops).toHaveLength(2);
    expect(response.body.hops[0].request.url).toBe(`${redirected.base}/start`);
    expect(response.body.hops[1].request.url).toBe(`${redirected.base}/end`);
    expect(target.seen[0].headers.authorization).toBe('Bearer token');
    expect(response.body.hops[1].droppedHeaders).toEqual([]);
  });

  it('strips Authorization when the chain crosses origins, with a recorded reason', async () => {
    const other = echo();
    const otherServer = await listen(other.handler);
    const first = await listen((req, res) => {
      res.writeHead(302, {location: `${otherServer.base}/landing`});
      res.end();
    });
    servers.push(otherServer.server, first.server);
    const app = createApp();
    const response = await request(app)
      .post('/api/scenarios/alpha/replay')
      .send({method: 'GET', url: `${first.base}/start`, headers: {authorization: 'Bearer token', 'x-trace': '1'}})
      .expect(200);
    expect(response.body.terminal.state).toBe('completed');
    expect(other.seen[0].headers.authorization).toBeUndefined();
    expect(other.seen[0].headers['x-trace']).toBe('1');
    expect(response.body.hops[1].droppedHeaders).toEqual([
      {name: 'authorization', reason: 'cross_origin', detail: `'authorization' not forwarded to cross-origin ${otherServer.base}`},
    ]);
  });

  it('preserves the body across a 307 redirect', async () => {
    const target = echo();
    const server = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(307, {location: '/end'});
        res.end();
      } else {
        target.handler(req, res);
      }
    });
    servers.push(server.server);
    const app = createApp();
    const response = await request(app)
      .post('/api/scenarios/alpha/replay')
      .send({method: 'POST', url: `${server.base}/start`, headers: {'content-type': 'text/plain'}, body: 'payload'})
      .expect(200);
    expect(response.body.terminal).toEqual({state: 'completed', redirects: 1});
    expect(target.seen[0].method).toBe('POST');
    expect(target.seen[0].body).toBe('payload');
    expect(response.body.hops[1].request.body).toBe('payload');
  });

  it('surfaces redirect loops as a distinct terminal state', async () => {
    const server = await listen((req, res) => {
      res.writeHead(302, {location: '/loop'});
      res.end();
    });
    servers.push(server.server);
    const app = createApp();
    const response = await request(app)
      .post('/api/scenarios/alpha/replay')
      .send({method: 'GET', url: `${server.base}/loop`, headers: {}})
      .expect(200);
    expect(response.body.terminal.state).toBe('redirect_loop');
    expect(response.body.terminal.pendingRedirect.resolvedUrl).toBe(`${server.base}/loop`);
    expect(response.body.hops).toHaveLength(1);
  });

  it('rejects requests without a URL', async () => {
    const app = createApp();
    await request(app).post('/api/scenarios/alpha/replay').send({method: 'GET'}).expect(400);
  });
});
