# CTaDI onboarding

An onboarding pipeline for CTaDI, a sustainable technology association.

An applicant fills in a form. The application is stored and **emailed to the
admin for manual review** — there is no automated screening and no AI. The admin
reads it and clicks Approve or Reject. On approval the applicant sees the
community link on their status page.

```
applicant ──► form ──► store ──► email the admin the full application
                                    with one-click Approve / Reject
                                          │
                    Approve ──────────────┴──────────────► applicant status page
                    Reject  ─────────────────────────────► shows the community link
                                                           polite closing message
```

Everything runs on free tiers. There is no build step, no framework, no runtime
dependency, and no third-party AI service — the whole service is Node's
standard library plus one optional database.

---

## Contents

1. [Architecture](#1-architecture)
2. [The form](#2-the-form)
3. [How the code is organised](#3-how-the-code-is-organised)
4. [Setup and deployment](#4-setup-and-deployment)
5. [Test plan](#5-test-plan)
6. [Configuration reference](#6-configuration-reference)
7. [Security notes](#7-security-notes)

---

## 1. Architecture

```
                    ┌───────────────────────────────────────────────┐
   applicant  ──────►  static portal (public/)                        │
   (browser)        │  index.html · form.js · status.js · decision.js │
                    └──────────────────────┬────────────────────────┘
                                           │  JSON over HTTP
                    ┌──────────────────────▼────────────────────────┐
   admin  ◄─────────►  Node HTTP server (src/server.js)              │
   (email)          │   — locally: long-running process               │
                    │   — Vercel:  api/index.js, one serverless fn    │
                    │                                                 │
                    │   /api/submit    validate → store → email admin │
                    │   /api/status    public status view             │
                    │   /api/decision  verify signed token → record   │
                    │   /api/form      form definition                │
                    │   /api/health    diagnostics                    │
                    └───┬──────────────────────┬──────────────────────┘
                        │                      │
              ┌─────────▼──┐          ┌────────▼──────┐
              │  store     │          │ mailer        │
              │ json       │          │ Resend        │
              │ sqlite     │          │ Brevo         │
              │ supabase   │          │ Gmail/console │
              └────────────┘          └───────────────┘
```

### Why this stack

- **A static frontend plus one small Node server.** There is no framework and
  no build step. The form is generated from `form.json` at runtime, so adding a
  question never means touching the frontend. This is the least machinery that
  can still do server-side validation, signed links, and email.
- **Node's standard library instead of dependencies.** `node:sqlite` (Node 22+)
  gives a real database with no native build and no npm install. The SMTP
  client, HMAC tokens, and HTTP routing are all standard library. Fewer
  dependencies means less to break and nothing to patch.
- **No AI, by design.** Screening is a judgement about people, made by people.
  Removing the model also removes an API key, a rate limit, a per-submission
  cost, a failure mode, and a body of prompt-injection and bias concerns. The
  admin reads the application itself, in full, in the email.
- **JSON by default, SQLite or Supabase when you need more.** Local development
  needs no configuration at all. A single-instance deployment can use SQLite.
  Serverless deployments use Supabase, because a serverless disk does not
  persist.
- **Free email via Resend or Brevo.** Both have generous free tiers and a
  simple HTTP API. `EMAIL_DRIVER=console` prints emails to the terminal so you
  can develop without any account at all.
- **The same code runs as a server or a serverless function.** `src/server.js`
  is the local entrypoint; `api/index.js` is the Vercel entrypoint. Both call
  the identical routing and pipeline code, so what you test locally is what runs
  in production.

### Request lifecycle

| Step | What happens | Where |
|---|---|---|
| 1 | Applicant submits the form | `POST /api/submit` |
| 2 | Input is cleaned, capped, validated | `src/lib/form.js`, `src/lib/util.js` |
| 3 | The application is stored immediately | `src/store/*` |
| 4 | The full application is emailed to the admin with signed one-click links | `src/pipeline.js`, `src/email/templates.js` |
| 5 | Admin clicks Approve or Reject in the email | `POST /api/decision` |
| 6 | Applicant sees the community link, or a polite closing message | `GET /api/status`, `public/status.js` |

The email is sent inline on submit. That is fine for a form people submit one
at a time. If a send fails the application is still stored, so nothing is lost —
re-send with `notifyAdmin(id)`.

---

## 2. The form

The full definition lives in `form.json`. Edit it there and the portal and the
validation both follow. Every question is open-ended on purpose, so answers show
real understanding rather than keywords.

### Section A — everyone

| id | Question |
|---|---|
| `a1` | What do you understand by "development"? |
| `a2` | Where should development begin, and why? |
| `a3` | What really matters about education? |
| `a4` | Why do you want to join CTaDI, and what do you hope to contribute? |

### Section B — by role

Each role has four questions on their craft plus a self-rated proficiency
(1–5) that must be justified with a concrete example.

**Software & Data**

| id | Question |
|---|---|
| `b_sd1` | Which languages, frameworks and data tools do you actually use day to day, and what do you reach for them for? |
| `b_sd2` | Walk us through a project you are proud of: the problem, what you built, and what you would do differently now. |
| `b_sd3` | Describe a time you chose NOT to build software — or chose the simplest possible solution. What did you weigh up? |
| `b_sd4` | How do you handle data that belongs to people — privacy, consent, ownership, and the possibility of harm? |
| `b_sd5` | Rate your overall software/data proficiency from 1 to 5, and justify the number with one specific piece of evidence. |

**Hardware & Energy**

| id | Question |
|---|---|
| `b_he1` | What hardware, power or energy systems have you built, repaired, installed or measured yourself? |
| `b_he2` | Describe a project you are proud of: the constraints you worked under, what you achieved, and what failed. |
| `b_he3` | What breaks first in a real deployment, and how do you design for maintenance, repair and local ownership? |
| `b_he4` | How do you judge whether a technology is genuinely appropriate for a community — and what makes you say no to one? |
| `b_he5` | Rate your overall hardware/energy proficiency from 1 to 5, and justify the number with one specific piece of evidence. |

**Policy & Advocacy**

| id | Question |
|---|---|
| `b_pa1` | Describe a policy, regulation or institutional decision you have engaged with — analysed, campaigned on, drafted or resisted. |
| `b_pa2` | Who holds power over the change you care about, and what would realistically move them? |
| `b_pa3` | Describe a time you had to argue a case to someone who disagreed strongly. What did you do, and how did it go? |
| `b_pa4` | How do you keep advocacy honest — avoiding both techno-optimism and doomerism, and staying accountable to affected communities? |
| `b_pa5` | Rate your overall policy/advocacy proficiency from 1 to 5, and justify the number with one specific piece of evidence. |

**Design**

| id | Question |
|---|---|
| `b_ds1` | Walk us through a design project you are proud of: who it was for, what you learned from them, and what you changed as a result. |
| `b_ds2` | How do you design for people and contexts very different from your own — low bandwidth, low literacy, shared devices, limited power? |
| `b_ds3` | What does accessibility and inclusion mean in your practice, beyond a checklist? |
| `b_ds4` | How do you tell whether your design actually helped? What evidence would change your mind? |
| `b_ds5` | Rate your overall design proficiency from 1 to 5, and justify the number with one specific piece of evidence. |

**Research**

| id | Question |
|---|---|
| `b_rs1` | Describe a piece of research you have done — formal or self-directed: the question, your method, and what you found. |
| `b_rs2` | What is a question in your field that you think is badly asked, and how would you ask it better? |
| `b_rs3` | How do you work with people as participants rather than as subjects — consent, benefit, and returning what you learn? |
| `b_rs4` | Tell us about evidence that contradicted your expectations. What did you do with it? |
| `b_rs5` | Rate your overall research proficiency from 1 to 5, and justify the number with one specific piece of evidence. |

**Operations**

| id | Question |
|---|---|
| `b_op1` | Describe an operation, event, programme or process you ran end to end. What was your part, and what did it take to make it work? |
| `b_op2` | How do you plan when money, time and people are all tight? Walk us through a real trade-off you made. |
| `b_op3` | How do you keep a distributed or volunteer team coordinated, accountable and motivated without burning them out? |
| `b_op4` | What does good record-keeping and handover look like to you, and why does it matter for an organisation like CTaDI? |
| `b_op5` | Rate your overall operations proficiency from 1 to 5, and justify the number with one specific piece of evidence. |

### Section C — commitment (everyone)

| id | Question |
|---|---|
| `av1` | Realistically, how many hours per week can you commit to CTaDI over the next six months, and how does that fit alongside your other work or study? |
| `av2` | How would you like to be involved — a specific project, ongoing volunteering, occasional advice, or something else? |

### Why the proficiency questions ask for a justification

The self-rating is a signal for the human reviewer, not a number to be scored.
Asking for a concrete example behind the number is what makes the rating
useful: it rewards calibration and honesty, and it removes the temptation to
game the form by writing "5".

---

## 3. How the code is organised

```
ctadi.config.json      organisation details and every applicant-facing message
form.json              the full form: sections, roles, questions
package.json           scripts only; no runtime dependencies

api/
  index.js             Vercel entrypoint: one catch-all serverless function
src/
  server.js            local HTTP server (long-running process)
  pipeline.js          submit → store → notify admin → decide → notify applicant
  lib/
    config.js          loads and validates the config files
    form.js            form lookup, submission validation and normalisation
    util.js            text cleaning, HTML escaping, crypto helpers
    tokens.js          HMAC-signed approve/reject tokens
    http.js            JSON helpers, body reader, rate limiter
  email/
    mailer.js          Resend, Brevo, Gmail, and a console driver
    templates.js       admin digest and applicant messages
    smtp.js            minimal SMTP client for the Gmail driver
  store/
    index.js           driver selection
    json.js            JSON file (default locally)
    sqlite.js          node:sqlite
    supabase.js        Supabase REST (default on Vercel)

public/
  index.html form.js    the application form
  status/index.html     the applicant status page (static)
  decision/index.html   the approve/reject confirmation page (static)
  status.js decision.js the scripts those pages load
  styles.css

vercel.json            Vercel function config, rewrites, and security headers
samples/applicants.json  strong, borderline, weak, and embedded-instruction samples
scripts/run-samples.js   renders the samples through the admin digest
test/                    the test suite (see below)
```

---

## 4. Setup and deployment

### Prerequisites

Node.js **22.5 or newer**. Check with `node --version`.

For a Vercel deployment you also need a Vercel account (free Hobby plan) and a
hosted Postgres — Supabase's free tier is the one this guide uses.

### Option A — run locally in two minutes

No accounts and no API keys needed. Emails print to the terminal.

```bash
git clone https://github.com/dontman-tech/CTaDI.git
cd CTaDI
cp .env.example .env
npm start
# open http://localhost:3000
```

You should see:

```
CTaDI onboarding portal listening on http://localhost:3000
  storage driver : json
  email driver   : console
  admin email    : (not set)
  screening      : manual — every application is emailed to the admin
```

Submit the form, then check the terminal — the admin digest is printed there,
including the working Approve and Reject links. Click one, then open the
status link the form gave you.

### Option B — wire up real email

1. **Get an email key.** Resend (<https://resend.com>) gives 3,000 emails a
   month free; Brevo (<https://brevo.com>) gives 300 a day free.
2. **Generate a token secret:**

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

3. **Fill in `.env`:**

   ```ini
   PUBLIC_BASE_URL=https://your-portal.example.org
   ADMIN_EMAIL=you@example.org
   FROM_EMAIL=CTaDI Onboarding <onboarding@your-domain.org>
   EMAIL_DRIVER=resend
   RESEND_API_KEY=re_...
   APPROVAL_TOKEN_SECRET=<the value from step 2>
   COMMUNITY_INVITE_URL=https://community.example.org/join/ctadi
   ```

4. **Restart.** `/api/health` confirms the drivers in use. Submit the form and
   the digest arrives in your inbox with working links.

### Option C — deploy to Vercel (production)

Vercel is the recommended production host: it is free for this traffic level,
deploys straight from GitHub, terminates TLS, and provides secrets management.
It is serverless, which changes three things:

| Local server | On Vercel | Why |
|---|---|---|
| JSON or SQLite file | Supabase (hosted Postgres) | A serverless filesystem is read-only except `/tmp` and does not persist between invocations, so a local file is lost on every deploy and not shared between instances. |
| One long-running process | One catch-all serverless function | Fewer cold starts, and a warm instance is reused across routes. See `api/index.js`. |
| In-process rate-limit map | Upstash Redis (or Supabase RPC) | Each invocation may be a fresh instance, so an in-process counter can be reset by getting a cold start. The code falls back to in-process if no backend is configured. |

**1. Create the database.** In Supabase (<https://supabase.com>, free tier),
open the SQL editor and run the schema in
[Switching to Supabase](#switching-to-supabase) below. Then copy the project
URL and the **service-role** key from Project Settings → API.

**2. Push the repository to GitHub.**

**3. Import the project in Vercel** at <https://vercel.com/new>. Vercel detects
`vercel.json` and uses it:

- no build step and no install step (the project has zero runtime dependencies);
- `api/index.js` as a single catch-all function, 60s max duration;
- `rewrites` sending every `/api/*` request to that function;
- security headers on every response.

**4. Set the environment variables** in Vercel → Settings → Environment
Variables. At minimum:

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | your production URL, e.g. `https://ctadi.vercel.app` |
| `ADMIN_EMAIL` | where the review digest goes |
| `FROM_EMAIL` | a verified sender for your email provider |
| `EMAIL_DRIVER` | `resend` (or `brevo`) — avoid Gmail on serverless, some hosts block outbound SMTP |
| `RESEND_API_KEY` | from Resend |
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role key (**server-side only**) |
| `STORAGE_DRIVER` | `supabase` |
| `APPROVAL_TOKEN_SECRET` | 32 random bytes as hex |
| `COMMUNITY_INVITE_URL` | the invite link approved applicants receive |
| `ADMIN_API_TOKEN` | protects `/api/admin/applications` |
| `RATE_LIMIT_BACKEND` | `upstash` (recommended) or `supabase` |

`PUBLIC_BASE_URL` matters: it is what the approve and reject links in the admin
email are built from. If it is wrong, those links point at the wrong host.

**5. Deploy, then smoke-test the live URL:**

```bash
curl https://your-app.vercel.app/api/health
```

You should see `"storage":"supabase"`. Then submit the form once and confirm
the admin digest arrives.

**6. (Recommended) distributed rate limiting.** Create a free Upstash Redis
database (<https://upstash.com>), copy the REST URL and token, and set
`RATE_LIMIT_BACKEND=upstash`, `UPSTASH_REDIS_REST_URL`, and
`UPSTASH_REDIS_REST_TOKEN`. Without this the limiter still works, but only
per warm instance.

If you would rather use Supabase for the limiter, create this function and set
`RATE_LIMIT_BACKEND=supabase`:

```sql
create table if not exists rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  count int not null default 0
);

create or replace function ctadi_rate_limit(p_key text, p_window_seconds int)
returns int language plpgsql as $$
declare new_count int;
begin
  insert into rate_limits (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update set
    count = case
      when rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
      then 1 else rate_limits.count + 1 end,
    window_start = case
      when rate_limits.window_start < now() - make_interval(secs => p_window_seconds)
      then now() else rate_limits.window_start end
  returning count into new_count;
  return new_count;
end $$;
```

**Deploying elsewhere.** Any Node host works, but a persistent-disk host (Render,
Railway, Fly.io) suits the SQLite driver better. Use `npm start` as the start
command, no build command, and the same environment variables with
`STORAGE_DRIVER=sqlite`.

### Switching to Supabase

1. Create a project at <https://supabase.com> (free tier).
2. Run this SQL in the SQL editor:

   ```sql
   create table applications (
     id text primary key,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now(),
     email text not null,
     full_name text not null,
     role text not null,
     role_label text not null,
     status text not null,
     application jsonb,
     decision text,
     decided_at timestamptz,
     decided_by text,
     notified_admin_at timestamptz
   );
   create index on applications (status);
   create index on applications (created_at desc);

   create table audit_log (
     id bigserial primary key,
     at timestamptz not null default now(),
     application_id text,
     action text not null,
     detail jsonb
   );
   ```

3. Set `STORAGE_DRIVER=supabase`, `SUPABASE_URL`, and
   `SUPABASE_SERVICE_ROLE_KEY`.

   The service-role key bypasses row-level security. Keep it server-side only
   and never expose it to the browser.

### Managing applications

- **Re-send a digest** for an application whose email failed by calling
  `notifyAdmin(id)` — see `scripts/run-samples.js` for the pattern.
- **List applications:**

  ```bash
  curl "$PUBLIC_BASE_URL/api/admin/applications?status=pending_review"
  ```

  Set `ADMIN_API_TOKEN` in the environment to require an `X-Admin-Token`
  header on that route. Without it the route is open, so **set it in
  production**.
- **Preview the admin email** for the sample applications:

  ```bash
  npm run sample            # all samples
  npm run sample strong     # just one
  ```

---

## 5. Test plan

Run the whole suite with:

```bash
npm test
```

All 50 tests pass with no network access, no API keys, and no accounts. The
suite uses an in-memory store and a recording mailer, and the HTTP and e2e
tests drive the real server.

### What the suite covers

| Area | Tests |
|---|---|
| Config | the organisation, messages, and invite link are present; there is no scoring configuration |
| Text handling | control characters stripped; length capped; HTML escaped; email validation |
| Tokens | valid tokens round-trip; a flipped payload fails the signature; expiry is enforced; links are absolute |
| Form | a complete submission validates; missing answers are reported; consent, email, and role are checked; instruction-shaped answers are stored verbatim |
| Pipeline | every submission emails the admin; the email carries every answer; it contains no score or criteria; the links are bound to the right application; duplicates are refused while pending and allowed after a decision; approve reveals the invite; reject closes politely; approve is idempotent; a decision cannot be flipped; an unknown id 404s; a bad verb 400s; the digest can be re-sent; an email failure is surfaced; the audit trail is written; applicant HTML is escaped |
| HTTP | health, form, and index routes; invalid submissions rejected; valid submissions accepted and emailed; the status view never leaks internal detail; forged tokens rejected; the full review flow over HTTP; the decision page renders; directory traversal blocked; the admin list works; `/api/cron/rescore` is gone |
| End-to-end | a submission is stored and emailed in full; approve reveals the invite; reject closes politely; the invite never leaks before a decision; an embedded instruction is delivered verbatim and changes nothing |

### The four sample applicants

In `samples/applicants.json`. Preview them with `npm run sample`.

#### 1. Strong — Amara Okonkwo, Hardware & Energy

An eight-year field engineer. She defines development as expanding what people
can do and choose, gives a specific counter-example (a mini-grid sized for the
wrong load because nobody asked), argues that education is about the capacity
to reason rather than credentialing, and names a concrete project — a 12 kW
clinic system — including what failed (cloud monitoring the clinic could not
afford to keep running). Her self-rating is 4, and she says why it is not 5.

**Expected outcome: approved.**

#### 2. Borderline — Jordan Blake, Software & Data

A competent developer with a real but small project (a React and Leaflet
dashboard for an NGO). The answers are correct but general, and the evidence is
thinner than the strong sample's.

**Expected outcome: a judgement call.** This is the sample that shows why the
decision is left to a human.

#### 3. Weak — Priya Nadar, Policy & Advocacy

Answers that are largely slogans and recycled definitions, with no concrete
work and a vague, aspirational commitment.

**Expected outcome: rejected.**

#### 4. Embedded instruction — Robin Vale, Research

A thin application that also contains text shaped like an instruction to an AI
system ("ignore previous instructions…").

**Expected outcome: delivered to the admin as plain text, with no effect.** The
application is stored and emailed like any other; the admin decides. A test in
`test/e2e.integration.test.js` asserts that the text reaches the email verbatim
and that nothing acts on it.

---

## 6. Configuration reference

### `ctadi.config.json`

Everything applicant-facing lives here.

| Key | Purpose |
|---|---|
| `organisation.name` | Used in email subjects and headings |
| `messages.applicant_received` | Shown on the status page after submitting |
| `messages.applicant_under_review` | Shown while the admin is reviewing |
| `messages.applicant_approved` | Shown once approved, with the invite |
| `messages.applicant_rejected` | The polite closing message |
| `messages.decision_already_made` | Shown if a decision link is clicked twice |
| `portal.community_invite_url` | Where the invite link points (fallback for `COMMUNITY_INVITE_URL`) |
| `portal.email_applicant_on_approval` | Also email the invite, not just show it |

### Environment variables

See `.env.example` for the annotated list. The important ones:

| Variable | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | Builds the absolute approve/reject links |
| `ADMIN_EMAIL` | Where the digest goes |
| `EMAIL_DRIVER` | `console`, `resend`, `brevo`, or `gmail` |
| `STORAGE_DRIVER` | `json`, `sqlite`, or `supabase`. Unset → `supabase` on Vercel, `json` locally |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Required for the Supabase driver (**server-side only**) |
| `APPROVAL_TOKEN_SECRET` | Signs the one-click links. **Required in production** |
| `COMMUNITY_INVITE_URL` | The link an approved applicant sees |
| `EMAIL_APPLICANT_ON_APPROVAL` | Also email the invite, not just show it |
| `ADMIN_API_TOKEN` | Protects `/api/admin/applications` |
| `SUBMIT_RATE_LIMIT_PER_HOUR` | Per-IP submission cap |
| `RATE_LIMIT_BACKEND`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Distributed rate limiting |
| `MAX_ANSWER_CHARS` | Hard cap on a single answer's length |

---

## 7. Security notes

**Secrets.** Every key is read from the environment. Nothing is hard-coded, and
`.env` is git-ignored. The service refuses to start in production without
`APPROVAL_TOKEN_SECRET`, so the insecure development fallback cannot reach
production by accident.

**No AI means no prompt injection.** There is no model to instruct, so an
applicant cannot write their way past a reviewer by embedding instructions in an
answer. The text is stored and displayed as data, escaped for HTML, and read by
a person who decides. That is the whole threat model, and it is why removing the
model removed a class of risk rather than moving it.

**One-click links.** The approve and reject links are HMAC-SHA256 signed over a
payload containing the application id, the decision, and an expiry. A link
cannot be edited from reject to approve, and a link for one application cannot
be replayed against another, because the signature covers both. Verification is
constant-time. Links expire after `APPROVAL_TOKEN_TTL_HOURS` (default 14 days).
A decision can be recorded once; a second click reports the existing decision
rather than flipping it.

**Email is a channel, not a security boundary.** Anyone who can read the admin
mailbox can approve an application. Treat the admin inbox as a privileged
resource, and set `ADMIN_API_TOKEN` so the listing route is not open.

**Data minimisation.** The status endpoint returns a deliberately small public
view — never the admin's notes, never the other answers. An applicant can only
see their own application if they hold the id, which is a random 20-character
string.

**Rate limiting.** `/api/submit` is limited per IP
(`SUBMIT_RATE_LIMIT_PER_HOUR`, default 5) and duplicate active applications
from the same email are refused. On a single instance the in-process limiter is
exact. On serverless it is per warm instance, so a caller could in principle
reset the window by landing on a cold instance — set `RATE_LIMIT_BACKEND` to
`upstash` (or `supabase`) for a shared counter. If the distributed backend is
unreachable the limiter **fails open** rather than blocking genuine applicants;
that trade-off is deliberate and logged.

**Serverless specifics.** Two things differ on Vercel, and each is handled
rather than assumed. The store driver is imported lazily, so an unused driver
(for example `node:sqlite`) can never crash a cold start. The request body is
read from the platform's pre-parsed `req.body`, because the underlying stream is
already drained — reading it would hang the request.

**Data protection.** You are storing personal data. Before going live: tell
applicants that a human reads every application (the form already asks for
consent to this), keep the retention period as short as your review process
allows, and restrict access to the admin mailbox and the admin listing route.

---

## Licence and provenance

This repository was scaffolded by an AI agent (OpenHands) on behalf of the
CTaDI maintainers. Review the code and the configuration before putting it in
front of real applicants.
