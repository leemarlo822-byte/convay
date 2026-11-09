-- Additive account and document-processing migrations. Existing encrypted records are retained.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'buyer' CHECK(account_type IN('buyer','seller'));

CREATE TABLE IF NOT EXISTS buyer_verifications (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 tin_encrypted bytea NOT NULL,
 purpose text NOT NULL DEFAULT 'legacy_verification' CHECK(purpose IN('legacy_verification','loan_processing','ownership_transfer','loan_and_ownership')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
 review_note text NOT NULL DEFAULT '',
 consented_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS buyer_identity_documents (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('id_front','id_back','ssn_card','bank_statement','selfie','title_deed','property_document')),
 content_type text NOT NULL,
 encrypted_body bytea NOT NULL,
 filename text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_access_log (
 id uuid PRIMARY KEY,
 admin_user_id uuid NOT NULL REFERENCES users(id),
 document_id uuid REFERENCES buyer_identity_documents(id) ON DELETE SET NULL,
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

ALTER TABLE buyer_verifications ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'legacy_verification' CHECK(purpose IN('legacy_verification','loan_processing','ownership_transfer','loan_and_ownership'));

DO $migration$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='buyer_identity_documents'::regclass AND conname='buyer_identity_documents_kind_check' AND pg_get_constraintdef(oid) NOT LIKE '%selfie%') THEN
  ALTER TABLE buyer_identity_documents DROP CONSTRAINT buyer_identity_documents_kind_check;
  ALTER TABLE buyer_identity_documents ADD CONSTRAINT buyer_identity_documents_kind_check CHECK(kind IN('id_front','id_back','ssn_card','bank_statement','selfie','title_deed','property_document'));
 END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='verification_access_log'::regclass AND conname='verification_access_log_document_id_fkey' AND confdeltype='c') THEN
  ALTER TABLE verification_access_log ALTER COLUMN document_id DROP NOT NULL;
  ALTER TABLE verification_access_log DROP CONSTRAINT verification_access_log_document_id_fkey;
  ALTER TABLE verification_access_log ADD CONSTRAINT verification_access_log_document_id_fkey FOREIGN KEY(document_id) REFERENCES buyer_identity_documents(id) ON DELETE SET NULL;
 END IF;
END $migration$;

CREATE UNIQUE INDEX IF NOT EXISTS ix_buyer_docs_kind ON buyer_identity_documents(user_id,kind);

ALTER TABLE buyer_verifications ENABLE ROW LEVEL SECURITY;

DO $policy$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='buyer_verifications' AND policyname='verification_backend_access') THEN CREATE POLICY verification_backend_access ON buyer_verifications TO CURRENT_USER USING(true) WITH CHECK(true); END IF; END $policy$;

ALTER TABLE buyer_identity_documents ENABLE ROW LEVEL SECURITY;

DO $policy$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='buyer_identity_documents' AND policyname='verification_backend_access') THEN CREATE POLICY verification_backend_access ON buyer_identity_documents TO CURRENT_USER USING(true) WITH CHECK(true); END IF; END $policy$;

ALTER TABLE verification_access_log ENABLE ROW LEVEL SECURITY;

DO $policy$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='verification_access_log' AND policyname='verification_backend_access') THEN CREATE POLICY verification_backend_access ON verification_access_log TO CURRENT_USER USING(true) WITH CHECK(true); END IF; END $policy$;

ALTER TABLE verification_review_log ENABLE ROW LEVEL SECURITY;

DO $policy$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='verification_review_log' AND policyname='verification_backend_access') THEN CREATE POLICY verification_backend_access ON verification_review_log TO CURRENT_USER USING(true) WITH CHECK(true); END IF; END $policy$;
