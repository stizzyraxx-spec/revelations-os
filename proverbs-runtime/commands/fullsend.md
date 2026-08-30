---
description: Deep end-to-end QA — exercise every button/form, audit code + UI + security + privacy across the whole platform, auto-fix safe issues, pause on risky ones
---

Operate in FABLE mode (see ~/fable.md). Run a **full-send** audit of this entire application. Optional scope (a path, route, or feature to focus on; default = whole platform): $ARGUMENTS

`/fullsend` is the most thorough pass you can make: it crawls the entire interface, presses every button, fills and submits every form, creates a test resource for every feature and deletes it after, traces the code behind each interaction, hunts security exploits, and verifies privacy/support/security coverage and data protection — then **fixes what's safe to fix** and **asks before anything risky**.

---

## 0. Read the exceptions FIRST — never skip this

Before touching anything, read **`.fullsendignore`** at the repo root (create a starter one only if the user asks). It governs the entire run.

Format (one rule per line; `#` comments):
```
# paths (glob) — never edit or flag files here
legacy/**
vendor/**
# rule IDs — skip this check class entirely
rule: a11y-contrast
rule: console-warn
# free-text intentions — honor literally, these are deliberate choices
Leave the demo banner on the homepage
Don't change Stripe test keys
The /admin route is intentionally unstyled
```
- Anything matching a path glob: **do not edit, do not flag** (mention once that it was skipped).
- Any `rule:` ID listed: skip that check class.
- Free-text lines: treat as authoritative product decisions. If you find something that looks like a bug but a free-text exception covers it, **leave it and note "intentional per .fullsendignore."**
- If no `.fullsendignore` exists, proceed with nothing excepted, and at the end suggest creating one for any intentional-looking patterns you had to guess about.

---

## 1. Map the platform

Detect the project type and build the work-list:
- **Framework / runtime** (Next.js, Vite/React, Electron, static HTML, CLI, Python). Read `package.json`, config, and any `CLAUDE.md`/`STATUS.md`.
- **Every route/page** (App Router dirs, router config, HTML files, Electron screens).
- **Every interactive element** — enumerate buttons, links, forms, inputs, toggles, modals, menus per page. This list is your test matrix; account for all of it.
- **Every feature with a create→read→update→delete lifecycle** (the things you'll create test resources for).
- **Backend surface** — API routes/handlers, server actions, webhooks, DB models, auth.
- Note the dev command + port (check the app's memory/CLAUDE.md; ports are assigned per app).

Print the work-list before you start so the user sees the scope.

---

## 2. Exercise the live interface (press every button, fill every form)

**Web apps → Playwright.** If Playwright isn't installed, install it (`npm i -D @playwright/test && npx playwright install chromium`) — it's free, local, and your app-template already ships a smoke spec. Then drive a real headless browser:

1. Boot the app on its dev/prod port (use the project's run skill if one exists; otherwise `next dev`/`next start`/`vite preview` as appropriate). Wait for ready.
2. **Crawl every route** from the §1 map. On each page:
   - Capture **console errors/warnings** and **failed network requests** (4xx/5xx) — these are real client-side bugs.
   - **Click every button and link.** Follow navigations, open every modal/menu/drawer, toggle every control. Confirm each does something and nothing throws.
   - **Fill and submit every form** with valid data, then re-test with invalid/edge data (empty, too-long, XSS payloads like `<script>`, SQL-ish strings, wrong types) to verify **client + server validation** and that nothing is reflected unescaped.
   - Take a screenshot of each page/state for the report.
3. **Full-lifecycle test every feature:** for each create-capable feature, log in (use a seeded/test account; create one if the app supports test signup), **create a test resource** (clearly named e.g. `fullsend-test-<feature>`), verify it appears/reads/updates correctly, then **delete it** and verify cleanup. Leave the platform exactly as you found it — no test data left behind. If a creation can't be cleanly undone (charges, emails, external side-effects), **stop and ask** instead of running it.
4. Test responsive/mobile viewport and keyboard-only navigation for the key flows.

**Electron →** drive via the app's existing test harness if present, else exercise the renderer like a web app and code-trace main-process IPC. **CLI / static / library →** no browser: run the binary/entrypoints across representative inputs incl. edge cases, and rely more heavily on §3. State clearly in the report when an interaction couldn't be exercised live and was only code-verified — never imply you clicked something you didn't.

---

## 3. Audit the code behind every interaction

For everything the UI exposed, read the code path and check for:
- **Dead/broken wiring** — buttons with no handler, forms posting to missing/incorrect endpoints, links to 404s, `onClick` no-ops, handlers that swallow errors silently.
- **Runtime hazards** — unhandled promise rejections, missing null/undefined guards, `useEffect` deps, hydration mismatches, race conditions, top-level browser-global access that breaks SSR, `useSearchParams` without Suspense (prerender bailouts).
- **Data integrity** — server-side validation on every mutation, server-authoritative pricing/amounts (never trust client), idempotent webhooks, inventory/stock correctness.
- **Build health** — run the project's build + typecheck + lint (use the `/test` skill if it fits) and resolve real errors.
- **Accessibility** — alt text, labels, focus order, contrast, ARIA on custom controls, reduced-motion. (Skip classes listed in `.fullsendignore`.)
- **Performance smells** — N+1 queries, unbounded lists, missing pagination, oversized client bundles, blocking work in render.

---

## 4. Security exploits

Run the full **`/secaudit`** 15-point RAXX checklist (don't duplicate it here — invoke it) and additionally probe, hands-on where safe:
- **AuthZ/IDOR** — try to access another user's resource by id; confirm every protected route/server-action checks the caller's role. **RLS** on every user-data table; no service-role key in any client bundle.
- **XSS** — the `<script>`-payload submissions from §2; confirm user content is escaped on render.
- **Injection** — parameterized/ORM-only queries; no string-built SQL.
- **CSRF** on state-changing requests; **rate limiting** on auth/payment/AI endpoints.
- **Secrets** — none committed; grep the repo and the **client bundle** for keys/tokens. Webhook **signatures verified**, amounts validated server-side.
- **Dependencies** — `npm audit`; flag known-vuln packages.
- Headers — CSP/HSTS/X-Frame-Options/etc.

---

## 5. Privacy, support, security & data protection coverage

This is a hard gate for every RAXX app:
- **`/privacy`** and **`/support`** pages exist, are publicly accessible (no auth), and linked site-wide in the footer. If either is missing, add it (use the **`/privacy-support-batch`** skill) — Company: RAXX BEATS STUDIOS LLC · Owner: Shane Bedasee · stizzyraxx@gmail.com.
- Privacy policy covers: data collected, usage, third parties (Stripe/Supabase/etc.), cookies, GDPR/CCPA rights, contact. Support page has FAQ + contact + 48h response expectation.
- **Data protection** — PII minimized; sensitive data **encrypted at rest** (DB/Supabase) and **in transit** (HTTPS/TLS everywhere); passwords hashed (bcrypt/argon, never plaintext); tokens short-lived; data-deletion + export paths exist (GDPR/CCPA); no PII/secrets in logs or error responses.
- Consent capture where required; cookie/analytics disclosure matches what the app actually loads.

---

## 6. Fix policy — auto-fix safe, ask on risky

For every confirmed issue NOT covered by `.fullsendignore`:

**Auto-fix (just do it, then verify it still builds/passes):**
- Dead buttons, broken form wiring, links to 404s, missing handlers.
- Client/server validation gaps, unescaped output / XSS, missing security headers.
- Missing `/privacy` `/support` pages + footer links.
- Console errors/warnings, accessibility fixes (labels/alt/focus/contrast), hydration/Suspense/prerender errors.
- Type/lint/build errors, obvious null-guard and error-handling gaps.

**Stop and ASK first (show the finding + your proposed change, wait for go-ahead):**
- Database **schema/migration** changes.
- **Auth/authorization logic** changes.
- **Deleting** code, files, or features.
- **Pricing, billing, payment** behavior, or anything touching real money/charges.
- Changes that alter intended **product behavior** or visual design.
- Anything that creates external side-effects (emails, third-party API writes) or that you're <90% sure is a bug vs. a deliberate choice.
- Anything matching a `.fullsendignore` path or free-text exception.

Fix the **specified class of issue only** — do not opportunistically refactor unrelated code (RAXX bug-fix discipline). Make surgical edits, no dead code.

---

## 7. Report

Produce **`FULLSEND-REPORT.md`** at the repo root:
- **Summary:** routes crawled, buttons clicked, forms submitted, features lifecycle-tested, test resources created+deleted (confirm zero leftover).
- **Fixed automatically** — each issue, severity, file:line, what changed.
- **Needs your decision** — each risky finding with the proposed fix, waiting on you.
- **Skipped (intentional)** — items left per `.fullsendignore`.
- **Security** — the `/secaudit` PASS/FAIL table + any exploit attempts and results.
- **Privacy/support/data-protection** — coverage status.
- **Couldn't fully test** — anything only code-verified (e.g. flows needing real payment), stated honestly.
- Screenshots referenced inline.

Then re-run the build/typecheck (and Playwright suite if added) and **only report success once they pass** — never claim green before the build exits 0 (RAXX deploy-verification rule). End with the prioritized list of items awaiting the user's decision.

**Be honest about evidence:** if a step was skipped or a button couldn't be reached, say so plainly. Do not report a feature as tested unless you actually exercised it.
