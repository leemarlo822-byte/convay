# Buyer document verification

Registration accepts a name, email, phone, a nine-digit U.S. TIN, ID front/back images and a bank statement image or PDF. An SSN card image is optional and needs separate consent. Files are uploaded from the user's device, with a 4 MB limit per file. Uploading documents creates a pending review; it does not establish that an identity is authentic.

TINs and document bodies are encrypted with AES-256-GCM before PostgreSQL storage. These records use the app's private database schema, row security and authenticated administrator routes. They are never served from property-image routes or public static folders.

## Deployment configuration

Keep the existing database and administrator settings. Add these secrets to the Render environment before deploying this version:

- `VERIFICATION_ENCRYPTION_KEY`: a cryptographically random 32-byte key encoded as 64 hexadecimal characters. Back up this key securely and retain it across deploys. Replacing it makes previously encrypted submissions unreadable.
- `VERIFICATION_REVIEW_KEY`: a separate cryptographically random key of at least 32 characters. This is the additional unlock key for the administrator's Verification tab. Do not put either key into GitHub, public frontend code or browser local storage.

The application creates verification tables on startup using its existing database role. It also enables row security and limits the backend policies to the database role creating the tables.

## Administrator review

Open Admin → Verification and enter the separate review key. The key stays in the current page's memory and is cleared on sign out. Authorized reviewers can see buyer contact details, the TIN and document buttons, and can save pending/approved/rejected decisions with notes. Image documents open in the private review dialog. PDFs download as attachments. File views, TIN-list access and review decisions are audited.

The current implementation validates file signatures and encrypts stored files; it does not perform malware scanning or independently verify IDs, SSNs, TINs or financial information. Define the business purpose, access, retention and deletion process before collecting actual client documents. Collect an SSN card only when necessary for the requested transaction.

## Property photos

Create/Edit Property now has a multiple-file picker. Saving creates/updates the property and uploads selected images using the existing persistent image endpoint. Existing photos are retained on edits. The form accepts up to 24 photos per property and 4 MB per photo. MLS media continues to be managed by the authorized feed.

## Verification performed

The test suite uses a local PostgreSQL engine and real HTTP multipart requests with synthetic documents. It covers encrypted storage, independent review-key access, denial for visitors/buyers, file retrieval, audit entries, review changes and transaction rollback on invalid or duplicate registrations. Hosted checks must be repeated after the source update is deployed.
