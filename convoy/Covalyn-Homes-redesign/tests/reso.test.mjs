import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {mapResoProperty,getResoConfig,syncReso} from '../server/mls.mjs';
import {validCoordinates,geocodeUsAddress} from '../server/geocode.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('no fake property inventory: no demo seeding or frontend placeholders',()=>{
 const db=readFileSync(resolve(root,'server/db.mjs'),'utf8');const ui=readFileSync(resolve(root,'public/app.js'),'utf8');
 assert.doesNotMatch(db,/import\s*\{demoProperties/);assert.match(db,/return \[\];/);assert.match(db,/DELETE FROM properties p WHERE p.demo=true/);
 assert.match(ui,/const fallback=\[\]/);assert.match(ui,/function mountMaps\(/);
});
test('RESO mapping requires an authorized, real Active listing with USD price and valid US state',()=>{
 assert.equal(mapResoProperty({StandardStatus:'Active',ListPrice:500000}),null);
 assert.equal(mapResoProperty({ListingKey:'42',StandardStatus:'Closed',ListPrice:500000,City:'Austin',StateOrProvince:'TX'}),null);
 const p=mapResoProperty({ListingKey:'abc',StandardStatus:'Active',ListPrice:425000,City:'Austin',StateOrProvince:'TX',BedroomsTotal:3,BathroomsTotalDecimal:2.5,LivingArea:1600,Latitude:30.2,Longitude:-97.7,UnparsedAddress:'101 Main St',ListOfficeName:'Licensed Brokerage',Media:[{MediaURL:'https://cdn.example.com/home.jpg'}]},'Provider','Provided by Provider');
 assert.equal(p.priceCents,42500000);assert.equal(p.lat,30.2);assert.equal(p.lng,-97.7);assert.equal(p.images[0],'https://cdn.example.com/home.jpg');assert.equal(p.brokerage,'Licensed Brokerage');assert.equal(p.attribution,'Provided by Provider');
});
test('MLS feed remains disconnected without explicit IDX rights and credentials',()=>{
 assert.equal(getResoConfig({MLS_RESO_API_URL:'https://provider.example/odata',MLS_RESO_ACCESS_TOKEN:'demo'}).configured,false);
 assert.equal(getResoConfig({MLS_RESO_IDX_AUTHORIZED:'true',MLS_RESO_API_URL:'http://local/odata',MLS_RESO_ACCESS_TOKEN:'demo'}).configured,false);
 assert.equal(getResoConfig({MLS_RESO_IDX_AUTHORIZED:'true',MLS_RESO_API_URL:'https://provider.example/odata',MLS_RESO_ACCESS_TOKEN:'demo'}).configured,true);
});
test('RESO Web API sync upserts active properties and hides stale records on completed feed',async()=>{
 const sql=[];const env={MLS_RESO_IDX_AUTHORIZED:'true',MLS_RESO_API_URL:'https://provider.example/odata',MLS_RESO_ACCESS_TOKEN:'TEST_VALUE',MLS_RESO_SOURCE_NAME:'Licensed Provider',MLS_RESO_ATTRIBUTION:'Courtesy of Listing Office'};
 const fakeFetch=async(url,options)=>({ok:true,json:async()=>({value:[{ListingKey:'xyz',StandardStatus:'Active',ListPrice:750000,City:'Miami',StateOrProvince:'FL',Latitude:25.7,Longitude:-80.2}], '@odata.nextLink':null})});
 const result=await syncReso({query:async(q,args)=>{sql.push({q,args});return {rows:[]}},env,fetchImpl:fakeFetch});
 assert.equal(result.complete,true);assert.equal(result.imported,1);assert.equal(sql.length,2);assert.match(sql[0].q,/ON CONFLICT/);assert.match(sql[1].q,/status='hidden'/);
});
test('map coordinates reject missing/outside US values and Census match is optional',async()=>{
 assert.equal(validCoordinates(30.2,-97.8),true);assert.equal(validCoordinates(null,null),false);assert.equal(validCoordinates(0,0),false);
 const r=await geocodeUsAddress({address:'123 Main St',city:'Austin',state:'TX'},async()=>({ok:true,json:async()=>({result:{addressMatches:[{coordinates:{y:30.25,x:-97.74},matchedAddress:'MATCH'}]}})}));
 assert.equal(r.lat,30.25);assert.equal(r.lng,-97.74);
});
