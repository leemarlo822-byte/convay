import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {base32,matchingTotp} from './totp.mjs';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import {query,enabled} from './db.mjs';
import {newId,sha256,validUuid,verifyPassword,validEmail,safeText,toCents} from './security.mjs';

const fail=(status,message)=>Object.assign(Error(message),{status});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const required=(x,n,max=350)=>{const v=safeText(x,max);if(!v)throw fail(400,`${n} is required.`);return v;};
const uuid=x=>{if(!validUuid(x))throw fail(400,'Invalid identifier.');return x;};
const yes=v=>v===true||v==='true';
const validDate=v=>!v?null:/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T12:00:00Z'))?v:(()=>{throw fail(400,'Use an ISO date, YYYY-MM-DD.');})();
const getRows=(sql,params=[])=>query(sql,params).then(r=>r.rows);
const roles=['buyer','seller','admin','title_company'];
const fields=['title_deed','seller_identity','ownership_records','address','encumbrances','listing_details'];
const reasons=['incorrect_details','ownership_concern','duplicate','suspicious','other'];
const reviewKinds=['government_id','income_document','bank_statement','title_deed','ownership_document','other'];
const reviewerGroup='Authorized Covalyn Homes document reviewers with two-step sign-in';
const limiter=(limit,windowMs=15*60*1000)=>rateLimit({limit,windowMs,standardHeaders:'draft-7',legacyHeaders:false});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:4*1024*1024,files:1,fields:2,parts:3}}).single('document');

function encryptionKey(){const k=process.env.VERIFICATION_ENCRYPTION_KEY;if(!/^[a-f0-9]{64}$/i.test(k||''))throw fail(503,'Secure review is not configured.');return Buffer.from(k,'hex');}
function encrypt(buffer){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);return Buffer.concat([iv,cipher.update(buffer),cipher.final(),cipher.getAuthTag()]);}
function decrypt(buffer){const b=Buffer.from(buffer),cipher=createDecipheriv('aes-256-gcm',encryptionKey(),b.subarray(0,12));cipher.setAuthTag(b.subarray(b.length-16));return Buffer.concat([cipher.update(b.subarray(12,b.length-16)),cipher.final()]);}
function sessionHash(req){return req.cookies?.covalyn_session?sha256(req.cookies.covalyn_session):null;}
export async function requireReviewerStepUp(req,res,next){
 try{
  if(req.user?.role!=='admin')throw fail(403,'Authorized reviewer account required.');
  const token=sessionHash(req);
  if(!token)throw fail(401,'Sign in before reviewing private records.');
  const row=(await getRows(`SELECT 1 FROM reviewer_stepups s JOIN reviewer_totp t ON s.user_id=t.user_id
    WHERE s.token_hash=$1 AND s.user_id=$2 AND s.expires_at>now() AND t.enabled_at IS NOT NULL`,[token,req.user.id]))[0];
  if(!row)throw fail(403,'Two-step reviewer verification required. Open Admin → Reviewer security.');
  res.set('Cache-Control','private,no-store');next();
 }catch(error){next(error);}
}
async function grantStepUp(req){
 const token=sessionHash(req);if(!token)throw fail(401,'Please sign in again.');
 await query(`INSERT INTO reviewer_stepups(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')
 ON CONFLICT(token_hash) DO UPDATE SET user_id=EXCLUDED.user_id,expires_at=EXCLUDED.expires_at`,[token,req.user.id]);
}
async function clearExpiredFiles(){
 await query(`WITH expired AS (DELETE FROM private_document_files WHERE expires_at<=now() RETURNING request_id)
 UPDATE private_document_requests SET status='expired',updated_at=now()
 WHERE id IN (SELECT request_id FROM expired) AND status!='cancelled'`);
}
function checkDocMime(file){
 if(!file)throw fail(400,'Select a document to upload.');const b=file.buffer;
 if(b.length<12)throw fail(400,'The file is empty or not supported.');
 if(b.subarray(0,3).equals(Buffer.from([255,216,255])))return 'image/jpeg';
 if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return 'image/webp';
 if(b.toString('ascii',0,5)==='%PDF-')return 'application/pdf';
 throw fail(400,'Upload a PDF, JPEG, PNG or WebP file.');
}

export function installTrust(app,{requireDb,loginRequired,adminRequired}={}){
 const protectedAdmin=[requireDb,adminRequired];
 const protectedDocs=[requireDb,adminRequired,requireReviewerStepUp];
 const protectedUser=[requireDb,loginRequired];
 // Public: no identity images, TINs, reviewer file names, raw evidence, or private notes.
 app.get('/api/listing-verifications',wrap(async(req,res)=>{
  if(!enabled)return res.json({items:{}});
  const rows=await getRows(`SELECT c.property_id,c.outcome,c.checked_fields,c.reviewer_name,
  c.reviewer_organization,c.verification_method,c.checked_at,c.independently_checked
  FROM listing_verification_checks c JOIN properties p ON p.id=c.property_id
  WHERE p.status!='hidden' AND p.demo=false ORDER BY c.property_id,c.checked_at DESC,c.created_at DESC LIMIT 500`);
  const items={};for(const c of rows){
   const entry={outcome:c.outcome,checkedFields:c.checked_fields,reviewerName:c.reviewer_name,
    organization:c.reviewer_organization,method:c.verification_method,checkedAt:c.checked_at};
   if(!items[c.property_id])items[c.property_id]={...entry,
    ownershipConfirmed:c.outcome==='verified'&&c.independently_checked&&c.checked_fields.includes('ownership_records')&&c.checked_fields.includes('title_deed'),history:[]};
   items[c.property_id].history.push(entry);
  }
  res.json({items});
 }));
 app.post('/api/listings/:id/report',limiter(8,60*60*1000),requireDb,wrap(async(req,res)=>{
  const id=uuid(req.params.id),reason=String(req.body.reason||''),description=required(req.body.description,'Explanation',1500),email=safeText(req.body.email,200).trim().toLowerCase();
  if(!reasons.includes(reason))throw fail(400,'Choose a report reason.');
  if(email&&!validEmail(email))throw fail(400,'Enter a valid contact email or leave it blank.');
  const p=await query("SELECT id FROM properties WHERE id=$1 AND status!='hidden' AND demo=false",[id]);if(!p.rowCount)throw fail(404,'Listing not found.');
  await query(`INSERT INTO listing_reports(id,property_id,reporter_user_id,reporter_email,reason,description) VALUES($1,$2,$3,$4,$5,$6)`,[newId(),id,req.user?.id||null,email,reason,description]);
  res.status(201).json({ok:true,message:'Your report was delivered to our admin review dashboard.'});
 }));
 app.get('/api/reviews',wrap(async(req,res)=>{
  if(!enabled)return res.json({reviews:[]});
  const reviews=await getRows(`SELECT r.rating,r.message,r.party,r.published_at,split_part(u.name,' ',1) AS display_name,
  p.city,p.state FROM client_reviews r JOIN users u ON u.id=r.user_id JOIN transactions t ON t.id=r.transaction_id
  JOIN properties p ON p.id=t.property_id WHERE r.moderation='published' AND r.publish_consent=true AND t.closed_at IS NOT NULL
  ORDER BY r.published_at DESC LIMIT 30`);res.json({reviews});
 }));

 // Reviewer enrollment: password + a time-based one-time password from a separate authenticator.
 app.get('/api/admin/reviewer-mfa/status',...protectedAdmin,wrap(async(req,res)=>{
  const enabledRecord=(await getRows('SELECT enabled_at FROM reviewer_totp WHERE user_id=$1',[req.user.id]))[0];
  const active=sessionHash(req)?(await getRows('SELECT 1 FROM reviewer_stepups WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',[sessionHash(req),req.user.id])).length>0:false;
  res.set('Cache-Control','private,no-store').json({enabled:Boolean(enabledRecord?.enabled_at),verified:Boolean(enabledRecord?.enabled_at&&active)});
 }));
 app.post('/api/admin/reviewer-mfa/setup',...protectedAdmin,limiter(5),wrap(async(req,res)=>{
  const account=(await getRows('SELECT password_hash,email FROM users WHERE id=$1',[req.user.id]))[0];
  if(!account||!verifyPassword(String(req.body.password||''),account.password_hash))throw fail(403,'Current account password is incorrect.');
  const existing=(await getRows('SELECT enabled_at FROM reviewer_totp WHERE user_id=$1',[req.user.id]))[0];
  if(existing?.enabled_at)throw fail(409,'Two-step verification is already enabled for this reviewer.');
  const secretBytes=randomBytes(20),secret=base32(secretBytes);
  await query(`INSERT INTO reviewer_totp(user_id,secret_encrypted) VALUES($1,$2)
  ON CONFLICT(user_id) DO UPDATE SET secret_encrypted=EXCLUDED.secret_encrypted,enabled_at=NULL,last_counter=-1`,[req.user.id,encrypt(secretBytes)]);
  const issuer='Covalyn Homes',label=`${issuer}:${account.email}`;
  res.set('Cache-Control','private,no-store').json({secret,otpauth:`otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`});
 }));
 const verifyCode=async(req,enable)=>{
  const r=(await getRows('SELECT secret_encrypted,enabled_at,last_counter FROM reviewer_totp WHERE user_id=$1',[req.user.id]))[0];
  if(!r||(!enable&&!r.enabled_at)||(enable&&r.enabled_at))throw fail(409,enable?'Set up two-step verification first.':'Two-step verification is not enabled.');
  const counter=matchingTotp(decrypt(r.secret_encrypted),String(req.body.code||''));
  if(counter===null)throw fail(403,'Invalid authenticator code.');
  const result=await query(`UPDATE reviewer_totp SET last_counter=$2, enabled_at=CASE WHEN $3 THEN now() ELSE enabled_at END
   WHERE user_id=$1 AND last_counter<$2 AND ($3 OR enabled_at IS NOT NULL) RETURNING user_id`,[req.user.id,counter,enable]);
  if(!result.rowCount)throw fail(403,'This code was already used. Wait for the next code.');
  await grantStepUp(req);return {ok:true,verified:true,expiresInMinutes:15};
 };
 app.post('/api/admin/reviewer-mfa/confirm',...protectedAdmin,limiter(12),wrap(async(req,res)=>res.json(await verifyCode(req,true))));
 app.post('/api/admin/reviewer-mfa/verify',...protectedAdmin,limiter(12),wrap(async(req,res)=>res.json(await verifyCode(req,false))));
 app.post('/api/admin/reviewer-mfa/lock',...protectedAdmin,wrap(async(req,res)=>{await query('DELETE FROM reviewer_stepups WHERE token_hash=$1 AND user_id=$2',[sessionHash(req),req.user.id]);res.json({ok:true});}));

 // Admin-only listing checks; an independent review must be attested, with title deed AND external record fields.
 app.get('/api/admin/listing-verifications',...protectedDocs,wrap(async(req,res)=>res.json({checks:await getRows(`SELECT c.id,c.property_id,c.checked_fields,c.outcome,c.reviewer_name,c.reviewer_organization,c.reviewer_email,c.verification_method,
 c.evidence_reference,c.independently_checked,c.checked_at,p.title FROM listing_verification_checks c JOIN properties p ON p.id=c.property_id ORDER BY c.created_at DESC LIMIT 200`)})));
 app.post('/api/admin/listings/:id/checks',...protectedDocs,wrap(async(req,res)=>{
  const propertyId=uuid(req.params.id),b=req.body||{},checkedFields=Array.isArray(b.checkedFields)?[...new Set(b.checkedFields)]:[];
  if(!checkedFields.length||checkedFields.some(x=>!fields.includes(x)))throw fail(400,'Select the fields actually checked.');
  const outcome=String(b.outcome||'');if(!['verified','issues_found','pending'].includes(outcome))throw fail(400,'Choose the verification outcome.');
  const reviewerName=required(b.reviewerName,'Independent reviewer name',120),organization=required(b.organization,'Reviewer organization',150);
  const reviewerEmail=required(b.reviewerEmail,'Reviewer email',200).toLowerCase(),method=required(b.method,'Independent check method',500);
  if(!validEmail(reviewerEmail))throw fail(400,'A valid reviewer email is required.');
  if(!yes(b.independent))throw fail(400,'Confirm that a genuinely independent review was completed.');
  const seller=await getRows('SELECT p.id,u.email AS seller_email FROM properties p LEFT JOIN users u ON u.id=p.seller_user_id WHERE p.id=$1',[propertyId]);
  if(!seller.length)throw fail(404,'Property not found.');
  if(seller[0].seller_email===reviewerEmail||req.user.email===reviewerEmail)throw fail(400,'The independent reviewer must be different from the seller and recording administrator.');
  const checkedAt=String(b.checkedAt||'');const date=validDate(checkedAt);if(!date)throw fail(400,'A check date is required.');
  if(new Date(date+'T12:00:00Z').getTime()>Date.now()+12*60*60*1000)throw fail(400,'A check cannot be dated in the future.');
  if(outcome==='verified'&&checkedFields.includes('ownership_records')&&!checkedFields.includes('title_deed'))throw fail(400,'Confirm the title deed as part of an ownership check.');
  if(outcome==='verified'&&checkedFields.includes('ownership_records')&&!safeText(b.evidenceReference,120))throw fail(400,'A verifiable independent evidence reference is required to confirm ownership.');
  await query(`INSERT INTO listing_verification_checks(id,property_id,checked_fields,outcome,reviewer_name,reviewer_organization,reviewer_email,verification_method,evidence_reference,independently_checked,recorded_by,checked_at)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11::date)`,[newId(),propertyId,checkedFields,outcome,reviewerName,organization,reviewerEmail,method,safeText(b.evidenceReference,120),req.user.id,date]);
  res.status(201).json({ok:true,ownershipConfirmed:outcome==='verified'&&checkedFields.includes('ownership_records')&&checkedFields.includes('title_deed')});
 }));
 app.post('/api/admin/listings/:id/assign-seller',...protectedDocs,wrap(async(req,res)=>{
  const propertyId=uuid(req.params.id),sellerId=uuid(req.body.sellerUserId);
  const seller=await query("SELECT id FROM users WHERE id=$1 AND account_type='seller' AND role='client'",[sellerId]);
  if(!seller.rowCount)throw fail(400,'Choose a registered seller account.');
  const p=await query('UPDATE properties SET seller_user_id=$2 WHERE id=$1 RETURNING id',[propertyId,sellerId]);
  if(!p.rowCount)throw fail(404,'Property not found.');res.json({ok:true});
 }));
 app.get('/api/admin/listing-reports',...protectedAdmin,wrap(async(req,res)=>res.json({reports:await getRows(`SELECT r.*,p.title,u.name AS reporter_name FROM listing_reports r JOIN properties p ON p.id=r.property_id
 LEFT JOIN users u ON u.id=r.reporter_user_id ORDER BY r.created_at DESC LIMIT 300`)})));
 app.patch('/api/admin/listing-reports/:id',...protectedAdmin,wrap(async(req,res)=>{
  const status=String(req.body.status||'');if(!['new','in_review','resolved','dismissed'].includes(status))throw fail(400,'Invalid report status.');
  const result=await query(`UPDATE listing_reports SET status=$2,admin_note=$3,reviewed_at=now(),reviewed_by=$4 WHERE id=$1 RETURNING id`,
  [uuid(req.params.id),status,safeText(req.body.note,1000),req.user.id]);if(!result.rowCount)throw fail(404,'Report not found.');res.json({ok:true});
 }));

 // Private per-property document requests. Full files are never put in normal JSON responses.
 app.get('/api/my/document-requests',...protectedUser,wrap(async(req,res)=>{
  await clearExpiredFiles();const requests=await getRows(`SELECT d.id,d.property_id,d.doc_type,d.purpose,d.reviewer_group,d.retention_days,d.due_at,d.status,d.reviewer_note,d.created_at,
  p.title,f.filename,f.submitted_at,f.expires_at FROM private_document_requests d JOIN properties p ON p.id=d.property_id
  LEFT JOIN private_document_files f ON f.request_id=d.id WHERE d.user_id=$1 ORDER BY d.created_at DESC`,[req.user.id]);
  res.set('Cache-Control','private,no-store').json({requests});
 }));
 app.post('/api/my/document-requests/:id/submit',...protectedUser,limiter(12),upload,wrap(async(req,res)=>{
  const requestId=uuid(req.params.id),mime=checkDocMime(req.file),filename=safeText(req.file.originalname,140);
  const client=await (await import('./db.mjs')).pool.connect();try{
   await client.query('BEGIN');
   const rows=(await client.query('SELECT id,status,retention_days FROM private_document_requests WHERE id=$1 AND user_id=$2 FOR UPDATE',[requestId,req.user.id])).rows;
   if(!rows.length)throw fail(404,'Document request not found.');
   if(!['requested','needs_changes','submitted'].includes(rows[0].status))throw fail(409,'This document request no longer accepts uploads.');
   const expires=new Date(Date.now()+rows[0].retention_days*86400000).toISOString();
   await client.query(`INSERT INTO private_document_files(request_id,encrypted_body,filename,content_type,expires_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(request_id) DO UPDATE SET encrypted_body=EXCLUDED.encrypted_body,filename=EXCLUDED.filename,
    content_type=EXCLUDED.content_type,submitted_at=now(),expires_at=EXCLUDED.expires_at`,[requestId,encrypt(req.file.buffer),filename,mime,expires]);
   await client.query("UPDATE private_document_requests SET status='submitted',reviewer_note='',updated_at=now() WHERE id=$1",[requestId]);
   await client.query('COMMIT');res.status(201).json({ok:true,status:'submitted',expiresAt:expires});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }));
 app.get('/api/admin/document-requests',...protectedDocs,wrap(async(req,res)=>{
  await clearExpiredFiles();const requests=await getRows(`SELECT d.*,p.title,u.name AS client_name,u.email AS client_email,f.filename,f.content_type,f.submitted_at,f.expires_at
   FROM private_document_requests d JOIN properties p ON p.id=d.property_id JOIN users u ON u.id=d.user_id
   LEFT JOIN private_document_files f ON f.request_id=d.id ORDER BY d.created_at DESC LIMIT 300`);
  res.set('Cache-Control','private,no-store').json({requests});
 }));
 app.post('/api/admin/document-requests',...protectedDocs,wrap(async(req,res)=>{
  const b=req.body||{},propertyId=uuid(b.propertyId),userId=uuid(b.userId),kind=String(b.docType||'');
  if(!reviewKinds.includes(kind))throw fail(400,'Select a document type.');
  const purpose=required(b.purpose,'Why the document is needed',600),retentionDays=Number(b.retentionDays);
  if(![30,60,90].includes(retentionDays))throw fail(400,'Choose 30, 60 or 90 days of retention.');
  const dueAt=validDate(b.dueAt);
  const accounts=await getRows('SELECT id FROM users WHERE id=$1 AND role=$2',[userId,'client']);
  const prop=await getRows('SELECT id FROM properties WHERE id=$1',[propertyId]);
  if(!accounts.length||!prop.length)throw fail(404,'Account or property not found.');
  const id=newId();await query(`INSERT INTO private_document_requests(id,property_id,user_id,requested_by,doc_type,purpose,reviewer_group,retention_days,due_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,propertyId,userId,req.user.id,kind,purpose,reviewerGroup,retentionDays,dueAt]);
  res.status(201).json({ok:true,id});
 }));
 app.patch('/api/admin/document-requests/:id',...protectedDocs,wrap(async(req,res)=>{
  const newStatus=String(req.body.status||'');if(!['requested','submitted','accepted','needs_changes','cancelled'].includes(newStatus))throw fail(400,'Invalid request status.');
  const result=await query(`UPDATE private_document_requests SET status=$2,reviewer_note=$3,updated_at=now()
  WHERE id=$1 AND status!='expired' RETURNING id`,[uuid(req.params.id),newStatus,safeText(req.body.note,1200)]);
  if(!result.rowCount)throw fail(404,'Document request not found or expired.');res.json({ok:true});
 }));
 app.get('/api/admin/document-requests/:id/file',...protectedDocs,wrap(async(req,res)=>{
  const id=uuid(req.params.id);await clearExpiredFiles();
  const doc=(await getRows('SELECT filename,content_type,encrypted_body FROM private_document_files WHERE request_id=$1 AND expires_at>now()',[id]))[0];
  if(!doc)throw fail(404,'No unexpired submission for this request.');
  await query('INSERT INTO private_document_access(id,request_id,reviewer_id) VALUES($1,$2,$3)',[newId(),id,req.user.id]);
  res.set({'Content-Type':doc.content_type,'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff',
   'Content-Disposition':'attachment; filename="private-document"','Content-Security-Policy':"sandbox; default-src 'none'"}).send(decrypt(doc.encrypted_body));
 }));

 // Transaction progress; ownership/financial claims are administrative records, never house-payment checkout.
 app.patch('/api/admin/transactions/:id/progress',...protectedAdmin,wrap(async(req,res)=>{
  const id=uuid(req.params.id),b=req.body||{},party=String(b.responsibleParty||'admin');
  if(!roles.includes(party))throw fail(400,'Choose who is responsible.');
  const nextAction=required(b.nextAction,'Next action',300),deadline=validDate(b.deadline);
  const cents=b.agreedFees?toCents(b.agreedFees):0;
  if(cents<0||cents>99999999)throw fail(400,'Fees must be between $0 and $999,999.99.');
  const feeDescription=safeText(b.feeDescription,500),feesConfirmed=yes(b.feesConfirmed);
  if(cents&&!feeDescription)throw fail(400,'Explain every recorded fee.');
  if(cents&&!feesConfirmed)throw fail(400,'Only include fees with an existing buyer/seller agreement.');
  const contactEmail=safeText(b.closingEmail,180).toLowerCase();if(contactEmail&&!validEmail(contactEmail))throw fail(400,'Enter a valid closing contact email.');
  const row=await query(`UPDATE transactions SET next_action=$2,responsible_party=$3,action_deadline=$4,
   agreed_fees_cents=$5,fee_description=$6,fees_confirmed_at=CASE WHEN $7 THEN now() ELSE NULL END,
   closing_contact_name=$8,closing_contact_email=$9,closing_contact_phone=$10,updated_at=now() WHERE id=$1 RETURNING id`,
  [id,nextAction,party,deadline,cents,feeDescription,feesConfirmed,safeText(b.closingName,120),contactEmail,safeText(b.closingPhone,45)]);
  if(!row.rowCount)throw fail(404,'Transaction not found.');
  await query('INSERT INTO transaction_events(id,transaction_id,stage,note) SELECT $1,id,stage,$3 FROM transactions WHERE id=$2',
   [newId(),id,`Next: ${nextAction} · Responsible: ${party} · Deadline: ${deadline||'TBD'}`]);res.json({ok:true});
 }));
 app.post('/api/admin/transactions/:id/close',...protectedDocs,wrap(async(req,res)=>{
  if(!yes(req.body.confirmed))throw fail(400,'Confirm that the closing actually completed.');
  const evidence=required(req.body.evidenceReference,'Independent closing confirmation reference',200);
  const id=uuid(req.params.id),r=await query(`UPDATE transactions SET closed_at=COALESCE(closed_at,now()),stage='Closed',closing_evidence_reference=$2,updated_at=now() WHERE id=$1 RETURNING id`,[id,evidence]);
  if(!r.rowCount)throw fail(404,'Transaction not found.');
  await query(`INSERT INTO transaction_events(id,transaction_id,stage,note) VALUES($1,$2,'Closed','Closing recorded after external confirmation')`,[newId(),id]);
  res.json({ok:true});
 }));
 app.get('/api/my/transactions/:id/receipts/:paymentId',...protectedUser,wrap(async(req,res)=>{
  const transactionId=uuid(req.params.id),paymentId=uuid(req.params.paymentId);
  const record=(await getRows(`SELECT pay.id,pay.amount_cents,pay.method,pay.reference,pay.created_at,p.title
   FROM payments pay JOIN transactions t ON t.id=pay.transaction_id JOIN properties p ON p.id=t.property_id
   WHERE pay.id=$1 AND t.id=$2 AND (t.user_id=$3 OR p.seller_user_id=$3)`,[paymentId,transactionId,req.user.id]))[0];
  if(!record)throw fail(404,'Payment record not found for this account.');
  res.set('Cache-Control','private,no-store').json({record:{id:record.id,property:record.title,
   amount:Number(record.amount_cents)/100,currency:'USD',method:record.method,reference:record.reference,recordedAt:record.created_at,
   statement:'Covalyn Homes administrative payment record only. Not independent settlement confirmation or a processor-issued receipt.'}});
 }));
 app.get('/api/my/review-eligibility',...protectedUser,wrap(async(req,res)=>{
  const items=await getRows(`SELECT t.id AS transaction_id,p.title,CASE WHEN t.user_id=$1 THEN 'buyer' ELSE 'seller' END AS party,
  r.id AS review_id,r.moderation,r.rating,r.message FROM transactions t JOIN properties p ON p.id=t.property_id
  LEFT JOIN client_reviews r ON r.transaction_id=t.id AND r.user_id=$1
  WHERE t.closed_at IS NOT NULL AND (t.user_id=$1 OR p.seller_user_id=$1) ORDER BY t.closed_at DESC`,[req.user.id]);
  res.json({items});
 }));
 app.post('/api/my/reviews',...protectedUser,limiter(10,60*60*1000),wrap(async(req,res)=>{
  const id=uuid(req.body.transactionId),rating=Number(req.body.rating),message=required(req.body.message,'Feedback',1200);
  if(!Number.isInteger(rating)||rating<1||rating>5)throw fail(400,'Choose 1 to 5 stars.');
  if(!yes(req.body.publishConsent))throw fail(400,'Permission is needed before feedback can be published.');
  const t=(await getRows(`SELECT t.user_id,p.seller_user_id FROM transactions t JOIN properties p ON p.id=t.property_id WHERE t.id=$1 AND t.closed_at IS NOT NULL`,[id]))[0];
  if(!t||!(t.user_id===req.user.id||t.seller_user_id===req.user.id))throw fail(403,'Reviews are only available to parties on completed transactions.');
  const party=t.user_id===req.user.id?'buyer':'seller';
  try{await query(`INSERT INTO client_reviews(id,transaction_id,user_id,party,rating,message,publish_consent) VALUES($1,$2,$3,$4,$5,$6,true)`,
   [newId(),id,req.user.id,party,rating,message]);}catch(e){if(e.code==='23505')throw fail(409,'Feedback was already submitted for this transaction.');throw e;}
  res.status(201).json({ok:true,moderation:'pending'});
 }));
 app.delete('/api/my/reviews/:id',...protectedUser,wrap(async(req,res)=>{
  const result=await query(`UPDATE client_reviews SET publish_consent=false,moderation='rejected',published_at=NULL
  WHERE id=$1 AND user_id=$2 RETURNING id`,[uuid(req.params.id),req.user.id]);
  if(!result.rowCount)throw fail(404,'Feedback not found.');res.json({ok:true});
 }));
 app.get('/api/admin/reviews',...protectedAdmin,wrap(async(req,res)=>res.json({reviews:await getRows(`SELECT r.id,r.party,r.rating,r.message,r.publish_consent,r.moderation,r.created_at,u.name,p.title
 FROM client_reviews r JOIN users u ON u.id=r.user_id JOIN transactions t ON t.id=r.transaction_id JOIN properties p ON p.id=t.property_id
 ORDER BY r.created_at DESC LIMIT 300`)})));
 app.patch('/api/admin/reviews/:id',...protectedAdmin,wrap(async(req,res)=>{
  const moderation=String(req.body.moderation||'');if(!['published','rejected'].includes(moderation))throw fail(400,'Invalid moderation choice.');
  const r=await query(`UPDATE client_reviews r SET moderation=$2,published_at=CASE WHEN $2='published' THEN now() ELSE NULL END
  FROM transactions t WHERE r.id=$1 AND t.id=r.transaction_id AND ($2='rejected' OR (r.publish_consent AND t.closed_at IS NOT NULL)) RETURNING r.id`,
  [uuid(req.params.id),moderation]);if(!r.rowCount)throw fail(404,'Review not found or not eligible for publication.');res.json({ok:true});
 }));
 // Opportunistic file retention cleanup even if no admin returns to the dashboard.
 if(enabled){const timer=setInterval(()=>clearExpiredFiles().catch(error=>console.error('Private document retention cleanup:',error.message)),6*60*60*1000);timer.unref?.();}
}
