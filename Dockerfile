# Node 24: modul „Smlouvy" používá vestavěné node:sqlite (dostupné bez flagu od Node 24).
FROM node:24-alpine
WORKDIR /app
COPY . .
# Otiskne čas buildu (ms) — patička „aktualizováno" pak ukazuje skutečný čas nasazení,
# ne čas úpravy souboru na disku vývojáře (COPY zachovává mtime souborů).
RUN node -e "require('fs').writeFileSync('.build-time', String(Date.now()))"
EXPOSE 8080
CMD ["node", "server.js"]
