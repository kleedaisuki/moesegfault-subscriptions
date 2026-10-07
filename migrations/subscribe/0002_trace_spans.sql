-- Only closed, typed telemetry is retained. No request URL, headers or body can be stored.
CREATE TABLE subscribe_trace_spans (
 schema_version INTEGER NOT NULL CHECK(schema_version=1),
 event_id TEXT PRIMARY KEY,
 service TEXT NOT NULL CHECK(service='subscribe'),
 operation TEXT NOT NULL CHECK(operation IN ('amail.authorization.approve','amail.authorization.cancel','amail.authorization.get','amail.authorization.page','auth.login','auth.callback','billing.activate','billing.account','session.get','session.logout','subscribe.other')),
 phase TEXT NOT NULL CHECK(phase IN ('request_exit','dependency_exit')),
 trace_id TEXT NOT NULL CHECK(length(trace_id)=32 AND trace_id NOT GLOB '*[^0-9a-f]*' AND trace_id!='00000000000000000000000000000000'),
 span_id TEXT NOT NULL CHECK(length(span_id)=16 AND span_id NOT GLOB '*[^0-9a-f]*' AND span_id!='0000000000000000'),
 parent_span_id TEXT CHECK(parent_span_id IS NULL OR (length(parent_span_id)=16 AND parent_span_id NOT GLOB '*[^0-9a-f]*' AND parent_span_id!='0000000000000000' AND parent_span_id!=span_id)),
 occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms>=0),
 duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),
 outcome TEXT NOT NULL CHECK(outcome IN ('success','client_error','server_error')),
 http_status INTEGER NOT NULL CHECK(http_status BETWEEN 100 AND 599),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms=occurred_at_ms+604800000),
 CHECK((http_status<400 AND outcome='success') OR (http_status BETWEEN 400 AND 499 AND outcome='client_error') OR (http_status>=500 AND outcome='server_error'))
);
-- Reads enforce retention even before bounded opportunistic cleanup removes expired records.
CREATE INDEX subscribe_trace_lookup ON subscribe_trace_spans(trace_id,occurred_at_ms,event_id);
CREATE INDEX subscribe_trace_expiry ON subscribe_trace_spans(expires_at_ms);

-- Server-only handoff ancestry stores capability hashes, never raw authorization handles.
CREATE TABLE subscribe_authorization_traces (
 authorization_hash TEXT PRIMARY KEY,
 traceparent TEXT NOT NULL CHECK(length(traceparent)=55),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>=0)
);
CREATE INDEX subscribe_authorization_trace_expiry ON subscribe_authorization_traces(expires_at_ms);
