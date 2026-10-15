FROM oven/bun:1.4.3-debian
ENV NODE_ENV=production
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --chown=bun:bun . .
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "run", "start"]
