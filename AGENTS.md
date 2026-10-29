# AGENTS.md — CTaDI onboarding

Repository-specific notes for AI agents and contributors.

## What this is

An automated onboarding pipeline: applicant form → LLM scoring → threshold →
admin digest with one-click approve/reject → applicant status page with the
community link. See `README.md` for the full design.

## Stack and constraints

- **Node.js >= 22.5, standard library only.** No runtime dependencies. Use
  `node:sqlite` for the database, `node:test` for tests, and `fetch` for HTTP.
  Do not add npm packages without a strong reason — the point is that there is
  nothing to install or patch.
- **No build step.** The frontend is plain HTML/CSS/JS served from `public/`.
- **Free tiers only.** Every external service must have a workable free tier.
- **Secrets come from the environment.** Never hard-code a key. See
  `.env.example`.

## Commands

```bash
npm start              # run the portal (http://localhost:3000)
npm test               # full suite, offline, no keys needed
npm run sample:offline # score the sample applicants with the local heuristic
npm run sample         # score the samples with the real model (needs a key)
CTADI_LIVE_TESTS=1 npm run test:live   # quality tests against the real model
```

## Layout

| Path | Purpose |
|---|---|
| `ctadi.config.json` | Weights, threshold, ideal member profile, all applicant messages |
| `form.json` | The full form: sections, roles, questions |
| `src/pipeline.js` | submit → score → threshold → notify → decide |
| `src/llm/prompt.js` | Builds the prompts; owns the JSON schema |
| `src/llm/providers.js` | Provider adapters and failover order |
| `src/llm/scorer.js` | Retries, failover, validation |
| `src/store/` | `sqlite` (default), `json`, `supabase` |
| `src/email/` | Mailer drivers and templates |
| `public/` | The portal (form, status, decision) |
| `samples/applicants.json` | strong, borderline, weak, injection samples |
| `test/` | The suite; `test/helpers/` has the fake provider, memory store, and recording mailer |

## Conventions

- **Scoring is tuned in config, not code.** To change who gets in, edit
  `ideal_member_profile`, `scoring.weights`, `scoring.criteria_guidance`, or
  `scoring.shortlist_threshold` in `ctadi.config.json`. Do not edit the prompt
  text in `src/llm/prompt.js` to tune scoring — that text is assembled from the
  config on purpose.
- **The form is defined once, in `form.json`.** The portal, validation, and the
  scoring prompt all read from it. Adding a question means editing one file.
- **Applicant text is untrusted.** Wrap it in data markers in prompts, escape
  it for HTML, and never let it change control flow.
- **The public status view must never leak the score or the evaluation.** See
  `publicStatus` in `src/pipeline.js`.
- **Failures park, they do not drop.** If scoring fails, the application goes
  to `parked` and can be re-scored with `processApplication(id)`.

## Testing notes

- Tests must run offline. Use `test/helpers/fake-provider.js` for a fake LLM,
  `makeMemoryStore()` for storage, and `makeRecordingMailer()` for email.
- `test/e2e.integration.test.js` is the real end-to-end path: it stands up a
  fake OpenAI-compatible upstream, points the **real** provider adapter at it,
  and drives the **real** server. Prefer extending that over adding mocks.
- Live tests that hit real providers are gated behind `CTADI_LIVE_TESTS=1` so
  they never cost quota by accident.
- After changing the prompt or the weights, run `npm run sample` with a real
  key and confirm the strong sample still shortlists and the weak one does not.

## Status values

`received` → `scored` → `shortlisted` | `not_shortlisted` → `approved` | `rejected`.
`parked` means scoring failed and the application is waiting to be re-scored.
