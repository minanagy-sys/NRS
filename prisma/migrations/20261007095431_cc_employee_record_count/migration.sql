-- How many Odoo employee records share one name. See CcEmployee.recordCount.
--
-- Written by hand rather than taken from `prisma migrate diff` as generated:
-- the diff also emitted `DROP TABLE "DoctorShift"`, which is pre-existing
-- drift between the schema and this database and nothing to do with this
-- change. Dropping it would have destroyed that table's rows, so only the
-- added column is kept here.
ALTER TABLE "CcEmployee" ADD COLUMN "recordCount" INTEGER NOT NULL DEFAULT 1;
