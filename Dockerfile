# Debian slim (glibc) rather than alpine: better-sqlite3 is a native module and
# ships prebuilt glibc binaries, so no build toolchain is needed and the build
# is reliable. Node 20 LTS (Node 18 is end-of-life).
FROM node:20-bookworm-slim

WORKDIR /app

# Install deps first for layer caching. `npm ci` is reproducible from the lockfile.
COPY package*.json ./
RUN npm ci

# Copy source and build (.dockerignore keeps out .env, data/, node_modules).
COPY . .
RUN npm run build

# SQLite (links + refresh tokens) lives at DB_PATH=/app/data/bot.sqlite. Attach a
# PERSISTENT volume mounted at /app/data, or every redeploy wipes connections and
# refresh tokens. NOTE: do not declare a Dockerfile `VOLUME` — Railway rejects it
# ("VOLUME ... is not supported, use Railway Volumes"); configure the mount in the
# host (Railway: add a Volume at /app/data). Other hosts: `docker run -v ...`.

# The callback web server binds to $PORT (host-injected), default 3000.
EXPOSE 3000

CMD ["npm", "run", "start"]
