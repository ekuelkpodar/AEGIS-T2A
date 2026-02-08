/**
 * AEGIS-T2A Database
 *
 * SQLite-based persistence with migration support.
 */

import Database from 'better-sqlite3';
import { getConfig } from './config.js';
import { componentLogger } from './logger.js';
import path from 'path';
import fs from 'fs';

const logger = componentLogger('database');

// =============================================================================
// Database Instance
// =============================================================================

let db: Database.Database | null = null;

/**
 * Get the database instance (singleton)
 */
export function getDatabase(): Database.Database {
  if (!db) {
    const config = getConfig();
    const dbPath = config.databasePath;

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');

    logger.info({ path: dbPath }, 'Database initialized');
  }
  return db;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}

// =============================================================================
// Migration System
// =============================================================================

const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      -- Intents table
      CREATE TABLE IF NOT EXISTS intents (
        intent_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        nl_text TEXT NOT NULL,
        typed_intent TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        budget TEXT NOT NULL,
        policy_status TEXT NOT NULL DEFAULT 'pending',
        confidence REAL NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_intents_user_id ON intents(user_id);
      CREATE INDEX IF NOT EXISTS idx_intents_created_at ON intents(created_at);

      -- Plans table
      CREATE TABLE IF NOT EXISTS plans (
        plan_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        steps TEXT NOT NULL,
        total_estimated_cost REAL NOT NULL,
        total_estimated_duration INTEGER NOT NULL,
        risk_level TEXT NOT NULL,
        approval_required INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        signature TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (intent_id) REFERENCES intents(intent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_plans_intent_id ON plans(intent_id);

      -- Workflows table
      CREATE TABLE IF NOT EXISTS workflows (
        workflow_id TEXT PRIMARY KEY,
        intent_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        plan_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        current_step_id TEXT,
        completed_steps TEXT NOT NULL DEFAULT '[]',
        failed_steps TEXT NOT NULL DEFAULT '[]',
        compensation_stack TEXT NOT NULL DEFAULT '[]',
        checkpoint_data TEXT,
        error TEXT,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (intent_id) REFERENCES intents(intent_id),
        FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
      );
      CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
      CREATE INDEX IF NOT EXISTS idx_workflows_intent_id ON workflows(intent_id);

      -- Step executions table
      CREATE TABLE IF NOT EXISTS step_executions (
        execution_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL,
        inputs TEXT NOT NULL,
        outputs TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        cost_incurred REAL DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
      );
      CREATE INDEX IF NOT EXISTS idx_step_executions_workflow_id ON step_executions(workflow_id);

      -- Approvals table
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        step_id TEXT,
        risk_level TEXT NOT NULL,
        approver_id TEXT NOT NULL,
        approver_identity TEXT NOT NULL,
        decision TEXT NOT NULL,
        rationale TEXT,
        modifications TEXT,
        signature TEXT NOT NULL,
        previous_approval_hash TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_workflow_id ON approvals(workflow_id);

      -- Audit events table (append-only)
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        intent_id TEXT,
        plan_id TEXT,
        plan_version INTEGER,
        step_id TEXT,
        workflow_id TEXT,
        actor_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        action TEXT NOT NULL,
        target_resource TEXT,
        inputs_hash TEXT NOT NULL,
        outputs_hash TEXT,
        success INTEGER NOT NULL,
        error_code TEXT,
        error_message TEXT,
        risk_level TEXT,
        cost_incurred REAL,
        duration_ms INTEGER,
        signature TEXT NOT NULL,
        previous_event_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp ON audit_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_events_intent_id ON audit_events(intent_id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_workflow_id ON audit_events(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_event_type ON audit_events(event_type);

      -- Tool adapters registry
      CREATE TABLE IF NOT EXISTS tool_adapters (
        adapter_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        description TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        output_schema TEXT NOT NULL,
        side_effects INTEGER NOT NULL,
        compensation_supported INTEGER NOT NULL,
        risk_level TEXT NOT NULL,
        timeout INTEGER NOT NULL,
        rate_limits TEXT,
        sbom_hash TEXT,
        signature TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_adapters_name ON tool_adapters(name);

      -- Ephemeral credentials
      CREATE TABLE IF NOT EXISTS ephemeral_credentials (
        credential_id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        nonce TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
      );
      CREATE INDEX IF NOT EXISTS idx_ephemeral_credentials_workflow_id ON ephemeral_credentials(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_ephemeral_credentials_expires_at ON ephemeral_credentials(expires_at);

      -- Policy rules
      CREATE TABLE IF NOT EXISTS policy_rules (
        rule_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        condition TEXT NOT NULL,
        action TEXT NOT NULL,
        risk_level TEXT,
        priority INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_policy_rules_enabled ON policy_rules(enabled);

      -- Simulations
      CREATE TABLE IF NOT EXISTS simulations (
        simulation_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        blast_radius TEXT NOT NULL,
        risk_score REAL NOT NULL,
        estimated_cost REAL NOT NULL,
        anomalies TEXT NOT NULL,
        step_results TEXT NOT NULL,
        human_review_required INTEGER NOT NULL,
        recommendations TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
      );
      CREATE INDEX IF NOT EXISTS idx_simulations_plan_id ON simulations(plan_id);

      -- Idempotency keys
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        result TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at ON idempotency_keys(expires_at);

      -- Schema version tracking
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'audit_spiffe_fields',
    sql: `
      ALTER TABLE audit_events ADD COLUMN actor_spiffe_id TEXT;
      ALTER TABLE audit_events ADD COLUMN parent_spiffe_id TEXT;
      ALTER TABLE audit_events ADD COLUMN svid_serial_number TEXT;
      CREATE INDEX IF NOT EXISTS idx_audit_events_actor_spiffe_id ON audit_events(actor_spiffe_id);
    `,
  },
  {
    version: 3,
    name: 'workflow_payloads',
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_payloads (
        payload_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        intent_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_payloads_plan_id ON workflow_payloads(plan_id);
      CREATE INDEX IF NOT EXISTS idx_workflow_payloads_expires_at ON workflow_payloads(expires_at);
    `,
  },
];

/**
 * Run database migrations
 */
export function runMigrations(): void {
  const database = getDatabase();

  // Create schema_version table if not exists
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  // Get current version
  const currentVersion = database
    .prepare('SELECT MAX(version) as version FROM schema_version')
    .get() as { version: number | null } | undefined;

  const startVersion = currentVersion?.version ?? 0;

  // Apply pending migrations
  for (const migration of MIGRATIONS) {
    if (migration.version > startVersion) {
      logger.info({ version: migration.version, name: migration.name }, 'Applying migration');

      database.transaction(() => {
        database.exec(migration.sql);
        database
          .prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
      })();

      logger.info({ version: migration.version, name: migration.name }, 'Migration applied');
    }
  }
}

// =============================================================================
// Query Helpers
// =============================================================================

/**
 * Execute a query and return all results
 */
export function queryAll<T>(sql: string, params: unknown[] = []): T[] {
  return getDatabase().prepare(sql).all(...params) as T[];
}

/**
 * Execute a query and return the first result
 */
export function queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
  return getDatabase().prepare(sql).get(...params) as T | undefined;
}

/**
 * Execute an insert/update/delete statement
 */
export function execute(sql: string, params: unknown[] = []): Database.RunResult {
  return getDatabase().prepare(sql).run(...params);
}

/**
 * Execute multiple statements in a transaction
 */
export function transaction<T>(fn: () => T): T {
  return getDatabase().transaction(fn)();
}

export default getDatabase;
