FROM node:20-bookworm-slim

WORKDIR /app/web

EXPOSE 8080

CMD ["sh", "-c", "if [ ! -x node_modules/.bin/vue-cli-service ]; then npm ci; fi && npm run serve -- --host 0.0.0.0 --port 8080"]
