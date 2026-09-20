import {useState} from 'react';
import {Repeat} from 'lucide-react';

type HeaderRemoval={name:string;reason:string};
type RequestSnapshot={method:string;url:string;origin:string;headers:Record<string,string>;body:string|null};
type ResponseSnapshot={status:number;headers:Record<string,string>;body:string};
type HopSnapshot={index:number;request:RequestSnapshot;response:ResponseSnapshot|null;removedHeaders:HeaderRemoval[];error:string|null};
type TerminalState=
  |{kind:'completed';status:number}
  |{kind:'loop_detected';url:string;firstSeenAt:number}
  |{kind:'max_hops_exceeded';maxHops:number}
  |{kind:'invalid_redirect';location:string}
  |{kind:'transport_error';message:string};
type ReplayResult={terminal:TerminalState;hops:HopSnapshot[]};

function terminalView(terminal:TerminalState):{tone:string;text:string}{
  switch(terminal.kind){
    case 'completed':return{tone:'ok',text:`Completed — final status ${terminal.status}`};
    case 'loop_detected':return{tone:'warn',text:`Redirect loop — ${terminal.url} was already requested at hop #${terminal.firstSeenAt}`};
    case 'max_hops_exceeded':return{tone:'warn',text:`Stopped — maximum hop count (${terminal.maxHops}) reached`};
    case 'invalid_redirect':return{tone:'err',text:`Invalid redirect Location: ${terminal.location}`};
    case 'transport_error':return{tone:'err',text:`Transport error — ${terminal.message}`};
  }
}

function formatHeaders(headers:Record<string,string>){
  const lines=Object.entries(headers).map(([name,value])=>`${name}: ${value}`);
  return lines.length>0?lines.join('\n'):'(no headers)';
}

function TerminalBanner({terminal}:{terminal:TerminalState}){
  const {tone,text}=terminalView(terminal);
  return <p className={`terminal ${tone}`}>{text}</p>;
}

export default function ReplayPanel(){
  const [method,setMethod]=useState('GET');
  const [url,setUrl]=useState('http://127.0.0.1:4174/api/bootstrap');
  const [headersText,setHeadersText]=useState('authorization: Bearer demo-token');
  const [body,setBody]=useState('');
  const [maxHops,setMaxHops]=useState('20');
  const [sensitiveText,setSensitiveText]=useState('authorization, proxy-authorization, cookie');
  const [result,setResult]=useState<ReplayResult|null>(null);
  const [error,setError]=useState('');
  const [running,setRunning]=useState(false);

  async function run(){
    setRunning(true);setError('');setResult(null);
    const headers:Record<string,string>={};
    for(const line of headersText.split(/\r?\n/)){
      const separator=line.indexOf(':');
      if(separator>0)headers[line.slice(0,separator).trim()]=line.slice(separator+1).trim();
    }
    try{
      const response=await fetch('/api/replay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        request:{method,url,headers,body:body||null},
        policy:{maxHops:Number(maxHops)||20,sensitiveHeaders:sensitiveText.split(',').map(value=>value.trim()).filter(Boolean)},
      })});
      const value=await response.json();
      if(!response.ok){setError(value.message??'replay failed');return}
      setResult(value);
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause))}
    finally{setRunning(false)}
  }

  return <div className="replay">
    <h2><Repeat size={16}/> Redirect replay</h2>
    <div className="replayform">
      <div className="row">
        <select aria-label="Replay method" value={method} onChange={event=>setMethod(event.target.value)}>{['GET','POST','PUT','PATCH','DELETE','HEAD'].map(value=><option key={value}>{value}</option>)}</select>
        <input aria-label="Replay URL" value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://api.example.com/start"/>
      </div>
      <textarea aria-label="Replay headers" rows={3} value={headersText} onChange={event=>setHeadersText(event.target.value)} placeholder="name: value (one per line)"/>
      <textarea aria-label="Replay body" rows={2} value={body} onChange={event=>setBody(event.target.value)} placeholder="request body (optional)"/>
      <div className="row">
        <label>Max hops<input aria-label="Max hops" type="number" min="1" max="100" value={maxHops} onChange={event=>setMaxHops(event.target.value)}/></label>
        <label>Sensitive headers<input aria-label="Sensitive headers" value={sensitiveText} onChange={event=>setSensitiveText(event.target.value)}/></label>
      </div>
      <button className="primary" onClick={run} disabled={running}>{running?'Replaying…':'Replay chain'}</button>
    </div>
    {error&&<p className="terminal err">{error}</p>}
    {result&&<div className="replayresult">
      <TerminalBanner terminal={result.terminal}/>
      {result.hops.map(hop=><article className="hop" key={hop.index}>
        <header>
          <strong>#{hop.index}</strong>
          <code>{hop.request.method}</code>
          <span className="hopurl">{hop.request.url}</span>
          <span className="pill">{hop.request.origin}</span>
          {hop.response?<span className="status">{hop.response.status}</span>:<span className="status bad">failed</span>}
        </header>
        {hop.removedHeaders.length>0&&<ul className="removals">
          {hop.removedHeaders.map(removal=><li key={removal.name}><del>{removal.name}</del><small>{removal.reason}</small></li>)}
        </ul>}
        <div className="hopgrid">
          <section><h3>Request sent</h3><pre>{formatHeaders(hop.request.headers)}{hop.request.body!==null?`\n\n${hop.request.body}`:''}</pre></section>
          <section><h3>Response</h3><pre>{hop.response?`${formatHeaders(hop.response.headers)}\n\n${hop.response.body}`:(hop.error??'no response')}</pre></section>
        </div>
      </article>)}
    </div>}
  </div>;
}
