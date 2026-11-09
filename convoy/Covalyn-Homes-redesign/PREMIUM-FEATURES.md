# COVALYN HOMES v1.5 — non-AI premium features and branded receipts

This update is based on COVALYN HOMES v1.4.1. The support/admin email remains **infocovalyn@gmail.com**. Previous buyer/seller signup, account identity documents, selfie capture (a still image, not an uploaded video), private document review, listing checks, paid service invoices, PayPal verification, buyer/seller transaction progress, consent-gated reviews and listing reports are preserved.

## Included

1. **Verified agent profiles** — Admin enters a property-linked agent, brokerage, state license number and official registry link after independently checking the license. Public pages display only checked profiles.
2. **Rule-based fraud indicators** — Duplicate address, exact duplicate photo hash across properties, and gross same-city/same-type price anomalies (minimum five comparable listings); private admin queue to investigate or dismiss. A flag is a lead for manual review, not proof of wrongdoing.
3. **Wire-fraud warning and independently checked closing contacts** — All closing pages warn users not to rely on instructions sent by email or chat. Never accept bank instructions through Covalyn.
4. **Buyer/seller/admin sign-in TOTP** — Account settings supports optional authenticator enrollment. Enabled accounts require a six-digit authenticator after password sign-in. Separate reviewer step-up remains required to review sensitive documents.
5. **Dispute center** — Customers open property/transaction-linked cases, send messages and view statuses; admin replies and resolves.
6. **360-degree photos without video** — Admin selects an uploaded panoramic image from that property's photo gallery. Users drag or press arrow buttons to pan the photograph. No video playback or video-consultation feature.
7. **Price history and source-linked property data** — New/updated manual prices are recorded. Admin can add tax-year facts with source links; nothing is inferred from invented records.
8. **Appointment confirmations** — Existing requested tour flow remains; admin and the property-linked seller can confirm or decline, with an in-app update for the buyer.
9. **Saved-search alerts** — Buyers opt into new-listing/price-drop alerts by city/state/type/price, pause them, and receive stored in-app notifications. Optional outbound messages require a verified sending provider.
10. **Nonbinding offer negotiation** — Admin/seller may propose a counteroffer to a registered buyer; buyers can accept in principle or decline. Not a legally executed home contract.
11. **Provider-hosted e-signature links** — Admin links an existing DocuSign or Adobe Sign envelope and its provider-reported status. This app does not create signatures, operate as an e-sign provider, or assert legal enforceability.
12. **Mortgage-lender referral directory** — Display only independently checked lender NMLS information and referral fee disclosures. Covalyn is not the lender and does not promise preapproval.
13. **Closing checklists** — Admin adds responsible party, deadline, and tracks task status in the database; buyer/seller sees their linked transactions.
14. **Escrow/title partner contact panel** — Admin records independently checked licensed contact and external portal URL; partner status is manually recorded. No bank account or closing funds are collected here. Full partner API synchronization is not connected.
15. **Seller analytics** — Approximate distinct daily listing views, tour requests, inquiries and offers by seller-owned listing. Visitor IPs are not stored in the analytics table; only time-scoped HMAC hashes are saved.
16. **Installable mobile website** — PWA manifest, Android/iOS-capable icon assets, service worker caches public static assets only. **Never** cache authentication, financial, document, receipt or API responses.
17. **Email delivery queue and review dashboard** — Alert requests are persisted. An admin can deliver batches via Resend with a verified sending address. `RESEND_API_KEY` and `EMAIL_FROM` are optional but needed for actual sends. `infocovalyn@gmail.com` is the reply-to contact; email sending does not work just by owning the Gmail address.
18. **Receipt issuance** — Downloadable USD PDF only after a verified PayPal capture (`paid` or `refunded`) or an external payment entry with an administrator-recorded evidence reference. PDF shows company billing signature, internal Covalyn stamp, reference, buyer, date, amount, payment status, and legal distinction for escrow/closing. Refunded receipts are marked refunded. Download is authenticated and never cached by the browser/service worker.

**Explicitly not added:** AI assistants, AI recommendations, video consultations or upload/playback of property videos. Selfie camera capture still uses a live preview for a *still photograph*, as requested in the earlier identity flow.

## Configuration and rollout

1. Deploy Node.js 22+ from `convoy/Covalyn-Homes-redesign/`, using existing private `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `VERIFICATION_ENCRYPTION_KEY`, and `VERIFICATION_REVIEW_KEY` configuration. The app creates additional tables/columns on startup (append-only schema changes; no existing customer records intentionally deleted).
2. In **Admin → Reviewer security**, set up the existing admin reviewer TOTP. Reviewer-specific verification is distinct from account-wide login MFA.
3. In **Client portal → Two-step sign-in**, users can opt into MFA. **Do not enable customer enrollment until account recovery and support identity checks are operational.** Lost authenticators require manual support at present.
4. For outward email delivery, add `RESEND_API_KEY` and `EMAIL_FROM` (a sender address on a domain verified with the provider). The Reply-To remains infocovalyn@gmail.com. Review queued emails in **Admin → Email notifications**; delivery attempts automatically for up to three queued emails when a matching new listing or price drop is recorded. The admin can retry or send additional queued emails; there is no scheduled background worker.
5. For view analytics, optionally provide `VIEW_HASH_SECRET` (a random secret, 32+ bytes). Otherwise the existing verification encryption key is used. Never embed either key in public frontend code.
6. Set `PUBLIC_ORIGIN` to the actual HTTPS Render domain. Full U.S. property inventory and any licensed MLS data must be supplied by the business.
7. For agent verification, lender referral and e-sign links, supply real state-license records and approved provider links. Neither partner API credentials nor a live licensed closing service has been connected by this source release.
8. Before U.S. launch, get legal, privacy, transaction, brokerage, RESPA/fair housing, data retention, consumer notice and payment compliance review appropriate to the actual states served.

### Receipt authenticity boundaries

The default electronic billing signature reads **Covalyn Homes Billing Office**. The circle says **COVALYN HOMES — RECEIPT**. These are internal company marks, **not handwritten signatures**, notarized documents, title stamps, official government seals or bank/escrow confirmation. The document never certifies ownership transfer or closing funds. The issuer must be authorized to use this business identity and should verify the receipt against the underlying payment processor record.

### External integration limitations

- A referral link is not a live mortgage prequalification integration.
- A provider-hosted e-signature link is not an API-connected signing workflow.
- A title/escrow status entry is manually supplied, not independently API-synchronized.
- Outbound notification emails require a provider key plus sender-domain verification; automatic small-batch sends and admin-triggered retries are supported, but there is no recurring background worker. In-app notifications are persisted immediately.
- Current code should be tested on a staging deployment with real Supabase PostgreSQL and simulated PayPal before publishing. No authenticated end-to-end staging testing was possible within this archive build.
