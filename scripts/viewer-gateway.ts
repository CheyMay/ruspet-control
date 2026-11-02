import 'dotenv/config';
import http from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';

const password=process.env.VIEWER_PASSWORD;
if(!password||password.length<20)throw Error('Set a strong VIEWER_PASSWORD');
const username=process.env.VIEWER_USER||'ruspet';
const expected=createHash('sha256').update('Basic '+Buffer.from(`${username}:${password}`).toString('base64')).digest();
const server=http.createServer((req,res)=>{
 if(process.env.VIEWER_REQUIRE_HTTPS==='true'&&req.headers['x-forwarded-proto']!=='https'){
  res.writeHead(308,{Location:'https://cheymay.ru/'});res.end();return;
 }
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 const received=createHash('sha256').update(req.headers.authorization||'').digest();
 if(!timingSafeEqual(expected,received)){
  res.writeHead(401,{'WWW-Authenticate':'Basic realm="RUSPET", charset="UTF-8"'});res.end('Authentication required');return;
 }
 const headers={...req.headers};delete headers.authorization;delete headers['proxy-authorization'];
 delete headers['x-forwarded-for'];delete headers['x-forwarded-host'];delete headers['x-forwarded-proto'];
 const upstream=http.request({hostname:'127.0.0.1',port:4310,path:req.url,method:req.method,headers},response=>{
  res.writeHead(response.statusCode||502,response.headers);response.pipe(res);
 });
 upstream.setTimeout(30000,()=>upstream.destroy());
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Service unavailable');});
 req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
});
// Non-loopback binding is only for a provider's TLS-terminating domain proxy.
server.listen(Number(process.env.VIEWER_PORT||4312),process.env.VIEWER_HOST||'127.0.0.1',()=>console.log('Protected viewer gateway ready'));
process.on('SIGTERM',()=>server.close());
