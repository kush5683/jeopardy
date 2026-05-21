-- The @unique constraint already creates Category_name_key; the explicit
-- @@index([name]) added Category_name_idx redundantly.
DROP INDEX IF EXISTS "Category_name_idx";
