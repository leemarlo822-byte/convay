import {createCipheriv,createDecipheriv,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import {newId,validUuid} from './security.mjs';
import {pool as defaultPool,query as defaultQuery} from './db.mjs';

const failure=(status,message)=>Object.assign(new Error(message),{status});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const consent=value=>value===true||value==='true';
const purposes=['loan_processing','ownership_transfer','loan_and_ownership'];
const fields={idFront:'id_front',idBack:'id_back',ssnCard:'ssn_card',bankStatement:'bank_statement',selfie:'selfie',titleDeed:'title_deed',propertyDocument:'property_document',proofOfIncome:'proof_of_income'};
const available=()=>/^[a-f0-9]{64}$/i.test(process.env.VERIFICATION_ENCRYPTION_KEY||'')&&(process.env.VERIFICATION_REVIEW_KEY||'').length>=32;
const key=()=>{
 const value=process.env.VERIFICATION_ENCRYPTION_KEY;
 if(!/^[a-f0-9]{64}$/i.test(value||''))throw failure(503,'Document processing is temporarily unavailable. Please try again later.');
 return Buffer.from(value,'hex');
};
function encrypt(data){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv),body=Buffer.concat([cipher.update(data),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),body]);
}
function decrypt(data){
 const body=Buffer.from(data),cipher=createDecipheriv('aes-256-gcm',key(),body.subarray(0,12));
 cipher.setAuthTag(body.subarray(12,28));return Buffer.concat([cipher.update(body.subarray(28)),cipher.final()]);
}
function mime(file,pdf=false){
 const b=file.buffer;
 const jpeg=b.length>3&&b[0]===255&&b[1]===216&&b[2]===255;
 const png=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const webp=b.length>12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
 const isPdf=pdf&&b.length>5&&b.toString('ascii',0,5)==='%PDF-';
 const value=jpeg?'image/jpeg':png?'image/png':webp?'image/webp':isPdf?'application/pdf':null;
 if(!value)throw failure(400,'Use JPEG, PNG or WebP images. Statements and property documents may also be PDF files.');return value;
}
function sendDocument(res,row){
 res.set({'Content-Type':row.content_type,'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff',
  'Content-Disposition':row.content_type==='application/pdf'?'attachment':'inline','Content-Security-Policy':"sandbox; default-src 'none'"}).send(decrypt(row.encrypted_body));
}
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:4*1024*1024,files:7,fields:12,fieldSize:2048,parts:19}})
 .fields(Object.keys(fields).map(name=>({name,maxCount:1})));

export function installVerification(app,{requireDb,loginRequired,adminRequired,hashPassword,createSession,checkEmail,required,limit},dependencies={}){
 const pool=dependencies.pool||defaultPool,query=dependencies.query||defaultQuery;
 const reviewLimiter=rateLimit({windowMs:15*60*1000,limit:20,skipSuccessfulRequests:true,standardHeaders:'draft-7',legacyHeaders:false});
 const processingLimiter=rateLimit({windowMs:15*60*1000,limit:30,standardHeaders:'draft-7',legacyHeaders:false});
 function clientRequired(req,res,next){if(req.user?.role!=='client')return next(failure(403,'Please use your client account.'));next();}
 function processingReady(req,res,next){if(!available())return next(failure(503,'Document processing is temporarily unavailable. Please try again later.'));next();}
 function reviewAccess(req,res,next){
  res.set('Cache-Control','private,no-store');
  const expected=process.env.VERIFICATION_REVIEW_KEY||'',received=req.get('X-Verification-Review-Key')||'';
  if(expected.length<32)return next(failure(503,'Private document review is temporarily unavailable.'));
  const digest=value=>createHash('sha256').update(value).digest();
  if(received.length>512||!timingSafeEqual(digest(expected),digest(received)))return next(failure(403,'Enter your document review secret phrase to unlock private files.'));
  next();
 }

 // Creating an account never collects tax numbers, financial records or identity images.
 app.post('/api/auth/register',requireDb,wrap(async(req,res)=>{
  const b=req.body||{},name=required(b.name,'Full name',90),email=checkEmail(b.email),phone=limit(b.phone,35),pass=String(b.password||''),accountType=String(b.accountType||'');
  if(!['buyer','seller','renter'].includes(accountType))throw failure(400,'Choose whether you want to buy, sell, or rent.');
  if(pass.length<8||pass.length>200)throw failure(400,'Password must be 8 to 200 characters.');
  if(!consent(b.consent))throw failure(400,'Please confirm the account contact agreement.');
  const id=newId();
  try{await query('INSERT INTO users(id,name,email,phone,password_hash,account_type) VALUES($1,$2,$3,$4,$5,$6)',[id,name,email,phone,hashPassword(pass),accountType]);}
  catch(error){if(error.code==='23505')throw failure(409,'Email already registered. Please sign in.');throw error;}
  await createSession(res,{id});res.json({user:{id,name,email,phone,role:'client',account_type:accountType},verificationStatus:'not_submitted'});
 }));

 app.get('/api/my/processing',requireDb,loginRequired,clientRequired,wrap(async(req,res)=>{
  const row=(await query('SELECT status,purpose,tin_encrypted,review_note,consented_at,reviewed_at FROM buyer_verifications WHERE user_id=$1',[req.user.id])).rows[0];
  const documents=(await query('SELECT id,kind,filename,content_type,created_at FROM buyer_identity_documents WHERE user_id=$1 ORDER BY created_at',[req.user.id])).rows;
  const maskedTin=row?.tin_encrypted&&available()?'••• •• '+decrypt(row.tin_encrypted).toString('utf8').slice(-4):null;
  res.set('Cache-Control','private,no-store').json({available:available(),submission:row?{
   status:row.status,purpose:row.purpose,reviewNote:row.review_note,consentedAt:row.consented_at,reviewedAt:row.reviewed_at,maskedTin
  }:null,documents});
 }));

 app.post('/api/my/processing',requireDb,loginRequired,clientRequired,processingLimiter,processingReady,upload,wrap(async(req,res)=>{
  res.set('Cache-Control','private,no-store');
  const b=req.body||{},purpose=String(b.purpose||''),tin=limit(b.tin,45).replace(/[ -]/g,'');
  if(purpose!=='rental_application'&&!purposes.includes(purpose))throw failure(400,'Choose a valid document review purpose.');
  if(!consent(b.processingConsent))throw failure(400,'Please consent to document review for the selected purpose.');
  if(tin&&!/^\d{9}$/.test(tin))throw failure(400,'Enter a 9-digit TIN. Spaces and hyphens are allowed.');
  const documents=Object.entries(fields).flatMap(([field,kind])=>{
   const file=req.files?.[field]?.[0];return file?[{kind,type:mime(file,['bank_statement','title_deed','property_document','proof_of_income'].includes(kind)),body:encrypt(file.buffer),filename:limit(file.originalname,150)}]:[];
  });
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   // Serialize initial submissions and replacements for the same account.
   const account=(await client.query('SELECT id,account_type FROM users WHERE id=$1 FOR UPDATE',[req.user.id])).rows[0];
   if(!account)throw failure(401,'Please sign in again.');
   const renting=account.account_type==='renter';
   if(renting!==(purpose==='rental_application'))throw failure(400,'Choose the document purpose for your account type.');
   if(renting&&(tin||documents.some(doc=>!['id_front','id_back','proof_of_income'].includes(doc.kind))))throw failure(400,'Submit only your ID and optional proof of income for rental review.');
   if(!renting&&documents.some(doc=>doc.kind==='proof_of_income'))throw failure(400,'Proof of income is available in renter accounts.');
   if(account.account_type!=='seller'&&documents.some(doc=>['title_deed','property_document'].includes(doc.kind)))throw failure(400,'Property document uploads are available in seller accounts.');
   const existing=(await client.query('SELECT tin_encrypted FROM buyer_verifications WHERE user_id=$1',[req.user.id])).rows[0];
   const old=(await client.query('SELECT kind FROM buyer_identity_documents WHERE user_id=$1',[req.user.id])).rows;
   const kinds=new Set([...old.map(d=>d.kind),...documents.map(d=>d.kind)]);
   if(!renting&&!tin&&!existing?.tin_encrypted)throw failure(400,'Enter your 9-digit TIN.');
   if(!['id_front','id_back'].every(kind=>kinds.has(kind)))throw failure(400,'Upload the front and back of your ID.');
   if(!renting&&!kinds.has('selfie'))throw failure(400,'Upload a selfie.');
   if(account.account_type==='seller'&&!['title_deed','property_document'].every(kind=>kinds.has(kind)))throw failure(400,'Upload your title deed and a supporting property document for ownership review.');
   if(!renting&&purpose!=='ownership_transfer'&&!kinds.has('bank_statement'))throw failure(400,'A bank statement is required for loan processing.');
   if(kinds.has('ssn_card')&&!consent(b.ssnConsent))throw failure(400,'Please give separate consent to review your SSN card.');
   await client.query(`INSERT INTO buyer_verifications(user_id,tin_encrypted,purpose) VALUES($1,$2,$3)
    ON CONFLICT(user_id) DO UPDATE SET tin_encrypted=EXCLUDED.tin_encrypted,purpose=EXCLUDED.purpose,status='pending',review_note='',consented_at=now(),reviewed_at=NULL,reviewed_by=NULL`,
    [req.user.id,renting?null:tin?encrypt(Buffer.from(tin)):existing.tin_encrypted,purpose]);
   for(const doc of documents){
    await client.query('DELETE FROM buyer_identity_documents WHERE user_id=$1 AND kind=$2',[req.user.id,doc.kind]);
    await client.query('INSERT INTO buyer_identity_documents(id,user_id,kind,content_type,encrypted_body,filename) VALUES($1,$2,$3,$4,$5,$6)',[newId(),req.user.id,doc.kind,doc.type,doc.body,doc.filename]);
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  res.json({ok:true,status:'pending'});
 }));

 app.get('/api/my/processing/documents/:id',requireDb,loginRequired,clientRequired,wrap(async(req,res)=>{
  if(!validUuid(req.params.id))throw failure(400,'Invalid document.');
  const row=(await query('SELECT content_type,encrypted_body FROM buyer_identity_documents WHERE id=$1 AND user_id=$2',[req.params.id,req.user.id])).rows[0];
  if(!row)throw failure(404,'Document not found.');sendDocument(res,row);
 }));

 app.get('/api/admin/verifications',requireDb,adminRequired,reviewLimiter,reviewAccess,wrap(async(req,res)=>{
  const rows=(await query("SELECT u.id,u.name,u.email,u.phone,u.account_type,u.created_at,v.status,v.purpose,v.tin_encrypted,v.review_note,v.consented_at,v.reviewed_at FROM users u LEFT JOIN buyer_verifications v ON u.id=v.user_id WHERE u.role='client' ORDER BY u.created_at DESC LIMIT 300")).rows;
  const users=await Promise.all(rows.map(async row=>({...row,status:row.status||'not_submitted',tin:row.tin_encrypted?decrypt(row.tin_encrypted).toString('utf8'):null,tin_encrypted:undefined,
   documents:(await query('SELECT id,kind,filename,content_type,created_at FROM buyer_identity_documents WHERE user_id=$1',[row.id])).rows})));
  await query('INSERT INTO verification_review_log(id,admin_user_id,action) VALUES($1,$2,$3)',[newId(),req.user.id,'list']);
  res.set('Cache-Control','private,no-store').json({users});
 }));
 app.get('/api/admin/verification-documents/:id',requireDb,adminRequired,reviewLimiter,reviewAccess,wrap(async(req,res)=>{
  if(!validUuid(req.params.id))throw failure(400,'Invalid document.');
  const row=(await query('SELECT content_type,encrypted_body FROM buyer_identity_documents WHERE id=$1',[req.params.id])).rows[0];
  if(!row)throw failure(404,'Document not found.');
  await query('INSERT INTO verification_access_log(id,admin_user_id,document_id) VALUES($1,$2,$3)',[newId(),req.user.id,req.params.id]);sendDocument(res,row);
 }));
 app.patch('/api/admin/verifications/:id',requireDb,adminRequired,reviewLimiter,reviewAccess,wrap(async(req,res)=>{
  const status=String(req.body.status||''),note=limit(req.body.note,500);
  if(!validUuid(req.params.id))throw failure(400,'Invalid account.');
  if(!['pending','approved','rejected'].includes(status))throw failure(400,'Invalid review status.');
  const result=await query('UPDATE buyer_verifications SET status=$2,review_note=$3,reviewed_by=$4,reviewed_at=now() WHERE user_id=$1 RETURNING user_id',[req.params.id,status,note,req.user.id]);
  if(!result.rowCount)throw failure(404,'No documents have been submitted for this account.');
  await query('INSERT INTO verification_review_log(id,admin_user_id,subject_user_id,action) VALUES($1,$2,$3,$4)',[newId(),req.user.id,req.params.id,'status_update']);res.json({ok:true});
 }));
}
