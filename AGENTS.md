# AGENTS.md — CTaDI onboarding

Repository-specific notes for AI agents and contributors.

## What this is

An onboarding portal: applicant form → stored in Postgres → the admin reads it
in a dashboard and clicks Approve or Reject → the applicant's status page shows
the community link, or a polite closing message.

**There is no automated screening, no AI, and no email.** Every submission waits
in the admin dashboard, where a person reads it and decides. Do not reintroduce
a scoring step or an email provider without an explicit request: both were
removed deliberately. Removing the model took with it an API key, a rate limit,
a per-submission cost, and a class of injection and bias risk; removing email
took with it an account, a quota, and a vendor holding applicant data. See
`README.md` for the full design.

## Stack and constraints

- **Node.js >= 22.5.** One runtime dependency: `@neondatabase/serverless`, for
  Postgres over HTTP. Everything else is the standard library — `node:test` for
  tests, `fetch` for HTTP, `node:sqlite` for the single-instance driver. Do not
  add packages without a strong reason.
- **No build step.** The frontend is plain HTML/CSS/JS served from `public/`.
- **Two entrypoints, one codebase.** `src/server.js` runs locally as a
  long-running process; `api/index.js` is the Vercel serverless function. Both
  call the same `handleApi` and pipeline code. Never put logic in an entrypoint
  that the other would not get.
- **Production target is Vercel + Postgres from the Vercel Marketplace.** That
  means: no reliance on a writable local filesystem, and no in-process state
  that must be shared across instances. Vercel Postgres no longer exists (it
  moved to Neon in December 2024); do not reintroduce `@vercel/postgres`.
- **No email provider and no third-party services beyond Vercel and Postgres.**
  The admin dashboard replaces email. If a task seems to need email, stop and
  ask first.
- **Free tiers only.**
- **Secrets come from the environment.** Never hard-code a key. See
  `.env.example`.

## Commands

```bash
npm start              # run the portal (http://localhost:3000), loads .env
npm test               # full suite, offline, no keys needed
npm run migrate        # apply schema.sql to DATABASE_URL
npm run sample         # render the samples as the dashboard would show them
npm run sample strong  # just one sample
```

`npm start`, `npm run migrate`, and `npm run sample` load `.env` via
`node --env-file-if-exists`. The test script does not, on purpose: the suite
must pass with no keys set.

## Layout

| Path | Purpose |
|---|---|
| `ctadi.config.json` | Organisation details and all applicant-facing messages |
| `form.json` | The full form: sections, roles, questions |
| `schema.sql` | The Postgres schema; applied by `npm run migrate` |
| `src/pipeline.js` | submit → store → review → decide, plus the public and admin views |
| `src/routes/api.js` | All HTTP routes, including the authenticated admin API |
| `api/index.js` | Vercel entrypoint: one catch-all serverless function |
| `vercel.json` | Function config, `/api/*` rewrite, security headers |
| `src/store/` | `postgres` (Vercel default), `sqlite`, `json` (local default) |
| `public/` | The portal (form, status) and the admin dashboard (`public/admin/`) |
| `samples/applicants.json` | strong, borderline, weak, injection samples |
| `test/` | The suite; `test/helpers/doubles.js` has the memory store |

## Conventions

- **Who gets in is decided by the admin, not by code.** There is no threshold,
  no rubric, and no score. If you find yourself adding one, stop and ask.
- **The form is defined once, in `form.json`.** The portal and the validation
  both read from it. Adding a question means editing one file.
- **Applicant text is untrusted.** Escape it for HTML and never let it change
  control flow. With no model in the loop there is no prompt to inject into, so
  the text simply flows to the reviewer as data. In the dashboard, render it
  with `textContent`, never `innerHTML`.
- **The admin API is the only door to applicant data.** Every `/api/admin/*`
  route goes through `requireAdmin()`. When `ADMIN_API_TOKEN` is unset in
  production the routes must fail closed (`503`), never open.
- **The public status view must never leak internal detail** — no answers, and
  no invite before approval. See `publicStatus` in `src/pipeline.js`.
- **Store access is async.** `getStore()` returns a promise and is memoised.
  Call `await getStore()` and pass the instance down; never import a driver
  directly, so an unused driver stays out of the module graph (see
  `src/store/index.js`). Drivers are loaded lazily so `node:sqlite` cannot crash
  a cold start on a Postgres deployment.
- **Read the request body via `readJsonBody`.** On serverless the body arrives
  pre-parsed on `req.body` and the stream is already drained; reading the stream
  instead will hang the request.
- **Rate limiting lives in the store.** When the driver is `postgres`, use its
  atomic `rateLimit` upsert; the in-process map is only for `json`/`sqlite`. Do
  not add a Redis or third-party limiter.

## Testing notes

- Tests must run offline. Use `test/helpers/doubles.js` for `makeMemoryStore()`,
  which mirrors the real store contract including `rateLimit`.
- `test/e2e.integration.test.js` drives the **real** server over HTTP against a
  real socket, with only the store swapped for the in-memory one, so routing,
  validation, storage, the admin API, the decision guard, and the status page
  are all production paths. Prefer extending that over adding mocks.
- After changing the dashboard or the public views, run the server and click
  through `/admin` by hand. The suite covers the API, not the rendering; a bug
  in the browser code (for example a shadowed function name) will not fail a
  test.

## Status values

`pending_review` → `approved` | `rejected`.

A submission is written as `pending_review` immediately. A duplicate application
is refused while the first is still `pending_review`, and allowed again once it
has been decided.
