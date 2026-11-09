import {createHmac} from 'node:crypto';
import rateLimit from 'express-rate-limit';
import {query,enabled} from './db.mjs';
import {newId,validUuid,validEmail,safeText,toCents} from './security.mjs';
const fail=(status,msg)=>Object.assign(Error(msg),{status});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const rows=(sql,args=[])=>query(sql,args).then(r=>r.rows);
const id=x=>{if(!validUuid(x))throw fail(400,'Invalid identifier');return x};
const txt=(x,name,length=300)=>{const s=safeText(x,length);if(!s)throw fail(400,name+' is required');return s};
const optional=(x,n=400)=>safeText(x,n);
const amount=x=>{try{return toCents(x)}catch{throw fail(400,'Enter a valid USD amount')}};
const date=x=>!x?null:/^\d{4}-\d{2}-\d{2}$/.test(String(x))?String(x):(()=>{throw fail(400,'Use YYYY-MM-DD for dates')})();
const url=x=>{const v=String(x||'');try{const u=new URL(v);if(u.protocol!=='https:'||u.username||u.password||u.hostname.length<4||u.hostname==='localhost')throw 0;return u.href}catch{throw fail(400,'Provide a valid HTTPS website address')}};
const statuses=['pending','in_progress','complete','waived'];
const issue=(res,code=200,data={ok:true})=>res.status(code).json(data);
const rate=(max=20)=>rateLimit({windowMs:15*60*1000,limit:max,standardHeaders:'draft-7',legacyHeaders:false});
const isParty=async(tid,uid)=>Boolean((await rows(`SELECT 1 FROM transactions t JOIN properties p ON p.id=t.property_id WHERE t.id=$1 AND (t.user_id=$2 OR p.seller_user_id=$2)`,[tid,uid])).length);
const isUserProperty=async(pid,uid)=>Boolean((await rows(`SELECT 1 FROM properties WHERE id=$1 AND seller_user_id=$2`,[pid,uid])).length);
const sendEvent=async(uid,title,body,path,key)=>{
 const u=(await rows('SELECT email FROM users WHERE id=$1',[uid]))[0];if(!u)return;
 await query(`INSERT INTO account_notifications(id,user_id,heading,message,path,unique_event) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(unique_event) DO NOTHING`,[newId(),uid,title,body,path,key]);
 // Email is queued only for explicitly opted-in search alerts; other alerts remain in-app.
};
export async function scanListing(propertyId){
 if(!enabled)return;
 const property=(await rows('SELECT id,city,state,address,price_cents,type,listing_mode FROM properties WHERE id=$1',[propertyId]))[0];if(!property)return;
 const flags=[];
 if(property.address){const dup=await rows(`SELECT id FROM properties WHERE id<>$1 AND lower(address)=lower($2) AND lower(city)=lower($3) AND state=$4 AND status!='hidden' LIMIT 1`,[propertyId,property.address,property.city,property.state]);if(dup.length)flags.push(['duplicate_address','This street address is used on another active property listing.']);}
 const q=await rows(`SELECT price_cents FROM properties WHERE id<>$1 AND city=$2 AND state=$3 AND type=$4 AND listing_mode=$5 AND status!='hidden' AND price_cents>0 ORDER BY price_cents LIMIT 150`,[propertyId,property.city,property.state,property.type,property.listing_mode]);if(q.length>=5){const a=q.map(x=>Number(x.price_cents)).sort((x,y)=>x-y),median=a[Math.floor(a.length/2)];if(Number(property.price_cents)<median*0.5)flags.push(['price_outlier','Asking price is less than half the median of at least five same-city same-type listings; manual review recommended.']);}
 for(const [reason,explanation] of flags)await query(`INSERT INTO property_risk_flags(id,property_id,reason,explanation) VALUES($1,$2,$3,$4) ON CONFLICT(property_id,reason) DO NOTHING`,[newId(),propertyId,reason,explanation]);
}
export async function onPhotoUpload(propertyId,photoId,bytes){
 const {sha256}=await import('./security.mjs');const hash=sha256(bytes);
 await query('UPDATE property_images SET content_hash=$2 WHERE id=$1',[photoId,hash]);
 const dup=await rows('SELECT id FROM property_images WHERE content_hash=$1 AND property_id<>$2 LIMIT 1',[hash,propertyId]);
 if(dup.length)await query(`INSERT INTO property_risk_flags(id,property_id,reason,explanation) VALUES($1,$2,'duplicate_photo','The uploaded photo matches a photo on another property. Manual review required.') ON CONFLICT(property_id,reason) DO NOTHING`,[newId(),propertyId]);
}
export async function deliverEmailOutbox(max=10){
 const apiKey=process.env.RESEND_API_KEY,from=process.env.EMAIL_FROM;
 if(!apiKey||!from)throw fail(503,'Configure a verified email sender and RESEND_API_KEY before delivery.');
 const items=await rows(`SELECT id,recipient,subject,body FROM email_outbox WHERE state IN ('pending','failed') ORDER BY created_at LIMIT $1`,[Math.max(1,Math.min(30,Number(max)||10))]);
 let sent=0,failed=0;
 for(const item of items){try{
   const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({from,to:[item.recipient],subject:item.subject,text:item.body,reply_to:'infocovalyn@gmail.com'}),signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error('Email provider rejected the message: '+response.status);
   await query("UPDATE email_outbox SET state='sent',sent_at=now(),last_error='' WHERE id=$1",[item.id]);sent++;
  }catch(error){await query("UPDATE email_outbox SET state='failed',last_error=$2 WHERE id=$1",[item.id,optional(error.message,200)]);failed++;}}
 return {sent,failed};
}
export async function onPropertySaved(property,previous=null){
 const isNew=!previous,changed=previous&&Number(previous.price_cents)!==Number(property.price_cents);
 if(isNew||changed){await query('INSERT INTO property_price_history(id,property_id,amount_cents,reason) VALUES($1,$2,$3,$4)',[newId(),property.id,property.price_cents,property.listing_mode==='rent'?'Monthly rent':isNew?'Initial asking price':'Listing price update']);}
 await scanListing(property.id);
 if(property.listing_mode!=='rent'&&(isNew||changed)&&property.status!=='hidden'&&!property.demo){
  const matches=await rows(`SELECT a.*,u.email FROM saved_search_alerts a JOIN users u ON u.id=a.user_id WHERE a.enabled=true AND (($1::boolean AND a.notify_new) OR ($2::boolean AND a.notify_price_drop)) AND (a.city='' OR lower(a.city)=lower($3)) AND (a.state='' OR a.state=$4) AND (a.property_type='' OR a.property_type=$5) AND (a.max_price_cents IS NULL OR a.max_price_cents>=$6)`,[isNew,Boolean(changed&&Number(property.price_cents)<Number(previous.price_cents)),property.city,property.state,property.type,property.price_cents]);
  for(const m of matches){const text=isNew?`New home in ${property.city}, ${property.state}`:`Price reduced for a saved search in ${property.city}, ${property.state}`;
   const key=`saved:${m.id}:${property.id}:${property.price_cents}`;
   await sendEvent(m.user_id,'Saved-search match',text,`/homes/${property.id}`,key);
   await query(`INSERT INTO email_outbox(id,user_id,recipient,subject,body,event_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO NOTHING`,[newId(),m.user_id,m.email,'Covalyn Homes - '+text,text+`\nView listing: ${(process.env.PUBLIC_ORIGIN||'').replace(/\/$/,'')}/homes/${property.id}\nTo stop alerts, open your account settings.`,key]);
  }
  if(matches.length&&process.env.RESEND_API_KEY&&process.env.EMAIL_FROM){await deliverEmailOutbox(3);}
 }
}
export async function onTourStatus(tourId,updated){const row=(await rows('SELECT user_id,property_id FROM tours WHERE id=$1',[tourId]))[0];if(row?.user_id&&updated==='confirmed')await sendEvent(row.user_id,'Tour confirmed','Your tour request was marked confirmed. Check your account for details.','/portal',`tour:${tourId}:confirmed`);}
export function installPremium(app,{requireDb,loginRequired,adminRequired}){
 const user=[requireDb,loginRequired],admin=[requireDb,adminRequired];
 app.get('/api/listings/:id/insights',wrap(async(req,res)=>{
  if(!enabled)return res.json({agent:null,history:[],tax:null,panorama:null});const pid=id(req.params.id);
  const p=(await rows(`SELECT id FROM properties WHERE id=$1 AND status!='hidden' AND demo=false`,[pid]))[0];if(!p)throw fail(404,'Property not found');
  const [agents,hist,records,pan]=await Promise.all([
   rows('SELECT full_name,brokerage,license_number,license_state,registry_url,phone,verified_at FROM property_agents WHERE property_id=$1',[pid]),
   rows('SELECT amount_cents,reason,recorded_at FROM property_price_history WHERE property_id=$1 ORDER BY recorded_at DESC LIMIT 30',[pid]),
   rows('SELECT annual_tax_cents,tax_year,source_url,source_label,updated_at FROM property_public_records WHERE property_id=$1',[pid]),
   rows('SELECT i.id FROM property_panoramas pp JOIN property_images i ON i.id=pp.image_id WHERE pp.property_id=$1',[pid])]);
  res.json({agent:agents[0]||null,history:hist.map(x=>({...x,price:Number(x.amount_cents)/100,amount_cents:undefined})),tax:records[0]||null,panorama:pan[0]?'/api/images/'+pan[0].id:null});
 }));
 app.get('/api/lenders',wrap(async(req,res)=>res.json({items:enabled?await rows('SELECT name,nmls_id,state,website,disclosure,verified_at FROM lender_referrals WHERE verified_at IS NOT NULL ORDER BY name LIMIT 40'):[]})));
 app.post('/api/listings/:id/view',requireDb,rate(150),wrap(async(req,res)=>{
  const pid=id(req.params.id);const p=(await rows(`SELECT id FROM properties WHERE id=$1 AND status!='hidden'`,[pid]))[0];if(!p)throw fail(404,'Property not found');
  const day=new Date().toISOString().slice(0,10),pepper=process.env.VIEW_HASH_SECRET||process.env.VERIFICATION_ENCRYPTION_KEY;
  if(!pepper)throw fail(503,'View analytics are temporarily unavailable');
  const hash=createHmac('sha256',pepper).update(`${day}|${req.ip}|${req.get('user-agent')||''}`).digest('hex');
  await query('INSERT INTO property_daily_views(property_id,view_day,visitor_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[pid,day,hash]);res.json({ok:true});
 }));
 app.put('/api/admin/listings/:id/agent',...admin,wrap(async(req,res)=>{
  const pid=id(req.params.id),b=req.body||{},name=txt(b.name,'Agent name',120),brokerage=txt(b.brokerage,'Brokerage name',130),state=txt(b.state,'Licensing state',2).toUpperCase(),license=txt(b.license,'License number',50),link=url(b.registryUrl);
  if(!/^[A-Z]{2}$/.test(state))throw fail(400,'Use two-letter state code');if(!/\.(gov|us|com|org)(\/|$)/i.test(link))throw fail(400,'Provide an official licensing registry link');
  if(b.verified!==true)throw fail(400,'Confirm independent verification against the state registry before displaying a verified agent.');
  await query(`INSERT INTO property_agents(property_id,full_name,brokerage,license_number,license_state,registry_url,phone,verified_by,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(property_id) DO UPDATE SET full_name=$2,brokerage=$3,license_number=$4,license_state=$5,registry_url=$6,phone=$7,verified_by=$8,verified_at=now()`,[pid,name,brokerage,license,state,link,optional(b.phone,45),req.user.id]);res.json({ok:true});
 }));
 app.put('/api/admin/listings/:id/insights',...admin,wrap(async(req,res)=>{
  const pid=id(req.params.id),b=req.body||{},year=Number(b.taxYear||0),cents=b.taxAmount?amount(b.taxAmount):null,source=url(b.sourceUrl);
  if(year<1900||year>new Date().getFullYear()+1)throw fail(400,'Provide the correct tax year');
  await query(`INSERT INTO property_public_records(property_id,annual_tax_cents,tax_year,source_url,source_label) VALUES($1,$2,$3,$4,$5) ON CONFLICT(property_id) DO UPDATE SET annual_tax_cents=$2,tax_year=$3,source_url=$4,source_label=$5,updated_at=now()`,[pid,cents,year,source,txt(b.sourceLabel,'Public record source',100)]);res.json({ok:true});
 }));
 app.put('/api/admin/listings/:id/panorama',...admin,wrap(async(req,res)=>{
  const pid=id(req.params.id),image=id(req.body.imageId);
  const valid=(await rows('SELECT id FROM property_images WHERE id=$1 AND property_id=$2',[image,pid]))[0];if(!valid)throw fail(400,'Select an image already uploaded to this property.');
  await query('INSERT INTO property_panoramas(property_id,image_id) VALUES($1,$2) ON CONFLICT(property_id) DO UPDATE SET image_id=$2',[pid,image]);res.json({ok:true});
 }));
 app.get('/api/admin/risks',...admin,wrap(async(req,res)=>res.json({items:await rows(`SELECT f.*,p.title FROM property_risk_flags f JOIN properties p ON p.id=f.property_id ORDER BY CASE f.status WHEN 'open' THEN 0 ELSE 1 END,f.created_at DESC LIMIT 200`)})));
 app.patch('/api/admin/risks/:id',...admin,wrap(async(req,res)=>{
  const st=String(req.body.status);if(!['reviewed','dismissed','open'].includes(st))throw fail(400,'Invalid risk review status');
  const r=await query('UPDATE property_risk_flags SET status=$2,reviewed_by=$3 WHERE id=$1 RETURNING id',[id(req.params.id),st,req.user.id]);if(!r.rowCount)throw fail(404,'Flag not found');res.json({ok:true});
 }));
 app.get('/api/my/support-cases',...user,wrap(async(req,res)=>res.json({items:await rows('SELECT * FROM support_cases WHERE user_id=$1 ORDER BY created_at DESC LIMIT 150',[req.user.id])})));
 app.post('/api/my/support-cases',...user,rate(),wrap(async(req,res)=>{
  const b=req.body||{},category=String(b.category||''),subject=txt(b.subject,'Subject',140),body=txt(b.message,'Description',3000);
  if(!['fraud_concern','document','payment','closing','service','other'].includes(category))throw fail(400,'Invalid case category');
  const pid=b.propertyId?id(b.propertyId):null,tid=b.transactionId?id(b.transactionId):null;
  if(tid&&!await isParty(tid,req.user.id))throw fail(403,'Not your transaction');
  const cid=newId();await query('INSERT INTO support_cases(id,user_id,property_id,transaction_id,category,subject) VALUES($1,$2,$3,$4,$5,$6)',[cid,req.user.id,pid,tid,category,subject]);await query('INSERT INTO support_case_messages(id,case_id,author_id,author_role,body) VALUES($1,$2,$3,$4,$5)',[newId(),cid,req.user.id,'client',body]);issue(res,201,{ok:true,id:cid});
 }));
 app.get('/api/my/support-cases/:id/messages',...user,wrap(async(req,res)=>{
  const cid=id(req.params.id);if(!(await rows('SELECT id FROM support_cases WHERE id=$1 AND user_id=$2',[cid,req.user.id])).length)throw fail(404,'Case not found');res.json({items:await rows('SELECT author_role,body,created_at FROM support_case_messages WHERE case_id=$1 ORDER BY created_at',[cid])});
 }));
 app.post('/api/my/support-cases/:id/messages',...user,rate(),wrap(async(req,res)=>{
  const cid=id(req.params.id),body=txt(req.body.message,'Reply',3000);if(!(await rows('SELECT id FROM support_cases WHERE id=$1 AND user_id=$2',[cid,req.user.id])).length)throw fail(404,'Case not found');await query('INSERT INTO support_case_messages(id,case_id,author_id,author_role,body) VALUES($1,$2,$3,$4,$5)',[newId(),cid,req.user.id,'client',body]);await query('UPDATE support_cases SET updated_at=now() WHERE id=$1',[cid]);res.json({ok:true});
 }));
 app.get('/api/admin/support-cases',...admin,wrap(async(req,res)=>res.json({items:await rows('SELECT c.*,u.email,u.name FROM support_cases c JOIN users u ON u.id=c.user_id ORDER BY c.updated_at DESC LIMIT 200')})));
 app.get('/api/admin/support-cases/:id/messages',...admin,wrap(async(req,res)=>res.json({items:await rows('SELECT author_role,body,created_at FROM support_case_messages WHERE case_id=$1 ORDER BY created_at',[id(req.params.id)])})));
 app.post('/api/admin/support-cases/:id/messages',...admin,wrap(async(req,res)=>{
  const cid=id(req.params.id),body=txt(req.body.message,'Reply',3000);const c=(await rows('SELECT user_id FROM support_cases WHERE id=$1',[cid]))[0];if(!c)throw fail(404,'Case not found');await query('INSERT INTO support_case_messages(id,case_id,author_id,author_role,body) VALUES($1,$2,$3,$4,$5)',[newId(),cid,req.user.id,'admin',body]);await query('UPDATE support_cases SET updated_at=now() WHERE id=$1',[cid]);await sendEvent(c.user_id,'Support case updated','A new response is available in your Covalyn support center.','/portal',`case:${cid}:msg:${newId()}`);res.json({ok:true});
 }));
 app.patch('/api/admin/support-cases/:id',...admin,wrap(async(req,res)=>{const st=String(req.body.status||'');if(!['open','investigating','waiting_client','resolved'].includes(st))throw fail(400,'Invalid case status');const cid=id(req.params.id);await query('UPDATE support_cases SET status=$2,updated_at=now() WHERE id=$1',[cid,st]);res.json({ok:true});}));
 app.get('/api/my/search-alerts',...user,wrap(async(req,res)=>res.json({items:await rows('SELECT * FROM saved_search_alerts WHERE user_id=$1 ORDER BY created_at DESC',[req.user.id])})));
 app.post('/api/my/search-alerts',...user,rate(),wrap(async(req,res)=>{const b=req.body||{},pid=newId();const state=optional(b.state,2).toUpperCase();if(state&&!/^[A-Z]{2}$/.test(state))throw fail(400,'State must have two letters');
  const max=b.maxPrice?amount(b.maxPrice):null;if(!b.notifyNew&&!b.notifyPriceDrop)throw fail(400,'Select at least one alert condition');
  await query('INSERT INTO saved_search_alerts(id,user_id,city,state,property_type,max_price_cents,notify_new,notify_price_drop) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[pid,req.user.id,optional(b.city,80),state,optional(b.propertyType,100),max,Boolean(b.notifyNew),Boolean(b.notifyPriceDrop)]);issue(res,201,{ok:true,id:pid});
 }));
 app.patch('/api/my/search-alerts/:id',...user,wrap(async(req,res)=>{const x=await query('UPDATE saved_search_alerts SET enabled=$3 WHERE id=$1 AND user_id=$2 RETURNING id',[id(req.params.id),req.user.id,Boolean(req.body.enabled)]);if(!x.rowCount)throw fail(404,'Alert not found');res.json({ok:true});}));
 app.get('/api/my/notifications',...user,wrap(async(req,res)=>res.json({items:await rows('SELECT * FROM account_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 80',[req.user.id])})));
 app.patch('/api/my/notifications/:id/read',...user,wrap(async(req,res)=>{await query('UPDATE account_notifications SET read_at=now() WHERE id=$1 AND user_id=$2',[id(req.params.id),req.user.id]);res.json({ok:true});}));
 app.get('/api/my/seller-analytics',...user,wrap(async(req,res)=>{
  const items=await rows(`SELECT p.id,p.title,p.city,p.state,(SELECT count(*)::int FROM property_daily_views v WHERE v.property_id=p.id AND v.view_day>=current_date-30) AS unique_daily_views,(SELECT count(*)::int FROM inquiries i WHERE i.property_id=p.id) AS inquiries,(SELECT count(*)::int FROM offers o WHERE o.property_id=p.id) AS offers,(SELECT count(*)::int FROM tours t WHERE t.property_id=p.id) AS tour_requests FROM properties p WHERE p.seller_user_id=$1 ORDER BY p.created_at DESC`,[req.user.id]);res.json({items});
 }));
 app.get('/api/my/transactions/:id/extras',...user,wrap(async(req,res)=>{
  const tid=id(req.params.id);if(!await isParty(tid,req.user.id))throw fail(404,'Transaction not found');res.json({tasks:await rows('SELECT id,task_label,assigned_to,due_at,status,completed_at FROM closing_tasks WHERE transaction_id=$1 ORDER BY due_at NULLS LAST',[tid]),partner:(await rows('SELECT provider_name,agent_name,contact_phone,contact_email,portal_url,external_status,verified_at FROM transaction_closing_partners WHERE transaction_id=$1',[tid]))[0]||null,esign:(await rows('SELECT provider_name,signing_url,reference,external_status FROM esign_requests WHERE transaction_id=$1',[tid]))[0]||null});
 }));
 app.get('/api/admin/transactions/:id/extras',...admin,wrap(async(req,res)=>{
  const tid=id(req.params.id);res.json({tasks:await rows('SELECT * FROM closing_tasks WHERE transaction_id=$1 ORDER BY due_at NULLS LAST',[tid]),partner:(await rows('SELECT * FROM transaction_closing_partners WHERE transaction_id=$1',[tid]))[0]||null,esign:(await rows('SELECT * FROM esign_requests WHERE transaction_id=$1',[tid]))[0]||null});
 }));
 app.put('/api/admin/transactions/:id/closing-partner',...admin,wrap(async(req,res)=>{
  const tid=id(req.params.id),b=req.body||{},email=txt(b.email,'Closing contact email',180).toLowerCase();if(!validEmail(email))throw fail(400,'Invalid email');
  if(b.verified!==true)throw fail(400,'Independently confirm the company and phone number before publishing closing contacts.');
  const link=b.portalUrl?url(b.portalUrl):'';
  await query(`INSERT INTO transaction_closing_partners(transaction_id,provider_name,agent_name,contact_phone,contact_email,portal_url,external_status,verified_at,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,now(),$8) ON CONFLICT(transaction_id) DO UPDATE SET provider_name=$2,agent_name=$3,contact_phone=$4,contact_email=$5,portal_url=$6,external_status=$7,verified_at=now(),updated_by=$8,updated_at=now()`,[tid,txt(b.company,'Provider name',130),txt(b.agent,'Closing contact',110),txt(b.phone,'Independent phone',50),email,link,optional(b.externalStatus,120),req.user.id]);res.json({ok:true});
 }));
 app.post('/api/admin/transactions/:id/tasks',...admin,wrap(async(req,res)=>{const tid=id(req.params.id),b=req.body||{},party=String(b.assignedTo||'');if(!['buyer','seller','admin','title_company'].includes(party))throw fail(400,'Invalid responsible party');const taskid=newId();await query('INSERT INTO closing_tasks(id,transaction_id,task_label,assigned_to,due_at) VALUES($1,$2,$3,$4,$5)',[taskid,tid,txt(b.label,'Task name',200),party,date(b.due)]);issue(res,201,{ok:true,id:taskid});}));
 app.patch('/api/admin/transactions/:id/tasks/:taskId',...admin,wrap(async(req,res)=>{const tid=id(req.params.id),taskid=id(req.params.taskId),status=String(req.body.status||'');if(!statuses.includes(status))throw fail(400,'Invalid task status');const r=await query(`UPDATE closing_tasks SET status=$3,completed_at=CASE WHEN $3='complete' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 AND transaction_id=$2 RETURNING id`,[taskid,tid,status]);if(!r.rowCount)throw fail(404,'Task not found');res.json({ok:true});}));
 app.put('/api/admin/transactions/:id/esign',...admin,wrap(async(req,res)=>{
  const tid=id(req.params.id),b=req.body||{},provider=String(b.provider||'');if(!['DocuSign','Adobe Acrobat Sign'].includes(provider))throw fail(400,'Select a supported external signature provider');
  const signing=url(b.signingUrl),host=new URL(signing).hostname.toLowerCase();if(provider==='DocuSign'&&!/(^|\.)(docusign\.com|docusign\.net)$/.test(host))throw fail(400,'Use an official DocuSign link');if(provider==='Adobe Acrobat Sign'&&!/(^|\.)(adobesign\.com|acrobat\.adobe\.com|echosign\.com)$/.test(host))throw fail(400,'Use an official Adobe Sign link');
  await query(`INSERT INTO esign_requests(transaction_id,provider_name,signing_url,reference,external_status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(transaction_id) DO UPDATE SET provider_name=$2,signing_url=$3,reference=$4,external_status=$5,updated_at=now()`,[tid,provider,signing,txt(b.reference,'External envelope reference',100),optional(b.status,100)||'Awaiting external signature']);res.json({ok:true});
 }));
 app.get('/api/my/offers/:id/counters',...user,wrap(async(req,res)=>{const oid=id(req.params.id);const o=(await rows('SELECT user_id FROM offers WHERE id=$1',[oid]))[0];if(!o||o.user_id!==req.user.id)throw fail(404,'Offer not found');res.json({items:await rows('SELECT id,amount_cents,note,status,created_at FROM offer_counteroffers WHERE offer_id=$1 ORDER BY created_at DESC',[oid])});}));
 app.post('/api/admin/offers/:id/counters',...admin,wrap(async(req,res)=>{const oid=id(req.params.id),b=req.body||{},r=(await rows('SELECT user_id FROM offers WHERE id=$1',[oid]))[0];if(!r?.user_id)throw fail(400,'Counteroffers require a registered buyer');const cid=newId(),cents=amount(b.amount);if(cents<100)throw fail(400,'Amount too small');await query('INSERT INTO offer_counteroffers(id,offer_id,created_by,amount_cents,note) VALUES($1,$2,$3,$4,$5)',[cid,oid,req.user.id,cents,optional(b.note,1000)]);await sendEvent(r.user_id,'Counteroffer received','You have a new nonbinding counteroffer. Review it in your account.','/portal',`counter:${cid}`);issue(res,201,{ok:true,id:cid});}));
 app.patch('/api/my/offers/:id/counters/:cid',...user,wrap(async(req,res)=>{const oid=id(req.params.id),cid=id(req.params.cid),st=String(req.body.status||'');if(!['accepted','declined'].includes(st))throw fail(400,'Choose accept or decline');const r=await query(`UPDATE offer_counteroffers c SET status=$4,responded_at=now() FROM offers o WHERE c.id=$1 AND c.offer_id=$2 AND o.id=c.offer_id AND o.user_id=$3 AND c.status='proposed' RETURNING c.id`,[cid,oid,req.user.id,st]);if(!r.rowCount)throw fail(409,'Counteroffer unavailable or already answered');res.json({ok:true,note:'An in-app response is not a binding real-estate contract. Use an authorized agreement for acceptance.'});}));
 app.get('/api/admin/lenders',...admin,wrap(async(req,res)=>res.json({items:await rows('SELECT * FROM lender_referrals ORDER BY created_at DESC LIMIT 60')})));
 app.post('/api/admin/lenders',...admin,wrap(async(req,res)=>{const b=req.body||{};if(b.verified!==true)throw fail(400,'Verify NMLS record and state licensing before publishing a lender');const lid=newId();await query('INSERT INTO lender_referrals(id,name,nmls_id,state,website,disclosure,verified_at) VALUES($1,$2,$3,$4,$5,$6,now())',[lid,txt(b.name,'Lender name',120),txt(b.nmls,'NMLS identifier',45),txt(b.state,'State',2).toUpperCase(),url(b.website),txt(b.disclosure,'Referral and fee disclosure',450)]);issue(res,201,{ok:true,id:lid});}));
 app.get('/api/admin/email-outbox',...admin,wrap(async(req,res)=>res.json({items:await rows('SELECT id,recipient,subject,state,last_error,created_at,sent_at FROM email_outbox ORDER BY created_at DESC LIMIT 100'),configured:Boolean(process.env.RESEND_API_KEY&&process.env.EMAIL_FROM)})));
 app.post('/api/admin/email-outbox/send',...admin,rate(3),wrap(async(req,res)=>res.json(await deliverEmailOutbox(10))));
}
// Seller-controlled appointments and nonbinding negotiation.
export function installSellerTools(app,{requireDb,loginRequired}){
 const auth=[requireDb,loginRequired];
 app.get('/api/my/seller-tours',...auth,wrap(async(req,res)=>res.json({items:await rows(`SELECT t.id,t.name,t.preferred_date,t.preferred_time,t.status,p.title FROM tours t JOIN properties p ON p.id=t.property_id WHERE p.seller_user_id=$1 ORDER BY t.created_at DESC LIMIT 100`,[req.user.id])})));
 app.patch('/api/my/seller-tours/:id',...auth,wrap(async(req,res)=>{
  const tid=id(req.params.id),st=String(req.body.status);if(!['confirmed','cancelled'].includes(st))throw fail(400,'Choose confirm or cancel');const r=await query(`UPDATE tours t SET status=$3 FROM properties p WHERE t.id=$1 AND t.property_id=p.id AND p.seller_user_id=$2 RETURNING t.id`,[tid,req.user.id,st]);if(!r.rowCount)throw fail(404,'Tour not found');await onTourStatus(tid,st);res.json({ok:true});
 }));
 app.get('/api/my/seller-offers',...auth,wrap(async(req,res)=>res.json({items:await rows(`SELECT o.id,o.amount_cents,o.status,o.created_at,p.title,o.user_id,o.name FROM offers o JOIN properties p ON p.id=o.property_id WHERE p.seller_user_id=$1 ORDER BY o.created_at DESC LIMIT 100`,[req.user.id])})));
 app.post('/api/my/seller-offers/:id/counters',...auth,wrap(async(req,res)=>{
  const oid=id(req.params.id),o=(await rows(`SELECT o.user_id FROM offers o JOIN properties p ON p.id=o.property_id WHERE o.id=$1 AND p.seller_user_id=$2`,[oid,req.user.id]))[0];if(!o)throw fail(404,'Offer not found');if(!o.user_id)throw fail(400,'Counteroffers require registered buyer accounts.');const cents=amount(req.body.amount);if(cents<100)throw fail(400,'Amount too small');const cid=newId();await query('INSERT INTO offer_counteroffers(id,offer_id,created_by,amount_cents,note) VALUES($1,$2,$3,$4,$5)',[cid,oid,req.user.id,cents,optional(req.body.note,1000)]);await sendEvent(o.user_id,'Seller counteroffer','A property seller has responded to your offer. Review the proposal in your account.','/portal',`counter:${cid}`);res.json({ok:true});
 }));
}
