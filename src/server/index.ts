import express from 'express';
import {fileURLToPath} from 'node:url';
import {nodeTransport,replayRedirects} from './redirects';
import type {HeaderMap,RedirectPolicy} from './redirects';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary request sequences',revision:3,content:'request sequences: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary request sequences',revision:5,content:'request sequences: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"api-scenario",count:rows.length}));
  app.get('/api/scenarios',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/scenarios/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/scenarios/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/scenarios/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});
  app.post('/api/scenarios/:id/replay',async(req,res)=>{
    const row=rows.find(value=>value.id===req.params.id);
    if(!row)return res.status(404).json({error:'not_found'});
    const {method,url,headers,body,policy}=req.body??{};
    if(typeof url!=='string'||!url)return res.status(400).json({error:'url_required'});
    try{
      const result=await replayRedirects(
        {method:typeof method==='string'?method:'GET',url,headers:parseHeaders(headers),body:typeof body==='string'?body:null},
        {transport:nodeTransport,policy:parsePolicy(policy)},
      );
      res.json(result);
    }catch(error){
      res.status(400).json({error:'replay_failed',message:error instanceof Error?error.message:String(error)});
    }
  });
  return app;
}
function parseHeaders(value:unknown):HeaderMap{
  const headers:HeaderMap={};
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    for(const [name,headerValue] of Object.entries(value)){
      if(typeof headerValue==='string')headers[name]=headerValue;
    }
  }
  return headers;
}
function parsePolicy(value:unknown):Partial<RedirectPolicy>{
  if(!value||typeof value!=='object')return {};
  const input=value as Record<string,unknown>;
  const policy:Partial<RedirectPolicy>={};
  if(typeof input.maxRedirects==='number'&&Number.isFinite(input.maxRedirects)){
    policy.maxRedirects=Math.min(Math.max(Math.trunc(input.maxRedirects),0),50);
  }
  if(typeof input.forwardSensitiveOnSameOrigin==='boolean')policy.forwardSensitiveOnSameOrigin=input.forwardSensitiveOnSameOrigin;
  if(Array.isArray(input.sensitiveHeaders)){
    policy.sensitiveHeaders=input.sensitiveHeaders.filter((name):name is string=>typeof name==='string');
  }
  return policy;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
