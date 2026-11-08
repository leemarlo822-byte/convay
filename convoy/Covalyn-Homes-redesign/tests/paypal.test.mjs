import test from 'node:test';
import assert from 'node:assert/strict';
import {getPayPalConfig,centsToUsd,buildCheckoutOrder,assertCompletedOrder,createPayPalClient} from '../server/paypal.mjs';
const invoice={id:'123e4567-e89b-42d3-a456-426614174000',description:'Professional services',status:'open',amount_cents:12550};
const completed={id:'8JR12345678912345',status:'COMPLETED',payer:{payer_id:'PAYER123'},purchase_units:[{custom_id:invoice.id,amount:{currency_code:'USD',value:'125.50'},payments:{captures:[{id:'4FC12345678',status:'COMPLETED',amount:{currency_code:'USD',value:'125.50'}}]}}]};
test('PayPal connection defaults to sandbox and needs merchant credentials',()=>{
 assert.equal(getPayPalConfig({}).enabled,false);
 assert.equal(getPayPalConfig({PAYPAL_CLIENT_ID:'id',PAYPAL_CLIENT_SECRET:'secret'}).mode,'sandbox');
 assert.equal(getPayPalConfig({PAYPAL_MODE:'live',PAYPAL_CLIENT_ID:'id',PAYPAL_CLIENT_SECRET:'secret'}).base,'https://api-m.paypal.com');
});
test('checkout order uses exact server-side USD cents, never client pricing',()=>{
 assert.equal(centsToUsd(12550),'125.50');
 const order=buildCheckoutOrder(invoice);
 assert.equal(order.purchase_units[0].amount.value,'125.50');
 assert.equal(order.purchase_units[0].amount.currency_code,'USD');
 assert.equal(order.purchase_units[0].custom_id,invoice.id);
 assert.throws(()=>buildCheckoutOrder({...invoice,status:'cancelled'}));
});
test('only completed, exact amount capture can mark invoice paid',()=>{
 assert.equal(assertCompletedOrder(completed,invoice).captureId,'4FC12345678');
 assert.throws(()=>assertCompletedOrder({...completed,status:'APPROVED'},invoice));
 assert.throws(()=>assertCompletedOrder({...completed,purchase_units:[{...completed.purchase_units[0],amount:{currency_code:'USD',value:'1.25'}}]},invoice));
 assert.throws(()=>assertCompletedOrder({...completed,purchase_units:[{...completed.purchase_units[0],custom_id:'other-invoice'}]},invoice));
 assert.throws(()=>assertCompletedOrder({...completed,purchase_units:[{...completed.purchase_units[0],payments:{captures:[{...completed.purchase_units[0].payments.captures[0],status:'PENDING'}]}}]},invoice));
 assert.throws(()=>assertCompletedOrder({...completed,purchase_units:[{...completed.purchase_units[0],payments:{captures:[{...completed.purchase_units[0].payments.captures[0],amount:{currency_code:'EUR',value:'125.50'}}]}}]},invoice));
});
test('mock integration authorizes, creates and captures with private credentials',async()=>{
 let count=0;
 const requests=[];
 const fakeFetch=async(url,opts)=>{requests.push({url,opts});if(url.endsWith('/v1/oauth2/token')){count++;return {ok:true,json:async()=>({access_token:'access',expires_in:7200})};}
 if(url.endsWith('/v2/checkout/orders')&&opts.method==='POST')return {ok:true,json:async()=>({id:completed.id})};
 if(url.endsWith('/v2/checkout/orders/'+completed.id+'/capture'))return {ok:true,json:async()=>completed};
 if(url.endsWith('/v2/checkout/orders/'+completed.id))return {ok:true,json:async()=>completed};
 if(url.endsWith('/v1/notifications/verify-webhook-signature'))return {ok:true,json:async()=>({verification_status:'SUCCESS'})};
 return {ok:false,json:async()=>({name:'TEST_ERROR'})};};
 const client=createPayPalClient({PAYPAL_CLIENT_ID:'id',PAYPAL_CLIENT_SECRET:'secret',PAYPAL_MODE:'sandbox',PAYPAL_WEBHOOK_ID:'WEBHOOK123'},fakeFetch);
 assert.equal((await client.createOrder(invoice,'abc')).id,completed.id);
 assert.equal(assertCompletedOrder(await client.captureOrder(completed.id,invoice.id),invoice).captureId,'4FC12345678');
 assert.equal((await client.getOrder(completed.id)).status,'COMPLETED');
 assert.equal(count,1);assert.equal(requests[1].opts.headers['PayPal-Request-Id'],'abc');
 assert.ok(!requests[1].opts.body.includes('secret'));
 const headers={'paypal-transmission-id':'id','paypal-transmission-time':'now','paypal-transmission-sig':'sig','paypal-cert-url':'https://paypal.com/cert','paypal-auth-algo':'SHA256withRSA'};
 assert.equal(await client.verifyWebhook(headers,{event_type:'PAYMENT.CAPTURE.COMPLETED'}),true);
});
