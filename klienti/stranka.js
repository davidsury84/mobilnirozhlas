'use strict';
// Veřejná interaktivní stránka pro potenciálního klienta.
// renderStranka(page, { nahled }) → kompletní HTML (bez závislostí, vše inline).
// Obsah je autorský (zaměstnanci), přesto se vše escapuje.

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ztmavení hex barvy (pro gradient)
function tmavsi(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (x) => Math.max(0, Math.round(((n >> x) & 255) * f)).toString(16).padStart(2, '0');
  return '#' + ch(16) + ch(8) + ch(0);
}

function renderStranka(page, opts) {
  opts = opts || {};
  const barva = /^#[0-9a-f]{6}$/i.test(page.barva || '') ? page.barva : '#0a6b34';
  const barva2 = tmavsi(barva, 0.65);
  const hero = page.hero || {};
  const kontakt = page.kontakt || {};
  const vyhody = page.vyhody || [];
  const produkty = page.produkty || [];
  const faq = page.faq || [];

  const nahledPruh = opts.nahled
    ? '<div style="position:sticky;top:0;z-index:99;background:#7a5c0e;color:#fff;text-align:center;padding:8px 14px;font:600 13px/1.4 system-ui">👁️ NÁHLED — takto stránku uvidí klient.' + (page.publikovano ? '' : ' Stránka zatím <u>není zveřejněná</u>.') + '</div>'
    : '';

  const vyhodyHtml = vyhody.length ? '<section class="sec" id="vyhody"><h2 class="reveal">Proč s námi</h2><div class="grid">'
    + vyhody.map((v, i) => '<div class="card reveal" style="transition-delay:' + (i * 70) + 'ms"><div class="num">' + (i + 1) + '</div><h3>' + esc(v.titulek) + '</h3><p>' + esc(v.text) + '</p></div>').join('')
    + '</div></section>' : '';

  const produktyHtml = produkty.length ? '<section class="sec alt" id="produkty"><h2 class="reveal">Co pro vás máme</h2><div class="grid">'
    + produkty.map((v, i) => '<div class="card prod reveal" style="transition-delay:' + (i * 70) + 'ms"><h3>' + esc(v.nazev) + '</h3><p>' + esc(v.popis) + '</p>'
      + (v.cena ? '<div class="cena">' + esc(v.cena) + '</div>' : '')
      + '<button class="btn ghost" onclick="vybrat(' + i + ')">Mám zájem →</button></div>').join('')
    + '</div></section>' : '';

  const faqHtml = faq.length ? '<section class="sec" id="faq"><h2 class="reveal">Časté otázky</h2><div class="faq reveal">'
    + faq.map(f => '<details><summary>' + esc(f.q) + '</summary><p>' + esc(f.a) + '</p></details>').join('')
    + '</div></section>' : '';

  const zajmy = produkty.map(v => v.nazev);

  return '<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex">'
    + '<title>' + esc(hero.titulek || page.nazev) + ' — ELKOPLAST CZ</title>'
    + '<style>'
    + ':root{--b:' + barva + ';--b2:' + barva2 + ';--zluta:#ffd21a}'
    + '*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#121814;background:#fff;line-height:1.6}'
    + '.hd{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 22px;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border-bottom:1px solid #e8ece8}'
    + '.hd .logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:16px}.hd .logo b{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:linear-gradient(150deg,#ffd21a,#ffc400);color:#11271c;font-size:18px}'
    + '.btn{display:inline-block;border:none;cursor:pointer;border-radius:11px;padding:12px 22px;font:600 15px system-ui;background:linear-gradient(135deg,var(--b),var(--b2));color:#fff;text-decoration:none;transition:transform .15s,box-shadow .15s}'
    + '.btn:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(0,0,0,.18)}.btn.ghost{background:#fff;color:var(--b);border:1.5px solid var(--b)}'
    + '.hero{position:relative;padding:84px 22px 96px;text-align:center;color:#fff;background:radial-gradient(1000px 500px at 85% -10%,rgba(255,210,26,.25),transparent 60%),linear-gradient(135deg,var(--b),var(--b2))}'
    + '.hero .chip{display:inline-block;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:6px 16px;font-size:13px;font-weight:600;margin-bottom:18px}'
    + '.hero h1{font-size:clamp(28px,5vw,46px);margin:0 0 14px;line-height:1.15}.hero p{max-width:640px;margin:0 auto 30px;font-size:17px;opacity:.94}'
    + '.hero .btn{background:var(--zluta);color:#11271c;font-size:16px;padding:14px 30px}'
    + '.sec{max-width:1020px;margin:0 auto;padding:64px 22px}.sec.alt{max-width:none;background:#f2f6f2}.sec.alt>*{max-width:1020px;margin-left:auto;margin-right:auto}'
    + '.sec h2{font-size:clamp(22px,3.4vw,32px);margin:0 0 28px;text-align:center}'
    + '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:18px}'
    + '.card{background:#fff;border:1px solid #e4e9e4;border-radius:16px;padding:22px;box-shadow:0 4px 14px rgba(15,25,18,.05)}'
    + '.card h3{margin:0 0 8px;font-size:17px}.card p{margin:0;color:#4c564e;font-size:14.5px}'
    + '.card .num{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:color-mix(in srgb,var(--b) 12%,#fff);color:var(--b);font-weight:800;margin-bottom:12px}'
    + '.card.prod{display:flex;flex-direction:column;gap:10px}.card.prod .btn{margin-top:auto;align-self:flex-start}.cena{font-weight:700;color:var(--b)}'
    + '.faq{max-width:720px;margin:0 auto}.faq details{background:#fff;border:1px solid #e4e9e4;border-radius:12px;margin-bottom:10px;padding:0 18px}'
    + '.faq summary{cursor:pointer;padding:15px 0;font-weight:600;list-style:none;position:relative;padding-right:28px}.faq summary::after{content:"+";position:absolute;right:2px;top:12px;font-size:20px;color:var(--b)}.faq details[open] summary::after{content:"–"}.faq details p{margin:0 0 15px;color:#4c564e}'
    + '.oNas{max-width:760px;margin:0 auto;font-size:16px;color:#333d35;white-space:pre-line}'
    + '/* průvodce poptávkou */'
    + '.wiz{max-width:680px;margin:0 auto;background:#fff;border:1px solid #e4e9e4;border-radius:20px;box-shadow:0 14px 40px rgba(15,25,18,.09);padding:30px 28px}'
    + '.kroky{display:flex;gap:8px;margin-bottom:24px}.kroky i{flex:1;height:5px;border-radius:99px;background:#e4e9e4;font-style:normal}.kroky i.on{background:var(--b)}'
    + '.wiz h3{margin:0 0 16px;font-size:20px}'
    + '.mozn{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:20px}'
    + '.mozn label{display:flex;align-items:center;gap:9px;border:1.5px solid #dbe2db;border-radius:11px;padding:11px 13px;cursor:pointer;font-size:14.5px;font-weight:500}'
    + '.mozn label:has(input:checked){border-color:var(--b);background:color-mix(in srgb,var(--b) 7%,#fff)}'
    + '.wiz input[type=text],.wiz input[type=email],.wiz select,.wiz textarea{width:100%;padding:11px 13px;border:1.5px solid #dbe2db;border-radius:10px;font:15px system-ui;margin:0 0 12px}'
    + '.wiz input:focus,.wiz select:focus,.wiz textarea:focus{outline:none;border-color:var(--b)}'
    + '.wiz .lbl{font-size:13px;font-weight:600;color:#4c564e;margin-bottom:4px;display:block}'
    + '.wnav{display:flex;justify-content:space-between;gap:10px;margin-top:6px}.wnav .zpet{background:#fff;color:#4c564e;border:1.5px solid #dbe2db}'
    + '.err{color:#c23636;font-size:13.5px;min-height:18px;margin:4px 0 0}'
    + '.hotovo{text-align:center;padding:26px 6px}.hotovo .ok{width:64px;height:64px;border-radius:50%;background:color-mix(in srgb,var(--b) 14%,#fff);color:var(--b);display:grid;place-items:center;font-size:32px;margin:0 auto 16px}'
    + 'footer{background:#11271c;color:#cfe3d6;padding:38px 22px;margin-top:70px}footer .in{max-width:1020px;margin:0 auto;display:flex;flex-wrap:wrap;gap:26px;justify-content:space-between;font-size:14px}footer a{color:#ffd21a;text-decoration:none}'
    + '.reveal{opacity:0;transform:translateY(16px);transition:opacity .5s,transform .5s}.reveal.in{opacity:1;transform:none}'
    + '@media(max-width:560px){.hero{padding:56px 18px 66px}.wiz{padding:24px 18px}}'
    + '</style></head><body>'
    + nahledPruh
    + '<header class="hd"><div class="logo"><b>✓</b>ELKOPLAST CZ</div><a class="btn" href="#poptavka">' + esc(hero.cta || 'Nezávazná poptávka') + '</a></header>'
    + '<section class="hero">'
    + (page.klientFirma ? '<div class="chip">Připraveno pro ' + esc(page.klientFirma) + '</div>' : '')
    + '<h1>' + esc(hero.titulek || page.nazev) + '</h1>'
    + (hero.podtitulek ? '<p>' + esc(hero.podtitulek) + '</p>' : '')
    + '<a class="btn" href="#poptavka">' + esc(hero.cta || 'Nezávazná poptávka') + ' →</a>'
    + '</section>'
    + (page.oNas ? '<section class="sec"><h2 class="reveal">Kdo jsme</h2><div class="oNas reveal">' + esc(page.oNas) + '</div></section>' : '')
    + vyhodyHtml
    + produktyHtml
    + faqHtml
    + '<section class="sec" id="poptavka"><h2 class="reveal">' + esc(hero.cta || 'Nezávazná poptávka') + '</h2>'
    + '<div class="wiz reveal"><div class="kroky"><i class="on"></i><i id="k2"></i><i id="k3"></i></div>'
    // krok 1 — co vás zajímá
    + '<div class="krok" id="krok1"><h3>Co vás zajímá?</h3>'
    + (zajmy.length
      ? '<div class="mozn">' + zajmy.map((z, i) => '<label><input type="checkbox" class="zajem" value="' + esc(z) + '" id="zj' + i + '">' + esc(z) + '</label>').join('') + '</div>'
      : '<span class="lbl">Popište stručně, co řešíte</span><textarea id="zajemText" rows="3" placeholder="Např. sběrné nádoby pro obec, kontejnery…"></textarea>')
    + '<div class="wnav"><span></span><button class="btn" onclick="dal(2)">Pokračovat →</button></div></div>'
    // krok 2 — objem a termín
    + '<div class="krok" id="krok2" hidden><h3>Upřesnění</h3>'
    + '<span class="lbl">Předpokládaný objem / množství</span>'
    + '<select id="objem"><option value="">— vyberte —</option><option>Jednorázový nákup</option><option>Menší pravidelný odběr</option><option>Větší pravidelný odběr</option><option>Zatím nevím, chci poradit</option></select>'
    + '<span class="lbl">Kdy to potřebujete řešit?</span>'
    + '<select id="termin"><option value="">— vyberte —</option><option>Co nejdřív</option><option>Do 3 měsíců</option><option>Do půl roku</option><option>Jen mapuji možnosti</option></select>'
    + '<div class="wnav"><button class="btn zpet" onclick="dal(1)">← Zpět</button><button class="btn" onclick="dal(3)">Pokračovat →</button></div></div>'
    // krok 3 — kontakt
    + '<div class="krok" id="krok3" hidden><h3>Kam se vám máme ozvat?</h3>'
    + '<span class="lbl">Jméno a příjmení *</span><input type="text" id="jmeno" autocomplete="name">'
    + '<span class="lbl">Firma / obec</span><input type="text" id="firma" autocomplete="organization">'
    + '<span class="lbl">E-mail</span><input type="email" id="email" autocomplete="email">'
    + '<span class="lbl">Telefon</span><input type="text" id="telefon" autocomplete="tel">'
    + '<span class="lbl">Zpráva (nepovinné)</span><textarea id="zprava" rows="3"></textarea>'
    + '<div class="err" id="chyba"></div>'
    + '<div class="wnav"><button class="btn zpet" onclick="dal(2)">← Zpět</button><button class="btn" id="odeslatBtn" onclick="odeslat()">Odeslat poptávku ✓</button></div></div>'
    // hotovo
    + '<div class="krok hotovo" id="krok4" hidden><div class="ok">✓</div><h3>Děkujeme za poptávku!</h3>'
    + '<p style="color:#4c564e">Ozveme se vám co nejdříve' + (kontakt.jmeno ? ' — ' + esc(kontakt.jmeno) : '') + '.</p></div>'
    + '</div></section>'
    + '<footer><div class="in">'
    + '<div><b style="color:#fff">ELKOPLAST CZ, s.r.o.</b><br>Štefánikova 2664, Zlín<br><a href="https://www.elkoplast.cz" rel="noopener">www.elkoplast.cz</a></div>'
    + (kontakt.jmeno || kontakt.email || kontakt.telefon
      ? '<div><b style="color:#fff">Váš kontakt</b><br>' + esc(kontakt.jmeno)
        + (kontakt.email ? '<br><a href="mailto:' + esc(kontakt.email) + '">' + esc(kontakt.email) + '</a>' : '')
        + (kontakt.telefon ? '<br>' + esc(kontakt.telefon) : '') + '</div>'
      : '')
    + '</div></footer>'
    + '<script>'
    + 'var SLUG=' + JSON.stringify(page.slug) + ';'
    + 'function dal(n){for(var i=1;i<=3;i++){document.getElementById("krok"+i).hidden=(i!==n);}'
    + 'document.getElementById("k2").className=n>=2?"on":"";document.getElementById("k3").className=n>=3?"on":"";'
    + 'document.querySelector(".wiz").scrollIntoView({behavior:"smooth",block:"center"});}'
    + 'function vybrat(i){var c=document.getElementById("zj"+i);if(c)c.checked=true;dal(1);'
    + 'document.getElementById("poptavka").scrollIntoView({behavior:"smooth"});}'
    + 'async function odeslat(){var ch=document.getElementById("chyba");ch.textContent="";'
    + 'var zajem=[].slice.call(document.querySelectorAll(".zajem:checked")).map(function(x){return x.value});'
    + 'var zt=document.getElementById("zajemText");if(zt&&zt.value.trim())zajem.push(zt.value.trim());'
    + 'var b={slug:SLUG,zajem:zajem,objem:document.getElementById("objem").value,termin:document.getElementById("termin").value,'
    + 'jmeno:document.getElementById("jmeno").value.trim(),firma:document.getElementById("firma").value.trim(),'
    + 'email:document.getElementById("email").value.trim(),telefon:document.getElementById("telefon").value.trim(),'
    + 'zprava:document.getElementById("zprava").value.trim()};'
    + 'if(!b.jmeno){ch.textContent="Vyplňte prosím jméno.";return}'
    + 'if(!b.email&&!b.telefon){ch.textContent="Vyplňte e-mail nebo telefon, ať se vám můžeme ozvat.";return}'
    + 'var btn=document.getElementById("odeslatBtn");btn.disabled=true;btn.textContent="Odesílám…";'
    + 'try{var r=await fetch("/api/klienti/lead",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});'
    + 'var j=await r.json();if(!r.ok)throw new Error(j.error||"Odeslání selhalo.");'
    + 'for(var i=1;i<=3;i++)document.getElementById("krok"+i).hidden=true;document.getElementById("krok4").hidden=false;}'
    + 'catch(e){ch.textContent=e.message;btn.disabled=false;btn.textContent="Odeslat poptávku ✓";}}'
    // plynulé odkrývání sekcí
    + 'var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target)}})},{threshold:.12});'
    + 'document.querySelectorAll(".reveal").forEach(function(el){io.observe(el)});'
    + '</script></body></html>';
}

module.exports = { renderStranka };
