import {useEffect,useState} from 'react';
import {FlaskConical,Play,Save,Send} from 'lucide-react';
type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};
type DroppedHeader={name:string;reason:string;detail:string};
type Hop={index:number;request:{method:string;url:string;headers:Record<string,string>;body:string|null};response:{status:number;headers:Record<string,string>;body:string}|null;droppedHeaders:DroppedHeader[]};
type Terminal={state:string;redirects:number;maxRedirects?:number;message?:string;pendingRedirect?:{status:number;location:string;resolvedUrl:string}};
type ReplayResult={hops:Hop[];terminal:Terminal};
function parseHeaderLines(text:string):Record<string,string>{
  const headers:Record<string,string>={};
  for(const line of text.split(/\r?\n/)){
    const at=line.indexOf(':');
    if(at<=0)continue;
    headers[line.slice(0,at).trim()]=line.slice(at+1).trim();
  }
  return headers;
}
function TerminalBadge({terminal}:{terminal:Terminal}){
  if(terminal.state==='completed')return <p className="terminal ok">Completed after {terminal.redirects} redirect(s)</p>;
  if(terminal.state==='redirect_loop')return <p className="terminal loop">Redirect loop — next Location would revisit {terminal.pendingRedirect?.resolvedUrl}</p>;
  if(terminal.state==='max_redirects_exceeded')return <p className="terminal max">Max redirects ({terminal.maxRedirects}) exceeded — stopped before {terminal.pendingRedirect?.resolvedUrl}</p>;
  return <p className="terminal error">Transport error: {terminal.message}</p>;
}
function HopCard({hop}:{hop:Hop}){
  return <article className="hop">
    <header><span className="badge">#{hop.index+1}</span><code>{hop.request.method} {hop.request.url}</code>{hop.response?<span className="status">{hop.response.status}</span>:<span className="status error">no response</span>}</header>
    <div className="hop-cols">
      <div>
        <h3>Sent request headers</h3>
        <table><tbody>{Object.entries(hop.request.headers).map(([name,value])=><tr key={name}><td>{name}</td><td>{value}</td></tr>)}</tbody></table>
        {hop.request.body!==null&&<pre className="body">{hop.request.body}</pre>}
        {hop.droppedHeaders.length>0&&<div className="drops"><h3>Removed before this hop</h3>{hop.droppedHeaders.map(drop=><p className="drop" key={drop.name}><code>{drop.name}</code><span className={`reason ${drop.reason}`}>{drop.detail}</span></p>)}</div>}
      </div>
      <div>
        <h3>Response</h3>
        {hop.response?<><table><tbody>{Object.entries(hop.response.headers).map(([name,value])=><tr key={name}><td>{name}</td><td>{value}</td></tr>)}</tbody></table>{hop.response.body&&<pre className="body">{hop.response.body}</pre>}</>:<p>No response received.</p>}
      </div>
    </div>
  </article>;
}
export default function App(){
  const [items,setItems]=useState<Summary[]>([]);const [selected,setSelected]=useState('alpha');const [row,setRow]=useState<Row|null>(null);const [draft,setDraft]=useState('');const [analysis,setAnalysis]=useState<unknown>(null);const [status,setStatus]=useState('Ready');
  const [replayUrl,setReplayUrl]=useState('');const [replayMethod,setReplayMethod]=useState('GET');const [replayHeaders,setReplayHeaders]=useState('Authorization: Bearer demo-token');const [replayBody,setReplayBody]=useState('');const [replay,setReplay]=useState<ReplayResult|null>(null);
  useEffect(()=>{fetch('/api/scenarios').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{setStatus('Loading');fetch('/api/scenarios/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/scenarios/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/scenarios/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  async function runReplay(){
    setStatus('Replaying');setReplay(null);
    const response=await fetch('/api/scenarios/'+selected+'/replay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:replayMethod,url:replayUrl,headers:parseHeaderLines(replayHeaders),body:replayBody||null})});
    const value=await response.json();
    if(!response.ok){setStatus('Replay failed: '+(value.message??value.error));return}
    setReplay(value);setStatus('Ready');
  }
  return <main className="shell"><header className="topbar"><FlaskConical size={20}/><strong>API Scenario Studio</strong><small>Local workspace</small></header><section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><span>{status}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(analysis??row,null,2)}</pre></aside></section><section className="replay"><h2>Redirect replay</h2><div className="replay-form"><select aria-label="Method" value={replayMethod} onChange={event=>setReplayMethod(event.target.value)}>{['GET','POST','PUT','PATCH','DELETE'].map(method=><option key={method}>{method}</option>)}</select><input aria-label="URL" placeholder="https://api.example.com/start" value={replayUrl} onChange={event=>setReplayUrl(event.target.value)}/><button className="primary" onClick={runReplay}><Send size={15}/>Replay</button></div><div className="replay-form"><textarea aria-label="Replay headers" className="headers" placeholder={'One header per line: Name: value'} value={replayHeaders} onChange={event=>setReplayHeaders(event.target.value)}/><textarea aria-label="Replay body" className="headers" placeholder="Request body (optional)" value={replayBody} onChange={event=>setReplayBody(event.target.value)}/></div>{replay&&<div className="hops">{replay.hops.map(hop=><HopCard hop={hop} key={hop.index}/>)}<TerminalBadge terminal={replay.terminal}/></div>}</section></main>;
}
