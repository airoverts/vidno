CREATE TABLE ai_request_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    check_id BIGINT REFERENCES checks(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    operation TEXT NOT NULL,
    stage TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    started_at TIMESTAMPTZ NOT NULL,
    duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0),
    status TEXT NOT NULL,
    http_status INTEGER,
    requested_model TEXT,
    returned_model TEXT,
    input_tokens BIGINT CHECK (input_tokens >= 0),
    output_tokens BIGINT CHECK (output_tokens >= 0),
    total_tokens BIGINT CHECK (total_tokens >= 0),
    cached_tokens BIGINT CHECK (cached_tokens >= 0),
    reasoning_tokens BIGINT CHECK (reasoning_tokens >= 0),
    error_category TEXT
);
CREATE INDEX idx_ai_logs_started ON ai_request_logs(started_at DESC, id DESC);
CREATE INDEX idx_ai_logs_user_started ON ai_request_logs(user_id, started_at DESC);
CREATE INDEX idx_ai_logs_request ON ai_request_logs(request_id);
CREATE INDEX idx_ai_logs_check ON ai_request_logs(check_id);
