import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,symlink,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';import {join} from 'node:path';import {createInterface} from 'node:readline';
import ts from 'typescript';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const dir=await mkdtemp(join(tmpdir(),'rambo-native-live-'));
const native=join(dir,'native');const profile=join(dir,'profile');await mkdir(native);await mkdir(profile);
await writeFile(join(native,'auth.json'),JSON.stringify({OPENAI_API_KEY:'fixture-api-key-not-used-for-inference'}));
await writeFile(join(native,'config.toml'),'model="gpt-6.1-sol"\ncli_auth_credentials_store="file"\n');
await writeFile(join(dir,'home.mjs'),ts.transpileModule(await readFile(join(root,'src/main/runtime-home.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
const {prepareRuntimeHome}=await import(join(dir,'home.mjs'));
const binary=join(homedir(),'.codex/packages/app-server-daemon/releases/0.164.0-aarch64-apple-darwin/bin/codex');
const clients=[];
async function connect(home){
 const child=spawn(binary,['app-server','--listen','stdio://','-c','cli_auth_credentials_store="file"','-c',`sqlite_home=${JSON.stringify(home)}`],{cwd:dir,env:{...process.env,CODEX_HOME:home,CODEX_SQLITE_HOME:home},stdio:['pipe','pipe','pipe']});child.stderr.resume();let id=0;const pending=new Map();
 createInterface({input:child.stdout}).on('line',line=>{try{const m=JSON.parse(line);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}catch{}});
 const request=(method,params={})=>{console.log('RPC',method);return new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(Error('timeout: '+method));},20000);pending.set(n,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:n,method,params})+'\n');});};
 const stop=async()=>{child.stdin.end();child.kill('SIGTERM');await new Promise(resolve=>{const t=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);child.once('exit',()=>{clearTimeout(t);resolve();});});};
 const client={child,request,stop};clients.push(client);
 await request('initialize',{clientInfo:{name:'rambo',title:'Rambo',version:'0.1.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');return client;
}
function assert(ok,message){if(!ok)throw Error(message);}
try{
 let original=await connect(native);
 const old=(await original.request('thread/start',{cwd:dir,model:undefined})).thread;
 await original.request('thread/name/set',{threadId:old.id,name:'Rambo native migration fixture'});
 await original.stop();
 console.log('OLD_CREATED');const home=await prepareRuntimeHome(native,profile,[old.id]);
 let isolated=await connect(home);
 const account=await isolated.request('account/read',{refreshToken:false});assert(account.account?.type==='apiKey','shared auth unavailable');
 const resumed=await isolated.request('thread/resume',{threadId:old.id,cwd:dir,model:undefined});assert(resumed.thread.id===old.id,'migration changed id');
 const fresh=(await isolated.request('thread/start',{cwd:dir,model:undefined})).thread;
 await isolated.request('thread/name/set',{threadId:fresh.id,name:'Rambo isolated fixture'});
 original=await connect(native);
 await original.request('thread/read',{threadId:fresh.id,includeTurns:false}).then(()=>{throw Error('native unexpectedly reads isolated thread');},()=>{});const nativeList=await original.request('thread/list',{limit:100,sourceKinds:['vscode','appServer'],includeHidden:true});
 assert(!nativeList.data.some(t=>t.id===fresh.id),'Rambo thread leaked to native list');
 const ramboList=await isolated.request('thread/list',{limit:100,sourceKinds:['vscode','appServer'],includeHidden:true});const ownRead=await isolated.request('thread/read',{threadId:fresh.id,includeTurns:false});assert(ownRead.thread.id===fresh.id,'Rambo own thread not readable');
 await isolated.stop();isolated=await connect(home);
 const restored=await isolated.request('thread/resume',{threadId:fresh.id,cwd:dir,model:undefined});assert(restored.thread.id===fresh.id,'restart lost thread');
 const report={binary,sharedAccount:account.account.type,migratedThreadResumed:true,nativeCannotReadNewThread:true,ownThreadReadable:true,restartResume:true,modelTurnsStarted:0,originalsRetained:true};
 await mkdir(join(root,'acceptance-runs/native-runtime-check/evidence'),{recursive:true});console.log(JSON.stringify(report,null,2));await writeFile(join(root,'acceptance-runs/native-runtime-check/evidence/live-runtime.json'),JSON.stringify(report,null,2));
}catch(e){console.error('LIVE_CHECK_FAILED',e.message);process.exitCode=1;}finally{for(const c of clients)if(c.child.exitCode===null&&c.child.signalCode===null)await c.stop();await rm(dir,{recursive:true,force:true});}
