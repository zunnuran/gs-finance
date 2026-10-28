-- Only unposted workflow states change. Posted documents and journals are immutable.
ALTER TABLE documents DROP CONSTRAINT documents_status_check;
WITH previous AS MATERIALIZED (
  SELECT id,company_id,created_by,status FROM documents
  WHERE status IN ('draft','submitted','approved','rejected')
), changed AS (
  UPDATE documents d SET status='pending' FROM previous p WHERE d.id=p.id
  RETURNING d.id,d.company_id,d.created_by,p.status AS previous_status
)
INSERT INTO audit(company_id,user_id,action,entity,entity_id,before_value,after_value)
SELECT company_id,
  COALESCE((SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='super_admin' ORDER BY u.id LIMIT 1),created_by),
  'workflow_migration','document',id,
  jsonb_build_object('status',previous_status),
  jsonb_build_object('status','pending','performedBy','system migration 005_simple_transactions.sql')
FROM changed;
ALTER TABLE documents ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK(status IN ('pending','posted','cancelled','reversed'));

-- Posting remains a separate, explicit permission. No new posting rights are granted.
UPDATE roles SET permissions=COALESCE((
  SELECT jsonb_agg(permission) FROM jsonb_array_elements(permissions) permission
  WHERE permission NOT IN ('"transactions.submit"'::jsonb,'"transactions.approve"'::jsonb)
),'[]'::jsonb);
UPDATE users SET overrides=overrides-'transactions.submit'-'transactions.approve';
UPDATE companies SET approvals=false WHERE approvals;
ALTER TABLE companies ALTER COLUMN approvals SET DEFAULT false;
