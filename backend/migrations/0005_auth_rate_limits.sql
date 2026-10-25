CREATE TABLE auth_rate_limits (
    key_hash TEXT PRIMARY KEY CHECK (length(key_hash) = 64),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_auth_rate_limits_expiry ON auth_rate_limits(expires_at);
