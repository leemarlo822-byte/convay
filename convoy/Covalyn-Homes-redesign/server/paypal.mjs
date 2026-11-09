// PayPal Orders v2: credentials and all monetary decisions stay on the server.
import {toCents} from './security.mjs';
const error=(status,message)=>Object.assign(new Error(message),{status});
export function getPayPalConfig(env=process.env){
 const mode=env.PAYPAL_MODE==='live'?'live':'sandbox';
 const clientId=String(env.PAYPAL_CLIENT_ID||'').trim();
 const secret=String(env.PAYPAL_CLIENT_SECRET||'').trim();
 return {enabled:!!(clientId&&secret),clientId,mode,base:mode==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com',webhookConfigured:!!env.PAYPAL_WEBHOOK_ID};
}
export function centsToUsd(cents){if(!Number.isSafeInteger(Number(cents))||Number(cents)<0)throw error(400,'Invalid payment amount.');return (Number(cents)/100).toFixed(2);}
export function buildCheckoutOrder(invoice){
 if(!invoice||invoice.status!=='open'||!Number.isSafeInteger(Number(invoice.amount_cents))||Number(invoice.amount_cents)<100)throw error(409,'This invoice is not available for payment.');
 return {intent:'CAPTURE',purchase_units:[{reference_id:invoice.id,custom_id:invoice.id,description:String(invoice.description).slice(0,120),amount:{currency_code:'USD',value:centsToUsd(invoice.amount_cents)}}]};
}
export function assertCompletedOrder(order,invoice){
 if(!order||order.status!=='COMPLETED')throw error(409,'PayPal has not confirmed this payment as complete.');
 const units=order.purchase_units||[];
 if(units.length!==1)throw error(409,'Unexpected PayPal purchase units.');
 const unit=units[0];
 if(unit.custom_id!==invoice.id||unit.amount?.currency_code!=='USD'||toCents(unit.amount?.value)!==Number(invoice.amount_cents))throw error(409,'PayPal order and invoice do not match.');
 const captures=unit.payments?.captures||[];
 if(captures.length!==1||captures[0].status!=='COMPLETED'||captures[0].amount?.currency_code!=='USD'||toCents(captures[0].amount?.value)!==Number(invoice.amount_cents)||!captures[0].id)throw error(409,'PayPal capture amount or status does not match the invoice.');
 return {captureId:captures[0].id,orderId:order.id,payerId:order.payer?.payer_id||null};
}
export function createPayPalClient(env=process.env,fetchImpl=fetch){
 const c=getPayPalConfig(env);if(!c.enabled)throw error(503,'PayPal is not configured.');
 let token=null,expiresAt=0;
 async function accessToken(){
  if(token&&Date.now()<expiresAt)return token;
  let r;try{r=await fetchImpl(c.base+'/v1/oauth2/token',{method:'POST',headers:{Authorization:'Basic '+Buffer.from(c.clientId+':'+env.PAYPAL_CLIENT_SECRET).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials',signal:AbortSignal.timeout(18000)});}catch{throw error(502,'Could not reach PayPal authentication.');}
  if(!r.ok)throw error(502,'PayPal rejected the merchant credentials.');
  const j=await r.json();if(!j.access_token)throw error(502,'PayPal did not supply an access token.');token=j.access_token;expiresAt=Date.now()+Math.max(0,Number(j.expires_in||300)-60)*1000;return token;
 }
 async function request(method,path,body=null,idempotencyKey=null){
  const headers={Authorization:'Bearer '+await accessToken(),Accept:'application/json'};
  if(body!==null)headers['Content-Type']='application/json';
  if(idempotencyKey)headers['PayPal-Request-Id']=idempotencyKey;
  let r;try{r=await fetchImpl(c.base+path,{method,headers,body:body===null?undefined:JSON.stringify(body),signal:AbortSignal.timeout(24000)});}catch{throw error(502,'PayPal could not be reached. Check the payment status before trying again.');}
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw error(502,'PayPal '+(data.name||'request')+' error ('+r.status+'). '+(data.message||'Please try again later.'));
  return data;
 }
 return {
  createOrder:(invoice,key)=>request('POST','/v2/checkout/orders',buildCheckoutOrder(invoice),key),
  captureOrder:(orderId,key)=>request('POST','/v2/checkout/orders/'+encodeURIComponent(orderId)+'/capture',{},key),
  getOrder:orderId=>request('GET','/v2/checkout/orders/'+encodeURIComponent(orderId)),
  verifyWebhook:async(headers,body)=>{
   if(!env.PAYPAL_WEBHOOK_ID)throw error(503,'PayPal webhook ID is not configured.');
   const keys=['paypal-transmission-id','paypal-transmission-time','paypal-transmission-sig','paypal-cert-url','paypal-auth-algo'];
   if(keys.some(k=>!headers[k]))throw error(400,'Missing PayPal webhook signature headers.');
   const verification={transmission_id:headers['paypal-transmission-id'],transmission_time:headers['paypal-transmission-time'],transmission_sig:headers['paypal-transmission-sig'],cert_url:headers['paypal-cert-url'],auth_algo:headers['paypal-auth-algo'],webhook_id:env.PAYPAL_WEBHOOK_ID,webhook_event:body};
   const result=await request('POST','/v1/notifications/verify-webhook-signature',verification);
   if(result.verification_status!=='SUCCESS')throw error(401,'Invalid PayPal webhook signature.');
   return true;
  }
 };
}
