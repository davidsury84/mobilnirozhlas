# Node 24: modul „Smlouvy" používá vestavěné node:sqlite (dostupné bez flagu od Node 24).
FROM node:24-alpine
WORKDIR /app
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
