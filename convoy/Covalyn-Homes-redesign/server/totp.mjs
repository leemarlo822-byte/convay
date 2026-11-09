import {createHmac,timingSafeEqual} from 'node:crypto';

export function base32(buffer){
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=0,value=0,output='';
 for(const byte of buffer){value=(value<<8)|byte;bits+=8;while(bits>=5){bits-=5;output+=alphabet[(value>>>bits)&31];}}
 if(bits)output+=alphabet[(value<<(5-bits))&31];return output;
}
// TOTP as specified in RFC 6238. Returns the matched time counter to prevent replay.
export function matchingTotp(secret,code,time=Date.now()){
 if(!/^\d{6}$/.test(String(code||'')))return null;
 const expected=Buffer.from(String(code));const current=Math.floor(time/30000);
 for(const delta of [-1,0,1]){
  const counter=current+delta;if(counter<0)continue;
  const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(counter));
  const digest=createHmac('sha1',secret).update(bytes).digest();const offset=digest[19]&15;
  const pin=String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
  if(timingSafeEqual(Buffer.from(pin),expected))return counter;
 }
 return null;
}
