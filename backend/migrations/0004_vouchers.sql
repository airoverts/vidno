ALTER TABLE user_access ADD COLUMN first_activated_at TIMESTAMPTZ;
ALTER TABLE user_access ADD COLUMN voucher_redeemed_at TIMESTAMPTZ;

UPDATE user_access
SET first_activated_at = COALESCE(activated_at, created_at)
WHERE activated_at IS NOT NULL OR status = 'active';

CREATE TABLE tariff_settings (
    plan TEXT PRIMARY KEY CHECK (plan IN ('basic', 'pro', 'business')),
    checks_limit INTEGER NOT NULL CHECK (checks_limit >= 0),
    brands_limit INTEGER NOT NULL CHECK (brands_limit >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO tariff_settings(plan, checks_limit, brands_limit)
VALUES ('basic', 3, 1), ('pro', 30, 3), ('business', 100, 10);

CREATE TABLE voucher_batches (
    id BIGSERIAL PRIMARY KEY,
    plan TEXT NOT NULL REFERENCES tariff_settings(plan),
    checks_limit INTEGER NOT NULL CHECK (checks_limit >= 0),
    brands_limit INTEGER NOT NULL CHECK (brands_limit >= 0),
    duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 365),
    quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vouchers (
    id BIGSERIAL PRIMARY KEY,
    batch_id BIGINT NOT NULL REFERENCES voucher_batches(id),
    code_hash TEXT NOT NULL UNIQUE,
    code_mask TEXT NOT NULL,
    redeemed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    redeemed_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    CHECK (redeemed_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX idx_vouchers_recipient ON vouchers(redeemed_by) WHERE redeemed_by IS NOT NULL;
CREATE INDEX idx_vouchers_batch ON vouchers(batch_id);
