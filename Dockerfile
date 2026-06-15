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

# SQLite (links + refresh tokens) lives here — mount a PERSISTENT volume at this
# path on the host, or every redeploy wipes connections and refresh tokens.
VOLUME ["/app/data"]

# The callback web server binds to $PORT (host-injected), default 3000.
EXPOSE 3000

CMD ["npm", "run", "start"]
