// Čtečka .xlsx pro modul Výkonnost — VŠECHNY listy v pořadí sešitu (rozšíření nakup-report/xlsx-mini.js, bez závislostí).
const zlib=require('zlib');
function readZip(buf){let e=-1;for(let i=buf.length-22;i>=0&&i>buf.length-22-65536;i--){if(buf.readUInt32LE(i)===0x06054b50){e=i;break}}
if(e<0)throw new Error('EOCD');const c=buf.readUInt16LE(e+10);let off=buf.readUInt32LE(e+16);const en={};
for(let n=0;n<c;n++){if(buf.readUInt32LE(off)!==0x02014b50)break;const m=buf.readUInt16LE(off+10),cs=buf.readUInt32LE(off+20),nl=buf.readUInt16LE(off+28),xl=buf.readUInt16LE(off+30),cl=buf.readUInt16LE(off+32),lho=buf.readUInt32LE(off+42);
en[buf.toString('utf8',off+46,off+46+nl)]={method:m,compSize:cs,lho};off+=46+nl+xl+cl}return{buf,entries:en}}
function extract(z,name){const e=z.entries[name];if(!e)return null;const b=z.buf,l=e.lho;const nl=b.readUInt16LE(l+26),xl=b.readUInt16LE(l+28);const s=l+30+nl+xl;const d=b.slice(s,s+e.compSize);
if(e.method===0)return d;if(e.method===8)return zlib.inflateRawSync(d);throw new Error('comp '+e.method)}
const dec=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#x([0-9a-fA-F]+);/g,(_,h)=>String.fromCodePoint(parseInt(h,16))).replace(/&#(\d+);/g,(_,d)=>String.fromCodePoint(+d)).replace(/&amp;/g,'&');
function textOf(x){let o='';const re=/<t\b[^>]*>([\s\S]*?)<\/t>/g;let m;while((m=re.exec(x)))o+=dec(m[1]);return o}
function colIdx(r){const m=/^([A-Z]+)/.exec(r||'');if(!m)return -1;let n=0;for(const ch of m[1])n=n*26+(ch.charCodeAt(0)-64);return n-1}
function parseAll(buffer){const z=readZip(buffer);const shared=[];const ss=extract(z,'xl/sharedStrings.xml');
if(ss){const sx=ss.toString('utf8');const re=/<si>([\s\S]*?)<\/si>/g;let m;while((m=re.exec(sx)))shared.push(textOf(m[1]))}
// mapa jmen listů
const wb=extract(z,'xl/workbook.xml').toString('utf8');
const rels=(extract(z,'xl/_rels/workbook.xml.rels')||Buffer.from('')).toString('utf8');
const relMap={};{const re=/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;let m;while((m=re.exec(rels)))relMap[m[1]]=m[2].replace(/^\/?xl\//,'').replace(/^\//,'')}
const sheets=[];{const re=/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g;let m;while((m=re.exec(wb)))sheets.push({name:dec(m[1]),path:'xl/'+(relMap[m[2]]||'')})}
// styly (kvůli datům)
const out={};
for(const sh of sheets){const b=extract(z,sh.path);if(!b){out[sh.name]=[];continue}
 const sx=b.toString('utf8');const rows=[];const rowRe=/<row\b[^>]*>([\s\S]*?)<\/row>/g;let rm;
 while((rm=rowRe.exec(sx))){const cells=[];const cRe=/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;let cm;
  while((cm=cRe.exec(rm[1]))){const attr=cm[1]||'',inner=cm[2]||'';const refM=/r="([A-Z]+\d+)"/.exec(attr);const idx=refM?colIdx(refM[1]):cells.length;
   const tM=/t="([^"]+)"/.exec(attr);const t=tM?tM[1]:'';let val='';
   if(t==='s'){const v=/<v>([\s\S]*?)<\/v>/.exec(inner);val=v?(shared[+v[1]]||''):''}
   else if(t==='inlineStr')val=textOf(inner);
   else if(t==='str'){const v=/<v>([\s\S]*?)<\/v>/.exec(inner);val=v?dec(v[1]):''}
   else{const v=/<v>([\s\S]*?)<\/v>/.exec(inner);if(v){const n=parseFloat(v[1]);val=isNaN(n)?dec(v[1]):n}}
   if(idx>=0)cells[idx]=val}
  for(let i=0;i<cells.length;i++)if(cells[i]===undefined)cells[i]='';
  rows.push(cells)}
 out[sh.name]=rows}
return out}
module.exports={parseAll};
