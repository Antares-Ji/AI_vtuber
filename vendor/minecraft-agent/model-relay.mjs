// Read the user-authorized secret into memory. Never log credentials or request bodies.
import {execFileSync} from 'node:child_process';
import http from 'node:http';
const token=execFileSync('gcloud',['auth','application-default','print-access-token'],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const secretResponse=await fetch('https://secretmanager.googleapis.com/v1/projects/useful-memory-477923-v7/secrets/OPENROUTER_API_KEY/versions/latest:access',{headers:{Authorization:'Bearer '+token}});
if(!secretResponse.ok)throw Error('Secret Manager returned HTTP '+secretResponse.status);
const secret=await secretResponse.json(),key=Buffer.from(secret.payload.data,'base64').toString().trim();
async function call(path,body){
 const started=Date.now(),controllers=[new AbortController(),new AbortController()];let timer;
 const attempt=async index=>{const r=await fetch('https://openrouter.ai'+path,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',Connection:'close'},body:JSON.stringify(body),signal:AbortSignal.any([controllers[index].signal,AbortSignal.timeout(60000)])});const data=await r.json();if(!r.ok||data.error)throw Error('Model HTTP '+r.status+': '+(data.error?.message||'Request failed'));return {index,data};};
 try{const a=attempt(0),b=new Promise((resolve,reject)=>{timer=setTimeout(()=>attempt(1).then(resolve,reject),path.endsWith('decisions')?3000:10000);});const winner=await Promise.any([a,b]);clearTimeout(timer);controllers[1-winner.index].abort();return {data:winner.data,latencyMs:Date.now()-started};}finally{clearTimeout(timer);controllers.forEach(c=>c.abort());}
}
http.createServer(async(req,res)=>{try{let input='';for await(const chunk of req){input+=chunk;if(input.length>2000000)throw Error('Request too large');}const {path,body}=JSON.parse(input);if(!['/api/alpha/decisions','/api/v1/chat/completions'].includes(path))throw Error('Unsupported model endpoint');const result=await call(path,body);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}catch(e){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}}).listen(3099,'127.0.0.1',()=>console.log('Local model relay ready; credential loaded from authorized Google Secret Manager via application default credentials.'));
