# Production Dockerfile for Internet Archive Stremio Addon
FROM node:20-alpine AS base

# Install curl for healthcheck
RUN apk add --no-cache curl

# Working directory
WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application source code
COPY index.js addon.js archive.js ./
COPY public ./public

# Environment defaults
ENV NODE_ENV=production \
    PORT=7000 \
    HOST=0.0.0.0

# Use non-root node user for security
USER node

# Expose server port
EXPOSE 7000

# Container Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:7000/health || exit 1

# Start the server
CMD ["node", "index.js"]
