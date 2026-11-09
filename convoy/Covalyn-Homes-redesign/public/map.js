// Lightweight interactive slippy map: U.S. property markers, pan, zoom and OSM tiles.
// No fabricated address coordinates or hardcoded property pins.
const PI=Math.PI,clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const normLon=x=>((x+180)%360+360)%360-180;
const project=(lat,lng,z)=>{const n=256*2**z,phi=clamp(lat,-85.0511,85.0511)*PI/180;return {x:(lng+180)/360*n,y:(1-Math.log(Math.tan(phi)+1/Math.cos(phi))/PI)/2*n};};
const unproject=(x,y,z)=>{const n=256*2**z;return {lng:normLon(x/n*360-180),lat:180/PI*Math.atan(Math.sinh(PI*(1-2*y/n)))};};
const nfmt=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0,notation:'compact'});
export function mountPropertyMap(node,properties,onSelect,{compact=false}={}){
 if(!node)return ()=>{};
 const locations=(properties||[]).filter(p=>p.lat!==null&&p.lat!==undefined&&p.lng!==null&&p.lng!==undefined&&Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng))&&Number(p.lat)>=18&&Number(p.lat)<=72&&Number(p.lng)>=-180&&Number(p.lng)<=-65);
 node.innerHTML='';node.classList.add('property-map');node.setAttribute('role','region');node.setAttribute('aria-label','Interactive map showing U.S. property locations');
 const layer=document.createElement('div');layer.className='map-tile-layer';const overlay=document.createElement('div');overlay.className='map-markers';
 const hud=document.createElement('div');hud.className='map-hud';
 const out=document.createElement('div');out.className='map-controls';
 const zoomIn=document.createElement('button');zoomIn.type='button';zoomIn.textContent='+';zoomIn.setAttribute('aria-label','Zoom map in');
 const zoomOut=document.createElement('button');zoomOut.type='button';zoomOut.textContent='−';zoomOut.setAttribute('aria-label','Zoom map out');out.append(zoomIn,zoomOut);
 const caption=document.createElement('div');caption.className='map-caption';caption.textContent=locations.length?`${locations.length} mapped ${locations.length===1?'home':'homes'}`:'No geolocated listings yet';
 const attribution=document.createElement('div');attribution.className='map-attribution';attribution.innerHTML='© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';
 hud.append(caption,out);node.append(layer,overlay,hud,attribution);
 let zoom=locations.length===1?12:4,center={lat:39.2,lng:-98.7},alive=true;
 const bounds=()=>{const r=node.getBoundingClientRect();return {w:Math.max(280,r.width),h:Math.max(240,r.height)};};
 if(locations.length>1){
  const pts=locations.map(p=>project(Number(p.lat),Number(p.lng),4)),xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
  const x=(Math.min(...xs)+Math.max(...xs))/2,y=(Math.min(...ys)+Math.max(...ys))/2;center=unproject(x,y,4);
  const {w,h}=bounds(),spanx=Math.max(...xs)-Math.min(...xs),spany=Math.max(...ys)-Math.min(...ys);
  const fit=Math.min(Math.log2((w-120)/Math.max(spanx,1)),Math.log2((h-140)/Math.max(spany,1)));
  zoom=clamp(Math.floor(4+fit),3,13);
 }else if(locations.length===1)center={lat:Number(locations[0].lat),lng:Number(locations[0].lng)};
 function paint(){if(!alive||!node.isConnected)return;
  const {w,h}=bounds(),c=project(center.lat,center.lng,zoom);layer.replaceChildren();overlay.replaceChildren();
  const minTx=Math.floor((c.x-w/2)/256),maxTx=Math.floor((c.x+w/2)/256),minTy=Math.floor((c.y-h/2)/256),maxTy=Math.floor((c.y+h/2)/256);
  const n=2**zoom;let made=0;
  for(let ty=minTy;ty<=maxTy;ty++)for(let tx=minTx;tx<=maxTx;tx++){
   if(ty<0||ty>=n||made++>26)continue;
   const tile=document.createElement('img');tile.className='map-tile';tile.alt='';tile.loading='lazy';tile.decoding='async';tile.draggable=false;
   tile.src=`https://tile.openstreetmap.org/${zoom}/${((tx%n)+n)%n}/${ty}.png`;
   tile.style.left=`${Math.round(tx*256-c.x+w/2)}px`;tile.style.top=`${Math.round(ty*256-c.y+h/2)}px`;layer.append(tile);
  }
  for(const p of locations){const pos=project(Number(p.lat),Number(p.lng),zoom),x=pos.x-c.x+w/2,y=pos.y-c.y+h/2;
   if(x < -90||y < -45||x > w+90||y > h+45)continue;
   const marker=document.createElement('button');marker.className='map-property-pin';marker.type='button';
   marker.textContent=nfmt.format(Number(p.price)||0);marker.title=`${p.title} — ${nfmt.format(Number(p.price)||0)}`;
   marker.setAttribute('aria-label',`View ${p.title}, ${nfmt.format(Number(p.price)||0)}`);
   marker.style.left=`${x}px`;marker.style.top=`${y}px`;
   marker.addEventListener('click',e=>{e.stopPropagation();onSelect?.(p);});overlay.append(marker);
  }
 }
 const zoomBy=dz=>{const target=clamp(zoom+dz,3,17);if(target===zoom)return;zoom=target;paint();};
 zoomIn.addEventListener('click',()=>zoomBy(1));zoomOut.addEventListener('click',()=>zoomBy(-1));
 const onWheel=e=>{e.preventDefault();zoomBy(e.deltaY<0?1:-1);};node.addEventListener('wheel',onWheel,{passive:false});
 let drag=null;
 const down=e=>{if(e.target.closest('button,a'))return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,lat:center.lat,lng:center.lng};node.setPointerCapture?.(e.pointerId);node.classList.add('dragging');};
 const move=e=>{if(!drag||e.pointerId!==drag.id)return;const first=project(drag.lat,drag.lng,zoom),next=unproject(first.x-(e.clientX-drag.x),first.y-(e.clientY-drag.y),zoom);center={lat:clamp(next.lat,18,72),lng:clamp(next.lng,-180,-65)};paint();};
 const up=e=>{if(drag&&(e.pointerId===drag.id)){drag=null;node.classList.remove('dragging');}};
 node.addEventListener('pointerdown',down);node.addEventListener('pointermove',move);node.addEventListener('pointerup',up);node.addEventListener('pointercancel',up);
 paint();
 let observer=null;if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(()=>{if(alive)paint();});observer.observe(node);}
 return ()=>{alive=false;observer?.disconnect();node.removeEventListener('wheel',onWheel);node.removeEventListener('pointerdown',down);node.removeEventListener('pointermove',move);node.removeEventListener('pointerup',up);node.removeEventListener('pointercancel',up);};
}
