ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
UPDATE users SET last_activity_at = created_at WHERE last_activity_at IS NULL;
ALTER TABLE users ALTER COLUMN last_activity_at SET DEFAULT NOW();
ALTER TABLE users ALTER COLUMN last_activity_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_last_activity_pending ON users(last_activity_at);
