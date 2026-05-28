# Seznámení se směrnicemi — online aplikace

Webová aplikace na evidenci seznámení zaměstnanců se směrnicemi.
Nahraješ dokument → rozešleš každému vlastní e-mail s odkazem → vidíš, kdo se seznámil.
Data jsou na serveru (dostupná odkudkoli, nic se neztratí). Bez jakýchkoli závislostí — čistý Node.js.

## Co je potřeba
- místo, kde poběží server: **vlastní/firemní server, levný VPS, nebo cloud (Render, Railway…)**,
- (doporučeno) **doména a HTTPS** — ať odkazy v e-mailech vypadají důvěryhodně.

## Přihlášení
Správa je chráněná heslem. Heslo nastavíš proměnnou `ADMIN_PASSWORD`.
Když ji nenastavíš, server si při prvním startu heslo vygeneruje a **vypíše do konzole** (a uloží do `data/secret.json`).

## Nastavení pošty
Po přihlášení v aplikaci: **Nastavení → Odesílání e-mailů** — vybereš poskytovatele, zadáš e-mail a heslo,
otestuješ „Odeslat zkušební e-mail". Heslo zůstává jen na serveru (`data/mail.config.json`).

---

## Nasazení – 3 možnosti

### A) Docker (nejjednodušší, kdekoli)
```
docker build -t smernice .
docker run -d --name smernice -p 80:8080 \
  -v /opt/smernice-data:/data \
  -e ADMIN_PASSWORD=zvol-silne-heslo \
  -e PUBLIC_URL=https://smernice.elkoplast.cz \
  smernice
```
Složka `/opt/smernice-data` uchová data i po restartu. HTTPS vyřeš reverzní proxy (nginx/Caddy/Traefik).

### B) Cloud (Render.com / Railway – bez vlastního serveru)
1. Nahraj tyto soubory do Git repozitáře (GitHub).
2. Vytvoř **Web Service** z repozitáře. Build necháš prázdný, start příkaz: `node server.js`.
3. Přidej **persistentní disk** připojený na cestu `/data` (např. 1 GB).
4. Nastav proměnné: `DATA_DIR=/data`, `ADMIN_PASSWORD=…`, `PUBLIC_URL=https://…` (adresa, kterou ti služba přidělí).
5. HTTPS i doménu řeší platforma sama.

### C) Přímo na serveru (Node + reverzní proxy)
```
DATA_DIR=/var/smernice ADMIN_PASSWORD=… PUBLIC_URL=https://smernice.elkoplast.cz node server.js
```
Spusť jako službu (systemd / pm2) a postav před to nginx/Caddy s HTTPS.

---

## Proměnné prostředí
| Proměnná | Význam | Výchozí |
|---|---|---|
| `PORT` | port serveru | 8080 |
| `ADMIN_PASSWORD` | heslo do správy | vygeneruje se |
| `PUBLIC_URL` | veřejná adresa (pro odkazy v e-mailech) | odvodí z požadavku |
| `DATA_DIR` | kam ukládat data | `./data` |

## Soubory
- `server.js` — server (čistý Node.js, bez závislostí)
- `seznameni-se-smernicemi.html` — aplikace
- `Dockerfile` — pro nasazení přes Docker
- `data/` — vznikne sám: `state.json` (směrnice, zaměstnanci), `acks.json` (potvrzení),
  `mail.config.json` (SMTP – obsahuje heslo), `secret.json` (heslo správy + klíč), `published/` (rozeslané směrnice)
- `Spustit-WINDOWS.bat` / `Spustit-MAC-LINUX.command` — spuštění pro lokální vyzkoušení
