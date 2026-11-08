import {createCipheriv,createDecipheriv,randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import {newId} from './security.mjs';
import {pool as defaultPool,query as defaultQuery} from './db.mjs';

const failure=(status,message)=>Object.assign(new Error(message),{status});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const key=()=>{const v=process.env.VERIFICATION_ENCRYPTION_KEY;if(!/^[a-f0-9]{64}$/i.test(v||''))throw failure(503,'Document verification is temporarily unavailable. Please contact the team.');return Buffer.from(v,'hex');};
function encrypt(data){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(),iv),body=Buffer.concat([c.update(data),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);}
function decrypt(data){const b=Buffer.from(data),c=createDecipheriv('aes-256-gcm',key(),b.subarray(0,12));c.setAuthTag(b.subarray(12,28));return Buffer.concat([c.update(b.subarray(28)),c.final()]);}
function mime(file,pdf=false){if(!file?.buffer)throw failure(400,'A required document is missing.');const b=file.buffer;
const jpeg=b.length>3&&b[0]===255&&b[1]===216&&b[2]===255;
const png=b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
const webp=b.length>12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
const isPdf=pdf&&b.length>5&&b.toString('ascii',0,5)==='%PDF-';
const value=jpeg?'image/jpeg':png?'image/png':webp?'image/webp':isPdf?'application/pdf':null;
if(!value)throw failure(400,'Unsupported document format. Use JPEG, PNG, WebP or PDF for statements.');return value;}
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:4*1024*1024,files:4,fields:20,fieldSize:32768,parts:24}}).fields([{name:'idFront',maxCount:1},{name:'idBack',maxCount:1},{name:'ssnCard',maxCount:1},{name:'bankStatement',maxCount:1}]);
export function installVerification(app,{requireDb,loginRequired,adminRequired,hashPassword,createSession,checkEmail,required,limit},dependencies={}){
const pool=dependencies.pool||defaultPool,query=dependencies.query||defaultQuery;
const reviewLimiter=rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:'draft-7',legacyHeaders:false});
function reviewAccess(req,res,next){
 res.set('Cache-Control','private,no-store');
 const expected=process.env.VERIFICATION_REVIEW_KEY||'',received=req.get('X-Verification-Review-Key')||'';
 if(expected.length<32)return next(failure(503,'Private document review is not configured.'));
 const digest=value=>createHash('sha256').update(value).digest();
 if(received.length>512||!timingSafeEqual(digest(expected),digest(received)))return next(failure(403,'Enter the separate verification review key to unlock documents.'));
 next();
}
function registrationReady(req,res,next){try{key();if((process.env.VERIFICATION_REVIEW_KEY||'').length<32)throw failure(503,'Private verification is not configured. Please contact the team.');next();}catch(e){next(e);}}
app.post('/api/auth/register',requireDb,registrationReady,upload,wrap(async(req,res)=>{
const b=req.body,name=required(b.name,'Full name',90),email=checkEmail(b.email),phone=limit(b.phone,35),pass=String(b.password||''),tin=limit(b.tin,45).replace(/[ -]/g,'');
if(pass.length<8||pass.length>200)throw failure(400,'Password must be 8 to 200 characters.');
if(b.consent!=='true'||b.verificationConsent!=='true')throw failure(400,'Registration and document consent is required.');
if(!/^\d{9}$/.test(tin))throw failure(400,'Enter a valid TIN.');
if(!req.files?.idFront?.[0]||!req.files?.idBack?.[0]||!req.files?.bankStatement?.[0])throw failure(400,'Both ID images and a bank statement are required.');
if(req.files?.ssnCard?.length&&b.ssnConsent!=='true')throw failure(400,'Separate SSN card consent is required.');
key();const id=newId(),docs=[['id_front',req.files.idFront[0]],['id_back',req.files.idBack[0]],['ssn_card',req.files?.ssnCard?.[0]],['bank_statement',req.files.bankStatement[0]]].filter(x=>x[1]).map(([kind,file])=>({kind,type:mime(file,kind==='bank_statement'),body:encrypt(file.buffer),filename:limit(file.originalname,150)}));
const client=await pool.connect();try{await client.query('BEGIN');
await client.query('INSERT INTO users(id,name,email,phone,password_hash) VALUES($1,$2,$3,$4,$5)',[id,name,email,phone,hashPassword(pass)]);
await client.query('INSERT INTO buyer_verifications(user_id,tin_encrypted) VALUES($1,$2)',[id,encrypt(Buffer.from(tin))]);
for(const d of docs)await client.query('INSERT INTO buyer_identity_documents(id,user_id,kind,content_type,encrypted_body,filename) VALUES($1,$2,$3,$4,$5,$6)',[newId(),id,d.kind,d.type,d.body,d.filename]);
await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');if(e.code==='23505')throw failure(409,'Email already registered.');throw e;}finally{client.release();}
await createSession(res,{id});res.json({user:{id,name,email,phone,role:'client'},verificationStatus:'pending'});
}));
app.get('/api/admin/verifications',requireDb,adminRequired,reviewLimiter,reviewAccess,wrap(async(req,res)=>{
const rows=(await query("SELECT u.id,u.name,u.email,u.phone,u.created_at,v.status,v.tin_encrypted,v.review_note,v.consented_at,v.reviewed_at FROM users u LEFT JOIN buyer_verifications v ON u.id=v.user_id WHERE u.role='client' ORDER BY u.created_at DESC LIMIT 300")).rows;
const users=await Promise.all(rows.map(async x=>({...x,tin:x.tin_encrypted?decrypt(x.tin_encrypted).toString('utf8'):null,tin_encrypted:undefined,documents:(await query('SELECT id,kind,filename,content_type,created_at FROM buyer_identity_documents WHERE user_id=$1',[x.id])).rows})));await query('INSERT INTO verification_review_log(id,admin_user_id,action) VALUES($1,$2,$3)',[newId(),req.user.id,'list']);res.set('Cache-Control','private,no-store').json({users});
}));
app.get('/api/admin/verification-documents/:id',requireDb,adminRequired,reviewLimiter,reviewAccess,wrap(async(req,res)=>{
const id=String(req.params.id);if(!/^[0-9a-f-]{36}$/i.test(id))throw failure(400,'Invalid document ID.');const r=await query('SELECT content_type,encrypted_body FROM buyer_identity_documents WHERE id=$1',[id]);if(!r.rowCount)throw failure(404,'Document not found.');
await query('INSERT INTO verification_access_log(id,admin_user_id,document_id) VALUES($1,$2,$3)',[newId(),req.user.id,id]);
res.set({'Content-Type':r.rows[0].content_type,'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff','Content-Disposition':r.rows[0].content_type==='application/pdf'?'attachment':'inline','Content-Security-Policy':"sandbox; default-src 'none'"}).send(decrypt(r.rows[0].encrypted_body));
}));
app.patch('/api/admin/verifications/:id',requireDb,adminRequired,reviewLimiter,reviewAccess,wrap(async(req,res)=>{
const status=String(req.body.status||''),note=limit(req.body.note,500);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id))throw failure(400,'Invalid buyer ID.');if(!['pending','approved','rejected'].includes(status))throw failure(400,'Invalid status.');
const result=await query('UPDATE buyer_verifications SET status=$2,review_note=$3,reviewed_by=$4,reviewed_at=now() WHERE user_id=$1 RETURNING user_id',[req.params.id,status,note,req.user.id]);if(!result.rowCount)throw failure(404,'Verification not found.');await query('INSERT INTO verification_review_log(id,admin_user_id,subject_user_id,action) VALUES($1,$2,$3,$4)',[newId(),req.user.id,req.params.id,'status_update']);res.json({ok:true});
}));
}
