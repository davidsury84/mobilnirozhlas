'use strict';
// Server-side generátor publikované stránky směrnice — přeneseno 1:1 z klienta (buildPublished).
// ctx: { audience:[{email,name}], hrEmail, apiUrl, baseUrl }. Používá import směrnic a publikaci na serveru.
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function buildPublished(d, ctx){
  const aud=(ctx.audience||[]).map(e=>({email:e.email,name:e.name}));
  let apiB=(ctx.apiUrl||"").replace(/\/+$/,"");
  if(!apiB && ctx.baseUrl){ try{ apiB=new URL(ctx.baseUrl).origin; }catch(e){} }
  const DATA={id:d.id,title:d.title,html:d.html,hr:(ctx.hrEmail||""),api:apiB,aud:aud};
  const dataStr=JSON.stringify(DATA).replace(/<\//g,'<\\/');
  const css=`*{box-sizing:border-box}
body{margin:0;background:#f3f2ee;color:#1c1d1a;font-family:"IBM Plex Sans",system-ui,sans-serif;line-height:1.5}
header{background:#1c1d1a;color:#f3f2ee;border-bottom:3px solid #2d7a52;padding:14px 22px}
header .b{max-width:880px;margin:0 auto;display:flex;align-items:center;gap:12px}
header .lg{width:32px;height:32px;border-radius:8px;background:#2d7a52;display:grid;place-items:center;color:#fff;font-weight:700}
header h1{font-size:16px;margin:0;font-weight:700}
header small{display:block;font-size:11px;color:#a9aaa3;text-transform:uppercase;letter-spacing:.04em}
main{max-width:880px;margin:0 auto;padding:26px 22px 80px}
.ident{background:#fff;border:1px solid #dcdbd4;border-radius:10px;padding:12px 16px;margin-bottom:18px;font-size:14px}
.ident label{display:block;font-size:12px;font-weight:600;color:#5a5d57;margin-bottom:5px;text-transform:uppercase}
.ident input{width:100%;max-width:360px;padding:9px 11px;border:1px solid #c3c2b8;border-radius:8px;font-size:14px;font-family:inherit}
.mono{font-family:"IBM Plex Mono",monospace}.mu{color:#5a5d57}
.doc{background:#fff;border:1px solid #dcdbd4;border-radius:10px;box-shadow:0 8px 24px rgba(28,29,26,.06);padding:48px 54px;font-family:"IBM Plex Serif",Georgia,serif;color:#26271f;line-height:1.65}
.doc h1{font-family:"IBM Plex Sans";font-size:26px;font-weight:700;margin:.2em 0 .5em}
.doc h2{font-family:"IBM Plex Sans";font-size:20px;font-weight:600;margin:1.3em 0 .4em;border-bottom:2px solid #e6f1ea;padding-bottom:5px}
.doc h3{font-family:"IBM Plex Sans";font-size:16px;font-weight:600;margin:1.1em 0 .3em}
.doc ul,.doc ol{padding-left:1.5em}
.doc table{border-collapse:collapse;width:100%;margin:1em 0;font-family:"IBM Plex Sans";font-size:14px}
.doc th,.doc td{border:1px solid #c3c2b8;padding:8px 10px;text-align:left}.doc th{background:#faf9f6}
.doc img{max-width:100%;height:auto}
.ack{margin:24px 0 0;background:#fff;border:2px solid #2d7a52;border-radius:10px;padding:22px 26px}
.ack.done{border-color:#1f5d3f;background:#e6f1ea}
.chk{display:flex;gap:12px;align-items:flex-start;cursor:pointer;user-select:none}
.chk input{width:20px;height:20px;margin-top:2px;accent-color:#2d7a52;flex:none}
.btn{border:1px solid #1f5d3f;background:#1f5d3f;color:#fff;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;font-family:inherit;cursor:pointer}
.btn:disabled{opacity:.45;cursor:not-allowed}
@media print{header,.ident,.ack{display:none}.doc{box-shadow:none;border:none;padding:0}}`;
  const js=`
var who=(location.hash.match(/kdo=([^&]+)/i)||[])[1]; who=who?decodeURIComponent(who):"";
var emp=null; for(var i=0;i<DATA.aud.length;i++){ if(DATA.aud[i].email.toLowerCase()===who.toLowerCase()) emp=DATA.aud[i]; }
var LK="elko_pub_"+DATA.id;
function getDone(){ try{return JSON.parse(localStorage.getItem(LK)||"{}");}catch(e){return {};} }
function setDone(o){ try{localStorage.setItem(LK,JSON.stringify(o));}catch(e){} }
function eh(s){ return (s||"").replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); }
function curEmail(){ if(who) return who; var el=document.getElementById("em"); return el?el.value.trim():""; }
function onEmail(){ var em=document.getElementById("em"),ck=document.getElementById("ck"); if(!ck) return; ck.disabled=em.value.trim().indexOf("@")<0; if(ck.disabled){ck.checked=false; var cf=document.getElementById("cf"); if(cf) cf.disabled=true;} }
function wire(){ var em=document.getElementById("em"); if(em) em.addEventListener("input",onEmail);
  var ck=document.getElementById("ck"); if(ck){ ck.addEventListener("change",function(){var cf=document.getElementById("cf"); if(cf) cf.disabled=!ck.checked;}); }
  var cf=document.getElementById("cf"); if(cf) cf.addEventListener("click",confirmIt); }
function render(){
  var idEl=document.getElementById("ident"), box=document.getElementById("ack"), done=getDone();
  if(who){ idEl.innerHTML='Seznamuje se: <strong>'+eh(emp?emp.name:who)+'</strong> <span class="mono mu">&lt;'+eh(who)+'&gt;</span>'; }
  else { idEl.innerHTML='<label>Zadejte svůj e-mail</label><input id="em" type="email" list="dl" placeholder="jmeno@firma.cz"><datalist id="dl">'+DATA.aud.map(function(a){return '<option value="'+a.email+'">'+eh(a.name)+'</option>';}).join("")+'</datalist>'; }
  var email=curEmail();
  if(email && done[email.toLowerCase()]){ box.className="ack done"; box.innerHTML='<strong>&#10003; Seznámení potvrzeno</strong><br><span class="mu">'+new Date(done[email.toLowerCase()]).toLocaleString("cs-CZ")+'</span>'; return; }
  box.className="ack";
  box.innerHTML='<label class="chk"><input type="checkbox" id="ck"'+(who?"":" disabled")+'><span>Prohlašuji, že jsem se s dokumentem <strong>seznámil(a) a přečetl(a)</strong> jej v plném rozsahu a porozuměl(a) jeho obsahu.</span></label><div style="margin-top:14px"><button class="btn" id="cf" disabled>Potvrdit seznámení</button></div>';
  wire();
}
function confirmIt(){
  var email=curEmail(); if(!email || email.indexOf("@")<0){ alert("Zadejte platný e-mail."); return; }
  var name = emp? emp.name : email;
  if(!emp){ for(var i=0;i<DATA.aud.length;i++){ if(DATA.aud[i].email.toLowerCase()===email.toLowerCase()) name=DATA.aud[i].name; } }
  var ts=Date.now();
  var cf=document.getElementById("cf"); if(cf){ cf.disabled=true; cf.textContent="Odesílám…"; }
  function finish(){ var done=getDone(); done[email.toLowerCase()]=ts; setDone(done); render(); }
  var payload={dirId:DATA.id, dirTitle:DATA.title, email:email.toLowerCase(), name:name, ts:ts};
  var apiBase=(DATA.api||"").replace(/[/]+$/,"");
  if(typeof fetch!=="undefined"){
    fetch(apiBase+"/api/ack",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
      .then(function(r){ if(!r.ok) throw 0; finish(); })
      .catch(function(){ mailtoFallback(payload); finish(); });
  } else { mailtoFallback(payload); finish(); }
}
function mailtoFallback(p){
  if(!DATA.hr) return;
  var nl=String.fromCharCode(10);
  var token="ELKO-OK|"+p.dirId+"|"+p.email+"|"+new Date(p.ts).toISOString();
  var subj="Potvrzení seznámení: "+DATA.title;
  var body="Potvrzuji seznámení se směrnicí: "+DATA.title+nl+"Jméno: "+p.name+nl+"E-mail: "+p.email+nl+"Datum: "+new Date(p.ts).toLocaleString("cs-CZ")+nl+nl+"[strojový kód – neměňte]"+nl+token+nl;
  location.href="mailto:"+encodeURIComponent(DATA.hr)+"?subject="+encodeURIComponent(subj)+"&body="+encodeURIComponent(body);
}
function init(){ document.getElementById("hd").textContent=DATA.title; document.title=DATA.title; document.getElementById("doc").innerHTML=DATA.html; render(); }
window.addEventListener("load",init);`;
  return '<!doctype html>\n<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n'+
    '<title>'+esc(d.title)+'</title>\n'+
    '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Serif:wght@400;500;600&display=swap" rel="stylesheet">\n'+
    '<style>'+css+'</style></head>\n<body>\n'+
    '<header><div class="b"><div class="lg">&#10003;</div><div><h1 id="hd">Směrnice</h1><small>Prosím přečtěte a potvrďte</small></div></div></header>\n'+
    '<main><div class="ident" id="ident"></div><div class="doc" id="doc"></div><div class="ack" id="ack"></div></main>\n'+
    '<script>var DATA='+dataStr+';\n'+js+'\n<\/script>\n</body></html>';
}

module.exports = { buildPublished };
