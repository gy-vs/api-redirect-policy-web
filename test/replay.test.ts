import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {describeOrigin,parseOrigin,sameOrigin} from '../src/server/origin';
import {createScriptedAdapter,replayRedirects} from '../src/server/replay';
import type {FetchAdapterRequest} from '../src/server/replay';

const AUTH={authorization:'Bearer secret-token',cookie:'session=abc'};

function redirect(location:string,status=302){
  return {status,headers:{location},body:''};
}
const OK={status:200,headers:{'content-type':'text/plain'},body:'done'};

describe('origin normalization',()=>{
  it('equates default ports with the scheme default',()=>{
    expect(sameOrigin('http://example.com/a','http://example.com:80/b')).toBe(true);
    expect(sameOrigin('https://example.com/a','https://example.com:443/b')).toBe(true);
    expect(sameOrigin('http://example.com/a','http://example.com:8080/b')).toBe(false);
    expect(sameOrigin('http://example.com:8080/a','https://example.com:8080/b')).toBe(false);
  });
  it('ignores host case',()=>{
    expect(sameOrigin('http://EXAMPLE.com/a','http://example.COM/b')).toBe(true);
  });
  it('equates unicode and punycode hosts',()=>{
    expect(sameOrigin('http://bücher.de/a','http://xn--bcher-kva.de/b')).toBe(true);
  });
  it('treats a scheme change as cross-origin even on the same host',()=>{
    expect(sameOrigin('https://api.example.com/a','http://api.example.com/b')).toBe(false);
  });
  it('parses the effective port and describes origins without default ports',()=>{
    expect(parseOrigin('https://example.com/')).toEqual({scheme:'https',host:'example.com',port:443});
    expect(parseOrigin('http://example.com:8080/')).toEqual({scheme:'http',host:'example.com',port:8080});
    expect(describeOrigin('https://example.com:443/a')).toBe('https://example.com');
    expect(describeOrigin('http://example.com:8080/a')).toBe('http://example.com:8080');
  });
});

describe('redirect replay — origin policy',()=>{
  it('keeps sensitive headers on same-origin hops across default ports and host case',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'http://example.com/a':redirect('http://EXAMPLE.com:80/b'),
      'http://example.com/b':redirect('http://example.com/c'),
      'http://example.com/c':OK,
    });
    const result=await replayRedirects({method:'GET',url:'http://example.com:80/a',headers:AUTH},{},adapter);
    expect(result.terminal).toEqual({kind:'completed',status:200});
    expect(result.hops).toHaveLength(3);
    for(const sent of requests)expect(sent.headers.authorization).toBe('Bearer secret-token');
    expect(result.hops.every(hop=>hop.removedHeaders.length===0)).toBe(true);
  });
  it('keeps headers when redirecting between unicode and punycode hosts',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'http://bücher.de/start':redirect('http://xn--bcher-kva.de/next'),
      'http://xn--bcher-kva.de/next':OK,
    });
    const result=await replayRedirects({method:'GET',url:'http://bücher.de/start',headers:AUTH},{},adapter);
    expect(result.terminal).toEqual({kind:'completed',status:200});
    expect(requests).toHaveLength(2);
    expect(requests[1].url).toBe('http://xn--bcher-kva.de/next');
    expect(requests[1].headers.authorization).toBe('Bearer secret-token');
  });
  it('strips sensitive headers on protocol downgrade and records the reason',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'https://api.example.com/a':redirect('http://api.example.com/b'),
      'http://api.example.com/b':OK,
    });
    const result=await replayRedirects({method:'GET',url:'https://api.example.com/a',headers:AUTH},{},adapter);
    expect(result.terminal).toEqual({kind:'completed',status:200});
    expect(requests[0].headers.authorization).toBe('Bearer secret-token');
    expect(requests[1].headers.authorization).toBeUndefined();
    expect(requests[1].headers.cookie).toBeUndefined();
    const removed=result.hops[1].removedHeaders;
    expect(removed.map(entry=>entry.name).sort()).toEqual(['authorization','cookie']);
    expect(removed[0].reason).toContain('cross-origin redirect https://api.example.com → http://api.example.com');
    expect(result.hops[0].request.headers.authorization).toBe('Bearer secret-token');
  });
  it('strips sensitive headers when only the port differs',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'http://example.com:8080/a':redirect('http://example.com/b'),
      'http://example.com/b':OK,
    });
    await replayRedirects({method:'GET',url:'http://example.com:8080/a',headers:AUTH},{},adapter);
    expect(requests[1].headers.authorization).toBeUndefined();
    expect(requests[1].headers.cookie).toBeUndefined();
  });
  it('treats protocol-relative Locations to another host as cross-origin',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'https://example.com/a':redirect('//cdn.example.com/b'),
      'https://cdn.example.com/b':OK,
    });
    await replayRedirects({method:'GET',url:'https://example.com/a',headers:AUTH},{},adapter);
    expect(requests[1].url).toBe('https://cdn.example.com/b');
    expect(requests[1].headers.authorization).toBeUndefined();
  });
  it('does not restore stripped headers when the chain returns to the original origin',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'https://a.example.com/start':redirect('https://b.example.com/middle'),
      'https://b.example.com/middle':redirect('https://a.example.com/back'),
      'https://a.example.com/back':OK,
    });
    const result=await replayRedirects({method:'GET',url:'https://a.example.com/start',headers:AUTH},{},adapter);
    expect(result.terminal).toEqual({kind:'completed',status:200});
    expect(requests[0].headers.authorization).toBe('Bearer secret-token');
    expect(requests[1].headers.authorization).toBeUndefined();
    expect(requests[2].headers.authorization).toBeUndefined();
    expect(result.hops[1].removedHeaders.map(entry=>entry.name)).toContain('authorization');
    expect(result.hops[2].removedHeaders).toEqual([]);
  });
  it('honours the configured sensitive header list',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'https://a.example.com/1':redirect('https://b.example.com/2'),
      'https://b.example.com/2':OK,
    });
    const result=await replayRedirects(
      {method:'GET',url:'https://a.example.com/1',headers:{authorization:'Bearer keep','x-api-key':'strip-me'}},
      {sensitiveHeaders:['x-api-key']},
      adapter,
    );
    expect(requests[1].headers['x-api-key']).toBeUndefined();
    expect(requests[1].headers.authorization).toBe('Bearer keep');
    expect(result.hops[1].removedHeaders.map(entry=>entry.name)).toEqual(['x-api-key']);
  });
  it('drops an explicit host header only when the authority changes',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'http://a.example.com/1':redirect('http://b.example.com/2'),
      'http://b.example.com/2':redirect('/3'),
      'http://b.example.com/3':OK,
    });
    const result=await replayRedirects({method:'GET',url:'http://a.example.com/1',headers:{host:'a.example.com'}},{},adapter);
    expect(requests[1].headers.host).toBeUndefined();
    expect(result.hops[1].removedHeaders.map(entry=>entry.name)).toEqual(['host']);
    expect(requests[2].headers.host).toBeUndefined();
    expect(result.hops[2].removedHeaders).toEqual([]);
  });
});

describe('redirect replay — locations, methods and bodies',()=>{
  it('resolves relative Location values against the current URL',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'http://example.com/dir/page':redirect('../up?q=1'),
      'http://example.com/up?q=1':redirect('/abs'),
      'http://example.com/abs':redirect('next'),
      'http://example.com/next':OK,
    });
    const result=await replayRedirects({method:'GET',url:'http://example.com/dir/page',headers:{}},{},adapter);
    expect(result.terminal).toEqual({kind:'completed',status:200});
    expect(requests.map(sent=>sent.url)).toEqual([
      'http://example.com/dir/page',
      'http://example.com/up?q=1',
      'http://example.com/abs',
      'http://example.com/next',
    ]);
  });
  it.each([307,308])('preserves method and body across %i redirects',async(status)=>{
    const {adapter,requests}=createScriptedAdapter({
      'http://example.com/upload':redirect('/again',status),
      'http://example.com/again':OK,
    });
    const result=await replayRedirects(
      {method:'POST',url:'http://example.com/upload',headers:{'content-type':'text/plain'},body:'payload-123'},
      {},
      adapter,
    );
    expect(result.terminal).toEqual({kind:'completed',status:200});
    expect(requests[1].method).toBe('POST');
    expect(requests[1].body).toBe('payload-123');
    expect(requests[1].headers['content-type']).toBe('text/plain');
    expect(result.hops[1].removedHeaders).toEqual([]);
  });
  it('rewrites POST to GET and drops the body on 303',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'http://example.com/submit':redirect('/done',303),
      'http://example.com/done':OK,
    });
    const result=await replayRedirects(
      {method:'POST',url:'http://example.com/submit',headers:{'content-type':'application/json','content-length':'7'},body:'{"a":1}'},
      {},
      adapter,
    );
    expect(requests[1].method).toBe('GET');
    expect(requests[1].body).toBeNull();
    expect(requests[1].headers['content-type']).toBeUndefined();
    expect(requests[1].headers['content-length']).toBeUndefined();
    const removed=result.hops[1].removedHeaders;
    expect(removed.map(entry=>entry.name).sort()).toEqual(['content-length','content-type']);
    expect(removed[0].reason).toContain('303');
  });
  it.each([301,302])('rewrites POST to GET on %i',async(status)=>{
    const {adapter,requests}=createScriptedAdapter({
      'http://example.com/a':redirect('/b',status),
      'http://example.com/b':OK,
    });
    await replayRedirects({method:'POST',url:'http://example.com/a',headers:{},body:'x'},{},adapter);
    expect(requests[1].method).toBe('GET');
    expect(requests[1].body).toBeNull();
  });
  it('keeps the method on 302 for non-POST requests',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'http://example.com/a':redirect('/b',302),
      'http://example.com/b':OK,
    });
    await replayRedirects({method:'PUT',url:'http://example.com/a',headers:{'content-type':'text/plain'},body:'keep-me'},{},adapter);
    expect(requests[1].method).toBe('PUT');
    expect(requests[1].body).toBe('keep-me');
  });
});

describe('redirect replay — terminal states',()=>{
  it('detects redirect loops as their own terminal state',async()=>{
    const {adapter}=createScriptedAdapter({
      'http://example.com/a':redirect('/b'),
      'http://example.com/b':redirect('/a'),
    });
    const result=await replayRedirects({method:'GET',url:'http://example.com/a',headers:{}},{},adapter);
    expect(result.terminal).toEqual({kind:'loop_detected',url:'http://example.com/a',firstSeenAt:0});
    expect(result.hops).toHaveLength(2);
  });
  it('reports loops before hitting the hop limit',async()=>{
    const {adapter}=createScriptedAdapter({
      'http://example.com/x':redirect('/y'),
      'http://example.com/y':redirect('/x'),
    });
    const result=await replayRedirects({method:'GET',url:'http://example.com/x',headers:{}},{maxHops:50},adapter);
    expect(result.terminal.kind).toBe('loop_detected');
  });
  it('stops with max_hops_exceeded when the chain never settles',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'http://example.com/1':redirect('/2'),
      'http://example.com/2':redirect('/3'),
      'http://example.com/3':redirect('/4'),
      'http://example.com/4':OK,
    });
    const result=await replayRedirects({method:'GET',url:'http://example.com/1',headers:{}},{maxHops:3},adapter);
    expect(result.terminal).toEqual({kind:'max_hops_exceeded',maxHops:3});
    expect(result.hops).toHaveLength(3);
    expect(requests).toHaveLength(3);
  });
  it('ends with invalid_redirect when Location cannot be parsed',async()=>{
    const {adapter}=createScriptedAdapter({'http://example.com/a':redirect('http://')});
    const result=await replayRedirects({method:'GET',url:'http://example.com/a',headers:{}},{},adapter);
    expect(result.terminal).toEqual({kind:'invalid_redirect',location:'http://'});
  });
  it('treats a redirect status without Location as the final response',async()=>{
    const {adapter}=createScriptedAdapter({'http://example.com/a':{status:302,headers:{},body:'no location'}});
    const result=await replayRedirects({method:'GET',url:'http://example.com/a',headers:{}},{},adapter);
    expect(result.terminal).toEqual({kind:'completed',status:302});
  });
  it('ends with transport_error when the adapter fails',async()=>{
    const {adapter}=createScriptedAdapter({});
    const result=await replayRedirects({method:'GET',url:'http://example.com/missing',headers:{}},{},adapter);
    expect(result.terminal.kind).toBe('transport_error');
    expect(result.hops[0].response).toBeNull();
    expect(result.hops[0].error).toContain('no scripted route');
  });
});

describe('redirect replay — immutable snapshots',()=>{
  it('freezes every hop snapshot so earlier records cannot change',async()=>{
    const {adapter}=createScriptedAdapter({
      'https://a.example.com/1':redirect('https://b.example.com/2'),
      'https://b.example.com/2':redirect('https://c.example.com/3'),
      'https://c.example.com/3':OK,
    });
    const result=await replayRedirects({method:'GET',url:'https://a.example.com/1',headers:AUTH},{},adapter);
    expect(Object.isFrozen(result.hops)).toBe(true);
    expect(Object.isFrozen(result.hops[0].request.headers)).toBe(true);
    expect(Object.isFrozen(result.terminal)).toBe(true);
    expect(()=>{result.hops[0].request.headers.authorization='tampered'}).toThrow(TypeError);
    expect(result.hops[0].request.headers.authorization).toBe('Bearer secret-token');
    expect(result.hops[2].request.headers.authorization).toBeUndefined();
  });
  it('sends the adapter an isolated copy of each request',async()=>{
    const mutating=async(sent:FetchAdapterRequest)=>{
      sent.headers.authorization='tampered';
      sent.body='tampered';
      return OK;
    };
    const result=await replayRedirects(
      {method:'POST',url:'http://example.com/a',headers:{authorization:'Bearer real'},body:'real-body'},
      {},
      mutating,
    );
    expect(result.hops[0].request.headers.authorization).toBe('Bearer real');
    expect(result.hops[0].request.body).toBe('real-body');
  });
});

describe('POST /api/replay',()=>{
  it('replays a chain through the injected adapter and returns per-hop snapshots',async()=>{
    const {adapter,requests}=createScriptedAdapter({
      'https://api.example.com/a':redirect('http://api.example.com/b'),
      'http://api.example.com/b':OK,
    });
    const app=createApp({fetchAdapter:adapter});
    const response=await request(app)
      .post('/api/replay')
      .send({request:{method:'GET',url:'https://api.example.com/a',headers:AUTH},policy:{maxHops:10}})
      .expect(200);
    expect(response.body.terminal).toEqual({kind:'completed',status:200});
    expect(response.body.hops).toHaveLength(2);
    expect(response.body.hops[0].request.headers.authorization).toBe('Bearer secret-token');
    expect(response.body.hops[1].request.headers.authorization).toBeUndefined();
    expect(response.body.hops[1].removedHeaders.length).toBeGreaterThan(0);
    expect(response.body.hops[1].removedHeaders[0].reason).toContain('cross-origin');
    expect(requests[1].headers.cookie).toBeUndefined();
  });
  it('rejects invalid input',async()=>{
    const app=createApp({fetchAdapter:async()=>OK});
    await request(app).post('/api/replay').send({request:{method:'GET',url:'not-a-url'}}).expect(400);
    await request(app).post('/api/replay').send({}).expect(400);
    await request(app).post('/api/replay').send({request:{method:'GET',url:'http://example.com'},policy:{maxHops:0}}).expect(400);
    await request(app).post('/api/replay').send({request:{method:'GET',url:'http://example.com',headers:'nope'}}).expect(400);
  });
});
