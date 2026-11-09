import {installTrust,requireReviewerStepUp} from './trust.mjs';
import {installInquiries} from './inquiries.mjs';
import {installVerification} from './verification.mjs';
import {installPremium,installSellerTools,onPropertySaved,onPhotoUpload,onTourStatus} from './premium.mjs';
import {beginLoginMfa,installAccountMfa} from './premium-auth.mjs';
import {installReceipts} from './receipt.mjs';
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {enabled,initDatabase,query,publicProperty,fallbackProperties} from './db.mjs';
import {newId,randomToken,sha256,hashPassword,verifyPassword,validEmail,safeText,validUuid,toCents,fromCents} from './security.mjs';
import {geocodeUsAddress,validCoordinates} from './geocode.mjs';
import {syncReso,getResoConfig} from './mls.mjs';
import {getPayPalConfig,createPayPalClient,assertCompletedOrder} from './paypal.mjs';
const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use(helmet({referrerPolicy:{policy:'strict-origin-when-cross-origin'},contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'","https://www.paypal.com"],styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com","https://www.paypal.com"],frameSrc:["https://www.paypal.com","https://www.sandbox.paypal.com"],fontSrc:["'self'","https://fonts.gstatic.com"],imgSrc:["'self'","data:","blob:","https:"],connectSrc:["'self'","https://www.paypal.com","https://www.sandbox.paypal.com"],objectSrc:["'none'"],frameAncestors:["'none'"]}}}));
app.use((req,res,next)=>{res.set('Permissions-Policy','camera=(self), microphone=()');next();});
app.use(express.json({limit:'100kb'}));app.use(cookieParser());
app.use('/api/auth',rateLimit({windowMs:15*60*1000,limit:35,standardHeaders:'draft-7',legacyHeaders:false}));
app.use('/api/inquiries',rateLimit({windowMs:60*60*1000,limit:25,standardHeaders:'draft-7',legacyHeaders:false}));
app.post('/api/chat',rateLimit({windowMs:60*60*1000,limit:35,standardHeaders:'draft-7',legacyHeaders:false}));
const fail=(status,error)=>Object.assign(Error(error),{status});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const ok=(res,data)=>res.json(data);
const validType=(v,allowed,label='Value')=>{if(!allowed.includes(v))throw fail(400,`${label} is invalid.`);return v;};
const limit=(v,max=180)=>safeText(v,max);
const checkId=(id)=>{if(!validUuid(id))throw fail(400,'Invalid identifier.');return id;};
const required=(v,label,max=250)=>{const t=limit(v,max);if(!t)throw fail(400,`${label} is required.`);return t;};
const checkEmail=(e)=>{const value=String(e||'').trim().toLowerCase();if(!validEmail(value))throw fail(400,'Enter a valid email address.');return value;};
const money=(v)=>{try{return toCents(v);}catch(e){throw fail(400,e.message);}};
function normalizeProperty(p){let images=Array.isArray(p.images)?p.images:[];let features=Array.isArray(p.features)?p.features:[];return {...publicProperty(p),images,features};}
async function session(req,res,next){req.user=null;const token=req.cookies?.covalyn_session;if(token&&enabled){const r=await query('SELECT u.id,u.name,u.email,u.phone,u.role,u.account_type FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[sha256(token)]);req.user=r.rows[0]||null;}next();}
app.use('/api',(req,res,next)=>Promise.resolve(session(req,res,next)).catch(next));
function loginRequired(req,res,next){if(!req.user)return next(fail(401,'Please sign in to continue.'));next();}
function adminRequired(req,res,next){if(req.user?.role!=='admin')return next(fail(403,'Administrator access required.'));next();}
function requireDb(req,res,next){if(!enabled)return next(fail(503,'This service is temporarily unavailable. Please try again later.'));next();}
function originGuard(req,res,next){if(!['GET','HEAD','OPTIONS'].includes(req.method)&&process.env.NODE_ENV==='production'){
const origin=req.get('origin'),host=req.get('x-forwarded-host')||req.get('host');
if(origin){try{const url=new URL(origin);const expected=process.env.PUBLIC_ORIGIN?new URL(process.env.PUBLIC_ORIGIN).host:host;if(url.host!==expected)return next(fail(403,'Request origin was rejected.'));}catch{return next(fail(403,'Invalid request origin.'));}}
}next();}
app.use('/api',originGuard);
app.get('/api/health',wrap(async(req,res)=>{if(!enabled)return res.json({ok:true,mode:'preview',database:false});try{await query('SELECT 1');return res.json({ok:true,mode:'live',database:true});}catch{return res.status(503).json({ok:false,database:false});}}));
app.get('/api/config',(req,res)=>ok(res,{live:enabled,currency:'USD',name:'Covalyn Homes',country:'US',mlsConnected:getResoConfig().configured,mlsDisclaimer:getResoConfig().disclaimer,paypalEnabled:getPayPalConfig().enabled,paypalMode:getPayPalConfig().mode}));
app.get('/api/properties',wrap(async(req,res)=>{const rows=enabled?(await query("SELECT * FROM properties WHERE status != 'hidden' AND demo=false ORDER BY featured DESC,created_at DESC LIMIT 500")).rows:fallbackProperties();ok(res,{properties:rows.map(normalizeProperty),demo:!enabled});}));
app.get('/api/properties/:id',wrap(async(req,res)=>{checkId(req.params.id);let rows=enabled?(await query("SELECT * FROM properties WHERE id=$1 AND status!='hidden' AND demo=false",[req.params.id])).rows:fallbackProperties().filter(p=>p.id===req.params.id);if(!rows.length)throw fail(404,'Property not found.');ok(res,{property:normalizeProperty(rows[0])});}));
app.get('/api/images/:id',wrap(async(req,res)=>{checkId(req.params.id);const r=await query('SELECT content_type,body FROM property_images WHERE id=$1',[req.params.id]);if(!r.rowCount)throw fail(404,'Photo not found.');res.set({'Content-Type':r.rows[0].content_type,'Cache-Control':'public,max-age=86400','X-Content-Type-Options':'nosniff'}).send(r.rows[0].body);}));
async function createSession(res,user){const token=randomToken();await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '14 days')",[sha256(token),user.id]);res.cookie('covalyn_session',token,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',path:'/',maxAge:14*24*60*60*1000});}
app.get('/api/me',(req,res)=>ok(res,{user:req.user||null}));

installVerification(app,{requireDb,loginRequired,adminRequired,hashPassword,createSession,checkEmail,required,limit,requireReviewerStepUp});
app.post('/api/auth/login',requireDb,wrap(async(req,res)=>{const email=checkEmail(req.body.email),pass=String(req.body.password||'');const r=await query('SELECT * FROM users WHERE email=$1',[email]);if(!r.rows[0]||!verifyPassword(pass,r.rows[0].password_hash))throw fail(401,'Incorrect email or password.');const u=r.rows[0];if(await beginLoginMfa(res,u))return ok(res,{mfaRequired:true});await createSession(res,u);ok(res,{user:{id:u.id,name:u.name,email:u.email,phone:u.phone,role:u.role,account_type:u.account_type}});}));
app.post('/api/auth/logout',requireDb,wrap(async(req,res)=>{if(req.cookies?.covalyn_session){const h=sha256(req.cookies.covalyn_session);await query('DELETE FROM reviewer_stepups WHERE token_hash=$1',[h]);await query('DELETE FROM sessions WHERE token_hash=$1',[h]);}res.clearCookie('covalyn_session',{path:'/'});ok(res,{ok:true});}));
app.post('/api/auth/change-password',requireDb,loginRequired,wrap(async(req,res)=>{const old=String(req.body.current||''),next=String(req.body.next||'');const r=await query('SELECT password_hash FROM users WHERE id=$1',[req.user.id]);if(!verifyPassword(old,r.rows[0].password_hash))throw fail(401,'Current password does not match.');if(next.length<8||next.length>200)throw fail(400,'Use a password with 8 to 200 characters.');await query('UPDATE users SET password_hash=$2 WHERE id=$1',[req.user.id,hashPassword(next)]);ok(res,{ok:true});}));
installInquiries(app,{requireDb,query,required,checkEmail,limit,money});
app.post('/api/tours',rateLimit({windowMs:60*60*1000,limit:25}),requireDb,wrap(async(req,res)=>{const b=req.body;checkId(b.propertyId);const date=String(b.date||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T23:59:59Z').getTime()<Date.now())throw fail(400,'Choose a future date.');const time=required(b.time,'Preferred time',45),name=required(b.name,'Name',90),email=checkEmail(b.email);await query('INSERT INTO tours(id,property_id,user_id,name,email,phone,preferred_date,preferred_time,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[newId(),b.propertyId,req.user?.id||null,name,email,limit(b.phone,35),date,time,limit(b.notes,1000)]);ok(res,{ok:true,message:'Tour requested. The team can review it in the admin dashboard.'});}));
app.post('/api/offers',rateLimit({windowMs:60*60*1000,limit:25}),requireDb,wrap(async(req,res)=>{const b=req.body;checkId(b.propertyId);const amount=money(b.amount);if(amount<100)throw fail(400,'Offer amount must be greater than zero.');await query('INSERT INTO offers(id,property_id,user_id,name,email,phone,amount_cents,financing,message) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[newId(),b.propertyId,req.user?.id||null,required(b.name,'Name',90),checkEmail(b.email),limit(b.phone,35),amount,validType(b.financing||'not-specified',['cash','mortgage','not-specified'],'Financing'),limit(b.message,1000)]);ok(res,{ok:true,message:'Offer submitted to the Covalyn Homes admin team. This is not a binding purchase contract.'});}));
app.get('/api/my/overview',requireDb,loginRequired,wrap(async(req,res)=>{const uid=req.user.id;const [f,t,o,q,tx]=await Promise.all([query('SELECT p.* FROM favorites f JOIN properties p ON p.id=f.property_id WHERE f.user_id=$1',[uid]),query('SELECT t.*,p.title,p.city,p.state FROM tours t JOIN properties p ON p.id=t.property_id WHERE t.user_id=$1 OR t.email=$2 ORDER BY t.created_at DESC',[uid,req.user.email]),query('SELECT o.*,p.title FROM offers o JOIN properties p ON p.id=o.property_id WHERE o.user_id=$1 OR o.email=$2 ORDER BY o.created_at DESC',[uid,req.user.email]),query("SELECT i.*,p.title FROM inquiries i LEFT JOIN properties p ON p.id=i.property_id WHERE i.user_id=$1 OR (i.kind<>'selling' AND i.email=$2) ORDER BY i.created_at DESC",[uid,req.user.email]),query('SELECT t.*,p.title,p.city,p.state,(SELECT COALESCE(sum(amount_cents),0) FROM payments WHERE transaction_id=t.id) AS paid_cents FROM transactions t JOIN properties p ON p.id=t.property_id WHERE t.user_id=$1 OR p.seller_user_id=$1 ORDER BY t.created_at DESC',[uid])]);ok(res,{favorites:f.rows.map(normalizeProperty),tours:t.rows,offers:o.rows.map(x=>({...x,amount:fromCents(x.amount_cents)})),inquiries:q.rows,transactions:tx.rows.map(x=>({...x,agreed_price:fromCents(x.agreed_price_cents),paid:fromCents(x.paid_cents)}))});}));
app.post('/api/my/favorites/:id',requireDb,loginRequired,wrap(async(req,res)=>{await query('INSERT INTO favorites(user_id,property_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[req.user.id,checkId(req.params.id)]);ok(res,{ok:true});}));
app.delete('/api/my/favorites/:id',requireDb,loginRequired,wrap(async(req,res)=>{await query('DELETE FROM favorites WHERE user_id=$1 AND property_id=$2',[req.user.id,checkId(req.params.id)]);ok(res,{ok:true});}));
function visitorHash(req){
 // Authenticated buyers have one server-bound inbox across browsers and devices.
 if(req.user?.role==='client')return sha256('account:'+req.user.id);
 const t=String(req.query.token||req.body?.token||'');
 if(!/^[a-f\d-]{32,64}$/i.test(t))throw fail(400,'Chat token is missing or invalid.');
 return sha256('guest:'+t);
}
app.get('/api/chat',requireDb,wrap(async(req,res)=>{
 const hash=visitorHash(req),c=await query('SELECT id FROM conversations WHERE visitor_hash=$1',[hash]);
 if(!c.rowCount)return ok(res,{messages:[]});
 const m=await query('SELECT id,sender,body,created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC LIMIT 300',[c.rows[0].id]);
 ok(res,{messages:m.rows});
}));
app.post('/api/chat',requireDb,wrap(async(req,res)=>{
 const hash=visitorHash(req),body=required(req.body.message,'Message',3000);
 const name=req.user?.name||limit(req.body.name,90)||'Guest visitor';
 const email=req.user?.email|| (req.body.email?checkEmail(req.body.email):'');
 let conv=await query('SELECT id FROM conversations WHERE visitor_hash=$1',[hash]);
 if(!conv.rowCount){
  await query('INSERT INTO conversations(id,visitor_hash,user_id,guest_name,guest_email) VALUES($1,$2,$3,$4,$5) ON CONFLICT(visitor_hash) DO NOTHING',[newId(),hash,req.user?.role==='client'?req.user.id:null,name,email]);
  conv=await query('SELECT id FROM conversations WHERE visitor_hash=$1',[hash]);
 }
 const id=conv.rows[0].id;
 await query('INSERT INTO messages(id,conversation_id,sender,body) VALUES($1,$2,$3,$4)',[newId(),id,'client',body]);
 await query("UPDATE conversations SET updated_at=now(),status='open' WHERE id=$1",[id]);
 ok(res,{ok:true});
}));
// Admin-only business APIs. All writes are persisted to Supabase PostgreSQL.

// PayPal checkout applies only to explicit, admin-issued service invoices.
// Property prices, offers, earnest money, down payments and closing funds are NOT charged here.
const paidInvoice=(r)=>({...r,amount:fromCents(r.amount_cents),currency:'USD',amount_cents:undefined});
const paypalOrderId=(s)=>{if(!/^[A-Z0-9]{8,40}$/.test(String(s)))throw fail(400,'Invalid PayPal order ID.');return s;};
app.get('/api/paypal/config',(req,res)=>{const c=getPayPalConfig();res.set('Cache-Control','no-store');ok(res,{enabled:c.enabled,clientId:c.enabled?c.clientId:null,mode:c.mode,currency:'USD'});});
app.get('/api/my/invoices',requireDb,loginRequired,wrap(async(req,res)=>{
 const result=await qList('SELECT id,property_id,description,amount_cents,currency,status,paypal_capture_id,paid_at,created_at FROM service_invoices WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200',[req.user.id]);
 ok(res,{invoices:result.map(paidInvoice)});
}));
app.post('/api/paypal/orders',rateLimit({windowMs:15*60*1000,limit:15}),requireDb,loginRequired,wrap(async(req,res)=>{
 const id=checkId(req.body.invoiceId),a=await query('SELECT * FROM service_invoices WHERE id=$1 AND user_id=$2',[id,req.user.id]);
 if(!a.rowCount)throw fail(404,'Invoice not found.');const invoice=a.rows[0];
 if(invoice.status!=='open')throw fail(409,'This invoice cannot be paid.');
 const paypal=createPayPalClient();
 // Reuse a recently created order to avoid multiple checkout attempts for the same invoice.
 if(invoice.paypal_order_id&&invoice.paypal_order_created_at&&Date.now()-new Date(invoice.paypal_order_created_at).getTime()<2*60*60*1000)return ok(res,{id:invoice.paypal_order_id});
 const order=await paypal.createOrder(invoice,newId());
 if(!/^[A-Z0-9]{8,40}$/.test(String(order.id||'')))throw fail(502,'PayPal did not return a valid order ID.');
 const update=await query("UPDATE service_invoices SET paypal_order_id=$2,paypal_order_created_at=now() WHERE id=$1 AND status='open' AND (paypal_order_id IS NOT DISTINCT FROM $3) RETURNING paypal_order_id",[id,order.id,invoice.paypal_order_id]);
 if(!update.rowCount){const current=await query('SELECT status,paypal_order_id FROM service_invoices WHERE id=$1',[id]);if(current.rows[0]?.status==='open'&&current.rows[0]?.paypal_order_id)return ok(res,{id:current.rows[0].paypal_order_id});throw fail(409,'Invoice status changed during checkout.');}
 ok(res,{id:order.id});
}));
app.post('/api/paypal/orders/:orderId/capture',rateLimit({windowMs:15*60*1000,limit:15}),requireDb,loginRequired,wrap(async(req,res)=>{
 const orderId=paypalOrderId(req.params.orderId),r=await query('SELECT * FROM service_invoices WHERE paypal_order_id=$1 AND user_id=$2',[orderId,req.user.id]);
 if(!r.rowCount)throw fail(404,'Invoice was not found for this account.');const invoice=r.rows[0];
 if(invoice.status==='paid')return ok(res,{ok:true,status:'paid',invoiceId:invoice.id});
 if(invoice.status!=='open')throw fail(409,'This invoice is not open for payment.');
 const paypal=createPayPalClient();let order;
 try{order=await paypal.captureOrder(orderId,invoice.id);}catch(e){
  // An interrupted capture can succeed upstream; reconcile with PayPal before prompting a retry.
  try{order=await paypal.getOrder(orderId);if(order.status!=='COMPLETED')throw e;}catch{throw e;}
 }
 const verified=assertCompletedOrder(order,invoice);
 if(verified.orderId!==orderId)throw fail(409,'PayPal order ID changed.');
 const update=await query("UPDATE service_invoices SET status='paid',paypal_capture_id=$2,paypal_payer_id=$3,paid_at=now() WHERE id=$1 AND status='open' AND paypal_order_id=$4 RETURNING id",[invoice.id,verified.captureId,verified.payerId,orderId]);
 if(!update.rowCount){const latest=await query('SELECT status FROM service_invoices WHERE id=$1',[invoice.id]);if(latest.rows[0]?.status!=='paid')throw fail(409,'Invoice could not be settled. Contact the administrator before paying again.');}
 ok(res,{ok:true,status:'paid',invoiceId:invoice.id,captureId:verified.captureId});
}));
app.post('/api/paypal/webhook',rateLimit({windowMs:60*1000,limit:120}),requireDb,wrap(async(req,res)=>{
 const paypal=createPayPalClient();await paypal.verifyWebhook(req.headers,req.body);
 const event=req.body||{},type=event.event_type||'',resource=event.resource||{};
 if(type==='PAYMENT.CAPTURE.COMPLETED'){
  const id=resource.supplementary_data?.related_ids?.order_id;
  if(id&&/^[A-Z0-9]{8,40}$/.test(String(id))){
   const invoices=await query('SELECT * FROM service_invoices WHERE paypal_order_id=$1',[id]);
   if(invoices.rowCount){const invoice=invoices.rows[0],order=await paypal.getOrder(id),v=assertCompletedOrder(order,invoice);
    if(v.captureId===resource.id)await query("UPDATE service_invoices SET status='paid',paypal_capture_id=$2,paypal_payer_id=$3,paid_at=COALESCE(paid_at,now()) WHERE id=$1 AND status='open'",[invoice.id,v.captureId,v.payerId]);
   }
  }
 }
 if(type==='PAYMENT.CAPTURE.REFUNDED'||type==='PAYMENT.CAPTURE.REVERSED'){
  const captureId=resource.supplementary_data?.related_ids?.capture_id;
  if(captureId){const invoice=await query("SELECT * FROM service_invoices WHERE paypal_capture_id=$1 AND status='paid'",[captureId]);
   // Only a full-amount reversal is marked refunded. Partial refunds need manual reconciliation.
   if(invoice.rowCount&&resource.amount?.currency_code==='USD'&&money(resource.amount.value)>=Number(invoice.rows[0].amount_cents))await query("UPDATE service_invoices SET status='refunded' WHERE id=$1 AND status='paid'",[invoice.rows[0].id]);
  }
 }
 ok(res,{ok:true});
}));
app.use('/api/admin',requireDb,adminRequired);
const qList=(sql,p=[])=>query(sql,p).then(x=>x.rows);
app.get('/api/admin/summary',wrap(async(req,res)=>{const a=await Promise.all([qList('SELECT count(*)::int n FROM properties'),qList("SELECT count(*)::int n FROM inquiries WHERE status='new'"),qList("SELECT count(*)::int n FROM tours WHERE status='requested'"),qList("SELECT count(*)::int n FROM offers WHERE status='received'"),qList('SELECT count(*)::int n FROM users WHERE role=\'client\''),qList('SELECT count(*)::int n FROM conversations'),qList('SELECT count(*)::int n FROM transactions')]);ok(res,{properties:a[0][0].n,inquiries:a[1][0].n,tours:a[2][0].n,offers:a[3][0].n,clients:a[4][0].n,conversations:a[5][0].n,transactions:a[6][0].n});}));
app.get('/api/admin/properties',wrap(async(req,res)=>ok(res,{properties:(await qList('SELECT * FROM properties ORDER BY created_at DESC')).map(normalizeProperty)})));
const usStates=new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC PR GU VI AS MP'.split(' '));
function propertyInput(b){const title=required(b.title,'Title',130),city=required(b.city,'City',80),state=required(b.state,'State',2).toUpperCase(),price=money(b.price);if(!usStates.has(state))throw fail(400,'Enter a valid U.S. state or territory abbreviation.');if(price<10000)throw fail(400,'Enter a realistic positive USD price.');const type=validType(b.type||'Single-family',['Single-family','Condo','Townhouse','Luxury','Multi-family','Land','New construction'],'Property type'),status=validType(b.status||'available',['available','under-contract','sold','hidden'],'Status');const beds=Number(b.beds||0),baths=Number(b.baths||0),sqft=Number(b.sqft||0),year=Number(b.year_built||0);if(![beds,baths,sqft,year].every(Number.isFinite)||beds<0||baths<0||sqft<0||beds>100||baths>100||sqft>10000000||year<0||year>2200)throw fail(400,'Invalid property dimensions.');const arr=x=>Array.isArray(x)?x:typeof x==='string'?x.split(','):[];const features=arr(b.features).map(x=>limit(x,80)).filter(Boolean).slice(0,30),images=arr(b.images).map(x=>limit(x,800)).filter(x=>/^https:\/\//.test(x)||/^\/api\/images\/[0-9a-f-]{36}$/.test(x)).slice(0,24);const lat=b.lat===''||b.lat===null||b.lat===undefined?null:Number(b.lat),lng=b.lng===''||b.lng===null||b.lng===undefined?null:Number(b.lng);
if((lat!==null||lng!==null)&&!validCoordinates(lat,lng))throw fail(400,'Provide both valid U.S. latitude and longitude values or leave both empty.');
return [title,city,state,limit(b.address,180),limit(b.zip_code,20),price,Math.round(beds),baths,Math.round(sqft),b.lot_sqft?Math.round(Number(b.lot_sqft)):null,year||null,type,status,limit(b.description,7000),JSON.stringify(features),JSON.stringify(images),Boolean(b.featured),lat,lng];}
async function addCoordinates(d){
 if(d[17]!==null&&d[18]!==null)return;
 const geo=await geocodeUsAddress({address:d[3],city:d[1],state:d[2],zip_code:d[4]});
 if(geo){d[17]=geo.lat;d[18]=geo.lng;}
}
app.post('/api/admin/geocode',rateLimit({windowMs:60*1000,limit:12}),wrap(async(req,res)=>{
 const b=req.body||{},address=required(b.address,'Street address',180),city=required(b.city,'City',80),state=required(b.state,'State',2).toUpperCase();
 if(!usStates.has(state))throw fail(400,'Enter a valid U.S. state or territory abbreviation.');
 const result=await geocodeUsAddress({address,city,state,zip_code:limit(b.zip_code,20)});
 if(!result)throw fail(404,'No U.S. Census coordinate match found. Enter the coordinates manually if needed.');
 ok(res,result);
}));
app.post('/api/admin/properties',wrap(async(req,res)=>{
 const d=propertyInput(req.body),id=newId();await addCoordinates(d);
 const r=await query('INSERT INTO properties(id,title,city,state,address,zip_code,price_cents,beds,baths,sqft,lot_sqft,year_built,type,status,description,features,images,featured,lat,lng,demo,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,false,\'manual\') RETURNING *',[id,...d]);await onPropertySaved(r.rows[0]);
 ok(res,{property:normalizeProperty(r.rows[0])});
}));
app.put('/api/admin/properties/:id',wrap(async(req,res)=>{
 const id=checkId(req.params.id),existing=await query('SELECT source,lat,lng,address,city,state,zip_code,price_cents FROM properties WHERE id=$1',[id]);
 if(!existing.rowCount)throw fail(404,'Property not found.');
 if(existing.rows[0].source==='mls')throw fail(403,'MLS listings are managed from the authorized feed, not the manual editor.');
 const d=propertyInput(req.body);
 if(d[17]===null&&d[18]===null&&d[3]===existing.rows[0].address&&d[1]===existing.rows[0].city&&d[2]===existing.rows[0].state){d[17]=existing.rows[0].lat;d[18]=existing.rows[0].lng;}
 await addCoordinates(d);
 const r=await query('UPDATE properties SET title=$2,city=$3,state=$4,address=$5,zip_code=$6,price_cents=$7,beds=$8,baths=$9,sqft=$10,lot_sqft=$11,year_built=$12,type=$13,status=$14,description=$15,features=$16,images=$17,featured=$18,lat=$19,lng=$20,demo=false,updated_at=now() WHERE id=$1 RETURNING *',[id,...d]);await onPropertySaved(r.rows[0],existing.rows[0]);
 ok(res,{property:normalizeProperty(r.rows[0])});
}));
app.delete('/api/admin/properties/:id',wrap(async(req,res)=>{const p=await query('SELECT id FROM properties WHERE id=$1',[checkId(req.params.id)]);if(!p.rowCount)throw fail(404,'Property not found.');await query("UPDATE properties SET status='hidden' WHERE id=$1",[req.params.id]);ok(res,{ok:true});}));
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:4*1024*1024,files:1}});
function inspectImage(file){if(!file)throw fail(400,'Select an image to upload.');const x=file.buffer;const jpg=x.length>3&&x[0]===0xff&&x[1]===0xd8&&x[2]===0xff;const png=x.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const webp=x.length>12&&x.toString('ascii',0,4)==='RIFF'&&x.toString('ascii',8,12)==='WEBP';const mime=jpg?'image/jpeg':png?'image/png':webp?'image/webp':null;if(!mime)throw fail(400,'Upload a JPEG, PNG or WebP image under 4 MB.');return mime;}
app.post('/api/admin/properties/:id/images',upload.single('image'),wrap(async(req,res)=>{const propertyId=checkId(req.params.id),mime=inspectImage(req.file);const p=await query('SELECT images FROM properties WHERE id=$1',[propertyId]);if(!p.rowCount)throw fail(404,'Property not found.');const images=p.rows[0].images||[];if(images.length>=24)throw fail(400,'A property can contain up to 24 images.');const id=newId(),src='/api/images/'+id;await query('INSERT INTO property_images(id,property_id,content_type,body,filename) VALUES($1,$2,$3,$4,$5)',[id,propertyId,mime,req.file.buffer,limit(req.file.originalname,150)]);await onPhotoUpload(propertyId,id,req.file.buffer);await query('UPDATE properties SET images=images || $2::jsonb,updated_at=now() WHERE id=$1',[propertyId,JSON.stringify([src])]);ok(res,{ok:true,url:src});}));
app.get('/api/admin/inquiries',wrap(async(req,res)=>ok(res,{items:await qList('SELECT i.*,p.title FROM inquiries i LEFT JOIN properties p ON p.id=i.property_id ORDER BY i.created_at DESC LIMIT 500')})));
app.get('/api/admin/tours',wrap(async(req,res)=>ok(res,{items:await qList('SELECT t.*,p.title FROM tours t LEFT JOIN properties p ON p.id=t.property_id ORDER BY t.created_at DESC LIMIT 500')})));
app.get('/api/admin/offers',wrap(async(req,res)=>ok(res,{items:(await qList('SELECT o.*,p.title FROM offers o LEFT JOIN properties p ON p.id=o.property_id ORDER BY o.created_at DESC LIMIT 500')).map(x=>({...x,amount:fromCents(x.amount_cents)}))})));
const statuses={inquiries:['new','contacted','closed'],tours:['requested','confirmed','completed','cancelled'],offers:['received','reviewing','accepted','declined']};
for(const [table,allowed] of Object.entries(statuses))app.patch('/api/admin/'+table+'/:id',wrap(async(req,res)=>{const s=validType(req.body.status,allowed,'Status');const r=await query(`UPDATE ${table} SET status=$2 WHERE id=$1 RETURNING id`,[checkId(req.params.id),s]);if(!r.rowCount)throw fail(404,'Record not found.');if(table==='tours')await onTourStatus(req.params.id,s);ok(res,{ok:true});}));
app.get('/api/admin/mls',wrap(async(req,res)=>{
 const cfg=getResoConfig();const last=await qList('SELECT provider,imported,pages,complete,error,created_at FROM mls_sync_runs ORDER BY created_at DESC LIMIT 8');
 ok(res,{configured:cfg.configured,authorized:cfg.authorized,source:cfg.source,attribution:cfg.attribution,disclaimer:cfg.disclaimer,lastSyncs:last});
}));
let syncInProgress=false;
app.post('/api/admin/mls/sync',rateLimit({windowMs:60*1000,limit:2}),wrap(async(req,res)=>{
 if(syncInProgress)throw fail(409,'A feed sync is already in progress.');
 const cfg=getResoConfig();if(!cfg.configured)throw fail(409,'An authorized MLS feed is required before listings can be synchronized.');
 syncInProgress=true;
 try{
  const result=await syncReso({query});
  await query('INSERT INTO mls_sync_runs(id,provider,imported,pages,complete) VALUES($1,$2,$3,$4,$5)',[newId(),result.source,result.imported,result.pages,result.complete]);
  ok(res,result);
 }catch(e){
  await query('INSERT INTO mls_sync_runs(id,provider,error) VALUES($1,$2,$3)',[newId(),cfg.source,limit(e.message,500)]);
  throw fail(502,'MLS sync failed: '+limit(e.message,250));
 }finally{syncInProgress=false;}
}));

app.get('/api/admin/invoices',wrap(async(req,res)=>{
 const items=await qList('SELECT i.*,u.name AS client_name,u.email AS client_email,p.title AS property_title FROM service_invoices i JOIN users u ON u.id=i.user_id LEFT JOIN properties p ON p.id=i.property_id ORDER BY i.created_at DESC LIMIT 300');
 ok(res,{invoices:items.map(paidInvoice),paypalConfigured:getPayPalConfig().enabled,mode:getPayPalConfig().mode});
}));
app.post('/api/admin/invoices',wrap(async(req,res)=>{
 const userId=checkId(req.body.userId),description=required(req.body.description,'Service description',200),amount=money(req.body.amount);
 if(amount<100||amount>999999)throw fail(400,'Service invoices must be from $1.00 to $9,999.99 USD.');
 const u=await query("SELECT id FROM users WHERE id=$1 AND role='client'",[userId]);if(!u.rowCount)throw fail(400,'Select a registered buyer.');
 const propertyId=req.body.propertyId?checkId(req.body.propertyId):null;
 if(propertyId){const p=await query('SELECT id FROM properties WHERE id=$1',[propertyId]);if(!p.rowCount)throw fail(400,'Property not found.');}
 const id=newId();await query('INSERT INTO service_invoices(id,user_id,property_id,description,amount_cents) VALUES($1,$2,$3,$4,$5)',[id,userId,propertyId,description,amount]);
 ok(res,{ok:true,id});
}));
app.post('/api/admin/invoices/:id/cancel',wrap(async(req,res)=>{
 const id=checkId(req.params.id),r=await query("UPDATE service_invoices SET status='cancelled' WHERE id=$1 AND status='open' AND paypal_order_id IS NULL RETURNING id",[id]);
 if(!r.rowCount)throw fail(409,'Only open invoices without an initiated PayPal checkout can be cancelled. Reconcile active checkouts first.');ok(res,{ok:true});
}));
app.get('/api/admin/users',wrap(async(req,res)=>ok(res,{users:await qList("SELECT id,name,email,phone,role,account_type,created_at FROM users ORDER BY created_at DESC LIMIT 300")})));
app.get('/api/admin/conversations',wrap(async(req,res)=>ok(res,{items:await qList("SELECT c.id,c.guest_name,c.guest_email,c.status,c.updated_at,u.name AS account_name,(SELECT body FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message,(SELECT count(*)::int FROM messages WHERE conversation_id=c.id) AS message_count FROM conversations c LEFT JOIN users u ON u.id=c.user_id ORDER BY c.updated_at DESC LIMIT 300")})));
app.get('/api/admin/conversations/:id',wrap(async(req,res)=>{const id=checkId(req.params.id);ok(res,{messages:await qList('SELECT id,sender,body,created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC',[id])});}));
app.post('/api/admin/conversations/:id/reply',wrap(async(req,res)=>{const id=checkId(req.params.id),body=required(req.body.message,'Reply',3000);await query('INSERT INTO messages(id,conversation_id,sender,body) VALUES($1,$2,$3,$4)',[newId(),id,'admin',body]);await query('UPDATE conversations SET updated_at=now() WHERE id=$1',[id]);ok(res,{ok:true});}));
app.patch('/api/admin/conversations/:id',wrap(async(req,res)=>{const status=validType(req.body.status,['open','closed'],'Conversation status');await query('UPDATE conversations SET status=$2 WHERE id=$1',[checkId(req.params.id),status]);ok(res,{ok:true});}));
app.get('/api/admin/transactions',wrap(async(req,res)=>ok(res,{items:(await qList('SELECT t.*,p.title,u.name AS client_name,u.email AS client_email,(SELECT COALESCE(sum(amount_cents),0) FROM payments WHERE transaction_id=t.id) AS paid_cents FROM transactions t JOIN properties p ON p.id=t.property_id JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC LIMIT 300')).map(x=>({...x,agreed_price:fromCents(x.agreed_price_cents),paid:fromCents(x.paid_cents)}))})));
app.post('/api/admin/transactions',wrap(async(req,res)=>{const b=req.body,id=newId(),propertyId=checkId(b.propertyId),userId=checkId(b.userId),amount=money(b.agreedPrice),stage=required(b.stage||'Offer accepted','Stage',90);await query('INSERT INTO transactions(id,property_id,user_id,agreed_price_cents,stage,closing_date,note) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,propertyId,userId,amount,stage,b.closingDate||null,limit(b.note,1000)]);await query('INSERT INTO transaction_events(id,transaction_id,stage,note) VALUES($1,$2,$3,$4)',[newId(),id,stage,limit(b.note,1000)]);ok(res,{ok:true,id});}));
app.patch('/api/admin/transactions/:id',wrap(async(req,res)=>{const id=checkId(req.params.id),stage=required(req.body.stage,'Stage',90),note=limit(req.body.note,1000);await query('UPDATE transactions SET stage=$2,note=$3,updated_at=now() WHERE id=$1',[id,stage,note]);await query('INSERT INTO transaction_events(id,transaction_id,stage,note) VALUES($1,$2,$3,$4)',[newId(),id,stage,note]);ok(res,{ok:true});}));
app.post('/api/admin/transactions/:id/payments',wrap(async(req,res)=>{const id=checkId(req.params.id),amount=money(req.body.amount),reference=required(req.body.reference,'Payment reference',90),method=required(req.body.method,'Payment method',45);const evidence=required(req.body.evidenceReference,'Independent payment evidence reference',200);if(!amount)throw fail(400,'Amount must exceed zero.');const client=await (await import('./db.mjs')).pool.connect();try{await client.query('BEGIN');const tx=await client.query('SELECT agreed_price_cents FROM transactions WHERE id=$1 FOR UPDATE',[id]);if(!tx.rowCount)throw fail(404,'Transaction not found.');const paid=await client.query('SELECT COALESCE(sum(amount_cents),0) AS n FROM payments WHERE transaction_id=$1',[id]);if(Number(paid.rows[0].n)+amount>Number(tx.rows[0].agreed_price_cents))throw fail(400,'Payment would exceed agreed purchase price.');await client.query('INSERT INTO payments(id,transaction_id,amount_cents,method,reference,evidence_reference,verified_by,verified_at) VALUES($1,$2,$3,$4,$5,$6,$7,now())',[newId(),id,amount,method,reference,evidence,req.user.id]);await client.query('COMMIT');ok(res,{ok:true});}catch(e){await client.query('ROLLBACK');if(e.code==='23505')throw fail(409,'Payment reference has already been recorded.');throw e;}finally{client.release();}}));
app.get('/api/my/transactions/:id',requireDb,loginRequired,wrap(async(req,res)=>{const id=checkId(req.params.id),tx=await qList('SELECT t.*,p.title FROM transactions t JOIN properties p ON p.id=t.property_id WHERE t.id=$1 AND (t.user_id=$2 OR p.seller_user_id=$2)',[id,req.user.id]);if(!tx.length)throw fail(404,'Transaction not found.');const [events,payments]=await Promise.all([qList('SELECT stage,note,created_at FROM transaction_events WHERE transaction_id=$1 ORDER BY created_at DESC',[id]),qList('SELECT id,amount_cents,method,reference,created_at,verified_at FROM payments WHERE transaction_id=$1 ORDER BY created_at DESC',[id])]);ok(res,{transaction:{...tx[0],agreed_price:fromCents(tx[0].agreed_price_cents)},events,payments:payments.map(p=>({...p,amount:fromCents(p.amount_cents)}))});}));
installTrust(app,{requireDb,loginRequired,adminRequired});
installAccountMfa(app,{requireDb,loginRequired,createSession});
installPremium(app,{requireDb,loginRequired,adminRequired});
installSellerTools(app,{requireDb,loginRequired});
installReceipts(app,{requireDb,loginRequired,adminRequired});
const here=dirname(fileURLToPath(import.meta.url));app.use(express.static(resolve(here,'../public'),{maxAge:'10m',setHeaders(res,path){if(path.endsWith('.html'))res.set('Cache-Control','no-cache');}}));app.get('*',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'Page not found.'});res.set('Cache-Control','no-cache').sendFile(resolve(here,'../public/index.html'));});
app.use((err,req,res,next)=>{if(err instanceof multer.MulterError)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Images must be under 4 MB.':err.message});const status=err.status||500;if(status>=500)console.error(err);res.status(status).json({error:status>=500?(status===503?'This service is temporarily unavailable. Please try again later.':'We could not complete your request. Please try again shortly.'):err.message});});
const port=Number(process.env.PORT||3000);
try{await initDatabase();app.listen(port,'0.0.0.0',()=>console.log(`Covalyn Homes running on port ${port}${enabled?' with Supabase PostgreSQL':' (preview mode)'}`));}catch(error){console.error('Startup error:',error.message);process.exit(1);}
