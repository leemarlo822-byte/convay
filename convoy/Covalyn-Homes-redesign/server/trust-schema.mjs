// Persisted trust features. Backend uses a private pooled PostgreSQL connection;
// no direct anonymous Supabase Data API access is granted to these RLS tables.
export const trustStatements = [
`ALTER TABLE properties ADD COLUMN IF NOT EXISTS seller_user_id uuid REFERENCES users(id) ON DELETE SET NULL`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS next_action text NOT NULL DEFAULT ''`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS responsible_party text NOT NULL DEFAULT 'admin' CHECK (responsible_party IN ('buyer','seller','admin','title_company'))`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS action_deadline date`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS agreed_fees_cents bigint NOT NULL DEFAULT 0 CHECK (agreed_fees_cents>=0)`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fee_description text NOT NULL DEFAULT ''`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS fees_confirmed_at timestamptz`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS closing_contact_name text NOT NULL DEFAULT ''`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS closing_contact_email text NOT NULL DEFAULT ''`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS closing_contact_phone text NOT NULL DEFAULT ''`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS closed_at timestamptz`,
`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS closing_evidence_reference text NOT NULL DEFAULT ''`,
`CREATE TABLE IF NOT EXISTS reviewer_totp (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 secret_encrypted bytea NOT NULL,
 enabled_at timestamptz,
 last_counter bigint NOT NULL DEFAULT -1,
 created_at timestamptz NOT NULL DEFAULT now()
)`,
`CREATE TABLE IF NOT EXISTS reviewer_stepups (
 token_hash text PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS listing_verification_checks (
 id uuid PRIMARY KEY,
 property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
 checked_fields text[] NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('verified','issues_found','pending')),
 reviewer_name text NOT NULL,
 reviewer_organization text NOT NULL,
 reviewer_email text NOT NULL,
 verification_method text NOT NULL,
 evidence_reference text NOT NULL DEFAULT '',
 independently_checked boolean NOT NULL DEFAULT false,
 recorded_by uuid NOT NULL REFERENCES users(id),
 checked_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS ix_listing_checks_property ON listing_verification_checks(property_id,checked_at DESC)`,
`CREATE TABLE IF NOT EXISTS listing_reports (
 id uuid PRIMARY KEY,
 property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
 reporter_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 reporter_email text NOT NULL DEFAULT '',
 reason text NOT NULL CHECK(reason IN ('incorrect_details','ownership_concern','duplicate','suspicious','other')),
 description text NOT NULL,
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_review','resolved','dismissed')),
 admin_note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL
)`,
`CREATE INDEX IF NOT EXISTS ix_listing_reports_created ON listing_reports(created_at DESC)`,
`CREATE TABLE IF NOT EXISTS private_document_requests (
 id uuid PRIMARY KEY,
 property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 requested_by uuid NOT NULL REFERENCES users(id),
 doc_type text NOT NULL,
 purpose text NOT NULL,
 reviewer_group text NOT NULL,
 retention_days int NOT NULL CHECK(retention_days BETWEEN 1 AND 90),
 due_at date,
 status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','submitted','accepted','needs_changes','cancelled','expired')),
 reviewer_note text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS ix_private_doc_user ON private_document_requests(user_id,status)`,
`CREATE TABLE IF NOT EXISTS private_document_files (
 request_id uuid PRIMARY KEY REFERENCES private_document_requests(id) ON DELETE CASCADE,
 encrypted_body bytea NOT NULL,
 filename text NOT NULL,
 content_type text NOT NULL,
 submitted_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS private_document_access (
 id uuid PRIMARY KEY,
 request_id uuid NOT NULL REFERENCES private_document_requests(id) ON DELETE CASCADE,
 reviewer_id uuid NOT NULL REFERENCES users(id),
 accessed_at timestamptz NOT NULL DEFAULT now()
)`,
`CREATE TABLE IF NOT EXISTS client_reviews (
 id uuid PRIMARY KEY,
 transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 party text NOT NULL CHECK(party IN ('buyer','seller')),
 rating int NOT NULL CHECK(rating BETWEEN 1 AND 5),
 message text NOT NULL,
 publish_consent boolean NOT NULL DEFAULT false,
 moderation text NOT NULL DEFAULT 'pending' CHECK(moderation IN ('pending','published','rejected')),
 published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(transaction_id,user_id)
)`,
`CREATE INDEX IF NOT EXISTS ix_client_reviews_public ON client_reviews(published_at DESC) WHERE moderation='published'`,
...['reviewer_totp','reviewer_stepups','listing_verification_checks','listing_reports','private_document_requests','private_document_files','private_document_access','client_reviews'].map(t=>`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`)
];
