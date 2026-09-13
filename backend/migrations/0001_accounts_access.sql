ALTER TABLE users
ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'client';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_role_check' AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users
        ADD CONSTRAINT users_role_check CHECK (role IN ('client', 'admin'));
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS user_access (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
    plan TEXT NOT NULL DEFAULT 'custom' CHECK (plan IN ('basic', 'pro', 'business', 'custom')),
    activated_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    checks_limit INTEGER CHECK (checks_limit IS NULL OR checks_limit >= 0),
    brands_limit INTEGER CHECK (brands_limit IS NULL OR brands_limit >= 0),
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    checks_used INTEGER NOT NULL DEFAULT 0 CHECK (checks_used >= 0),
    quota_cycle BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO user_access(
    user_id, status, plan, activated_at, expires_at,
    checks_limit, brands_limit, period_start, period_end, checks_used
)
SELECT id, 'active', 'custom', NOW(), NULL, NULL, NULL, NOW(), NOW() + INTERVAL '1 month', 0
FROM users
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE brands
ADD COLUMN IF NOT EXISTS identity_changed_at TIMESTAMPTZ;

UPDATE brands
SET identity_changed_at = COALESCE(identity_changed_at, created_at, NOW())
WHERE identity_changed_at IS NULL;

ALTER TABLE brands
ALTER COLUMN identity_changed_at SET DEFAULT NOW();

ALTER TABLE brands
ALTER COLUMN identity_changed_at SET NOT NULL;

ALTER TABLE checks
ADD COLUMN IF NOT EXISTS quota_state TEXT NOT NULL DEFAULT 'unmetered';

ALTER TABLE checks
ADD COLUMN IF NOT EXISTS quota_cycle BIGINT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'checks_quota_state_check' AND conrelid = 'checks'::regclass
    ) THEN
        ALTER TABLE checks
        ADD CONSTRAINT checks_quota_state_check
        CHECK (quota_state IN ('unmetered', 'reserved', 'consumed', 'refunded'));
    END IF;
END
$$;

INSERT INTO brands(user_id, canonical_id, canonical_name, identity_changed_at)
SELECT users.id, md5(users.id::text || ':' || users.brand), users.brand, NOW()
FROM users
WHERE BTRIM(users.brand) <> ''
  AND NOT EXISTS (SELECT 1 FROM brands WHERE brands.user_id = users.id)
ON CONFLICT (user_id, canonical_id) DO NOTHING;
