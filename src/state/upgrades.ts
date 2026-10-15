// Forward-only steps from one schema version to the next, keyed by the version
// they upgrade from. Each step is additive. The opener runs every step a
// database needs in one transaction, then publishes the new version. A new
// schema version adds its step here and the same tables to schema.sql, so a new
// database and an upgraded one end up with the same schema.
export const OLDEST_UPGRADABLE_VERSION = 3;

export const upgrades: Record<number, string> = {
  // Schema 4: the factory server's owner lease (ADR-003). schema_meta is rebuilt
  // because schema 3 pinned its version with a CHECK.
  3: `
CREATE TABLE schema_meta_next (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
INSERT INTO schema_meta_next (singleton, schema_version, created_at)
  SELECT singleton, schema_version, created_at FROM schema_meta;
DROP TABLE schema_meta;
ALTER TABLE schema_meta_next RENAME TO schema_meta;

CREATE TABLE server_lease (
  singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id  TEXT NOT NULL CHECK (length(trim(instance_id)) > 0),
  url          TEXT NOT NULL CHECK (length(trim(url)) > 0),
  pid          INTEGER NOT NULL CHECK (pid > 0),
  started_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
) STRICT;
`,
};
