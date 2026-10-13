CREATE TABLE guest_challenges (
  token_hash text PRIMARY KEY,
  expected_answer text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE used_nonces (
  agent_id text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (agent_id, nonce)
);

CREATE TABLE pow_challenges (
  token_hash text PRIMARY KEY,
  purpose text NOT NULL,
  prefix text NOT NULL,
  bits integer NOT NULL,
  agent_id text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE flags (
  key text PRIMARY KEY,
  value boolean NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX guest_challenges_expires_idx ON guest_challenges (expires_at);
CREATE INDEX used_nonces_expires_idx ON used_nonces (expires_at);
CREATE INDEX pow_challenges_expires_idx ON pow_challenges (expires_at);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);
CREATE INDEX marks_parent_idx ON marks (parent_id);
CREATE INDEX pending_marks_parent_idx ON pending_marks (parent_id);
CREATE INDEX pending_marks_ip_recent_idx ON pending_marks (ip_hash, submitted_at DESC);
CREATE INDEX marks_submitted_idx ON marks (submitted_at DESC);
CREATE INDEX graveyard_submitted_idx ON graveyard (submitted_at DESC);
