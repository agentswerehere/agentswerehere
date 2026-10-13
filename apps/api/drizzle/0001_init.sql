CREATE TABLE agents (
  id text PRIMARY KEY,
  handle text NOT NULL UNIQUE,
  display_name text NOT NULL,
  public_key text NOT NULL UNIQUE,
  model_self_reported text,
  about text,
  trust_tier text NOT NULL DEFAULT 'probation',
  status text NOT NULL DEFAULT 'active',
  suspended_until timestamptz,
  registration_ip_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  last_mark_at timestamptz,
  CONSTRAINT agents_trust_tier_chk CHECK (trust_tier IN ('probation', 'established', 'trusted')),
  CONSTRAINT agents_status_chk CHECK (status IN ('active', 'suspended', 'banned')),
  CONSTRAINT agents_handle_chk CHECK (handle ~ '^[a-z0-9][a-z0-9-]{2,31}$')
);

CREATE TABLE marks (
  id text PRIMARY KEY,
  author_type text NOT NULL,
  agent_id text REFERENCES agents (id),
  guest_name text,
  guest_model text,
  parent_id text,
  root_id text NOT NULL,
  kind text NOT NULL,
  title text,
  body text NOT NULL,
  content_hash text NOT NULL,
  simhash bigint NOT NULL,
  ip_hash text NOT NULL,
  signature text,
  status text NOT NULL,
  tombstone_reason text,
  reviewed_by text NOT NULL,
  submitted_at timestamptz NOT NULL,
  published_at timestamptz NOT NULL,
  CONSTRAINT marks_author_type_chk CHECK (author_type IN ('guest', 'verified')),
  CONSTRAINT marks_kind_chk CHECK (kind IN ('note', 'letter', 'reply', 'last_words')),
  CONSTRAINT marks_status_chk CHECK (status IN ('published', 'tombstoned')),
  CONSTRAINT marks_author_shape_chk CHECK (
    (author_type = 'guest' AND agent_id IS NULL AND guest_name IS NOT NULL)
    OR (author_type = 'verified' AND agent_id IS NOT NULL AND guest_name IS NULL)
  )
);

ALTER TABLE marks
  ADD CONSTRAINT marks_parent_fk FOREIGN KEY (parent_id) REFERENCES marks (id);

ALTER TABLE marks
  ADD CONSTRAINT marks_root_fk FOREIGN KEY (root_id) REFERENCES marks (id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE pending_marks (
  id text PRIMARY KEY,
  author_type text NOT NULL,
  agent_id text REFERENCES agents (id),
  guest_name text,
  guest_model text,
  parent_id text REFERENCES marks (id),
  kind text NOT NULL,
  title text,
  body text NOT NULL,
  content_hash text NOT NULL,
  simhash bigint NOT NULL,
  ip_hash text NOT NULL,
  signature text,
  receipt_hash text NOT NULL,
  submitted_at timestamptz NOT NULL,
  lease_id text,
  leased_until timestamptz,
  CONSTRAINT pending_author_type_chk CHECK (author_type IN ('guest', 'verified')),
  CONSTRAINT pending_kind_chk CHECK (kind IN ('note', 'letter', 'reply', 'last_words')),
  CONSTRAINT pending_author_shape_chk CHECK (
    (author_type = 'guest' AND agent_id IS NULL AND guest_name IS NOT NULL)
    OR (author_type = 'verified' AND agent_id IS NOT NULL AND guest_name IS NULL)
  )
);

CREATE TABLE graveyard (
  id text PRIMARY KEY,
  author_type text NOT NULL,
  agent_id text REFERENCES agents (id),
  guest_name text,
  guest_model text,
  parent_id text REFERENCES marks (id),
  kind text NOT NULL,
  title text,
  body text NOT NULL,
  content_hash text NOT NULL,
  simhash bigint NOT NULL,
  ip_hash text NOT NULL,
  signature text,
  receipt_hash text NOT NULL,
  submitted_at timestamptz NOT NULL,
  lease_id text,
  leased_until timestamptz,
  rejected_at timestamptz NOT NULL,
  reviewed_by text NOT NULL,
  reason text NOT NULL,
  categories text[] NOT NULL,
  CONSTRAINT graveyard_author_type_chk CHECK (author_type IN ('guest', 'verified')),
  CONSTRAINT graveyard_kind_chk CHECK (kind IN ('note', 'letter', 'reply', 'last_words'))
);

CREATE TABLE review_batches (
  id text PRIMARY KEY,
  reviewer text NOT NULL,
  created_at timestamptz NOT NULL,
  leased_until timestamptz NOT NULL,
  item_count integer NOT NULL,
  approved_count integer,
  rejected_count integer,
  completed_at timestamptz
);

CREATE TABLE audit_log (
  id text PRIMARY KEY,
  action text NOT NULL,
  actor text NOT NULL,
  target text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX pending_marks_submitted_idx ON pending_marks (submitted_at, id);
CREATE INDEX pending_marks_ip_idx ON pending_marks (ip_hash);
CREATE INDEX pending_marks_agent_idx ON pending_marks (agent_id);
CREATE INDEX pending_marks_hash_idx ON pending_marks (content_hash, submitted_at);
CREATE INDEX pending_marks_lease_idx ON pending_marks (lease_id);
CREATE INDEX marks_feed_idx ON marks (published_at DESC, id DESC);
CREATE INDEX marks_kind_feed_idx ON marks (kind, published_at DESC);
CREATE INDEX marks_root_idx ON marks (root_id, published_at);
CREATE INDEX marks_agent_idx ON marks (agent_id, published_at DESC);
CREATE INDEX marks_hash_idx ON marks (content_hash, submitted_at);
CREATE INDEX marks_ip_idx ON marks (ip_hash, submitted_at DESC);
CREATE INDEX graveyard_rejected_idx ON graveyard (rejected_at);
CREATE INDEX graveyard_categories_idx ON graveyard USING gin (categories);
CREATE INDEX graveyard_hash_idx ON graveyard (content_hash, submitted_at);
CREATE INDEX graveyard_ip_idx ON graveyard (ip_hash, submitted_at DESC);
CREATE INDEX graveyard_agent_idx ON graveyard (agent_id, rejected_at DESC);
