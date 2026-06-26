FROM apify/actor-node:20

WORKDIR /usr/src/app

# Install all deps (including devDeps needed for tsc build)
COPY package*.json ./
RUN npm ci --include=dev

# Copy source and build
COPY . .
RUN npm run build

# Drop devDeps after build to shrink image
RUN npm prune --omit=dev

CMD ["node", "dist/actor.js"]
