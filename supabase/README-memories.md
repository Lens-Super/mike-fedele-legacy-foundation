# Memories of Mike — Supabase setup

This feature keeps every new story and photo private until Stephanie signs in and approves it. The browser only receives the Supabase URL and **anon/publishable** key. Never put the service-role key, database password, or Cloudflare Turnstile secret in website files or public GitHub content.

## Current implementation limits

- Up to five JPG, PNG, or WebP photos per submission; each file is limited to 4 MB.
- Stories are limited to 20,000 characters. The Edge Function limits each client IP to five submissions per hour and twenty per day.
- A hidden honeypot is always enabled. Cloudflare Turnstile can be enabled with its free site key and secret; the server verifies each challenge.
- Email notifications are not enabled. Supabase does not provide a dependable free arbitrary notification email for new database rows. The private dashboard has a refresh button; adding email later needs an email delivery provider or an existing SMTP relay.

## Free plan and cost

The implementation uses standard Supabase Database, Auth, Storage, and Edge Functions and does not enable paid add-ons. As of the current Supabase plan information, Free includes 1 GB file storage, 500 MB database size, 5 GB egress, and 500,000 Edge Function invocations per month. Free projects can pause after a week of inactivity. Supabase lists Pro from $25/month, which includes 100 GB file storage and 250 GB egress; overages apply only under paid plans with spend controls changed. No paid upgrade is required for this initial setup. Review the live [Supabase pricing page](https://supabase.com/pricing) before changing plans or add-ons.

## One-time setup

1. Create a Supabase project on the Free plan. Save the database password privately. Choose a region near most visitors.
2. In **Project Settings → API**, copy the Project URL and anon/publishable key into `memories-config.js` (`supabaseUrl` and `supabaseAnonKey`). These are public browser settings; do not copy a service-role/secret key there.
3. In **SQL Editor**, run `migrations/202611040001_memories_of_mike.sql` from top to bottom. Confirm it completes without errors.
4. In **Authentication → URL Configuration**, set the site URL to `https://mikefedelelegacy.org` and add `https://mikefedelelegacy.org/memories-admin.html` to allowed redirect URLs.
5. In **Authentication → Providers → Email**, enable email sign-in and confirm that Stephanie can receive magic-link messages at `stephanie@mikefedelelegacy.org`. The dashboard accepts no other email address.
6. For stronger spam protection, create a free Cloudflare Turnstile widget for `mikefedelelegacy.org` and enter its site key in `memories-config.js`. Set its secret as `TURNSTILE_SECRET_KEY` in **Edge Functions → Secrets**. The server verifies the token; the secret stays in Supabase.
7. Deploy `functions/submit-memory/index.ts` as an Edge Function named `submit-memory`, with JWT verification off (the function is public by design but validates every submission). Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to deployed functions. Do not expose those values. One CLI route is `supabase login`, `supabase link --project-ref PROJECT_REF`, then `supabase functions deploy submit-memory --no-verify-jwt` from the repository root. Never commit the login token, service key, or database password.
8. After GitHub Pages deploys, open `/memories-admin.html`, sign in with Stephanie's foundation email, and verify that a test submission appears as **pending**. Approve it and verify it appears at the top of `/memories-of-mike.html`; then reject or remove the test entry.

If the free project pauses after a week without activity, resume it in the Supabase dashboard. It can take a few minutes before requests work again.

## Security behavior

- Only the Edge Function can create submissions. It validates required fields, consent, upload count/size/type and image signatures, applies per-IP rate limits, and can verify Turnstile.
- RLS prevents anonymous reads of submissions, emails, and pending photos. The public RPC returns only approved story fields, contributor display name, publication time, and approved photo paths.
- The photo bucket is private. Storage read policies permit Stephanie to review pending files and visitors to mint short-lived signed links only for photos attached to approved submissions.
- Stephanie's email allowlist is enforced in both dashboard code and database RLS. The browser allowlist is only a convenience; RLS is the access boundary.
- The project URL and anon key are intentionally public. No service-role key or secret belongs in this repository.
