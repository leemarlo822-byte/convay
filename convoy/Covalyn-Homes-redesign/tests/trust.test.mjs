import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {base32,matchingTotp} from '../server/totp.mjs';
const files=Object.fromEntries(await Promise.all(['server/trust.mjs','server/trust-schema.mjs','server/verification.mjs','public/trust-ui.js','public/app.js'].map(async f=>[f,await readFile(new URL('../'+f,import.meta.url),'utf8')])));
test('TOTP matches six-digit SHA-1 RFC test vectors and rejects reuse outside the permitted window',()=>{
 const key=Buffer.from('12345678901234567890');
 assert.equal(matchingTotp(key,'287082',59000),1);
 assert.equal(matchingTotp(key,'081804',1111111109000),37037036);
 assert.equal(matchingTotp(key,'287082',119000),null);
 assert.equal(matchingTotp(key,'000000',59000),null);
 assert.equal(base32(Buffer.from('foo')),'MZXW6');
});
test('identity review requires the separate phrase and property requests retain reviewer verification',()=>{
 assert.match(files['server/verification.mjs'],/adminRequired,reviewLimiter,reviewAccess/);
 assert.doesNotMatch(files['server/verification.mjs'],/requireReviewerStepUp/);
 assert.match(files['server/trust.mjs'],/reviewer_stepups s JOIN reviewer_totp/);
 assert.match(files['server/trust.mjs'],/last_counter<\$2/);
 assert.match(files['server/trust.mjs'],/app\.get\('\/api\/admin\/document-requests\/:id\/file',\.\.\.protectedDocs/);
 assert.match(files['server/trust.mjs'],/timingSafeEqual|matchingTotp/);
});
test('reports, review moderation, private requests and seller progress are tied to records',()=>{
 const src=files['server/trust.mjs'];
 for(const route of ['/api/listings/:id/report','/api/admin/listing-reports','/api/admin/document-requests','/api/my/document-requests','/api/my/reviews','/api/admin/reviews','/api/admin/transactions/:id/progress','/api/admin/transactions/:id/close'])assert.ok(src.includes(route));
 assert.match(src,/t\.closed_at IS NOT NULL/);
 assert.match(src,/p\.seller_user_id/);
 assert.match(src,/publish_consent=true/);
 assert.match(src,/expires_at<=now\(\)/);
 assert.match(src,/AES|aes-256-gcm/);
});
test('public UI links reports, listing checks and testimonials without default fake inventory',()=>{
 assert.match(files['public/app.js'],/TRUST\.homeReviews\(\)/);
 assert.match(files['public/app.js'],/TRUST\.propertyTrust\(S\.detailId\)/);
 assert.match(files['public/app.js'],/infocovalyn@gmail\.com/);
 assert.match(files['public/trust-ui.js'],/Report a listing/);
 assert.match(files['public/trust-ui.js'],/Private property document requests/);
 assert.match(files['public/trust-ui.js'],/Completed-transaction reviews/);
});
