import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createCipheriv,randomBytes,randomUUID} from 'node:crypto';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {installVerification} from '../server/verification.mjs';
import {installInquiries} from '../server/inquiries.mjs';
import {hashPassword,safeText,toCents,validEmail} from '../server/security.mjs';

let db,server,base,buyer,seller,buyerDocument;
const adminId=randomUUID(),legacyId=randomUUID(),legacyDocumentId=randomUUID();
const encryptionKey=randomBytes(32),reviewKey=randomBytes(32).toString('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const pdf=Buffer.from('%PDF-1.4\nSynthetic test document\n%%EOF');
const roles={admin:{id:adminId,role:'admin'},legacy:{id:legacyId,role:'client',account_type:'buyer'}};
const error=(status,message)=>Object.assign(Error(message),{status});
const query=async(sql,params=[])=>{const result=await db.query(sql,params);return {...result,rowCount:result.rows.length};};
const required=(value,label,max=250)=>{const text=safeText(value,max);if(!text)throw error(400,label+' is required');return text;};
const checkEmail=value=>{value=String(value||'').toLowerCase().trim();if(!validEmail(value))throw error(400,'Invalid email');return value;};
const account=(type,email=type+'@example.invalid')=>({name:'Test '+type,email,phone:'+1 555 0100',password:'Synthetic-test-password',accountType:type,consent:true});
function form({accountType='buyer',purpose='loan_and_ownership',tin='123-45-6789',processingConsent=true,ssn=false}={}){
 const body=new FormData();
 body.set('purpose',purpose);body.set('tin',tin);body.set('processingConsent',String(processingConsent));
 for(const name of ['idFront','idBack','selfie'])body.set(name,new Blob([png],{type:'image/png'}),name+'.png');
 if(purpose!=='ownership_transfer')body.set('bankStatement',new Blob([pdf],{type:'application/pdf'}),'statement.pdf');
 if(accountType==='seller')for(const name of ['titleDeed','propertyDocument'])body.set(name,new Blob([pdf],{type:'application/pdf'}),name+'.pdf');
 if(ssn){body.set('ssnCard',new Blob([png],{type:'image/png'}),'optional-card.png');body.set('ssnConsent','true');}
 return body;
}
async function request(path,{role,key,body,method='GET'}={}){
 const headers={};if(role)headers['X-Test-Role']=role;if(key)headers['X-Verification-Review-Key']=key;
 if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
 return fetch(base+path,{method,headers,body});
}
function legacyEncrypt(data){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey,iv),body=Buffer.concat([cipher.update(data),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),body]);
}
before(async()=>{
 process.env.VERIFICATION_ENCRYPTION_KEY=encryptionKey.toString('hex');process.env.VERIFICATION_REVIEW_KEY=reviewKey;
 db=new PGlite();
 const source=await readFile(new URL('../server/db.mjs',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('const statements=['),source.indexOf('\n];',source.indexOf('const statements=[')));
 const statements=Array.from(block.matchAll(/`([\s\S]*?)`/g),match=>match[1]);
 await db.exec('CREATE ROLE covalyn_app NOLOGIN; CREATE ROLE covalyn_convay_app NOLOGIN IN ROLE covalyn_app; CREATE SCHEMA covalyn AUTHORIZATION covalyn_app; SET search_path TO covalyn,pg_catalog; SET ROLE covalyn_app;');
 await db.exec(statements[0]);
 await query("INSERT INTO users(id,name,email,password_hash,role) VALUES($1,'Test administrator','admin@example.invalid',$2,'admin'),($3,'Legacy buyer','legacy@example.invalid',$2,'client')",[adminId,hashPassword('fixture-only'),legacyId]);
 await db.exec('SET ROLE covalyn_convay_app');
 // The deployed v1.2 tables have neither purpose nor the new document kinds.
 await db.exec(`CREATE TABLE buyer_verifications (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tin_encrypted bytea NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
  review_note text NOT NULL DEFAULT '',consented_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL
 );
 CREATE TABLE buyer_identity_documents (
  id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN('id_front','id_back','ssn_card','bank_statement')),
  content_type text NOT NULL,encrypted_body bytea NOT NULL,filename text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
 );
 CREATE TABLE verification_access_log (
  id uuid PRIMARY KEY,admin_user_id uuid NOT NULL REFERENCES users(id),
  document_id uuid NOT NULL REFERENCES buyer_identity_documents(id) ON DELETE CASCADE,
  accessed_at timestamptz NOT NULL DEFAULT now()
 );`);
 await query("INSERT INTO buyer_verifications(user_id,tin_encrypted,status) VALUES($1,$2,'approved')",[legacyId,legacyEncrypt(Buffer.from('987654321'))]);
 await query("INSERT INTO buyer_identity_documents(id,user_id,kind,content_type,encrypted_body,filename) VALUES($1,$2,'id_front','image/png',$3,'legacy-id.png')",[legacyDocumentId,legacyId,legacyEncrypt(png)]);
 for(let startup=0;startup<2;startup++)for(const statement of statements)await db.exec(statement);
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=roles[req.get('X-Test-Role')]||null;next();});
 const requireDb=(req,res,next)=>next();
 const loginRequired=(req,res,next)=>req.user?next():next(error(401,'Sign in required'));
 const adminRequired=(req,res,next)=>req.user?.role==='admin'?next():next(error(403,'Administrator required'));
 installVerification(app,{requireDb,loginRequired,adminRequired,hashPassword,createSession:async()=>{},checkEmail,required,limit:safeText},{query,pool:{connect:async()=>({query,release(){}})}});
 installInquiries(app,{requireDb,query,required,checkEmail,limit:safeText,money:toCents});
 app.use((err,req,res,next)=>res.status(err.code?.startsWith('LIMIT_')?400:err.status||500).json({error:err.message}));
 server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(db)await db.close();delete process.env.VERIFICATION_ENCRYPTION_KEY;delete process.env.VERIFICATION_REVIEW_KEY;});

test('startup retains older encrypted records and keeps document tables private',async()=>{
 const rows=(await query("SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='covalyn' AND (tablename LIKE 'buyer_%' OR tablename LIKE 'verification_%')")).rows;
 assert.equal(rows.length,4);assert.ok(rows.every(r=>r.rowsecurity));
 const response=await request('/api/my/processing',{role:'legacy'});assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.submission.purpose,'legacy_verification');assert.equal(data.submission.status,'approved');
 assert.match(data.submission.maskedTin,/4321$/);assert.equal(data.documents[0].id,legacyDocumentId);
 const download=await request('/api/my/processing/documents/'+legacyDocumentId,{role:'legacy'});
 assert.deepEqual(Buffer.from(await download.arrayBuffer()),png);
});
test('buyer, seller and renter signup works without TIN, documents or verification secrets',async()=>{
 delete process.env.VERIFICATION_ENCRYPTION_KEY;
 try{
  for(const type of ['buyer','seller','renter']){
   const response=await request('/api/auth/register',{method:'POST',body:account(type)});
   assert.equal(response.status,200);const result=await response.json();assert.equal(result.verificationStatus,'not_submitted');
   assert.equal(result.user.account_type,type);roles[type]=result.user;
   const processing=await request('/api/my/processing',{role:type});assert.deepEqual(await processing.json(),{available:false,submission:null,documents:[]});
  }
  buyer=roles.buyer;seller=roles.seller;
  assert.equal((await request('/api/my/processing',{role:'buyer',method:'POST',body:form()})).status,503);
 }finally{process.env.VERIFICATION_ENCRYPTION_KEY=encryptionKey.toString('hex');}
 assert.equal((await request('/api/auth/register',{method:'POST',body:account('admin','invalid@example.invalid')})).status,400);
 assert.equal((await request('/api/auth/register',{method:'POST',body:account('buyer')})).status,409);
 assert.equal((await query('SELECT count(*)::int AS n FROM buyer_verifications')).rows[0].n,1);
});
test('processing requires sign-in and validates consent, TIN, images and loan statement',async()=>{
 assert.equal((await request('/api/my/processing',{method:'POST',body:form()})).status,401);
 for(const body of [form({processingConsent:false}),form({tin:'abc'}),form({purpose:'legacy_verification'})])assert.equal((await request('/api/my/processing',{role:'buyer',method:'POST',body})).status,400);
 const missing=form();missing.delete('selfie');assert.equal((await request('/api/my/processing',{role:'buyer',method:'POST',body:missing})).status,400);
 const noBank=form();noBank.delete('bankStatement');assert.equal((await request('/api/my/processing',{role:'buyer',method:'POST',body:noBank})).status,400);
 const fakeImage=form();fakeImage.set('selfie',new Blob(['<svg/>'],{type:'image/svg+xml'}),'image.svg');assert.equal((await request('/api/my/processing',{role:'buyer',method:'POST',body:fakeImage})).status,400);
 const noConsent=form({ssn:true});noConsent.delete('ssnConsent');assert.equal((await request('/api/my/processing',{role:'buyer',method:'POST',body:noConsent})).status,400);
 assert.deepEqual((await (await request('/api/my/processing',{role:'buyer'})).json()).documents,[]);
});
test('buyer documents and TIN are encrypted and ownership-only processing does not require a bank statement',async()=>{
 const response=await request('/api/my/processing',{role:'buyer',method:'POST',body:form({purpose:'ownership_transfer'})});assert.equal(response.status,200);
 const record=await request('/api/my/processing',{role:'buyer'});assert.match(record.headers.get('cache-control'),/no-store/);
 const data=await record.json();assert.equal(data.submission.status,'pending');assert.match(data.submission.maskedTin,/6789$/);assert.ok(!JSON.stringify(data).includes('123456789'));
 assert.equal(data.documents.length,3);buyerDocument=data.documents.find(doc=>doc.kind==='selfie');
 const encrypted=(await query('SELECT encrypted_body FROM buyer_identity_documents WHERE id=$1',[buyerDocument.id])).rows[0];
 assert.ok(!Buffer.from(encrypted.encrypted_body).equals(png));
 const tin=(await query('SELECT tin_encrypted FROM buyer_verifications WHERE user_id=$1',[buyer.id])).rows[0];
 assert.ok(!Buffer.from(tin.tin_encrypted).includes(Buffer.from('123456789')));
});
test('seller must supply ownership documents and buyer cannot submit them',async()=>{
 assert.equal((await request('/api/my/processing',{role:'seller',method:'POST',body:form()})).status,400);
 assert.equal((await request('/api/my/processing',{role:'buyer',method:'POST',body:form({accountType:'seller'})})).status,400);
 const result=await request('/api/my/processing',{role:'seller',method:'POST',body:form({accountType:'seller',ssn:true})});assert.equal(result.status,200);
 const {documents}=await (await request('/api/my/processing',{role:'seller'})).json();
 assert.equal(documents.length,7);assert.ok(documents.some(doc=>doc.kind==='title_deed'));assert.ok(documents.some(doc=>doc.kind==='property_document'));
});
test('private documents are restricted to their owner or a reviewer with both credentials',async()=>{
 const own='/api/my/processing/documents/'+buyerDocument.id,review='/api/admin/verification-documents/'+buyerDocument.id;
 assert.equal((await request(own)).status,401);assert.equal((await request(own,{role:'seller'})).status,404);
 for(const role of [undefined,'buyer','seller'])assert.equal((await request(review,{role,key:reviewKey})).status,403);
 assert.equal((await request(review,{role:'admin'})).status,403);assert.equal((await request(review,{role:'admin',key:'wrong'})).status,403);
 const authorized=await request(review,{role:'admin',key:reviewKey});assert.equal(authorized.status,200);
 assert.match(authorized.headers.get('cache-control'),/no-store/);assert.deepEqual(Buffer.from(await authorized.arrayBuffer()),png);
 assert.equal((await query('SELECT count(*)::int AS n FROM verification_access_log WHERE document_id=$1',[buyerDocument.id])).rows[0].n,1);
});
test('admin review includes account type, purpose and deeds while preserving separate authorization',async()=>{
 const response=await request('/api/admin/verifications',{role:'admin',key:reviewKey});assert.equal(response.status,200);
 assert.match(response.headers.get('cache-control'),/no-store/);const users=(await response.json()).users;
 const record=users.find(user=>user.id===seller.id);assert.equal(record.account_type,'seller');assert.equal(record.purpose,'loan_and_ownership');assert.equal(record.tin,'123456789');assert.equal(record.tin_encrypted,undefined);
 const deed=record.documents.find(doc=>doc.kind==='title_deed');
 const download=await request('/api/admin/verification-documents/'+deed.id,{role:'admin',key:reviewKey});assert.equal(download.headers.get('content-disposition'),'attachment');
 assert.deepEqual(Buffer.from(await download.arrayBuffer()),pdf);
 const path='/api/admin/verifications/'+buyer.id;
 assert.equal((await request(path,{role:'admin',method:'PATCH',body:{status:'approved'}})).status,403);
 assert.equal((await request(path,{role:'admin',key:reviewKey,method:'PATCH',body:{status:'approved',note:'Reviewed in test'}})).status,200);
 const status=await (await request('/api/my/processing',{role:'buyer'})).json();assert.equal(status.submission.status,'approved');assert.equal(status.submission.reviewNote,'Reviewed in test');
});
test('replacing a file keeps the TIN and other documents and resets the review',async()=>{
 const change=new FormData();change.set('purpose','ownership_transfer');change.set('processingConsent','true');change.set('selfie',new Blob([png],{type:'image/png'}),'replacement.png');
 assert.equal((await request('/api/my/processing',{role:'buyer',method:'POST',body:change})).status,200);
 const {submission,documents}=await (await request('/api/my/processing',{role:'buyer'})).json();
 assert.equal(submission.status,'pending');assert.equal(submission.reviewNote,'');assert.match(submission.maskedTin,/6789$/);assert.equal(documents.length,3);
 assert.notEqual(documents.find(doc=>doc.kind==='selfie').id,buyerDocument.id);
 assert.equal((await request('/api/my/processing/documents/'+buyerDocument.id,{role:'buyer'})).status,404);
 assert.equal((await query('SELECT count(*)::int AS n FROM verification_access_log WHERE document_id IS NULL')).rows[0].n,1);
});
test('homeowner inquiries reach the existing inbox with the property details and consent',async()=>{
 const body={...account('seller'),kind:'selling',propertyAddress:'101 Test Street',city:'Austin',state:'TX',zipCode:'78701',askingPrice:'400000.25',timeline:'1-3-months',message:'Synthetic house details',contactConsent:true};
 assert.equal((await request('/api/inquiries',{method:'POST',role:'seller',body:{...body,contactConsent:false}})).status,400);
 assert.equal((await request('/api/inquiries',{method:'POST',role:'seller',body:{...body,state:'XX'}})).status,400);
 assert.equal((await request('/api/inquiries',{method:'POST',role:'seller',body})).status,200);
 const records=(await query("SELECT kind,user_id,message FROM inquiries WHERE kind='selling'")).rows;
 assert.equal(records.length,1);assert.equal(records[0].user_id,seller.id);
 for(const value of ['101 Test Street','Austin','78701','400000.25','Synthetic house details'])assert.ok(records[0].message.includes(value));
});

test('renters submit encrypted ID and income proof without a tax number',async()=>{
 const payload=new FormData();
 payload.set('purpose','rental_application');
 payload.set('processingConsent','true');
 for(const name of ['idFront','idBack'])payload.set(name,new Blob([png],{type:'image/png'}),name+'.png');
 payload.set('proofOfIncome',new Blob([pdf],{type:'application/pdf'}),'income.pdf');
 assert.equal((await request('/api/my/processing',{role:'buyer',method:'POST',body:payload})).status,400);
 payload.set('tin','123456789');
 assert.equal((await request('/api/my/processing',{role:'renter',method:'POST',body:payload})).status,400);
 payload.delete('tin');
 assert.equal((await request('/api/my/processing',{role:'renter',method:'POST',body:payload})).status,200);
 const own=await (await request('/api/my/processing',{role:'renter'})).json();
 assert.equal(own.submission.purpose,'rental_application');
 assert.equal(own.submission.maskedTin,null);
 assert.equal(own.documents.length,3);
 const income=own.documents.find(doc=>doc.kind==='proof_of_income');
 assert.equal((await request('/api/my/processing/documents/'+income.id,{role:'buyer'})).status,404);
 const encrypted=(await query('SELECT encrypted_body FROM buyer_identity_documents WHERE id=$1',[income.id])).rows[0].encrypted_body;
 assert.notDeepEqual(Buffer.from(encrypted),pdf);
 const admin=await (await request('/api/admin/verifications',{role:'admin',key:reviewKey})).json();
 const record=admin.users.find(user=>user.id===roles.renter.id);
 assert.equal(record.account_type,'renter');
 assert.equal(record.purpose,'rental_application');
 assert.equal(record.tin,null);
 const file=await request('/api/admin/verification-documents/'+income.id,{role:'admin',key:reviewKey});
 assert.equal(file.status,200);
 assert.deepEqual(Buffer.from(await file.arrayBuffer()),pdf);
});
test('rental inquiries reach the inbox and require an available rental',async()=>{
 const rent=randomUUID(),sale=randomUUID();
 await query("INSERT INTO properties(id,title,city,state,price_cents,listing_mode) VALUES($1,'Rental fixture','Austin','TX',185050,'rent')",[rent]);
 await query("INSERT INTO properties(id,title,city,state,price_cents) VALUES($1,'Sale fixture','Austin','TX',32500000)",[sale]);
 const body={name:'Fixture Renter',email:'renter@example.invalid',kind:'rental',message:'Is the house available?',propertyId:sale};
 assert.equal((await request('/api/inquiries',{role:'renter',method:'POST',body})).status,404);
 body.propertyId=rent;
 assert.equal((await request('/api/inquiries',{role:'renter',method:'POST',body})).status,200);
 const item=(await query('SELECT kind,property_id,user_id FROM inquiries WHERE property_id=$1',[rent])).rows[0];
 assert.deepEqual(item,{kind:'rental',property_id:rent,user_id:roles.renter.id});
 await query("UPDATE properties SET status='sold' WHERE id=$1",[rent]);
 assert.equal((await request('/api/inquiries',{role:'renter',method:'POST',body})).status,404);
});
