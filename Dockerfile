FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY --chown=node:node . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Use numeric UID so Kubernetes runAsNonRoot can verify the user is non-root.
# UID 1000 is the 'node' user in node:alpine images.
USER 1000

CMD ["npm", "start"]