-- Closed spans persist directly without provider HTTP log wrappers or capability URLs.
CREATE TABLE billing_trace_spans (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  service TEXT NOT NULL CHECK(service='billing'),
  operation TEXT NOT NULL CHECK(operation IN ('billing_session_create','billing_session_status','billing_authorize','billing_usage_record','billing_status')),
  phase TEXT NOT NULL CHECK(phase='request_exit'),
  trace_id TEXT NOT NULL CHECK(length(trace_id)=32 AND trace_id NOT GLOB '*[^0-9a-f]*'),
  span_id TEXT NOT NULL CHECK(length(span_id)=16 AND span_id NOT GLOB '*[^0-9a-f]*'),
  parent_span_id TEXT CHECK(parent_span_id IS NULL OR (length(parent_span_id)=16 AND parent_span_id NOT GLOB '*[^0-9a-f]*')),
  occurred_at_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),
  outcome TEXT NOT NULL CHECK(outcome IN ('success','client_error','server_error')),
  http_status INTEGER NOT NULL CHECK(http_status BETWEEN 100 AND 599),
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX billing_trace_lookup ON billing_trace_spans(trace_id,occurred_at_ms);
CREATE INDEX billing_trace_expiry ON billing_trace_spans(expires_at_ms);
