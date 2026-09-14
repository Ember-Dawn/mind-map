FROM node:20-bookworm-slim AS builder

WORKDIR /app/web

CMD ["sh", "-c", "if [ ! -x node_modules/.bin/vue-cli-service ]; then npm ci; fi && node scripts/static-watch.js"]

FROM nginx:1.27-alpine AS server

COPY nginx.conf /etc/nginx/nginx.conf
