import pg from 'pg';
import {premiumStatements} from './premium-schema.mjs';
import {hashPassword,newId} from './security.mjs';
import {trustStatements} from './trust-schema.mjs';
export const enabled=Boolean(process.env.DATABASE_URL);
const connection=process.env.DATABASE_URL||'';
export const pool=enabled?new pg.Pool({connectionString:connection,max:5,connectionTimeoutMillis:12000,ssl:connection.includes('sslmode=')?undefined:{rejectUnauthorized:false}}):null;
export const query=async(sql,params=[])=>{if(!pool)throw Object.assign(Error('This service is temporarily unavailable. Please try again later.'),{status:503});return pool.query(sql,params);};
export async function initDatabase(){if(!pool){console.warn('DATABASE_URL missing: public listings remain empty and database-backed operations are disabled.');return;}
const statements=[
`CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, phone text DEFAULT '', password_hash text NOT NULL, role text NOT NULL DEFAULT 'client' CHECK(role IN('client','admin')), created_at timestamptz NOT NULL DEFAULT now())`,
`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'buyer' CHECK(account_type IN('buyer','seller'))`,
`CREATE TABLE IF NOT EXISTS buyer_verifications (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 tin_encrypted bytea NOT NULL,
 purpose text NOT NULL DEFAULT 'legacy_verification' CHECK(purpose IN('legacy_verification','loan_processing','ownership_transfer','loan_and_ownership')),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
 review_note text NOT NULL DEFAULT '',
 consented_at timestamptz NOT NULL DEFAULT now(),
 reviewed_at timestamptz,
 reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL
)`,
`CREATE TABLE IF NOT EXISTS buyer_identity_documents (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN('id_front','id_back','ssn_card','bank_statement','selfie','title_deed','property_document')),
 content_type text NOT NULL,
 encrypted_body bytea NOT NULL,
 filename text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
)`,
`CREATE TABLE IF NOT EXISTS verification_access_log (
 id uuid PRIMARY KEY,
 admin_user_id uuid NOT NULL REFERENCES users(id),
 document_id uuid REFERENCES buyer_identity_documents(id) ON DELETE SET NULL,
 accessed_at timestamptz NOT NULL DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS ix_buyer_docs_user ON buyer_identity_documents(user_id)`,
`CREATE TABLE IF NOT EXISTS verification_review_log (
 id uuid PRIMARY KEY,
 admin_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 subject_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 action text NOT NULL CHECK(action IN('list','status_update')),
 created_at timestamptz NOT NULL DEFAULT now()
)`,
`ALTER TABLE buyer_verifications ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'legacy_verification' CHECK(purpose IN('legacy_verification','loan_processing','ownership_transfer','loan_and_ownership'))`,
`DO $migration$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='buyer_identity_documents'::regclass AND conname='buyer_identity_documents_kind_check' AND pg_get_constraintdef(oid) NOT LIKE '%selfie%') THEN
  ALTER TABLE buyer_identity_documents DROP CONSTRAINT buyer_identity_documents_kind_check;
  ALTER TABLE buyer_identity_documents ADD CONSTRAINT buyer_identity_documents_kind_check CHECK(kind IN('id_front','id_back','ssn_card','bank_statement','selfie','title_deed','property_document'));
 END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='verification_access_log'::regclass AND conname='verification_access_log_document_id_fkey' AND confdeltype='c') THEN
  ALTER TABLE verification_access_log ALTER COLUMN document_id DROP NOT NULL;
  ALTER TABLE verification_access_log DROP CONSTRAINT verification_access_log_document_id_fkey;
  ALTER TABLE verification_access_log ADD CONSTRAINT verification_access_log_document_id_fkey FOREIGN KEY(document_id) REFERENCES buyer_identity_documents(id) ON DELETE SET NULL;
 END IF;
END $migration$`,
`CREATE UNIQUE INDEX IF NOT EXISTS ix_buyer_docs_kind ON buyer_identity_documents(user_id,kind)`,
`ALTER TABLE buyer_verifications ENABLE ROW LEVEL SECURITY`,
`DO $policy$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='buyer_verifications' AND policyname='verification_backend_access') THEN CREATE POLICY verification_backend_access ON buyer_verifications TO CURRENT_USER USING(true) WITH CHECK(true); END IF; END $policy$`,
`ALTER TABLE buyer_identity_documents ENABLE ROW LEVEL SECURITY`,
`DO $policy$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='buyer_identity_documents' AND policyname='verification_backend_access') THEN CREATE POLICY verification_backend_access ON buyer_identity_documents TO CURRENT_USER USING(true) WITH CHECK(true); END IF; END $policy$`,
`ALTER TABLE verification_access_log ENABLE ROW LEVEL SECURITY`,
`DO $policy$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='verification_access_log' AND policyname='verification_backend_access') THEN CREATE POLICY verification_backend_access ON verification_access_log TO CURRENT_USER USING(true) WITH CHECK(true); END IF; END $policy$`,
`ALTER TABLE verification_review_log ENABLE ROW LEVEL SECURITY`,
`DO $policy$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='verification_review_log' AND policyname='verification_backend_access') THEN CREATE POLICY verification_backend_access ON verification_review_log TO CURRENT_USER USING(true) WITH CHECK(true); END IF; END $policy$`,
`CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL)`,
`CREATE TABLE IF NOT EXISTS properties(id uuid PRIMARY KEY, title text NOT NULL, city text NOT NULL, state text NOT NULL, address text NOT NULL DEFAULT '', zip_code text NOT NULL DEFAULT '', price_cents bigint NOT NULL, beds int NOT NULL DEFAULT 0, baths numeric(4,1) NOT NULL DEFAULT 0, sqft int NOT NULL DEFAULT 0, lot_sqft int, year_built int, type text NOT NULL DEFAULT 'Single-family', status text NOT NULL DEFAULT 'available' CHECK(status IN('available','under-contract','sold','hidden')), description text NOT NULL DEFAULT '', features jsonb NOT NULL DEFAULT '[]'::jsonb, images jsonb NOT NULL DEFAULT '[]'::jsonb, featured boolean NOT NULL DEFAULT false, demo boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS property_images(id uuid PRIMARY KEY,property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,content_type text NOT NULL,body bytea NOT NULL,filename text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS favorites(user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,PRIMARY KEY(user_id,property_id))`,
`CREATE TABLE IF NOT EXISTS inquiries(id uuid PRIMARY KEY,property_id uuid REFERENCES properties(id) ON DELETE SET NULL,user_id uuid REFERENCES users(id) ON DELETE SET NULL,name text NOT NULL,email text NOT NULL,phone text NOT NULL DEFAULT '',kind text NOT NULL DEFAULT 'question',message text NOT NULL,status text NOT NULL DEFAULT 'new',created_at timestamptz NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS tours(id uuid PRIMARY KEY,property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,user_id uuid REFERENCES users(id) ON DELETE SET NULL,name text NOT NULL,email text NOT NULL,phone text NOT NULL DEFAULT '',preferred_date date NOT NULL,preferred_time text NOT NULL,notes text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'requested',created_at timestamptz NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS offers(id uuid PRIMARY KEY,property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,user_id uuid REFERENCES users(id) ON DELETE SET NULL,name text NOT NULL,email text NOT NULL,phone text NOT NULL DEFAULT '',amount_cents bigint NOT NULL,financing text NOT NULL DEFAULT 'not-specified',message text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'received',created_at timestamptz NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS conversations(id uuid PRIMARY KEY,visitor_hash text NOT NULL UNIQUE,user_id uuid REFERENCES users(id) ON DELETE SET NULL,guest_name text NOT NULL DEFAULT '',guest_email text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'open',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS messages(id uuid PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,sender text NOT NULL CHECK(sender IN('client','admin')),body text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS transactions(id uuid PRIMARY KEY,property_id uuid NOT NULL REFERENCES properties(id),user_id uuid NOT NULL REFERENCES users(id),offer_id uuid REFERENCES offers(id),agreed_price_cents bigint NOT NULL,stage text NOT NULL DEFAULT 'Offer accepted',closing_date date,note text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS transaction_events(id uuid PRIMARY KEY,transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,stage text NOT NULL,note text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now())`,
`CREATE TABLE IF NOT EXISTS payments(id uuid PRIMARY KEY,transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,amount_cents bigint NOT NULL,method text NOT NULL,reference text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`,
`ALTER TABLE properties ADD COLUMN IF NOT EXISTS lat numeric(10,7)`,
`ALTER TABLE properties ADD COLUMN IF NOT EXISTS lng numeric(11,7)`,
`ALTER TABLE properties ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual'`,
`ALTER TABLE properties ADD COLUMN IF NOT EXISTS mls_source text`,
`ALTER TABLE properties ADD COLUMN IF NOT EXISTS external_id text`,
`ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_office text NOT NULL DEFAULT ''`,
`ALTER TABLE properties ADD COLUMN IF NOT EXISTS listing_agent text NOT NULL DEFAULT ''`,
`ALTER TABLE properties ADD COLUMN IF NOT EXISTS attribution text NOT NULL DEFAULT ''`,
`ALTER TABLE properties ADD COLUMN IF NOT EXISTS mls_last_seen timestamptz NOT NULL DEFAULT now()`,
`CREATE UNIQUE INDEX IF NOT EXISTS ux_mls_source_external ON properties(mls_source,external_id) WHERE source='mls' AND external_id IS NOT NULL`,
`CREATE TABLE IF NOT EXISTS mls_sync_runs(id uuid PRIMARY KEY,provider text NOT NULL,imported int NOT NULL DEFAULT 0,pages int NOT NULL DEFAULT 0,complete boolean NOT NULL DEFAULT false,error text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now())`,
`CREATE INDEX IF NOT EXISTS ix_properties_coords ON properties(lat,lng) WHERE lat IS NOT NULL AND lng IS NOT NULL`,
`CREATE INDEX IF NOT EXISTS ix_conversations_user ON conversations(user_id)`,
`CREATE UNIQUE INDEX IF NOT EXISTS ix_payments_reference ON payments(transaction_id,reference)`,
`CREATE INDEX IF NOT EXISTS ix_properties_status ON properties(status,featured)`,
`CREATE INDEX IF NOT EXISTS ix_messages_conv ON messages(conversation_id,created_at)`,
`CREATE INDEX IF NOT EXISTS ix_inquiries_created ON inquiries(created_at DESC)`,
`CREATE TABLE IF NOT EXISTS service_invoices(
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id),
 property_id uuid REFERENCES properties(id) ON DELETE SET NULL,
 description text NOT NULL,
 amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN 100 AND 999999),
 currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 status text NOT NULL DEFAULT 'open' CHECK(status IN('open','paid','cancelled','refunded')),
 paypal_order_id text UNIQUE,
 paypal_capture_id text UNIQUE,
 paypal_payer_id text,
 paypal_order_created_at timestamptz,
 paid_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS ix_service_invoices_buyer ON service_invoices(user_id,created_at DESC)`,
`CREATE INDEX IF NOT EXISTS ix_tours_created ON tours(created_at DESC)`
];
for(const sql of statements)await query(sql);
for(const sql of trustStatements)await query(sql);
for(const sql of premiumStatements)await query(sql);
if(process.env.ADMIN_PASSWORD){
 const email=(process.env.ADMIN_EMAIL||'infocovalyn@gmail.com').trim().toLowerCase();
 const existing=await query('SELECT id FROM users WHERE email=$1',[email]);
 if(!existing.rowCount){if(process.env.ADMIN_PASSWORD.length<8)throw Error('ADMIN_PASSWORD must have at least eight characters.');await query('INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)',[newId(),'Covalyn Administrator',email,hashPassword(process.env.ADMIN_PASSWORD),'admin']);console.log('Initial administrator was created for',email);}
}
// Remove the previous application's illustrative database inventory.
// Keep any demo properties referenced by historical transactions but hide them.
await query("UPDATE properties SET status='hidden' WHERE demo=true AND status!='hidden'");
await query("DELETE FROM properties p WHERE p.demo=true AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.property_id=p.id)");

}
export function publicProperty(p){return {...p,price:Number(p.price_cents)/100,baths:Number(p.baths),lat:p.lat===null||p.lat===undefined?null:Number(p.lat),lng:p.lng===null||p.lng===undefined?null:Number(p.lng),price_cents:undefined};}
export function fallbackProperties(){return [];}
