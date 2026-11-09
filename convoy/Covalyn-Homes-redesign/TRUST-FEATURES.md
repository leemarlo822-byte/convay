# COVALYN HOMES — Trust center update (2026-11-09)

The site now includes independently recorded listing checks, private property-specific document requests, reviewer two-step verification, buyer and seller transaction progress, consented client reviews, and a public report-a-listing workflow. Public contact and admin notification address: **infocovalyn@gmail.com**. Sending automatic emails requires separately configuring an email delivery service; all visitor reports and private requests are stored in the admin dashboard even without outbound email.

## User journeys

- **Property detail → Property verification.** Visitors can see which fields were checked, the independent reviewer's name and organization, the method and check date. The ownership-confirmed label appears only when the most recent recorded independent review is verified and includes both the title deed and external ownership records. This is a recorded attestation by an authorized admin, **not an automatic title search** or legal guarantee. Never represent it as such.
- **Property detail → Report a listing.** Visitors report incorrect details, ownership concerns, duplicates or suspicious activity, with a required explanation and optional email. Reports appear in **Admin → Listing reports** for triage and resolution. Spam controls rate-limit submissions.
- **Account → Private requests.** Client sees the property, document type, purpose, reviewers, deadline, retention, submitted file and admin feedback. Submissions are encrypted using AES-256-GCM and linked to the specific request. No public download URLs. The client sees their own records only.
- **Admin → Document requests.** After two-step verification, create a request for a registered buyer or seller and particular property. Choose a clear purpose, a permitted reviewer group and a retention period of 30, 60 or 90 days from upload. Staff can download files only while their verified reviewer session is valid. File access is audited. Clients may replace documents or respond to requested changes.
- **Account → My transactions.** Both the buyer on the transaction and the seller linked to its property see the current milestone, next step, responsible party, deadline, agreed fee, closing contact and downloadable administrative payment records with references (not processor-issued receipts). Admin can edit these under **Admin → Transactions**. These are administrative records, not payment-processor receipts or title-transfer proof.
- **Account → Leave feedback.** Only a buyer or linked seller from a transaction with an externally confirmed closing can submit feedback, with explicit permission to publish first name and buyer/seller role. Admin moderation precedes public display; published reviews appear on the homepage. Clients can withdraw publication permission.
- **Admin → Reviewer security.** Admin sets up a time-based six-digit authenticator by confirming the account password and entering a code. Property-specific document requests and ownership-check records require a verified reviewer session (15 minutes). The Verification tab uses an admin login and the separate document review secret phrase.
- **Admin → Listing checks.** Record independent reviewer, their organization and email, check method, date, fields checked, outcome and evidence reference. An owner-confirmed claim additionally requires a verifiable reference, an ownership-records check, and a title-deed check. Link a registered seller account to the property here so they can view transactions and leave reviews after closing.

## Deployment / schema migration

1. This package preserves the latest buyer/seller registration flow from the user's Work ZIP. Registration **does not** ask for TIN, SSN card, ID photos or bank statement. Those remain in the authenticated **Loan & ownership** page. Seller-only deed documents remain in that page.
2. In the current GitHub repository `leemarlo822-byte/convay`, the project is located under `convoy/Covalyn-Homes-redesign/`. Replace files under **that exact path** with the same paths in this ZIP. If deploying this subfolder from Render, make the Render root directory `convoy/Covalyn-Homes-redesign` (or move the project contents to the repository root deliberately, updating the service configuration).
3. Set/retain private Render environment variables: `DATABASE_URL`, `ADMIN_EMAIL=infocovalyn@gmail.com`, `ADMIN_PASSWORD` for fresh installations, **`VERIFICATION_ENCRYPTION_KEY` (64 hex characters, stable across redeploys)** and **`VERIFICATION_REVIEW_KEY` (32+ characters)**. The encryption key must match the existing one so previously stored documents remain decryptable. Never put real secrets in GitHub, frontend code or a ZIP.
4. On startup `server/db.mjs` runs **additive**, idempotent `trustStatements` from `server/trust-schema.mjs` against the existing PostgreSQL database. Review these DDL changes and back up the Supabase project before first deployment. New public-schema tables have row-level security enabled and do not expose permissive anonymous policies; the backend must use its existing privileged, private DB connection.
5. Log in with an existing admin account and open **Admin → Reviewer security** to enroll an authenticator before accessing property-specific private requests or recording listing checks. Each authorized admin who reviews sensitive documents should enroll separately. Never share an authenticator seed or a review key with clients.
6. Assign sellers to their real properties, record only authentic independent listing checks, request only necessary client documents, and confirm actual closings through a licensed title/escrow professional before publishing transaction reviews.
7. Test on staging with synthetic identities and documents before connecting real users. The existing database, PayPal, MLS connection, mail delivery and Render service have **not** been live-tested or modified by this package.

## Privacy & practical limits

- New private request files are encrypted using the existing `VERIFICATION_ENCRYPTION_KEY`. Each file is inaccessible at its expiry timestamp and eligible for physical deletion through the six-hour in-process cleanup cycle and on client/admin document-list requests. Render free services may sleep; delayed service wakeups may delay physical cleanup. **Database backups and legal retention requirements must be handled separately** before making an unconditional deletion promise.
- Existing account-level ID and loan documents use the earlier verification table and are subject to that workflow's retention policy. The new property-request retention is not retroactively applied to them.
- Do not collect SSN cards, passports, banking records or deeds without a legitimate specific purpose, an appropriate privacy notice, explicit permission and a secure retention/deletion policy. These documents are sensitive even when encrypted.
- Transaction fees are recorded only when explicitly attested as agreed. Any PayPal integration is still limited to permitted service invoices, **not** house purchase payments, escrow, earnest money, deposits or closing funds.
- A verification label is not proof of title, a review is not a guaranteed endorsement, and a report has not been investigated merely because it was submitted. Admin staff must review all substantive evidence and handle errors/corrections promptly.
- For production scale, add per-staff account permissions, a documented MFA recovery procedure, mail delivery and delivery verification, formal data-retention automation and encrypted backups, monitoring and staff audit procedures, independent security testing, and U.S. legal/privacy compliance review.

## Local checks

```sh
npm ci
npm test
node --check server/index.mjs
node --check public/app.js
node --check public/trust-ui.js
```

The new pure-TOTP tests and source-level security checks run without optional infrastructure. Database-connected integration and live payment tests require the actual dependencies and a configured test environment.
