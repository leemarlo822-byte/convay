CREATE TABLE IF NOT EXISTS buyer_verifications (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 tin_encrypted bytea NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
 review_note text NOT NULL DEFAULT '',
 consented_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS buyer_identity_documents (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('id_front','id_back','ssn_card','bank_statement')),
 content_type text NOT NULL,
 encrypted_body bytea NOT NULL,
 filename text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS verification_access_log (
 id uuid PRIMARY KEY,
 admin_user_id uuid NOT NULL REFERENCES users(id),
 document_id uuid NOT NULL REFERENCES buyer_identity_documents(id) ON DELETE CASCADE,
 accessed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_buyer_docs_user ON buyer_identity_documents(user_id);

CREATE TABLE IF NOT EXISTS verification_review_log (
 id uuid PRIMARY KEY,
 admin_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL CHECK(action IN('list','status_update')),
 created_at timestamptz NOT NULL DEFAULT now()
);
