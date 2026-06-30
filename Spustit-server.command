#!/bin/bash
# Spuštění intranet serveru s automatickým restartem po pádu.
# Na Macu lze poklepat (double-click). Okno nechte otevřené.
# Zastavení: stiskni Ctrl+C nebo zavři okno.

cd "$(dirname "$0")" || exit 1

echo "============================================================"
echo " Intranet ELKOPLAST — server"
echo " Adresa:  http://localhost:8080"
echo " Okno nechte OTEVŘENÉ. Zastavení: Ctrl+C nebo zavřít okno."
echo "============================================================"
echo ""

# uvolni port, kdyby tam visel starý proces
OLD=$(lsof -nP -iTCP:8080 -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$OLD" ]; then
  echo "Uvolňuji port 8080 (ukončuji starý proces $OLD)…"
  kill "$OLD" 2>/dev/null; sleep 1
fi

# auto-restart smyčka: když server spadne, po 2 s ho znovu nahodí
while true; do
  node server.js
  CODE=$?
  echo ""
  echo ">> Server se ukončil (kód $CODE). Restartuji za 2 s…  (Ctrl+C = konec)"
  sleep 2
done
