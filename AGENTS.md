# AGENTS.md — CTaDI onboarding

Repository-specific notes for AI agents and contributors.

## What this is

An onboarding pipeline: applicant form → stored → the full application is
emailed to the admin for manual review → one-click approve/reject → applicant
status page with the community link.

**There is no automated screening and no AI.** Every submission is emailed to
the admin, who reads it and decides. Do not reintroduce a scoring step without
an explicit request: the model was removed deliberately, and it took with it an
API key, a rate limit, a per-submission cost, and a class of injection and bias
risk. See `README.md` for the full design.

## Stack and constraints

- **Node.js >= 22.5, standard library only.** No runtime dependencies. Use
  `node:sqlite` for the database, `node:test` for tests, and `fetch` for HTTP.
  Do not add npm packages without a strong reason — the point is that there is
  nothing to install or patch.
- **No build step.** The frontend is plain HTML/CSS/JS served from `public/`.
- **Two entrypoints, one codebase.** `src/server.js` runs locally as a
  long-running process; `api/index.js` is the Vercel serverless function. Both
  call the same `handleApi` and pipeline code. Never put logic in an entrypoint
  that the other would not get.
- **Production target is Vercel + Supabase.** That means: no reliance on a
  writable local filesystem, and no in-process state that must be shared across
  instances.
- **Free tiers only.** Every external service must have a workable free tier.
- **Secrets come from the environment.** Never hard-code a key. See
  `.env.example`.

## Commands

```bash
npm start              # run the portal (http://localhost:3000), loads .env
npm test               # full suite, offline, no keys needed
npm run sample         # render the samples through the admin digest
npm run sample strong  # just one sample
```

`npm start` and `npm run sample` load `.env` via `node --env-file-if-exists`.
The test scripts do not, on purpose: the suite must pass with no keys set.

## Layout

| Path | Purpose |
|---|---|
| `ctadi.config.json` | Organisation details and all applicant-facing messages |
| `form.json` | The full form: sections, roles, questions |
| `src/pipeline.js` | submit → store → notify admin → decide → notify applicant |
| `src/email/templates.js` | The admin digest (full application + links) and applicant messages |
| `api/index.js` | Vercel entrypoint: one catch-all serverless function |
| `vercel.json` | Function config, `/api/*` rewrite, security headers |
| `src/store/` | `json` (local default), `sqlite`, `supabase` (Vercel default) |
| `src/email/` | Mailer drivers and templates |
| `public/` | The portal (form, status, decision) |
| `samples/applicants.json` | strong, borderline, weak, injection samples |
| `test/` | The suite; `test/helpers/doubles.js` has the memory store and recording mailer |

## Conventions

- **Who gets in is decided by the admin, not by code.** There is no threshold
  and no rubric. If you find yourself adding one, stop and ask.
- **The form is defined once, in `form.json`.** The portal and the validation
  both read from it. Adding a question means editing one file.
- **Applicant text is untrusted.** Escape it for HTML and never let it change
  control flow. With no model in the loop there is no prompt to inject into, so
  the text simply flows to the reviewer as data.
- **The public status view must never leak internal detail.** See
  `publicStatus` in `src/pipeline.js`.
- **A failed email does not lose the application.** The record is written
  before the send, so a failure surfaces to the caller and the digest can be
  re-sent with `notifyAdmin(id)`.
- **Store access is async.** `getStore()` returns a promise and is memoised.
  Call `await getStore()` and pass the instance down; never import a driver
  directly, so an unused driver stays out of the module graph (see
  `src/store/index.js`).
- **Read the request body via `readJsonBody`.** On serverless the body arrives
  pre-parsed on `req.body` and the stream is already drained; reading the stream
  instead will hang the request.

## Testing notes

- Tests must run offline. Use `test/helpers/doubles.js` for `makeMemoryStore()`
  and `makeRecordingMailer()`.
- `test/e2e.integration.test.js` drives the **real** server over HTTP with only
  the mailer replaced by a capture, so routing, validation, storage, the digest,
  the signed links, the decision endpoint, and the status page are all
  production paths. Prefer extending that over adding mocks.
- After changing the digest template, run `npm run sample` and read the output —
  that is exactly what the admin will receive.

## Status values

`received` → `pending_review` → `approved` | `rejected`.

`received` is set the instant the record is written; `pending_review` once the
admin has been emailed. A duplicate application is refused while the first is in
either of those states, and allowed again once it has been decided.
