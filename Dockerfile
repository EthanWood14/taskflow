# TaskFlow — Node backend (accounts, sync, realtime, API) that also serves the static app.
FROM node:20-alpine
WORKDIR /app

# Install server deps first (better layer caching)
COPY server/package.json ./
RUN npm install --omit=dev

# Server code
COPY server/server.js ./

# Static app, served from /app/public
COPY index.html manifest.webmanifest sw.js ./public/

ENV PUBLIC_DIR=/app/public
ENV DATA_DIR=/data
# Railway injects PORT; default for local runs:
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
