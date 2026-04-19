# Standard Node.js Dockerfile for flawless deployment
FROM node:20-slim

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev --ignore-scripts

# Copy source code (excluding what's in .dockerignore)
COPY . .

# Ensure data directory exists
RUN mkdir -p data

EXPOSE 3000

CMD ["node", "src/server.js"]
