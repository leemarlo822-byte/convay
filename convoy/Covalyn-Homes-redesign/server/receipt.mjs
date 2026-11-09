// Dependency-free, server-issued PDF receipts. These are company records, not bank, escrow or notarial certificates.
import {query} from './db.mjs';
import {validUuid} from './security.mjs';
import {receiptPdf} from './pdf-receipt.mjs';
const fail=(s,m)=>Object.assign(Error(m),{status:s});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const uuid=x=>{if(!validUuid(x))throw fail(400,'Invalid receipt reference');return x};
export function installReceipts(app,{requireDb,loginRequired,adminRequired}){
 const issue=(res,r)=>{res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${r.receiptId}.pdf"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).send(receiptPdf(r))};
 for(const [prefix,isAdmin] of [['/api/my',false],['/api/admin',true]]){
  app.get(`${prefix}/invoices/:id/receipt.pdf`,requireDb,isAdmin?adminRequired:loginRequired,wrap(async(req,res)=>{
   const id=uuid(req.params.id),p=isAdmin?[]:[req.user.id];
   const row=(await query(`SELECT i.*,u.name AS payer_name FROM service_invoices i JOIN users u ON u.id=i.user_id WHERE i.id=$1 ${isAdmin?'':'AND i.user_id=$2'}`,[id,...p])).rows[0];
   if(!row||!['paid','refunded'].includes(row.status)||!row.paypal_capture_id||!row.paid_at)throw fail(404,'A confirmed PayPal payment is required for a receipt.');
   issue(res,{receiptId:'CVH-P-'+id.slice(0,8).toUpperCase(),date:row.paid_at,name:row.payer_name,description:row.description,method:'PayPal',reference:row.paypal_capture_id,amountCents:row.amount_cents,status:row.status.toUpperCase(),isExternal:false});
  }));
 }
 for(const [prefix,isAdmin] of [['/api/my',false],['/api/admin',true]]){
 app.get(`${prefix}/transactions/:id/receipts/:paymentId.pdf`,requireDb,isAdmin?adminRequired:loginRequired,wrap(async(req,res)=>{
  const id=uuid(req.params.id),pid=uuid(req.params.paymentId);
  const row=(await query(`SELECT pay.*,p.title,u.name AS buyer_name FROM payments pay JOIN transactions t ON t.id=pay.transaction_id JOIN properties p ON p.id=t.property_id JOIN users u ON u.id=t.user_id WHERE pay.id=$1 AND t.id=$2 ${isAdmin?'':'AND (t.user_id=$3 OR p.seller_user_id=$3)'}`,[pid,id,...(isAdmin?[]:[req.user.id])])).rows[0];
  if(!row||!row.verified_at||!row.evidence_reference)throw fail(404,'Payment has not been marked externally verified.');
  issue(res,{receiptId:'CVH-R-'+pid.slice(0,8).toUpperCase(),date:row.verified_at,name:row.buyer_name,description:row.title,method:row.method,reference:row.reference,amountCents:row.amount_cents,status:'EXTERNAL RECORD',isExternal:true});
 }));
 }
}
