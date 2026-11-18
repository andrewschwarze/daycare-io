DROP INDEX IF EXISTS users_login_code_unique;
ALTER TABLE users DROP COLUMN login_code;
