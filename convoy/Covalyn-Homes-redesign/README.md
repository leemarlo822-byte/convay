# COVALYN HOMES — U.S. property marketplace

A complete responsive Node.js / Express + PostgreSQL real-estate website, based on the original Dragon Motor showroom design. The app uses a modern paper-and-ink editorial design, property listing cards, a U.S.-only property search, interactive maps, an authorized RESO MLS/IDX feed connector, customer/admin messaging and PayPal checkout for separately issued **service invoices**.

**Important:** There are **no starter/sample homes**. No properties appear until the administrator uploads them, or an authorized MLS feed is configured and synchronized. Every amount is denominated in **United States dollars (USD)**.

## Functional features

**Trust features (v1.4):** Independent property check history and conditional ownership-confirmed labels; property-specific encrypted document requests with reviewer MFA and retention; buyer/seller next-action and closing tracker; reviews from verified completed transactions with consent; visitor listing reports that reach the admin dashboard. See [TRUST-FEATURES.md](TRUST-FEATURES.md).

- **Public U.S. listings:** Filter by city, state, property category, asking price, bedrooms, status; listing galleries; USD pricing; saved homes, comparison and mortgage estimator.
- **Interactive maps:** Grid/map toggle with price markers on property coordinates, map details, zoom/pan and individual listing map. Maps do not invent locations; listings without coordinates have no pin. Manual property creation supports coordinates and U.S. Census geocoding.
- **Authorized MLS/IDX:** REST/RESO Web API connector with an authenticated server-side feed, listing-source attribution, sync history, update/upsert and hiding stale feed records on a complete synchronization. No MLS feed or listings are included. You must obtain permission and credentials from your licensed provider; each provider may require specific field/media/rule adjustments.
- **Customer accounts and messages:** Buyer registration/login, account-linked chat with persistent PostgreSQL messages, and an administrator inbox that receives messages and supports replies. Both sides poll for recent messages. Guests can chat with a local browser token, but account login provides cross-device access.
- **Customer portal:** Saved homes, tours, offers, inquiries, purchase journey, messages and payment invoices.
- **Admin workspace:** Create/edit/hide property listings, upload photos, manage customers, inbox, offers, tours, transactions and MLS synchronizations; issue and track service invoices in USD.
- **PayPal service checkout:** The admin creates an explicit service invoice assigned to a registered buyer. The buyer opens **Client portal → Payments** and uses a PayPal checkout button. Order creation and capture happen on the backend using PayPal Orders v2; the price comes only from a database invoice, not browser input. The invoice becomes *paid* only after PayPal's completed USD capture is checked. Optional verified webhooks reconcile completed captures and full refunds/reversals.

**PayPal is not for buying houses or funding the closing.** The checkout intentionally supports only an agreed, permitted service invoice between $1.00 and $9,999.99. It does not accept a house's full asking price, earnest money, down payments, escrow funds or closing funds. Actual U.S. real-estate transactions must use appropriate licensed closing/escrow/title services with the proper legal and regulatory protections. Don't assume every kind of real-estate fee can legally be charged: verify service description, licensing, fee rules, refund policy and agreement before sending invoices.

## Deployment: Render free Node service + Supabase PostgreSQL

1. Create a Supabase project. From **Connect → Session pooler** copy the PostgreSQL connection string on port **5432**, including `sslmode=require`. Keep it private. Render can connect to a Supabase pooler over IPv4.
2. For the existing `leemarlo822-byte/convay` repository, replace the project files in `convoy/Covalyn-Homes-redesign/`, preserving the folder paths. Alternatively, to create a new GitHub repository, upload the *contents* of this folder to the repository root. `package.json`, `render.yaml`, `public/` and `server/` must be at the root.
3. In Render choose **New → Blueprint**, connect that repository and review the `render.yaml`. It configures a single free Node web service. For the existing nested GitHub layout, set its Render **Root Directory** to `convoy/Covalyn-Homes-redesign`. The database is external Supabase, not Render PostgreSQL.
4. Configure environment variables:

   | Key | Setting |
   | --- | --- |
   | `DATABASE_URL` | Supabase Session pooler PostgreSQL URL |
   | `ADMIN_EMAIL` | Default `infocovalyn@gmail.com` (change if needed) |
   | `ADMIN_PASSWORD` | Choose your own long, unique initial password (8+ characters) |
   | `VERIFICATION_ENCRYPTION_KEY` | Existing 64-character hex encryption key (required for private documents and reviewer MFA) |
   | `VERIFICATION_REVIEW_KEY` | Separate existing private document-review key, minimum 32 characters |
   | `NODE_ENV` | `production` |
   | `PUBLIC_ORIGIN` | Optional full `https://your-service.onrender.com` origin |
   | `PAYPAL_MODE` | Start with `sandbox`, switch to `live` after successful testing |
   | `PAYPAL_CLIENT_ID` | Client ID from your own PayPal REST app |
   | `PAYPAL_CLIENT_SECRET` | Secret from your PayPal REST app (**server only**) |
   | `PAYPAL_WEBHOOK_ID` | Optional but recommended verified webhook ID from your PayPal REST app |

5. Deploy. The server automatically creates the database schema and (once) an administrator account using the initial environment credentials. It does **not** overwrite an existing admin password when you later change the environment variable. All account and listing writes require PostgreSQL.
6. Visit your new URL, sign in at `/admin`, upload your first real authorized U.S. listing, then create a test buyer account at `/login` to verify messaging and payments.
7. For MLS, set your **authorized** provider feed configuration, then in **Admin → MLS / IDX feed** press **Synchronize licensed properties**.

### Configure the authorized RESO / MLS connector

Set these environment variables on the Render web service:

- `MLS_RESO_IDX_AUTHORIZED=true` **only after documented permission to display and use the feed**.
- `MLS_RESO_API_URL=https://your-approved-provider.example/path/to/Property` — HTTPS only, provider supplied.
- `MLS_RESO_ACCESS_TOKEN=...` — access token supplied by your provider; consult `server/mls.mjs` for alternative supported authorization configurations.
- `MLS_RESO_SOURCE_NAME=...` — provider name and any required custom attribution fields.
- `MLS_RESO_ATTRIBUTION=...` — provider-required attribution.

Keep credentials private. MLS data is not automatically available from RESO. Each MLS has its own access requirements, data fields, media terms, attribution policies and refresh mandates.

### Connect PayPal for actual online payment collection

1. Create or sign in to a **PayPal Business** merchant account and create a REST application at [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications).
2. Start in **Sandbox**, where no real funds move. Copy the **Sandbox Client ID** and **Secret** into the Render environment variables. Set `PAYPAL_MODE=sandbox`.
3. In PayPal's developer dashboard, create a webhook subscription URL `https://YOUR-RENDER-DOMAIN/api/paypal/webhook` for the events `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.CAPTURE.REVERSED`. Copy the webhook ID into `PAYPAL_WEBHOOK_ID`. Incoming events are **validated against PayPal** before affecting invoice status. Without the webhook ID, server-side capture works but webhook reconciliation is unavailable.
4. Sign in as admin → **PayPal invoices**, issue an agreed service invoice to a registered customer. Sign in as that customer → **Payments**, click the PayPal button and complete a Sandbox buyer checkout. Verify the status and PayPal capture reference in both dashboards.
5. When testing passes and PayPal approves the merchant for the intended fees, replace the sandbox credentials with **Live** credentials and set `PAYPAL_MODE=live`; replace the webhook ID with the live subscription ID. Confirm billing terms, refund procedures, client disclosures and any applicable real estate regulations before collecting real payments.

The browser receives only the public PayPal Client ID. The secret, OAuth token requests, checkout amount, order creation, capture and webhook verification stay on the server. PayPal handles customer payment credentials; **do not request card numbers in site messages or forms**. The checkout UI is only shown when both merchant credentials are configured. **The app has not been connected to your live PayPal account**, so you must complete that setup.

**Important operational limitation:** Invoice cancellations after a PayPal order has been initiated are blocked in the admin dashboard to avoid silently cancelling a payment already in progress. Reconcile the order with PayPal support/business dashboard before changing its status. Production refund initiation from within Covalyn Homes is not included. Refunds should be handled in PayPal and verified through webhooks and merchant reconciliation. Partial refund handling needs additional reconciliation support before real customers rely on it.

## Local development

Install Node.js 22 or newer, then:

```bash
npm install
cp .env.example .env
# Enter DATABASE_URL and ADMIN_PASSWORD; add PayPal sandbox credentials when testing payments
npm run dev
```

Open <http://localhost:3000>. When DATABASE_URL is absent, the app is **read-only preview mode**, with no listings. User registrations, chat and payments are unavailable without a persistent PostgreSQL database. This avoids falsely claiming messages or payments were saved.

Run built-in automated checks (including mocked PayPal REST flows):

```bash
npm test
node --check server/index.mjs
node --check public/app.js
```

## Post-launch security and operations

- Obtain permission to advertise homes; follow U.S. fair-housing, state real-estate brokerage and MLS/IDX display rules. Add verified business identity, brokerage/license and local contact information, terms, privacy notice, accessibility statement and refund/fee disclosures.
- Before accepting live payments, test completed, cancelled, reversed and interrupted PayPal captures using merchant and buyer test accounts; set up PayPal dispute monitoring and reconcile refunds. Do not use PayPal for real-estate closing funds.
- Turn on Supabase backups, secret rotation, account-level reviewer MFA (included for private-review routes), fraud and abuse protection, error monitoring, and support processes appropriate to your scale. This starter implements session cookies and hashed passwords but does not represent a complete compliance audit.
- The supplied website uploads photos into PostgreSQL byte arrays (4 MB each). Migrate images to Supabase Storage/CDN for a large U.S. property catalog.
- Render free web services may sleep when idle; Supabase free tiers have resource limitations. Review pricing and capacity before public launch.
- The map uses publicly available OpenStreetMap tiles and requires attribution. For sustained commercial traffic, use an approved tile provider or self-host map tiles according to provider policy.
- Customer chat is database-backed with periodic polling; it is not a push-notification or email service. Add notifications and customer support staffing separately.

## Support email

Public contact email: **infocovalyn@gmail.com**. Visitor listing reports and document requests are stored in the dashboard. Automatic outbound email requires separately configuring a transactional mail service.

## Buyer and seller accounts

Sign up as a buyer or seller, then use **My account → Loan & ownership** to submit documents and a selfie. Sellers can upload a title deed and supporting property document for private review. The **Sell your home** page delivers seller inquiries to the admin inbox. See [VERIFICATION.md](VERIFICATION.md) for the account and deployment details.

## Status / verification

Source-code and automated tests (USD calculations, MLS mapping, geocoding, PayPal fake API create/capture/verification flow, security helpers) can run without credentials. **Live PayPal checkout, real database operations, hosted Render deployment, and an authorized MLS provider feed are not verified until you connect and test those accounts.** No property listing or invoice is preloaded.

**Existing admin accounts:** Updating `ADMIN_EMAIL` in Render and in this project does not automatically change an existing admin login email in PostgreSQL. Update the existing admin account email securely in the deployment database if the login should also change; keep administrator permissions and password unchanged. Do not insert a second administrator merely to rename the email.

## v1.5 — premium trust tools, PDF receipts and mobile install

See [PREMIUM-FEATURES.md](PREMIUM-FEATURES.md) for a detailed breakdown and deployment limitations. Added property-linked agent licensing, rule-based anomaly flags, closing verification and fraud warnings, user TOTP sign-in, support case inbox, 360-degree still photographs, source-attributed price history, saved-search alerts, seller analytics, nonbinding counteroffers, provider-hosted signing references, lender referrals, title/escrow contacts, PWA support and stamped company-issued PDF receipts.

**No AI assistant, AI recommendation, property video playback or video consultation** has been added. Optional Resend delivery is not enabled until `RESEND_API_KEY` and a verified `EMAIL_FROM` sender are configured. All service receipts require a confirmed PayPal capture; property-related external payment records require an admin evidence reference. Their stamped receipts do not certify escrow settlement or property ownership.
