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
  -e PUBLIC_URL=https://intranet.elkoplast.cz \
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
DATA_DIR=/var/smernice ADMIN_PASSWORD=… PUBLIC_URL=https://intranet.elkoplast.cz node server.js
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
| `GOOGLE_CLIENT_ID` | OAuth Client ID (intranet – přihlášení zaměstnanců) | – |
| `GOOGLE_CLIENT_SECRET` | OAuth Client Secret | – |
| `ALLOWED_HD` | omezení SSO jen na firemní doménu (např. `elkoplast.cz`) | bez omezení |

## Intranet pro zaměstnance (přihlášení přes Google)

Vedle rozesílání e-mailů je k dispozici **intranet** na adrese **`<PUBLIC_URL>/#muj`**.
Zaměstnanec se přihlásí firemním Google účtem a uvidí seznam **směrnic** i dokumentů **knihovny**
(pracovní řád, SOP, postupy), které se ho týkají, včetně stavu *přečteno / nepřečteno*,
a může je rovnou potvrzovat. Dokumenty knihovny jsou **verzované** — při nové verzi je potřeba potvrzení znovu.
E-mailové rozesílání zůstává beze změny.

- Přihlášený, který ještě není v seznamu zaměstnanců, se při prvním přihlášení **automaticky založí**.
- S nastaveným `ALLOWED_HD` se dovnitř dostanou jen účty z firemní domény.
- **Vyžaduje HTTPS** (Google OAuth po holém HTTP nepovolí mimo `localhost`).

### Nastavení Google OAuth (jednorázově)
1. V [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials** vytvoř
   **OAuth client ID** typu *Web application*.
2. Do **Authorized redirect URIs** přidej adresu `…/auth/google/callback`, **přesně** podle prostředí:
   - lokální test: `http://localhost:8080/auth/google/callback` (Google `http://localhost` povoluje)
   - produkce: `https://<tvoje-doména>/auth/google/callback`
3. Zkopíruj `.env.example` na **`.env`** a vyplň `GOOGLE_CLIENT_ID` a `GOOGLE_CLIENT_SECRET`
   (soubor `.env` je v `.gitignore`, necommituje se). Proměnné lze zadat i přes prostředí.
4. (Doporučeno pro produkci) nastav `ALLOWED_HD=tvoje-doména.cz`. Pro první test s osobním Gmailem nech prázdné.
5. Restartuj server — v konzoli se vypíše `Intranet (Google SSO): zapnuto`. Na `/#muj` se objeví tlačítko
   „Přihlásit se přes Google" (lokální demo přihlášení se automaticky vypne).

> Tip: dokud SSO nenastavíš, je na `localhost` k dispozici **demo přihlášení** (tlačítko „Vyzkoušet jako
> demo zaměstnanec") — funguje jen lokálně, v produkci je vypnuté.

## Měsíční vyhodnocení (automatický e-mail)

Jednou měsíčně server sestaví **vyhodnocení stavu seznámení** (směrnice i dokumenty knihovny vyžadující potvrzení —
kolik lidí potvrdilo, kdo má nevyřízené, celková míra) a odešle ho e-mailem.

- Příjemce: `REPORT_EMAIL` (výchozí `tomas.krajca@elkoplast.cz`).
- Den odeslání: `REPORT_DAY` (1–28, výchozí 1.). Pokud server v daný den neběžel, odešle se při nejbližším startu daný měsíc.
- Vypnutí: `REPORT_ENABLED=0`.
- **Vyžaduje nastavenou poštu** (SMTP v záložce Nastavení, nebo `RESEND_API_KEY`). Bez ní se přeskočí.
- Náhled (po přihlášení do správy): `GET /api/report/preview`. Ruční odeslání teď: `POST /api/report/send`.

## Soubory
- `server.js` — server (čistý Node.js, bez závislostí)
- `seznameni-se-smernicemi.html` — aplikace
- `Dockerfile` — pro nasazení přes Docker
- `data/` — vznikne sám: `state.json` (směrnice, zaměstnanci), `acks.json` (potvrzení),
  `mail.config.json` (SMTP – obsahuje heslo), `secret.json` (heslo správy + klíč), `published/` (rozeslané směrnice),
  `library.json` (knihovna – verzované dokumenty), `library-acks.json` (potvrzení verzí)
- `Spustit-WINDOWS.bat` / `Spustit-MAC-LINUX.command` — spuštění pro lokální vyzkoušení OK
- 
