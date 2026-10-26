import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
export async function startPanel({core,root,port=8765,demo=false}) {
 const token=randomBytes(32).toString('hex');let origin;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Frame-Options','DENY');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  try{
   if(req.headers['sec-fetch-site']==='cross-site'||req.headers.host!==new URL(origin).host)return reply(403,{error:'host_denied'});
   const url=new URL(req.url,origin);
   if(req.method==='POST'&&url.pathname==='/api/call'){
    const supplied=Buffer.from(String(req.headers['x-xiaoxi-token']??''));const expected=Buffer.from(token);
    if(req.headers.origin!==origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply(403,{error:'owner_token_required'});
    if(!req.headers['content-type']?.startsWith('application/json'))return reply(415,{error:'json_required'});
    let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>256*1024)return reply(413,{error:'request_too_large'});body+=chunk;}
    const {action,payload={}}=JSON.parse(body);
    if(typeof action!=='string'||!payload||typeof payload!=='object'||Array.isArray(payload))return reply(400,{error:'invalid_request'});
    if(demo&&(['start','deployment.save','extension.call'].includes(action)||action==='settings.save'&&(payload.provider!=='mock'||payload.allowSearch===true||payload.autoConnect===true)))return reply(400,{error:'demo_mock_only: use npm run panel for model or WeChat configuration'});
    // Browser mode never writes plaintext credentials; Electron uses OS encryption.
    if(action==='settings.save'&&payload.apiKey)return reply(400,{error:'browser_uses_apiKeyEnv: set the key in your environment'});
    return reply(200,{result:await core.dispatch(action,payload)});
   }
   if(req.method!=='GET')return reply(405,{error:'method_not_allowed'});
   if(url.pathname==='/api/bootstrap')return reply(200,{token,demo,version:'0.4.0'});
   const name=url.pathname==='/'?'client.html':url.pathname.slice(1);
   if(!['client.html','client.js','client.css','browser_bridge.js'].includes(name))return reply(404,{error:'not_found'});
   let content=fs.readFileSync(path.join(root,'public',name));
   if(name==='client.html')content=Buffer.from(content.toString().replace("connect-src 'none'","connect-src 'self'").replace('<script src="client.js">','<script src="browser_bridge.js"></script><script src="client.js">'));
   res.writeHead(200,{'Content-Type':TYPES[path.extname(name)]});res.end(content);
  }catch(error){reply(400,{error:error.code==='unsupported'?`unsupported:${error.capability}`:String(error.message).slice(0,400)});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 origin=`http://127.0.0.1:${server.address().port}`;
 return {server,url:origin,token,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
