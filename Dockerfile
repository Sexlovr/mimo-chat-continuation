# ── Build stage: compile better-sqlite3 native addon ──
FROM node:20-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --production

# ── Runtime stage: lean image ──
FROM node:20-slim

WORKDIR /app

# Install chromium for the auto-login CDP flow (optional; only needed if you
# want /admin/accounts/autologin to drive a headless browser).
RUN apt-get update && \
    apt-get install -y --no-install-recommends chromium && \
    rm -rf /var/lib/apt/lists/*

# Copy compiled node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY package*.json ./
COPY index.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY captures/ ./captures/

# Create persistent data directory
RUN mkdir -p /data

# HuggingFace Spaces expects port 7860
# /data is the persistent storage mount
ENV PORT=7860
ENV DATA_DIR=/data
ENV ADMIN_PASSWORD=admin
ENV JWT_SECRET=""
ENV CONV_TIMEOUT_MINUTES=60
ENV CLEANUP_HOURS=24
ENV DEBUG=1

EXPOSE 7860

CMD ["node", "index.js"]
