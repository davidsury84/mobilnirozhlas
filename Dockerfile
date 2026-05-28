FROM node:20-alpine
WORKDIR /app
COPY server.js seznameni-se-smernicemi.html ./
ENV PORT=8080
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server.js"]
