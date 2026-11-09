import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const apiSource=source.slice(source.indexOf('const API='),source.indexOf('\nconst get='));
function setup(){const calls=[];const context={S:{verificationReviewKey:'fixture-document-review-key'},FormData,fetch:async(url,config)=>{calls.push({url,config});return {ok:true,json:async()=>({ok:true})};}};vm.createContext(context);vm.runInContext(apiSource+';globalThis.testAPI=API;',context);return {api:context.testAPI,calls};}
test('document review JSON requests preserve their separate unlock header',async()=>{
 const {api,calls}=setup();await api('/admin/verifications/fixture',{method:'PATCH',body:{status:'pending'}});
 assert.equal(calls[0].config.headers['X-Verification-Review-Key'],'fixture-document-review-key');
 assert.equal(calls[0].config.headers['Content-Type'],'application/json');
});
test('manual multipart uploads retain native FormData without a JSON content type',async()=>{
 const {api,calls}=setup();const data=new FormData();data.set('name','Fixture');await api('/my/processing',{method:'POST',body:data});
 assert.equal(calls[0].config.body,data);assert.equal(calls[0].config.headers,undefined);
});

test('signup has an account type selector and keeps document fields in the signed-in account',async()=>{
 const {createSelfieCamera}=await import('../public/selfie.js');
 const element={addEventListener(){}};
 const context={createSelfieCamera,createTrustUi:()=>({badge:()=>'',portalDocuments:()=>'',portalReviews:()=>'',adminPanel:()=>'',adminProgressPanel:()=>'',homeReviews:()=>'',propertyTrust:()=>''}),localStorage:{getItem:()=>null},window:{addEventListener(){}},document:{getElementById:()=>element},setInterval(){}};
 vm.createContext(context);
 vm.runInContext(source.replace(/^import .*$/gm,'').replace(/\nboot\(\);\s*$/,'')+`
  S.authRegister=true;
  globalThis.signup=authPage(false);
  S.user={name:'Fixture Buyer',email:'buyer@example.invalid',role:'client',account_type:'buyer'};
  S.processingData={available:true,submission:null,documents:[]};
  globalThis.buyerPage=processingPage();
  S.user.account_type='seller';
  globalThis.sellerPage=processingPage();
  globalThis.sellingPage=sell();`,context);
 assert.match(context.signup,/<select id="accountType" name="accountType" required>/);
 assert.doesNotMatch(context.signup,/type="file"|name="tin"|verificationConsent/);
 for(const page of [context.buyerPage,context.sellerPage]){
  assert.match(page,/loan processing and transfer of ownership/);
  assert.match(page,/data-action="selfie-start"/);
  assert.match(page,/name="selfie"/);
 }
 assert.doesNotMatch(context.buyerPage,/name="titleDeed"|name="propertyDocument"/);
 assert.match(context.sellerPage,/name="titleDeed"/);
 assert.match(context.sellerPage,/name="propertyDocument"/);
 assert.match(context.sellingPage,/data-form="selling-inquiry"/);
});

test('selfie capture uses the front camera, produces a JPEG and releases the camera',async()=>{
 const {createSelfieCamera}=await import('../public/selfie.js');
 let stopped=0,calls=0;
 const stream={getTracks:()=>[{stop:()=>{stopped++;}}]};
 const camera=createSelfieCamera({getUserMedia:async constraints=>{calls++;assert.deepEqual(constraints,{video:{facingMode:'user'},audio:false});return stream;}});
 const video={isConnected:true,videoWidth:1920,videoHeight:1080,play:async()=>{},srcObject:null};
 assert.equal(calls,0);assert.equal(await camera.start(video),true);assert.equal(video.srcObject,stream);
 const canvas={getContext:()=>({drawImage(){}}),toBlob(callback,type){callback(new Blob(['fixture'],{type}));}};
 const file=await camera.capture(video,{createElement:()=>canvas});
 assert.equal(file.name,'selfie.jpg');assert.equal(file.type,'image/jpeg');assert.equal(canvas.width,1280);
 assert.equal(stopped,1);assert.equal(video.srcObject,null);
});

test('leaving the page while camera permission is pending releases the stream',async()=>{
 const {createSelfieCamera}=await import('../public/selfie.js');
 let finish,stopped=0;
 const camera=createSelfieCamera({getUserMedia:()=>new Promise(resolve=>{finish=resolve;})});
 const video={isConnected:true,srcObject:null},start=camera.start(video);
 camera.stop();finish({getTracks:()=>[{stop:()=>{stopped++;}}]});
 assert.equal(await start,false);assert.equal(stopped,1);assert.equal(video.srcObject,null);
});
