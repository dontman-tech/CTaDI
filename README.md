# CTaDI onboarding

An onboarding portal for CTaDI, a sustainable technology association.

An applicant fills in a form. The application is stored in Postgres and waits in
an **admin dashboard**. There is no automated screening and no AI: the admin
reads each application in full and clicks Approve or Reject. On approval the
applicant's status page reveals the community link. Nothing is sent by email.

```
applicant ──► form ──► Postgres ──► admin dashboard (/admin)
                                        │
                  Approve ──────────────┴──────────────► applicant status page
                  Reject  ─────────────────────────────► shows the community link
                                                         polite closing message
```

It runs entirely on Vercel plus a Postgres database from the Vercel Marketplace.
There is no framework, no build step, and no service other than those two.

---

## Contents

1. [Architecture](#1-architecture)
2. [The form](#2-the-form)
3. [How the code is organised](#3-how-the-code-is-organised)
4. [Setup and deployment](#4-setup-and-deployment)
5. [Test plan](#5-test-plan)
6. [Configuration reference](#6-configuration-reference)
7. [Security notes](#7-security-notes)
8. [Brand and palette](#8-brand-and-palette)

---

## 1. Architecture

```
                    ┌──────────────────────────────────────────────────┐
   applicant  ──────►  static portal (public/)                          │
   (browser)        │  index.html · form.js · status.js                 │
                    └───────────────────────┬──────────────────────────┘
                                            │  JSON over HTTP
   admin      ──────►  admin dashboard      │
   (browser)        │  public/admin/        │
                    │  index.html · admin.js│
                    │  master + reviewers   │
                    └───────────┬───────────┘
                                │  X-Admin-Token
                    ┌───────────▼──────────────────────────────────────┐
                    │  api/index.js — one catch-all serverless function │
                    │   /api/form                  form definition      │
                    │   /api/submit    validate → store                 │
                    │   /api/status    public status view               │
                    │   /api/admin/me             who am I (any admin)  │
                    │   /api/admin/applications   list  (auth required) │
                    │   /api/admin/application    detail (auth required)│
                    │   /api/admin/decision       approve / reject      │
                    │   /api/admin/admins  GET/POST/DELETE (master only)│
                    │   /api/health                diagnostics          │
                    └───────────┬──────────────────────────────────────┘
                                │
                    ┌───────────▼───────────────────────────────────────┐
                    │  Postgres (Neon, via the Vercel Marketplace)      │
                    │  applications · audit_log · rate_limits · admins  │
                    └───────────────────────────────────────────────────┘
```

The **master admin** is the `ADMIN_API_TOKEN` in the environment — it always
exists and is the only account that can create and delete the others. **Ordinary
admins** live in the `admins` table as token hashes, and can review applications
but not manage accounts.

### Why this stack

- **Vercel for hosting, and Postgres from the Vercel Marketplace.** Vercel
  provides the serverless runtime, TLS, secrets, and the CDN for the static
  pages. Vercel no longer ships a database of its own — Vercel Postgres was
  retired in December 2024 and moved to Neon — so the database is provisioned
  through the Marketplace. It is one dashboard, the connection string is
  injected into the project automatically, and no other account is involved.
- **No email provider.** This is the deliberate part of the design. Every hosted
  email service is another account, another API key, another free-tier quota,
  and another vendor holding applicant data. The admin dashboard replaces the
  email entirely: the review screen shows the whole application, and it is
  reachable only with the admin token. The applicant learns the outcome on their
  status page rather than in an inbox.
- **A static frontend plus one small Node function.** There is no framework and
  no build step. The form is generated from `form.json` at runtime, so adding a
  question never means touching the frontend. This is the least machinery that
  can still do server-side validation and access control.
- **Node's standard library instead of dependencies.** HMAC, HTTP routing, and
  text handling are all standard library. The single dependency is the Neon
  serverless Postgres driver, which talks to the database over HTTP so there is
  no connection pool to exhaust across many short-lived function instances.
- **No AI, by design.** Screening is a judgement about people, made by people.
  Removing the model also removes an API key, a rate limit, a per-submission
  cost, a failure mode, and a body of prompt-injection and bias concerns.
- **The same code runs as a server or a serverless function.** `src/server.js`
  is the local entrypoint; `api/index.js` is the Vercel entrypoint. Both call
  the identical routing and pipeline code, so what you test locally is what runs
  in production.

### Request lifecycle

| Step | What happens | Where |
|---|---|---|
| 1 | Applicant submits the form | `POST /api/submit` |
| 2 | Input is cleaned, capped, validated | `src/lib/form.js`, `src/lib/util.js` |
| 3 | The application is stored as `pending_review` | `src/store/postgres.js` |
| 4 | The admin opens `/admin`, enters the token, and reads the application | `GET /api/admin/application` |
| 5 | The admin clicks Approve or Reject | `POST /api/admin/decision` |
| 6 | The applicant's status page changes | `GET /api/status`, `public/status.js` |

Submission is a single write and returns immediately — there is no external
call to wait on, so the request is fast and nothing can be lost to a failed
notification.

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
schema.sql             the Postgres schema (applications, audit_log, rate_limits, admins)
package.json           scripts and one dependency: @neondatabase/serverless

api/
  index.js             Vercel entrypoint: one catch-all serverless function
src/
  server.js            local HTTP server (long-running process)
  pipeline.js          submit → store → review in the dashboard → decide
  lib/
    config.js          loads and validates the config files
    form.js            form lookup, submission validation and normalisation
    admins.js          master vs ordinary admins; create, resolve, delete
    util.js            text cleaning, HTML escaping, token minting, constant-time compare
    http.js            JSON helpers, body reader, rate limiter
  store/
    index.js           driver selection
    postgres.js        Postgres over HTTP (default on Vercel)
    sqlite.js          node:sqlite (single instance)
    json.js            JSON file (default locally)

public/
  index.html form.js    the application form
  status/index.html     the applicant status page
  status.js             the script that page loads
  admin/index.html      the admin dashboard shell
  admin/admin.js        login, list, detail, decisions, and admin management
  logo.svg              the CTaDI mark
  logo-full.svg         the CTaDI lockup (mark + wordmark)
  styles.css            one stylesheet for the portal and the dashboard

vercel.json            Vercel function config, rewrites, and security headers
samples/applicants.json  strong, borderline, weak, and embedded-instruction samples
scripts/
  migrate.js             applies schema.sql
  run-samples.js         previews the samples as the dashboard would show them
test/                    the test suite (see below)
```

---

## 4. Setup and deployment

### Prerequisites

Node.js **22.5 or newer**. Check with `node --version`.

For a Vercel deployment you also need a Vercel account (free Hobby plan). The
database is created from inside Vercel, so no separate account is required.

### Option A — run locally in two minutes

No accounts and no database needed. Applications are written to a local JSON
file.

```bash
git clone https://github.com/dontman-tech/CTaDI.git
cd CTaDI
cp .env.example .env
npm start
# open http://localhost:3000       — the form
# open http://localhost:3000/admin — the review dashboard
```

You should see:

```
CTaDI onboarding portal listening on http://localhost:3000
  storage driver : json
  screening      : manual — review applications in the dashboard
  master token   : NOT SET (dashboard is open locally only)
  admin accounts : n/a locally
  dashboard      : http://localhost:3000/admin
```

Submit the form, then open `/admin`. Locally, with no `ADMIN_API_TOKEN` set,
the dashboard opens without a token so development needs no setup, and you are
treated as the master. Set `ADMIN_API_TOKEN` in `.env` at any point to require
one — that token then becomes the master admin.

### Option B — deploy to Vercel (production)

Vercel is the production host: free at this traffic level, deploys straight from
GitHub, terminates TLS, and manages secrets. It is serverless, which changes two
things, and both are handled rather than assumed:

| Local server | On Vercel | Why |
|---|---|---|
| JSON file | Postgres | A serverless filesystem is read-only except `/tmp` and does not persist between invocations, so a local file is lost on every deploy and not shared between instances. |
| One long-running process | One catch-all serverless function | Fewer cold starts, and a warm instance is reused across routes. See `api/index.js`. |

Rate limiting needs no separate service: the counter lives in the same Postgres
database, in a single atomic upsert, so it is shared across every instance.

**1. Push the repository to GitHub.**

**2. Import the project in Vercel** at <https://vercel.com/new>. Vercel reads
`vercel.json` and uses it: `npm install` to fetch the one dependency,
`api/index.js` as a single catch-all function with a 60s ceiling, a rewrite
sending every `/api/*` request to that function, and security headers on every
response.

**3. Add a Postgres database from the Marketplace.** In the Vercel dashboard
open your project, go to **Storage**, and add **Neon** (search for "Postgres").
Choose the free plan. Vercel provisions the database and injects `DATABASE_URL`
into the project automatically — you do not copy any credentials by hand. This
is the current replacement for Vercel Postgres, which was retired in December
2024.

**4. Apply the schema.** Either run it locally against the production
`DATABASE_URL`:

```bash
DATABASE_URL='postgres://...' npm run migrate
```

or paste `schema.sql` into the SQL editor in the Neon console. Both are
idempotent.

**5. Set the environment variables** in Vercel → Settings → Environment
Variables:

| Variable | Value |
|---|---|
| `ADMIN_API_TOKEN` | the **master** admin token; protects the dashboard and is the only account that can create or delete other admins. **Required in production.** Generate with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"` |
| `COMMUNITY_INVITE_URL` | the invite link approved applicants see |
| `PUBLIC_BASE_URL` | your production URL, e.g. `https://ctadi.vercel.app` |

`DATABASE_URL` is already set by the Marketplace integration. `STORAGE_DRIVER`
defaults to `postgres` whenever `VERCEL` is set, so it needs no value.

Without `ADMIN_API_TOKEN` the dashboard routes return `503` on Vercel rather
than serving applicant data unauthenticated.

**6. Deploy, then smoke-test the live URL:**

```bash
curl https://your-app.vercel.app/api/health
```

You should see `"storage":"postgres"` and `"screening":"manual"`. Then submit
the form once and confirm it appears at `https://your-app.vercel.app/admin`.

### Managing applications

- **Review:** open `/admin`, enter your admin token, and pick an application.
  The list defaults to those awaiting review; the filter switches to approved or
  rejected.
- **Decide:** Approve reveals the community invite on the applicant's status
  page. Reject shows a polite closing message. A decision is recorded once — a
  second click reports the existing decision rather than flipping it. The
  decision records *who* made it, so the audit trail names the reviewer.
- **List over HTTP:**

  ```bash
  curl -H "X-Admin-Token: $ADMIN_API_TOKEN" \
    "$PUBLIC_BASE_URL/api/admin/applications?status=pending_review"
  ```

- **Preview the samples** as the dashboard would show them:

  ```bash
  npm run sample            # all samples
  npm run sample strong     # just one
  ```

### Managing admins (master only)

There are two kinds of admin, and the difference is who can manage accounts.

- The **master admin** is the token in `ADMIN_API_TOKEN`. It always exists,
  cannot be edited or deleted, and is the only account that can create and
  delete the others. Keeping it in the environment means you can always get back
  in, even if the `admins` table is lost.
- **Ordinary admins** are created by the master from the dashboard. They sign
  in with their own token, review applications, and approve or reject — but they
  cannot create or delete admins. The **Admins** button is only shown to the
  master.

To add a reviewer: open `/admin` as the master, click **Admins**, type a name,
and click **Create admin**. A token appears **once** — copy it and send it to
that person. Only a SHA-256 hash of the token is stored, so it cannot be
retrieved later; if it is lost, delete the account and create a new one. To
revoke access, click **Delete** on that row — their token stops working
immediately.

The same three operations over HTTP (master token required):

```bash
# List admins
curl -H "X-Admin-Token: $ADMIN_API_TOKEN" "$PUBLIC_BASE_URL/api/admin/admins"

# Create an admin — the response contains the one-time token
curl -X POST -H "X-Admin-Token: $ADMIN_API_TOKEN" -H 'content-type: application/json' \
  -d '{"label":"Ama — reviewer"}' "$PUBLIC_BASE_URL/api/admin/admins"

# Delete an admin
curl -X DELETE -H "X-Admin-Token: $ADMIN_API_TOKEN" \
  "$PUBLIC_BASE_URL/api/admin/admins?id=adm_…"
```

### Deploying elsewhere

Any Node host works. A host with a persistent disk (Render, Railway, Fly.io)
suits the SQLite driver: use `npm start` as the start command, no build command,
and set `STORAGE_DRIVER=sqlite`. Any Postgres will also do — the driver is a
standard connection string, so Neon, RDS, or a self-hosted server all work by
setting `DATABASE_URL`.

---

## 5. Test plan

Run the whole suite with:

```bash
npm test
```

All 64 tests pass with no network access, no API keys, no accounts, and no
database. The suite uses an in-memory store, and the HTTP and e2e tests drive
the real server over a real socket.

### What the suite covers

| Area | Tests |
|---|---|
| Config | the organisation, messages, and invite link are present; no scoring configuration remains; no email configuration remains; every role has a full question set |
| Text handling | control characters stripped; length capped; HTML escaped; email validation; constant-time compare; admin tokens are unique, high-entropy, and hash to their stored digest |
| Form | a complete submission validates and normalises; missing answers are reported; consent, email, and role are checked; instruction-shaped answers are stored verbatim |
| Pipeline | a submission is stored as `pending_review`; nothing is emailed; duplicates are refused while pending and allowed after a decision; approve reveals the invite; reject closes politely; approve is idempotent; a decision cannot be flipped; an unknown id 404s; a bad verb 400s; the audit trail is written; `adminView` returns the full application and the review state |
| HTTP | health, form, index, and `/admin` routes; invalid submissions rejected; valid submissions accepted; the status view never leaks answers or the invite before a decision; the admin API requires a token on list, detail, and decision; the full review flow over HTTP; directory traversal blocked; the removed email-era endpoints return 404 |
| Admin accounts | `/api/admin/me` identifies master vs ordinary; the master is always listed first; the master can create an admin whose token then works, with the plaintext stored nowhere; an ordinary admin can approve and the decision records their name; an ordinary admin gets `403` on every management route; a created token stops working once deleted; the master cannot be deleted; management is closed without a token |
| End-to-end | a submission waits in the dashboard; the admin reads it in full; approve reveals the invite; reject closes politely; the invite never leaks before a decision; an embedded instruction is delivered verbatim and changes nothing |

### The four sample applicants

In `samples/applicants.json`. Preview them with `npm run sample`. Since
screening is manual, each sample has an *expected human outcome* rather than an
expected score.

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

**Expected outcome: reviewed as plain text, with no effect.** The application is
stored and shown in the dashboard like any other; the admin decides. A test in
`test/e2e.integration.test.js` asserts that the text reaches the review screen
verbatim and that nothing acts on it.

---

## 6. Configuration reference

### `ctadi.config.json`

Everything applicant-facing lives here.

| Key | Purpose |
|---|---|
| `organisation.name` | Used in page headings and subjects |
| `messages.applicant_received` | Shown on the status page after submitting |
| `messages.applicant_under_review` | Shown while the admin is reviewing |
| `messages.applicant_approved` | Shown once approved, with the invite |
| `messages.applicant_rejected` | The polite closing message |
| `portal.community_invite_url` | Where the invite link points (fallback for `COMMUNITY_INVITE_URL`) |

### Environment variables

See `.env.example` for the annotated list. The important ones:

| Variable | Purpose |
|---|---|
| `ADMIN_API_TOKEN` | The **master** admin token. Protects `/admin` and every `/api/admin/*` route, and is the only account that can create or delete other admins. **Required in production** |
| `DATABASE_URL` | Postgres connection string. Set automatically by the Vercel Marketplace integration |
| `STORAGE_DRIVER` | `postgres`, `sqlite`, or `json`. Unset → `postgres` on Vercel, `json` locally |
| `COMMUNITY_INVITE_URL` | The link an approved applicant sees |
| `PUBLIC_BASE_URL` | The portal's own public URL |
| `SUBMIT_RATE_LIMIT_PER_HOUR` | Per-IP submission cap |
| `MAX_ANSWER_CHARS` | Hard cap on a single answer's length |

---

## 7. Security notes

**Secrets.** Every value is read from the environment. Nothing is hard-coded,
and `.env` is git-ignored. `DATABASE_URL` is injected by the Vercel integration
and never appears in the repository.

**The dashboard is the only door to applicant data, and it is locked.** `/admin`
is a static shell that carries no data; every `/api/admin/*` call is
authenticated. A presented token is checked against the master token
(`ADMIN_API_TOKEN`) and against the stored hashes of the ordinary admins. Both
comparisons are constant-time. On Vercel, if the master token is unset the routes
return `503` rather than serving anything — a misconfiguration fails closed. The
token is kept in `sessionStorage`, so it does not survive a browser restart and
is never placed in a URL.

**Admin tokens are stored as hashes.** When the master creates an ordinary admin,
the server mints a 192-bit random token, stores only its SHA-256 hash, and shows
the plaintext once. A database leak therefore does not hand over usable tokens.
Because a token is high-entropy random — not a chosen password — a fast hash is
the right choice: there is nothing to brute-force, and a slow KDF would only add
latency to every request. Deleting an admin deletes the hash, so the token stops
working at once.

**Only the master manages admins.** The `POST` and `DELETE` admin routes check
that the caller is the master and return `403` otherwise, so an ordinary admin
cannot create accounts or revoke a colleague. The master itself is not a database
row and cannot be deleted, so the owner can never lock themselves out.

**No AI means no prompt injection.** There is no model to instruct, so an
applicant cannot write their way past a reviewer by embedding instructions in an
answer. The text is stored and displayed as data, escaped for HTML, and read by
a person who decides. Removing the model removed a class of risk rather than
moving it.

**Output escaping.** The dashboard renders every applicant answer with
`textContent`, never `innerHTML`, so a crafted answer cannot inject markup into
the reviewer's page. Applicant text is also cleaned and length-capped on the way
in.

**Data minimisation.** The public status endpoint returns a deliberately small
view — never the answers, never any internal state, and never the invite until
the application is approved. An applicant can only see their own application if
they hold its id, which is a random 20-character string.

**Rate limiting.** `/api/submit` is limited per IP
(`SUBMIT_RATE_LIMIT_PER_HOUR`, default 5) and duplicate active applications from
the same email are refused by a partial unique index. On Postgres the counter is
a single atomic upsert, so it is shared across every serverless instance rather
than reset by a cold start. If the database is unreachable the limiter **fails
open** rather than blocking genuine applicants; that trade-off is deliberate and
logged.

**Serverless specifics.** Two things differ on Vercel, and each is handled
rather than assumed. The store driver is imported lazily, so an unused driver
(for example `node:sqlite`) can never crash a cold start. The request body is
read from the platform's pre-parsed `req.body`, because the underlying stream is
already drained — reading it would hang the request.

**Data protection.** You are storing personal data. Before going live: tell
applicants that a human reads every application (the form already asks for
consent to this), keep the retention period as short as your review process
allows, and restrict access to the admin token.

---

## 8. Brand and palette

The portal uses the CTaDI colour scheme throughout. The palette lives in one
place — the custom properties at the top of `public/styles.css` — so a change
there restyles every page.

| Colour | Hex | Role |
|---|---|---|
| Deep Charcoal Black | `#0B0D10` | Page canvas, and ink on light surfaces |
| Golden Amber | `#F5A642` | Gradient start, focus rings, highlights |
| Vibrant Orange | `#F16B32` | Gradient middle, primary accent, links |
| Burnt Orange | `#D94D27` | Gradient end, section tags, reject action |
| Graphite Grey | `#42444A` | Borders, secondary text, secondary surfaces |
| Pale Sage / Off-White | `#EAF0DF` | Light card surfaces, body text on dark |

The signature gradient runs **Golden Amber → Vibrant Orange → Burnt Orange**:

```css
--gradient: linear-gradient(90deg, #F5A642 0%, #F16B32 52%, #D94D27 100%);
```

It is applied to primary buttons, the card top rule, the master-admin pill, and
the logo. Dark charcoal is the page canvas; pale sage is the light card surface.

### The logo

Two SVGs live in `public/`:

- `logo.svg` — the square mark, used in the header of every page.
- `logo-full.svg` — the horizontal lockup (mark + wordmark + tagline), for
  places where the name should read alongside the mark.

Both are drawn from the palette above, so they sit correctly on the charcoal
background. **If you have an official CTaDI logo file, drop it in as
`public/logo.svg`** (and `public/logo-full.svg` for the lockup) — the pages
reference those paths and need no other change. Keep the mark square and around
`38px` tall so the header stays balanced.

---

## Licence and provenance

This repository was scaffolded by an AI agent (OpenHands) on behalf of the
CTaDI maintainers. Review the code and the configuration before putting it in
front of real applicants.
