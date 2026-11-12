# Agent service: campaign planning and lead sourcing workers.
# Node 22 runs the TypeScript sources directly (type stripping), so there is no build step.
FROM node:22.23.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
