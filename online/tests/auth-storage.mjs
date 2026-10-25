import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {RecordStore,APIError} from '../outputs/test-core.mjs';
import {context,encrypt,decrypt,publicSettings,settingsRoute} from '../outputs/test-auth.mjs';
function database() {
 const db=new DatabaseSync(':memory:');
 for(const file of readdirSync('drizzle').filter(n=>n.endsWith('.sql'))) db.exec(readFileSync('drizzle/'+file,'utf8'));
 return {prepare(sql) {
   const stmt=db.prepare(sql);
   return {bind(...args) {
     return {
       async first(){return stmt.get(...args)||null;},
       async all(){return {results:stmt.all(...args)};},
       async run(){const r=stmt.run(...args);return {meta:{changes:Number(r.changes)}};}
     };
   }};
 }};
}
const secret='a'.repeat(64);
test('unauthenticated callers cannot read cloud records',async()=>{await assert.rejects(context(new Request('https://test.test/api/workspace'),{DB:database(),VAULT_SECRET:secret},()=>{}),{status:401});});
test('ciphertext is account bound and does not reveal API key',async()=>{const encrypted=await encrypt({textApiKey:'visitor-private-key'},secret,'owner-a');assert.ok(!encrypted.includes('visitor-private-key'));assert.equal((await decrypt(encrypted,secret,'owner-a')).textApiKey,'visitor-private-key');await assert.rejects(decrypt(encrypted,secret,'owner-b'));});
test('records, request ids and writes are isolated by account',async()=>{const db=database(),a=new RecordStore(db,'a'),b=new RecordStore(db,'b');await a.create('run',{id:'run',requestId:'same',body:'private'});assert.equal(await b.get('run','run'),null);assert.equal(await b.byRequest('run','same'),null);assert.equal((await b.create('run',{id:'run',requestId:'same',body:'different'})).body,'different');assert.equal((await a.get('run','run')).body,'private');});
test('concurrent identical requests insert only once',async()=>{const a=new RecordStore(database(),'a');const results=await Promise.all([a.create('media',{id:'one',requestId:'same'}),a.create('media',{id:'two',requestId:'same'})]);assert.equal(results.filter(Boolean).length,1);});
test('CAS prevents a stale tab overwriting newer content',async()=>{const a=new RecordStore(database(),'a');const old=await a.put('workspace',{id:'current',state:'one'},0);await a.put('workspace',{id:'current',state:'two'},old.revision);await assert.rejects(a.put('workspace',{id:'current',state:'stale'},old.revision),{status:409});assert.equal((await a.get('workspace','current')).state,'two');});
test('mutating calls require correct same-origin CSRF',async()=>{const env={DB:database(),VAULT_SECRET:secret};const headers={'oai-authenticated-user-id':'a','oai-authenticated-user-email':'a@example.test'};const ctx=await context(new Request('https://test.test/api/health',{headers}),env,()=>{});for(const values of [{},{'X-Studio-Token':ctx.csrfToken,Origin:'https://evil.test'}])await assert.rejects(context(new Request('https://test.test/api/cloud/settings',{method:'POST',headers:{...headers,...values}}),env,()=>{}),{status:403});assert.ok(await context(new Request('https://test.test/api/cloud/settings',{method:'POST',headers:{...headers,'X-Studio-Token':ctx.csrfToken,Origin:'https://test.test'}}),env,()=>{}));});
test('saved BYOK credentials are encrypted and public response omits them',async()=>{const env={DB:database(),VAULT_SECRET:secret};const ctx=await context(new Request('https://test.test/api/health',{headers:{'oai-authenticated-user-id':'a','oai-authenticated-user-email':'a@example.test'}}),env,()=>{});const response=await settingsRoute(ctx,'/api/cloud/settings','POST',{textProvider:'deepseek',textModel:'deepseek-chat',textApiKey:'private-credential-12345'});const data=await response.json();assert.equal(data.configured.text,true);assert.ok(!JSON.stringify(data).includes('private-credential'));const row=await env.DB.prepare('SELECT ciphertext FROM settings WHERE owner=?').bind('a').first();assert.ok(!row.ciphertext.includes('private-credential'));await settingsRoute(ctx,'/api/cloud/settings','POST',{clearTextKey:true});assert.equal(publicSettings(ctx.settings).configured.text,false);});
test('setting cannot change provider endpoint or accept malformed secrets',async()=>{const ctx={settings:{},env:{DB:database(),VAULT_SECRET:secret},user:{id:'a'}};await assert.rejects(settingsRoute(ctx,'/api/cloud/settings','POST',{endpoint:'http://localhost'}));await assert.rejects(settingsRoute(ctx,'/api/cloud/settings','POST',{textProvider:'private-host'}));await assert.rejects(settingsRoute(ctx,'/api/cloud/settings','POST',{textApiKey:'key\nline'}));});

test('changing text provider never forwards the previous providers key',async()=>{const ctx={settings:{textProvider:'deepseek',textModel:'deepseek-chat',textApiKey:'old-provider-private-key'},env:{DB:database(),VAULT_SECRET:secret},user:{id:'a'}};await settingsRoute(ctx,'/api/cloud/settings','POST',{textProvider:'qwen'});assert.equal(ctx.settings.textApiKey,undefined);assert.equal(ctx.settings.textModel,'qwen-plus');});
