# Atomix — small image with Node.js LTS + ffmpeg. No npm install needed.
FROM node:24-alpine

# ffmpeg for probing/transcoding, tini to forward signals, tzdata for logs.
# For Intel/AMD VAAPI add: mesa-va-gallium intel-media-driver libva-utils
RUN apk add --no-cache ffmpeg tini tzdata

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY plugins ./plugins
COPY themes ./themes
COPY scripts ./scripts

ENV NODE_ENV=production \
    ATOMIX_HOST=0.0.0.0 \
    ATOMIX_PORT=8787 \
    ATOMIX_DATA_DIR=/data

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
