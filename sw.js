/* V49 offline PWA: only local static files are cached; Supabase traffic is network-only. */
const VERSION='northside-pizza-v49-online-20261122-a';
const CORE=['./','./index.html','./manifest.webmanifest','./leaderboard.js','./leaderboard-config.js',
'./icon-192.png','./icon-512.png','./maskable-512.png','./apple-touch-icon.png','./favicon.png'];
self.addEventListener('install',e=>e.waitUntil(
  caches.open(VERSION).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting())
));
self.addEventListener('activate',e=>e.waitUntil(
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('northside-pizza-')&&k!==VERSION).map(k=>caches.delete(k))))
    .then(()=>self.clients.claim())
));
self.addEventListener('fetch',e=>{
 const r=e.request;if(r.method!=='GET')return;
 const u=new URL(r.url),scope=new URL('./',self.location.href).pathname;
 if(u.origin!==self.location.origin||!u.pathname.startsWith(scope))return;
 if(r.mode==='navigate'){
   e.respondWith(fetch(r).then(async res=>{if(res.ok){const c=await caches.open(VERSION);await c.put('./index.html',res.clone())}return res})
     .catch(async()=>{const c=await caches.open(VERSION);return(await c.match('./index.html'))||(await c.match('./'))||Response.error()}));
   return;
 }
 // Always fetch configuration when online, so server setup can be updated without reinstalling.
 if(u.pathname.endsWith('/leaderboard-config.js')){
   e.respondWith(fetch(r).then(async res=>{if(res.ok){const c=await caches.open(VERSION);await c.put(r,res.clone())}return res})
     .catch(async()=>{const c=await caches.open(VERSION);return(await c.match(r))||Response.error()}));
   return;
 }
 e.respondWith(caches.open(VERSION).then(c=>c.match(r).then(cached=>cached||fetch(r).then(res=>{
   if(res.ok)e.waitUntil(c.put(r,res.clone()));return res;
 }))));
});
