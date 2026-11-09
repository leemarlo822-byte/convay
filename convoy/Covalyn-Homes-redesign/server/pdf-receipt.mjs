// Pure PDF renderer for buyer and seller payment records.
const esc=s=>String(s??'').normalize('NFKD').replace(/[^\x20-\x7e]/g,' ').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').slice(0,260);
const usd=c=>`USD ${(Number(c)/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fail=(s,m)=>Object.assign(Error(m),{status:s});
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const uuid=x=>{if(!validUuid(x))throw fail(400,'Invalid receipt reference');return x};
function receiptPdf(r){
 const lines=[];
 const tx=(s,x,y,size=12,font='F1')=>lines.push(`BT /${font} ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET`);
 lines.push('0.10 0.17 0.13 rg 0 0 612 792 re f','0.63 0.91 0.47 rg 40 732 532 4 re f','1 1 1 rg');
 tx('COVALYN',43,755,23,'F2');tx('HOMES',177,755,23,'F2');tx('PAYMENT RECEIPT',42,699,20,'F2');
 tx('Issued by Covalyn Homes | infocovalyn@gmail.com',42,672,10);
 lines.push('0.6 0.7 0.63 RG 42 657 m 570 657 l S');
 const entries=[['Receipt reference',r.receiptId],['Receipt issued',new Date().toISOString().slice(0,10)+' UTC'],['Payment date',new Date(r.date).toISOString().slice(0,10)],['Bill to',r.name],['Property / service',r.description],['Payment method',r.method],['Processor / external reference',r.reference],['Payment recorded',usd(r.amountCents)],['Payment status',r.status]];
 let y=630;for(const [label,val] of entries){tx(label+':',43,y,10,'F2');tx(String(val).slice(0,78),220,y,10);y-=31;}
 lines.push('0.63 0.91 0.47 RG 42 328 m 570 328 l S');
 tx('TOTAL '+usd(r.amountCents),43,295,19,'F2');
 // Branded organizational mark. No individual handwriting, seal of government, or notarization implied.
 lines.push('0.63 0.91 0.47 RG 2 w 480 237 53 0 360 arc S'.replace('480 237 53 0 360 arc','480 237 m 479 266 458 288 428 288 c 398 288 376 266 376 237 c 376 208 398 186 428 186 c 458 186 480 208 480 237 c'));
 tx('COVALYN',393,247,10,'F2');tx('HOMES',402,231,10,'F2');tx('RECEIPT',400,213,9,'F2');
 tx('Covalyn Homes Billing Office',43,226,16,'F3');tx('Company-issued electronic signature',43,207,9);
 tx('Covalyn receipt stamp - internal business mark only',43,165,9);
 tx(r.status==='REFUNDED'?'Refund recorded. Original payment was later refunded.':r.isExternal?'Recorded external payment; this document is not independent bank or escrow confirmation.':'Payment confirmed by PayPal capture. Not an escrow, closing or property ownership receipt.',43,130,9);
 tx('For closing instructions, independently call your licensed title/escrow provider.',43,113,9);
 tx('This PDF does not certify a title, deed, bank statement, notarization or transfer of ownership.',43,96,9);
 tx('Questions? infocovalyn@gmail.com',43,60,10,'F2');
 const stream=lines.join('\n')+'\n';
 const objs=[null,'<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
 let pdf='%PDF-1.4\n',positions=[0];for(let i=1;i<objs.length;i++){positions.push(Buffer.byteLength(pdf));pdf+=`${i} 0 obj\n${objs[i]}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objs.length}\n0000000000 65535 f \n`+positions.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Root 1 0 R /Size ${objs.length} >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(pdf,'utf8');
}
export {receiptPdf};
