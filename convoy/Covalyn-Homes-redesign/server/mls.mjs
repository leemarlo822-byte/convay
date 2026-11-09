/* RESO Web API IDX connector. Only sync feeds your brokerage is licensed to display.
   Provider-specific Media, attribution and filtering requirements may vary. */
import {randomUUID} from 'node:crypto';
const txt=(v,n=240)=>String(v??'').trim().slice(0,n);
const priceCents=v=>{const a=Number(v);return Number.isFinite(a)&&a>0&&a<1e10?Math.round(a*100):null;};
const num=(v,min=0,max=10000000)=>{const n=Number(v);return v!==null&&v!==undefined&&Number.isFinite(n)&&n>=min&&n<=max?n:null;};
const imageList=v=>{const items=Array.isArray(v)?v:Array.isArray(v?.value)?v.value:[];return items.map(m=>typeof m==='string'?m:m?.MediaURL||m?.MediaUrl||m?.MediaURLOriginal||m?.MediaUrlOriginal||m?.Url||'').filter(x=>typeof x==='string'&&/^https:\/\//i.test(x)).slice(0,24);};
export function mapResoProperty(x,source='Authorized MLS',defaultAttribution=''){
 if(!x||!x.ListingKey||!['active'].includes(String(x.StandardStatus||'').toLowerCase()))return null;
 const price=priceCents(x.ListPrice),city=txt(x.City,80),state=txt(x.StateOrProvince,2).toUpperCase();
 if(!price||!city||!/^[A-Z]{2}$/.test(state))return null;
 const lat=num(x.Latitude,18,72),lng=num(x.Longitude,-180,-65);
 const street=txt(x.UnparsedAddress||[x.StreetNumber,x.StreetDirPrefix,x.StreetName,x.StreetSuffix,x.UnitNumber].filter(Boolean).join(' '),180);
 const media=imageList(x.Media||x.MediaItems||x.Photos);
 const type=String(x.PropertySubType||x.PropertyType||'').toLowerCase();
 const category=type.includes('condo')?'Condo':type.includes('town')?'Townhouse':type.includes('multi')?'Multi-family':type.includes('land')?'Land':type.includes('new construction')?'New construction':'Single-family';
 const brokerage=txt(x.ListOfficeName||x.ListOffice?.OfficeName||'',150),agent=txt(x.ListAgentFullName||x.ListAgent?.MemberFullName||'',130);
 return {externalId:txt(x.ListingKey,150),title:txt(street||`${city} residence`,130),city,state,address:street,zip:txt(x.PostalCode,20),priceCents:price,
 beds:Math.round(num(x.BedroomsTotal,0,100)??0),baths:num(x.BathroomsTotalInteger??x.BathroomsTotalDecimal??x.BathroomsFull,0,100)??0,
 sqft:Math.round(num(x.LivingArea,0,1e7)??0),lotSqft:num(x.LotSizeSquareFeet,0,1e9),yearBuilt:num(x.YearBuilt,1600,2200),type:category,
 description:txt(x.PublicRemarks||'',7000),images:media,lat,lng,brokerage,agent,attribution:txt(defaultAttribution,600),source:txt(source,120),
 modified:x.ModificationTimestamp||x.OriginalEntryTimestamp||null};
}
export function getResoConfig(env=process.env){
 const permitted=env.MLS_RESO_IDX_AUTHORIZED==='true';
 const endpoint=env.MLS_RESO_API_URL||'',tokenUrl=env.MLS_RESO_TOKEN_URL||'';
 const credentials=Boolean(env.MLS_RESO_ACCESS_TOKEN||(env.MLS_RESO_CLIENT_ID&&env.MLS_RESO_CLIENT_SECRET&&tokenUrl));
 let validUrl=false;try{validUrl=new URL(endpoint).protocol==='https:'&&(!tokenUrl||new URL(tokenUrl).protocol==='https:');}catch{}
 return {configured:permitted&&validUrl&&credentials,authorized:permitted,source:txt(env.MLS_RESO_SOURCE_NAME||'Licensed MLS',120),attribution:txt(env.MLS_RESO_ATTRIBUTION||'',600),disclaimer:txt(env.MLS_RESO_DISCLAIMER||'',1500),maxPages:Math.min(100,Math.max(1,Number(env.MLS_RESO_MAX_PAGES)||10)),endpoint,tokenUrl};
}
async function fetchJson(url,token,fetchImpl){const resp=await fetchImpl(url,{headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal:AbortSignal.timeout(15000)});if(!resp.ok)throw Error(`MLS provider returned HTTP ${resp.status}`);return resp.json();}
async function getAccessToken(env,fetchImpl){if(env.MLS_RESO_ACCESS_TOKEN)return env.MLS_RESO_ACCESS_TOKEN;
 const params=new URLSearchParams({grant_type:'client_credentials',client_id:env.MLS_RESO_CLIENT_ID,client_secret:env.MLS_RESO_CLIENT_SECRET});
 if(env.MLS_RESO_SCOPE)params.set('scope',env.MLS_RESO_SCOPE);
 const response=await fetchImpl(env.MLS_RESO_TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},body:params,signal:AbortSignal.timeout(15000)});
 if(!response.ok)throw Error(`MLS authentication failed (HTTP ${response.status})`);
 const data=await response.json();if(!data?.access_token)throw Error('MLS authentication did not return an access token');return data.access_token;
}
export async function syncReso({query,env=process.env,fetchImpl=fetch}){
 const cfg=getResoConfig(env);if(!cfg.configured)throw Error('Authorized MLS credentials and HTTPS RESO endpoint must be configured before syncing.');
 const token=await getAccessToken(env,fetchImpl),root=new URL(cfg.endpoint),source=cfg.source;
 const start=new URL(root.toString());if(!start.pathname.endsWith('/Property'))start.pathname=start.pathname.replace(/\/$/,'')+'/Property';
 start.searchParams.set('$top','100');
 start.searchParams.set('$filter',env.MLS_RESO_FILTER||"StandardStatus eq 'Active'");
 if(env.MLS_RESO_EXPAND_MEDIA==='true')start.searchParams.set('$expand','Media');
 const seen=[],batch=[];let next=start.toString(),page=0;
 while(next&&page<cfg.maxPages){
  const url=new URL(next,root);if(url.protocol!=='https:'||url.origin!==root.origin||!url.pathname.startsWith(root.pathname.replace(/\/$/,'').replace(/\/Property$/,'')+'/'))throw Error('Unsafe MLS pagination URL rejected.');
  const json=await fetchJson(url.toString(),token,fetchImpl);
  if(!Array.isArray(json?.value))throw Error('Expected a RESO OData response with a value array.');
  for(const x of json.value){const p=mapResoProperty(x,source,cfg.attribution);if(p){batch.push(p);seen.push(p.externalId);}}
  next=json['@odata.nextLink']||json['odata.nextLink']||null;page++;
 }
 let imported=0;
 for(const p of batch){
  // One ID per external listing. ON CONFLICT only updates MLS-owned records.
  const args=[randomUUID(),p.externalId,p.title,p.city,p.state,p.address,p.zip,p.priceCents,p.beds,p.baths,p.sqft,p.lotSqft,p.yearBuilt,p.type,p.description,JSON.stringify(p.images),p.lat,p.lng,source,p.brokerage,p.agent,p.attribution];
  await query(`INSERT INTO properties(id,external_id,title,city,state,address,zip_code,price_cents,beds,baths,sqft,lot_sqft,year_built,type,description,images,lat,lng,source,mls_source,listing_office,listing_agent,attribution,status,featured,demo)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,'mls',$19,$20,$21,$22,'available',false,false)
 ON CONFLICT (mls_source,external_id) WHERE source='mls' AND external_id IS NOT NULL DO UPDATE SET
 title=EXCLUDED.title,city=EXCLUDED.city,state=EXCLUDED.state,address=EXCLUDED.address,zip_code=EXCLUDED.zip_code,price_cents=EXCLUDED.price_cents,
 beds=EXCLUDED.beds,baths=EXCLUDED.baths,sqft=EXCLUDED.sqft,lot_sqft=EXCLUDED.lot_sqft,year_built=EXCLUDED.year_built,type=EXCLUDED.type,
 description=EXCLUDED.description,images=EXCLUDED.images,lat=EXCLUDED.lat,lng=EXCLUDED.lng,listing_office=EXCLUDED.listing_office,listing_agent=EXCLUDED.listing_agent,attribution=EXCLUDED.attribution,
 status='available',updated_at=now(),mls_last_seen=now()`,args);
  imported++;
 }
 const complete=!next;
 if(complete){await query(`UPDATE properties SET status='hidden',updated_at=now() WHERE source='mls' AND mls_source=$1 AND external_id <> ALL($2::text[])`,[source,seen]);}
 return {imported,pages:page,complete,morePages:Boolean(next),source,warning:complete?null:'Feed not fully paged; no stale MLS listings were removed. Increase MLS_RESO_MAX_PAGES or configure provider filtering and recurring sync.'};
}
