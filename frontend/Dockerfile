# -- Stage 1: Base --
FROM node:22-alpine AS base
ENV NEXT_TELEMETRY_DISABLED=1

# -- Stage 2: Dependencies --
FROM base AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
# Note: If you switched to pnpm in your terminal, ensure pnpm-lock.yaml is present.
# Otherwise, 'npm install' works for standard package-lock.json.
RUN npm install

# -- Stage 3: Builder --
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Accept build arguments from docker-compose. 
# These MUST be present for Next.js to bake them into the client-side JS.
ARG NEXT_PUBLIC_NODE_IP
ARG NEXT_PUBLIC_API_PORT
ARG NEXT_PUBLIC_SNAPSHOT_PORT
ARG NEXT_PUBLIC_API_URL

# Set them as environment variables for the 'npm run build' process
ENV NEXT_PUBLIC_NODE_IP=$NEXT_PUBLIC_NODE_IP
ENV NEXT_PUBLIC_API_PORT=$NEXT_PUBLIC_API_PORT
ENV NEXT_PUBLIC_SNAPSHOT_PORT=$NEXT_PUBLIC_SNAPSHOT_PORT
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build

# -- Stage 4: Runner --
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
# Re-declare port for the runner environment
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy necessary files from the builder stage
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next

USER nextjs

EXPOSE 3000

# Start the Next.js production server
CMD ["npx", "next", "start", "-p", "3000", "-H", "0.0.0.0"]
