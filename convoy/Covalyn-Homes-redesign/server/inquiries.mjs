import {newId,validUuid} from './security.mjs';
const fail=(status,message)=>Object.assign(Error(message),{status});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const states=new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI'.split(' '));
const timelines={exploring:'Just exploring',soon:'As soon as possible','1-3-months':'Within 1–3 months','3-plus-months':'In 3 months or later'};
export function installInquiries(app,{requireDb,query,required,checkEmail,limit,money}){
 app.post('/api/inquiries',requireDb,wrap(async(req,res)=>{
  const b=req.body||{},email=checkEmail(b.email),name=required(b.name,'Name',90),phone=limit(b.phone,35),kind=String(b.kind||'question');
  if(!['question','selling','general'].includes(kind))throw fail(400,'Choose a valid inquiry type.');
  let propertyId=null,message=required(b.message,'Message',2500);
  if(kind==='selling'){
   if(b.contactConsent!==true&&b.contactConsent!=='true')throw fail(400,'Please agree to be contacted about your property.');
   const address=required(b.propertyAddress,'Property address',180),city=required(b.city,'City',90),state=required(b.state,'State',40).toUpperCase(),zip=limit(b.zipCode,10);
   if(!states.has(state))throw fail(400,'Enter a valid two-letter U.S. state abbreviation.');
   if(zip&&!/^\d{5}(-\d{4})?$/.test(zip))throw fail(400,'Enter a valid U.S. ZIP code.');
   if(!Object.hasOwn(timelines,b.timeline))throw fail(400,'Choose a selling timeline.');
   let price='Not provided';
   if(String(b.askingPrice||'').trim()){
    const cents=money(b.askingPrice);if(cents<100)throw fail(400,'Enter an asking price greater than zero.');price=(cents/100).toFixed(2);
   }
   message=`Property for sale\nAddress: ${address}\nCity: ${city}\nState: ${state}\nZIP: ${zip||'Not provided'}\nAsking price (USD): ${price}\nTimeline: ${timelines[b.timeline]}\nContact consent: given\n\nProperty condition and details:\n${limit(b.message,1500)}`;
  }else if(b.propertyId){if(!validUuid(b.propertyId))throw fail(400,'Invalid property.');propertyId=b.propertyId;}
  await query('INSERT INTO inquiries(id,property_id,user_id,name,email,phone,kind,message) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[newId(),propertyId,req.user?.id||null,name,email,phone,kind,message]);
  res.json({ok:true,message:'Your inquiry has been sent to the Covalyn Homes team.'});
 }));
}
