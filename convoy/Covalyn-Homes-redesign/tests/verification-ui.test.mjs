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
 const {api,calls}=setup();const data=new FormData();data.set('name','Fixture');await api('/auth/register',{method:'POST',body:data});
 assert.equal(calls[0].config.body,data);assert.equal(calls[0].config.headers,undefined);
});
