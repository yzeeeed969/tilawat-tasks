# Production Deployment

This project has two deployable parts:

- API server: `artifacts/api-server`
- Frontend app: `artifacts/tilawat-tasks`

Production must use the real API server with PostgreSQL. Do not run `scripts/mock-api.mjs` in production.

## Required Environment Variables

Copy `.env.example` into your hosting provider variables and fill real values.

Required:

- `NODE_ENV=production`
- `PORT`: the port the API server listens on, for example `3001` or the port provided by the host.
- `BASE_PATH=/`: use `/` when the app is served from the domain root.
- `DATABASE_URL`: PostgreSQL connection string.
- `SESSION_SECRET`: long random secret for login sessions.

Optional:

- `LOG_LEVEL=info`
- `GMAIL_USER`
- `GMAIL_APP_PASSWORD`

## Install

```bash
pnpm install --frozen-lockfile
```

## Prepare The Database

Run the Drizzle schema push against the real PostgreSQL database:

```bash
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require" pnpm --filter @workspace/db run push
```

The API session store uses `connect-pg-simple` with table name `user_sessions` and `createTableIfMissing: false`, so create the session table once:

```sql
CREATE TABLE IF NOT EXISTS user_sessions (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expire
  ON user_sessions (expire);
```

## Production Build

Build the frontend:

```bash
NODE_ENV=production PORT=5176 BASE_PATH=/ pnpm --filter @workspace/tilawat-tasks run build
```

Build the API:

```bash
pnpm --filter @workspace/api-server run build
```

Or build the whole workspace:

```bash
NODE_ENV=production PORT=5176 BASE_PATH=/ pnpm run build
```

## Run The API In Production

Set the production environment variables, then run:

```bash
NODE_ENV=production \
PORT=3001 \
BASE_PATH=/ \
DATABASE_URL="postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require" \
SESSION_SECRET="replace-with-a-long-random-secret" \
pnpm --filter @workspace/api-server run start
```

The API entry point is:

```bash
node --enable-source-maps artifacts/api-server/dist/index.mjs
```

## Frontend Hosting

The frontend build output is:

```text
artifacts/tilawat-tasks/dist/public
```

Serve this directory as a static site. Configure your host or reverse proxy so requests to `/api/*` go to the API server, and all frontend routes such as `/tasks` or `/tasks/123` return `index.html`.

## Recommended Deployment

Recommended first production setup:

- Node.js hosting for `artifacts/api-server`
- Managed PostgreSQL database
- Static hosting for `artifacts/tilawat-tasks/dist/public`
- Same domain preferred, with `/api` proxied to the API service

Railway is a simple option because it can run a Node service and a PostgreSQL service in the same project and provides `DATABASE_URL`. Render is also suitable with a Web Service plus Render Postgres.

## Production Checklist

- Use the real `DATABASE_URL`.
- Do not start `scripts/mock-api.mjs`.
- Set `SESSION_SECRET`.
- Run the Drizzle schema push.
- Create `user_sessions`.
- Build frontend with `BASE_PATH=/`.
- Ensure `/api/*` reaches the API server.
- Ensure SPA routes return `index.html`.
