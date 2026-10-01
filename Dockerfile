# Stage 1: Build the frontend Next.js app
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
# Allow build without failing on missing backend files initially
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 2: Final runtime container with Python 3.11 + Node 20
FROM python:3.11-slim-bookworm
WORKDIR /app

# Install Node.js runtime and supervisor
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    supervisor \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install backend dependencies
COPY backend/ /app/backend/
WORKDIR /app/backend
RUN pip install --no-cache-dir -e ".[dev]"
# Ensure data folder exists
RUN mkdir -p /app/backend/data

# Copy built frontend application
WORKDIR /app/frontend
COPY --from=frontend-builder /app/frontend/.next ./.next
COPY --from=frontend-builder /app/frontend/public ./public
COPY --from=frontend-builder /app/frontend/package*.json ./
COPY --from=frontend-builder /app/frontend/node_modules ./node_modules
COPY frontend/ ./

WORKDIR /app
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

ENV PORT=3000
EXPOSE 3000

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
