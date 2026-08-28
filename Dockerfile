FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY bin ./bin
# Optional: -e GRIDHUB_API_KEY=ghk_... for full data; sample mode without.
ENTRYPOINT ["node", "bin/gridhub-mcp.mjs"]
