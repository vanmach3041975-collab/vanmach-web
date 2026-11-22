FROM node:24-bookworm-slim
WORKDIR /app/08_BACKEND
RUN npm install --global pnpm@10.17.1
COPY 08_BACKEND/package.json 08_BACKEND/pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY 08_BACKEND/*.mjs ./
COPY 08_BACKEND/admin.html ./
COPY 02_FLUTTER_APP/assets/content/works.json /app/02_FLUTTER_APP/assets/content/works.json
COPY 02_FLUTTER_APP/build/web /app/02_FLUTTER_APP/build/web
RUN mkdir -p /data && chmod 777 /data
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    VANMACH_DATA_DIR=/data \
    FIREBASE_PROJECT_ID=vanmach-8b20f \
    GEMINI_MODEL=gemini-3.5-flash-lite \
    VANMACH_UNLIMITED_AI=1 \
    VANMACH_OPEN_FEATURES=1
EXPOSE 8787
CMD ["node", "server.mjs"]
