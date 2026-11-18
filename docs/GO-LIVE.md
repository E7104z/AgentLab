# Go-live checklist (The Real Help)

Do these in order. Keep `AGENT_ENABLED=false` until step 9.

1. **Railway Postgres.** Add the Postgres plugin to the AgentLab project. Railway sets `DATABASE_URL`; migrations run on start.
2. **Variables.** Set everything in `env.example`. Generate `LEAD_WEBHOOK_SECRET` and `CAL_WEBHOOK_SECRET` with `openssl rand -hex 32`. Set `ADMIN_USER` and a strong `ADMIN_PASSWORD`. Set `APP_BASE_URL` to the Railway URL.
3. **Mailbox.** In Google Cloud project `real-help-internal-agents`, enable the Gmail, Docs, Drive and Sheets APIs. Run `npm run auth` locally, sign in as **info@thecdscloud.com**, and put the printed `GMAIL_REFRESH_TOKEN_MAIN` in Railway. (The old token for jason@therealhelp.com no longer works.)
4. **Cal.com.** Settings → Developer → Webhooks → add `https://<app>/webhooks/cal?client=default` with the `CAL_WEBHOOK_SECRET` value. Events: Booking created, rescheduled, cancelled, meeting ended. Turn on Cal.com's 24 h and 1 h reminder workflows.
5. **Stripe (test mode).** Create a $500 one-time price and a $30/month price, set `STRIPE_PRICE_SETUP` / `STRIPE_PRICE_MONTHLY`. Add a webhook endpoint `https://<app>/webhooks/stripe` for `checkout.session.completed` and `invoice.payment_failed`, and set `STRIPE_WEBHOOK_SECRET`.
6. **Proposal template (optional).** Make a Google Doc using any of these placeholders: `{{ClientName}} {{Business}} {{Date}} {{Offer}} {{Problem}} {{Solution}} {{Deliverables}} {{Timeline}} {{Price}} {{Monthly}} {{NextSteps}} {{PayLink}} {{PreparedBy}}`. Set `PROPOSAL_TEMPLATE_DOC_ID` (and `PROPOSAL_FOLDER_ID`). Without a template, a plain doc is generated.
7. **Website.** Apply `docs/WEBSITE_HOOK.md` in the-real-help, and set `AGENTLAB_LEAD_URL` and `AGENTLAB_LEAD_SECRET` in Vercel.
8. **Client portal (optional).** Create a service account in the-real-help's Firebase project, set `PORTAL_FIREBASE_SERVICE_ACCOUNT` and `PORTAL_INVITE_ENABLED=true`. Otherwise each paid client creates an "invite to portal" task.
9. **Turn on in log mode.** `clients/default/client.json` ships with `"sendMode": "log"`. Set `POLL_ENABLED=true`, deploy, and click **Turn on**. Send yourself a test email and a test form lead, and check Activity and Contacts.
10. **Draft mode.** Change `sendMode` to `"draft"`. Review the first 10 replies in **Review** (or Gmail Drafts).
11. **Send mode.** Change to `"send"`. Watch the 7 a.m. digest for a week.
12. **Reviews.** Once the Google Business Profile exists, set `reviewUrl` in `client.json`.
13. **Demo.** Mail to `info+demo@thecdscloud.com` is answered by the fictional demo business, with a disclosure line and limits of 3 per sender and 50 per day. Point the website's "Try it" section at that address.
