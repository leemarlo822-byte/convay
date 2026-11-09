# Account documents

Buyers and sellers choose their account type at signup and enter their basic contact details. Once signed in, open **My account → Upload documents** to submit documents for loan processing, transfer of ownership, or both.

Both account types use the same form for a nine-digit TIN, the front and back of a government ID, and a selfie. The selfie can be taken on the page with camera permission or selected from the device. A bank statement is required for loan processing. An SSN card is optional and requires separate consent. Seller accounts also have fields for a title deed and supporting property document. Files have a 4 MB limit. Images can be JPEG, PNG or WebP, and statements and property documents can also be PDFs.

**Sell your home** sends homeowner inquiries to **Admin → Inquiries**. Signed-in sellers can open the separate document page when their ownership papers are needed.

Rental applicants choose **I want to rent** at signup. Under **My account → Upload documents**, they can provide both sides of a government ID and optional proof of income for private rental review. The rental form does not collect a TIN, SSN card, selfie, or title deed.

## Administrator review

Sign in as an administrator, then open **Admin → Verification** and enter the separate document review secret phrase. Listing checks and property-specific private requests use the reviewer authenticator flow. Reviewers can see contact details, account type, submitted purpose, TIN, and private document attachments. The review decision and note appear in the client's account. Images open in the review dialog and PDFs download as attachments. File views, TIN access and decisions are audited. The team's review covers documents and ownership evidence. Loan decisions and transfers are handled separately.


## Updating the existing service

Keep the current database connection, administrator settings, `VERIFICATION_ENCRYPTION_KEY` and `VERIFICATION_REVIEW_KEY`. The application applies additive changes on startup. Existing accounts default to Buyer, and earlier submissions retain their original identity verification purpose. Existing encrypted documents stay readable with the same encryption key.

For a new installation, use a private database schema and a restricted database login. Set `VERIFICATION_ENCRYPTION_KEY` to a random 32-byte key encoded as 64 hexadecimal characters and `VERIFICATION_REVIEW_KEY` to a separate random key of at least 32 characters. Keep both in the service environment. Serve the app over HTTPS for camera access. Use `npm test` for the local checks with synthetic accounts and documents.

## Trust features

See [TRUST-FEATURES.md](TRUST-FEATURES.md) for ownership checks, property-specific private document requests, retention periods, reporting, reviews and purchase tracking.
