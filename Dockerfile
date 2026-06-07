# TaskFlow — static site served by Caddy. Works on Railway, Fly, Render, any container host.
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /usr/share/caddy/index.html
COPY manifest.webmanifest /usr/share/caddy/manifest.webmanifest
COPY sw.js /usr/share/caddy/sw.js

# Railway sets $PORT at runtime; the Caddyfile reads it. Expose for clarity.
EXPOSE 8777

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
