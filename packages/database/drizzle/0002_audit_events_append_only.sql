-- Custom SQL migration file, put your code below! --

-- Enforce the append-only contract (PRD.md §13, CONTRACTS.md §7) at the
-- database level: no privilege short of dropping/disabling this trigger can
-- update or delete a recorded audit_events row. This does not address the
-- stated self-anchored-hash-chain limitation (a superuser could still
-- disable the trigger and rewrite history) — that remains an explicit,
-- disclosed MVP limitation. It does close the much cheaper gap where any
-- role with ordinary UPDATE/DELETE privilege on the table could silently
-- alter or remove evidence.
CREATE OR REPLACE FUNCTION audit_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted on this table', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON "audit_events"
FOR EACH ROW
EXECUTE FUNCTION audit_events_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON "audit_events"
FOR EACH ROW
EXECUTE FUNCTION audit_events_append_only();
