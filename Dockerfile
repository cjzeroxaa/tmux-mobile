# Multi-arch Node image; builds and runs on both linux/amd64 and linux/arm64.
# Fargate ARM64 (Graviton) is ~20% cheaper than x86 for the same shape, and
# the user's Mac is Apple Silicon so the image builds natively without QEMU.
FROM node:22-slim

WORKDIR /app
ARG TMUX_MOBILE_REVISION=dev
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3737
ENV TMUX_MOBILE_REVISION=$TMUX_MOBILE_REVISION

COPY package*.json ./
RUN npm ci

COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

RUN npm run build:connector && npm prune --omit=dev

# Document the listening port for tooling; ECS/Fargate uses the task def's
# containerPort regardless, so this is purely informational.
EXPOSE 3737

# /api/health is the controller's liveness probe — it answers {ok:true}
# without touching tmux, OpenAI, or Google OAuth, so it's safe to hit
# every 30s. ALB uses its own target-group health check at the same path.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs", "--controller"]
