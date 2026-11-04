# Memories of Mike — Cloudflare deployment

The feature uses two Cloudflare Workers, one D1 database, and a private R2 bucket. The existing GitHub Pages site remains the public website. No Contact page or unrelated website files are changed.

## Security design

- `mike-fedele-memories-api` accepts public submissions and serves approved memories/photos. It never returns contributor emails. It rejects submissions from other website origins.
- `mike-fedele-memories-admin` serves the private dashboard and moderation/export API. Protect its entire `workers.dev` URL with Cloudflare Access and an allow policy for `stephanie@mikefedelelegacy.org`. Enable One-time PIN as the Access login method. The Worker also verifies the signed Cloudflare Access JWT, its audience and issuer, and Stephanie's exact email before serving either the dashboard or an admin endpoint.
- R2 remains private. Public photo requests first check D1 and stream a file only when its memory is approved. Admin review can read pending originals behind Access.
- Uploads accept only JPEG/PNG/WebP, verify the file signature, allow at most five photos at 5 MB each, cap stories at 20,000 characters, and stop accepting uploads at 8 GB total stored originals (below R2's 10 GB-month Free allowance). Cloudflare Turnstile is required. A hidden honeypot and D1 rate limits allow up to five submissions per IP per hour and twenty per IP per day.
- Admin export downloads a JSON archive of every memory and its photo metadata; each original photo also has an individual download link in the dashboard. Store the JSON and the originals together for a restorable backup.
- No access key, account password, API token, or Turnstile secret is stored in the public repository.

## Free allowances and cost controls

The configuration uses Workers Free, D1, R2 Standard, and Cloudflare Access; it does not select a paid plan or add-on. Current published Free allowances include 100,000 Worker requests/day; D1 5 million rows read/day, 100,000 rows written/day, and 5 GB total storage; R2 10 GB-month Standard storage, 1 million Class A operations, 10 million Class B operations, and free egress. Access Free permits up to 50 users. R2/D1 use beyond Free allowances requires an upgrade for more capacity; do not upgrade or enable paid options without Stephanie's approval. Monitor usage in Cloudflare. At the Free Worker daily limit or D1 quota, requests can fail until limits reset. R2's free tier only covers Standard storage.

## Cloudflare resources to create

1. Create a Cloudflare account or sign in. Use the Free plan; no zone migration or nameserver change is required for the `workers.dev` URLs.
2. In **Workers & Pages → D1 SQL Database**, create database `mike-memories`. Copy its database ID into both Wrangler files, replacing `REPLACE_WITH_D1_DATABASE_ID`.
3. In **R2 Object Storage**, create a private Standard bucket named `mike-memories-originals`. Do not enable `r2.dev` public access or add a public custom domain.
4. In **Turnstile**, create a Managed widget for `mikefedelelegacy.org`. Put the site key in `cloudflare/wrangler-api.toml` and `memories-config.js`; add the secret to the API Worker as secret `TURNSTILE_SECRET_KEY` after deployment.
5. Create a Cloudflare API token scoped to this account with Workers Scripts Edit, D1 Edit, and R2 Storage Edit. Add it to the GitHub repository as Actions secret `CLOUDFLARE_API_TOKEN`; add the account ID as `CLOUDFLARE_ACCOUNT_ID`. Never put either value in a committed file or paste them into chat. The included workflow uses these secrets to apply the database migration and deploy both Workers after each relevant push.
6. After first deployment, open the `mike-fedele-memories-admin` Worker. In **Settings → Domains & Routes**, enable Cloudflare Access for its `workers.dev` URL. In the generated Access app, allow only `stephanie@mikefedelelegacy.org` and enable One-time PIN email authentication. Copy the app's audience tag and your Zero Trust team domain to `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `wrangler-admin.toml`, then deploy again. The Worker fails closed until those values are set and Access is enabled.
7. Set Worker secret `TURNSTILE_SECRET_KEY` and a random `RATE_LIMIT_SALT` in the API Worker using **Settings → Variables and Secrets**. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in the admin Worker's variables or in `wrangler-admin.toml`, then deploy it again. Set `apiBase`, `adminUrl`, and the Turnstile site key in public `memories-config.js`; set the same site key in `wrangler-api.toml`. These website values are public; only the Turnstile secret, rate-limit salt, and GitHub deployment token are secrets.

The account owner must complete Cloudflare's account sign-in, create the resources, and accept any account terms. No secret keys should be shared in chat.

## Verification checklist before opening the form

1. Confirm GitHub Pages deployment succeeded and `/health` on the API Worker returns `{ "ok": true }`.
2. Submit a story with no photos; confirm a friendly confirmation appears and it is visible only in the Access-protected admin dashboard.
3. Submit a story with two photos; confirm both originals are private while pending and visible to the admin.
4. Attempt public API reads for the pending submission and its photo IDs; they must return no story and 404 for both photos.
5. Approve the two-photo story; reload the public Memories page and confirm it appears first with both images and no email.
6. Reject another test story, confirm it stays hidden, then remove it and confirm its D1 row and R2 originals are deleted.
7. Review layout at 390px and 430px on the live site and on the private dashboard.
8. Download the JSON export and original test photos, then permanently delete all test memories.

Keep the form closed in `memories-config.js` until all steps pass.
