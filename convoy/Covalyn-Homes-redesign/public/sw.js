// Public-static-only service worker. Never cache payment, auth, private documents, invoices or API responses.
const VERSION='covalyn-static-v1.5';
const FILES=['/','/index.html','/styles.css?v=6','/app.js?v=6','/premium-ui.js','/trust-ui.js','/selfie.js','/map.js','/favicon.svg','/manifest.webmanifest'];
self.addEventListener('install',event=>{event.waitUntil(caches.open(VERSION).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{const req=event.request,requestUrl=new URL(req.url);if(req.method!=='GET'||requestUrl.origin!==self.location.origin)return;if(requestUrl.pathname.startsWith('/api/')||requestUrl.pathname.includes('receipt')||requestUrl.pathname.includes('document'))return;
const isStatic=FILES.some(p=>new URL(p,self.location.origin).pathname===requestUrl.pathname);
if(!isStatic)return;
event.respondWith(fetch(req).then(resp=>{if(resp.ok&&resp.type==='basic'){const clone=resp.clone();caches.open(VERSION).then(c=>c.put(req,clone));}return resp;}).catch(()=>caches.match(req).then(r=>r||Response.error())));
});
