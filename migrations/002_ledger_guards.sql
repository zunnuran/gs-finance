-- Seal journals at transaction commit. Line inserts are allowed only while their
-- journal is being assembled inside its original database transaction.
ALTER TABLE journals ADD COLUMN created_tx bigint NOT NULL DEFAULT txid_current();
CREATE FUNCTION guard_line_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j journals;
BEGIN
 SELECT * INTO j FROM journals WHERE id=NEW.journal_id;
 IF j.created_tx<>txid_current() THEN RAISE EXCEPTION 'A posted journal cannot receive additional lines'; END IF;
 IF j.company_id<>NEW.company_id THEN RAISE EXCEPTION 'Journal line belongs to another company'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_line_insert BEFORE INSERT ON journal_lines FOR EACH ROW EXECUTE FUNCTION guard_line_insert();
CREATE FUNCTION guard_journal_header() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total numeric; cnt integer;
BEGIN
 SELECT COALESCE(sum(debit-credit),0),count(*) INTO total,cnt FROM journal_lines WHERE journal_id=NEW.id;
 IF total<>0 OR cnt<2 THEN RAISE EXCEPTION 'Journal must contain balanced entries'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER balanced_header AFTER INSERT ON journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_journal_header();
CREATE FUNCTION guard_posted_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('posted','reversed') THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Posted documents cannot be deleted'; END IF;
   IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NOT (OLD.status='posted' AND NEW.status='reversed') THEN
     RAISE EXCEPTION 'Posted documents cannot be edited; create a reversal';
   END IF;
 END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER guard_posted_document BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION guard_posted_document();
