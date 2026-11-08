import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {installVerification} from '../server/verification.mjs';
import {hashPassword,safeText,validEmail} from '../server/security.mjs';

let db,server,base,registered,document;
const adminId=randomUUID(),buyerId=randomUUID();
const reviewKey=randomBytes(32).toString('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const roles={admin:{id:adminId,role:'admin'},buyer:{id:buyerId,role:'client'}};
const error=(status,message)=>Object.assign(Error(message),{status});
const query=async(sql,params=[])=>{const r=await db.query(sql,params);return {...r,rowCount:r.rows.length};};
function form(email='verification@example.invalid',changes={}){
 const f=new FormData();
 for(const [k,v] of Object.entries({name:'Verification Test',email,phone:'+1 555 0100',password:'Synthetic-test-password',tin:'123-45-6789',consent:'true',verificationConsent:'true',ssnConsent:'true',...changes}))f.set(k,v);
 for(const field of ['idFront','idBack','ssnCard'])f.set(field,new Blob([png],{type:'image/png'}),field+'.png');
 f.set('bankStatement',new Blob(['%PDF-1.4\nSynthetic test statement\n%%EOF'],{type:'application/pdf'}),'statement.pdf');
 return f;
}
async function request(path,{role,key,body,method='GET'}={}){
 const headers={};if(role)headers['X-Test-Role']=role;if(key)headers['X-Verification-Review-Key']=key;
 if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
 const response=await fetch(base+path,{method,headers,body});
 return response;
}
before(async()=>{
 process.env.VERIFICATION_ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.VERIFICATION_REVIEW_KEY=reviewKey;
 db=new PGlite();
 const source=await readFile(new URL('../server/db.mjs',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('const statements=['),source.indexOf('\n];',source.indexOf('const statements=[')));
 for(const match of block.matchAll(/`([\s\S]*?)`/g))await db.exec(match[1]);
 await query("INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'Test administrator','admin@example.invalid',$2,'admin'),($3,'Test buyer','buyer@example.invalid',$2,'client')",[adminId,hashPassword('fixture-only'),buyerId]);
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=roles[req.get('X-Test-Role')]||null;next();});
 const requireDb=(req,res,next)=>next();
 const loginRequired=(req,res,next)=>req.user?next():next(error(401,'Sign in required'));
 const adminRequired=(req,res,next)=>req.user?.role==='admin'?next():next(error(403,'Administrator required'));
 const required=(v,label,max=250)=>{const value=safeText(v,max);if(!value)throw error(400,label+' required');return value;};
 const checkEmail=value=>{value=String(value||'').toLowerCase().trim();if(!validEmail(value))throw error(400,'Invalid email');return value;};
 installVerification(app,{requireDb,loginRequired,adminRequired,hashPassword,createSession:async()=>{},checkEmail,required,limit:safeText},{query,pool:{connect:async()=>({query,release(){}})}});
 app.use((err,req,res,next)=>res.status(err.code==='LIMIT_FILE_SIZE'?400:err.status||500).json({error:err.message}));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();delete process.env.VERIFICATION_ENCRYPTION_KEY;delete process.env.VERIFICATION_REVIEW_KEY;});

test('verification tables have row security enabled',async()=>{
 const rows=(await query("SELECT tablename,rowsecurity FROM pg_tables WHERE tablename LIKE 'buyer_%' OR tablename LIKE 'verification_%'")).rows;
 assert.equal(rows.length,4);assert.ok(rows.every(r=>r.rowsecurity));
});
test('multipart registration encrypts TIN and all four documents in PostgreSQL',async()=>{
 const response=await request('/api/auth/register',{method:'POST',body:form()});assert.equal(response.status,200);
 registered=await response.json();assert.equal(registered.verificationStatus,'pending');assert.equal(registered.user.email,'verification@example.invalid');
 const data=(await query('SELECT tin_encrypted FROM buyer_verifications WHERE user_id=$1',[registered.user.id])).rows[0];
 assert.ok(!Buffer.from(data.tin_encrypted).includes(Buffer.from('123456789')));
 const docs=(await query('SELECT * FROM buyer_identity_documents WHERE user_id=$1',[registered.user.id])).rows;assert.equal(docs.length,4);
 document=docs.find(d=>d.kind==='id_front');assert.ok(!Buffer.from(document.encrypted_body).equals(png));
});
test('anonymous visitors and ordinary buyers cannot access verification data',async()=>{
 for(const role of [undefined,'buyer']){
  assert.equal((await request('/api/admin/verifications',{role,key:reviewKey})).status,403);
  assert.equal((await request('/api/admin/verification-documents/'+document.id,{role,key:reviewKey})).status,403);
 }
});
test('administrator session alone cannot unlock TINs or files',async()=>{
 assert.equal((await request('/api/admin/verifications',{role:'admin'})).status,403);
 assert.equal((await request('/api/admin/verification-documents/'+document.id,{role:'admin',key:'wrong-key'})).status,403);
});
test('separate review key reveals encrypted values, with no-store and access auditing',async()=>{
 const response=await request('/api/admin/verifications',{role:'admin',key:reviewKey});assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
 const buyer=(await response.json()).users.find(u=>u.id===registered.user.id);assert.equal(buyer.tin,'123456789');assert.equal(buyer.documents.length,4);assert.equal(buyer.tin_encrypted,undefined);
 const image=await request('/api/admin/verification-documents/'+document.id,{role:'admin',key:reviewKey});assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
 assert.match(image.headers.get('cache-control'),/no-store/);
 assert.equal((await query('SELECT count(*)::int AS n FROM verification_access_log')).rows[0].n,1);
 assert.equal((await query('SELECT count(*)::int AS n FROM verification_review_log')).rows[0].n,1);
 const pdf=buyer.documents.find(d=>d.kind==='bank_statement');const download=await request('/api/admin/verification-documents/'+pdf.id,{role:'admin',key:reviewKey});assert.equal(download.headers.get('content-disposition'),'attachment');
});
test('review updates need the review key and validate identifiers and decisions',async()=>{
 const path='/api/admin/verifications/'+registered.user.id;
 assert.equal((await request(path,{role:'admin',method:'PATCH',body:{status:'approved'}})).status,403);
 assert.equal((await request(path,{role:'admin',key:reviewKey,method:'PATCH',body:{status:'approved',note:'Synthetic review'}})).status,200);
 assert.equal((await query('SELECT status FROM buyer_verifications WHERE user_id=$1',[registered.user.id])).rows[0].status,'approved');
 assert.equal((await request('/api/admin/verifications/not-an-id',{role:'admin',key:reviewKey,method:'PATCH',body:{status:'approved'}})).status,400);
});
test('invalid and duplicate submissions leave no partial users or files',async()=>{
 assert.equal((await request('/api/auth/register',{method:'POST',body:form('consent@example.invalid',{ssnConsent:'false'})})).status,400);
 assert.equal((await request('/api/auth/register',{method:'POST',body:form('tin@example.invalid',{tin:'abc'})})).status,400);
 const bad=form('format@example.invalid');bad.set('idFront',new Blob(['<svg/>'],{type:'image/svg+xml'}),'image.svg');assert.equal((await request('/api/auth/register',{method:'POST',body:bad})).status,400);
 assert.equal((await request('/api/auth/register',{method:'POST',body:form()})).status,409);
 assert.equal((await query('SELECT count(*)::int AS n FROM buyer_identity_documents')).rows[0].n,4);
 assert.equal((await query("SELECT count(*)::int AS n FROM users WHERE email IN('consent@example.invalid','tin@example.invalid','format@example.invalid')")).rows[0].n,0);
});
test('missing encryption configuration refuses collection before saving data',async()=>{
 const saved=process.env.VERIFICATION_ENCRYPTION_KEY;delete process.env.VERIFICATION_ENCRYPTION_KEY;
 try{assert.equal((await request('/api/auth/register',{method:'POST',body:form('disabled@example.invalid')})).status,503);}finally{process.env.VERIFICATION_ENCRYPTION_KEY=saved;}
 assert.equal((await query("SELECT count(*)::int AS n FROM users WHERE email='disabled@example.invalid'")).rows[0].n,0);
});
