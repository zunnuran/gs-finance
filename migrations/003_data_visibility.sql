ALTER TABLE users ADD COLUMN data_scope text CHECK(data_scope IN ('own','company'));
ALTER TABLE accounts ADD COLUMN restricted boolean NOT NULL DEFAULT false;
UPDATE accounts SET restricted=true WHERE purpose='employee_expense';
CREATE TABLE user_contacts (
  user_id integer NOT NULL,
  company_id integer NOT NULL,
  contact_id integer NOT NULL,
  PRIMARY KEY(user_id,company_id),
  UNIQUE(company_id,contact_id),
  FOREIGN KEY(user_id,company_id) REFERENCES memberships(user_id,company_id) ON DELETE CASCADE,
  FOREIGN KEY(contact_id,company_id) REFERENCES contacts(id,company_id)
);
