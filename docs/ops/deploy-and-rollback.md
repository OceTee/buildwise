# Deploy and rollback

Two Vercel projects, both deployed from the CLI, not from Git pushes: `buildwise-api` (Root Directory `apps/api`,
built by `scripts/build-vercel-api.mjs`) and the web project (Root Directory `apps/web`). We deploy a clean copy of
one commit made with `git archive`, so uncommitted files in a working checkout never ship.

## Before you deploy

- The commit is on `origin/main` and CI passed on it (typecheck, boundaries, tests, web build, e2e).
- Read new migrations in `apps/api/src/db/migrations/`. They run on the first request after the deploy (every cold
  start checks). They are forward-only: a rollback does **not** undo them. A migration that drops or renames
  something an older build uses makes rollback unsafe. Ship those in two steps (stop using it, deploy, then drop).
- Note the current production deployment URL so you can roll back: `vercel ls buildwise-api --prod | head -5`.

## Deploy

```bash
SHA=$(git rev-parse origin/main)
OUT=$(mktemp -d)
git archive "$SHA" | tar -x -C "$OUT"
cd "$OUT"
```

API (IDs from `.vercel/project.json` in the main checkout, or the Vercel dashboard → project → Settings):

```bash
VERCEL_ORG_ID=<team id> VERCEL_PROJECT_ID=<buildwise-api project id> vercel deploy --prod --yes --env SENTRY_RELEASE="$SHA"
```

Web, after the API is healthy:

```bash
VERCEL_ORG_ID=<team id> VERCEL_PROJECT_ID=<web project id> vercel deploy --prod --yes --build-env NEXT_PUBLIC_SENTRY_RELEASE="$SHA"
```

A deploy takes several minutes and the API build bundles with esbuild. Give the command a generous timeout (20 min).

## Check

1. `curl -s https://<api host>/health/ready` → `{"ok":true,"db":"ok","migrations":"current"}`. The first call after a deploy runs migrations and can take 10–30 s.
2. `curl -s -H "Authorization: Bearer $CRON_SECRET" https://<api host>/health/details | jq .alerts` lists nothing new.
3. Open the home page, `/market`, `/build`, sign in, open a project.
4. Sentry: no new issues for the release in the next 30 minutes.

## Roll back

Fastest: put the previous production deployment back. Nothing is rebuilt.

```bash
vercel ls buildwise-api --prod                 # find the last good deployment URL
vercel rollback <last good deployment url> --yes
```

Do the same on the web project if the web deploy is the problem. Then:

- `/health/ready` again. If it says `migrations: pending` or the older build fails on the new schema, roll forward instead: fix on `main` and deploy.
- A rollback restores that deployment exactly, with the env values it was created with. Env changes made since then (for example `MAINTENANCE_MODE=on`) are not in it: set them again and redeploy if you still need them.
- After a rollback, later production deploys are not promoted automatically until you promote one. To make a specific deployment production again: `vercel promote <deployment url> --yes`.

## Apply an env change

Runtime env vars are read when a deployment starts. After `vercel env add NAME production` (or an edit in the dashboard):

```bash
vercel redeploy <current production deployment url> --environment production
```

`NEXT_PUBLIC_*` variables on the web project are inlined at build time, so they need a rebuild, which `redeploy` does.
