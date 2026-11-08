// U.S. Census single-address geocoding; a no-match never fabricates coordinates.
export function validCoordinates(lat,lng){
 const a=Number(lat),b=Number(lng);
 return lat!==''&&lat!==null&&lat!==undefined&&lng!==''&&lng!==null&&lng!==undefined&&
 Number.isFinite(a)&&Number.isFinite(b)&&a>=18&&a<=72&&b>=-180&&b<=-65;
}
export async function geocodeUsAddress({address,city,state,zip_code}, fetchImpl=fetch){
 if(!String(address||'').trim()||!String(city||'').trim()||!String(state||'').trim())return null;
 const u=new URL('https://geocoding.geo.census.gov/geocoder/locations/address');
 for(const [k,v] of Object.entries({street:address,city,state,zip:zip_code||'',benchmark:'Public_AR_Current',format:'json'}))u.searchParams.set(k,String(v));
 try{
  const r=await fetchImpl(u.toString(),{signal:AbortSignal.timeout(7000),headers:{Accept:'application/json'}});
  if(!r.ok)return null;
  const o=await r.json(),point=o?.result?.addressMatches?.[0]?.coordinates;
  if(!point||!validCoordinates(point.y,point.x))return null;
  return {lat:Number(point.y),lng:Number(point.x),matchedAddress:o.result.addressMatches[0].matchedAddress||''};
 }catch{return null;}
}
