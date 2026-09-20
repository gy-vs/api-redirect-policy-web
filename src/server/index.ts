import express from 'express';
import {fileURLToPath} from 'node:url';
import {createNodeFetchAdapter, replayRedirects} from './replay';
import type {FetchAdapter, RedirectPolicy} from './replay';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary request sequences',revision:3,content:'request sequences: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary request sequences',revision:5,content:'request sequences: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

export function createApp(options:{fetchAdapter?:FetchAdapter}={}){
  const fetchAdapter=options.fetchAdapter??createNodeFetchAdapter();
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"api-scenario",count:rows.length}));
  app.get('/api/scenarios',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/scenarios/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/scenarios/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/scenarios/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});
  app.post('/api/replay',async(req,res)=>{
    const body=req.body??{};
    const replayRequest=body.request;
    if(!replayRequest||typeof replayRequest!=='object'||typeof replayRequest.method!=='string'||typeof replayRequest.url!=='string'){
      return res.status(400).json({error:'invalid_request',message:'request.method and request.url are required'});
    }
    try{new URL(replayRequest.url)}catch{return res.status(400).json({error:'invalid_request',message:'request.url must be an absolute URL'})}
    if(replayRequest.headers!==undefined&&(typeof replayRequest.headers!=='object'||replayRequest.headers===null||Array.isArray(replayRequest.headers))){
      return res.status(400).json({error:'invalid_request',message:'request.headers must be an object of name/value pairs'});
    }
    if(replayRequest.body!==undefined&&replayRequest.body!==null&&typeof replayRequest.body!=='string'){
      return res.status(400).json({error:'invalid_request',message:'request.body must be a string'});
    }
    const policy:Partial<RedirectPolicy>={};
    if(body.policy!==undefined){
      if(typeof body.policy!=='object'||body.policy===null)return res.status(400).json({error:'invalid_request',message:'policy must be an object'});
      if(body.policy.maxHops!==undefined){
        const maxHops=Number(body.policy.maxHops);
        if(!Number.isInteger(maxHops)||maxHops<1||maxHops>100)return res.status(400).json({error:'invalid_request',message:'policy.maxHops must be an integer between 1 and 100'});
        policy.maxHops=maxHops;
      }
      if(body.policy.sensitiveHeaders!==undefined){
        if(!Array.isArray(body.policy.sensitiveHeaders)||body.policy.sensitiveHeaders.some((name:unknown)=>typeof name!=='string')){
          return res.status(400).json({error:'invalid_request',message:'policy.sensitiveHeaders must be an array of header names'});
        }
        policy.sensitiveHeaders=body.policy.sensitiveHeaders;
      }
    }
    try{
      const result=await replayRedirects(
        {method:replayRequest.method,url:replayRequest.url,headers:replayRequest.headers,body:replayRequest.body??null},
        policy,
        fetchAdapter,
      );
      res.json(result);
    }catch(cause){
      res.status(400).json({error:'invalid_request',message:cause instanceof Error?cause.message:String(cause)});
    }
  });
  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
