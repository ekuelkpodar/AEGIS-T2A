# Week 1: SPIFFE/SPIRE Identity Implementation

## Overview

Implement zero-trust identity for all AEGIS-T2A agents using SPIFFE/SPIRE. This is the foundational layer for all security controls.

**Goal**: Every agent instance gets a unique, cryptographically verifiable identity with automatic credential rotation.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      SPIRE Server                           │
│  ┌────────────────────────────────────────────────────┐    │
│  │  Trust Domain: spiffe://aegis.io                   │    │
│  │  ┌──────────────────────────────────────────────┐  │    │
│  │  │  Node Attestation (K8s, AWS, etc.)          │  │    │
│  │  └──────────────────────────────────────────────┘  │    │
│  │  ┌──────────────────────────────────────────────┐  │    │
│  │  │  Workload Attestation (namespace, SA, etc.) │  │    │
│  │  └──────────────────────────────────────────────┘  │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                          │
                          │ SVIDs (X.509 certs)
                          ▼
        ┌─────────────────────────────────────┐
        │       SPIRE Agent (sidecar)         │
        │  ┌───────────────────────────────┐  │
        │  │  spiffe://aegis.io/           │  │
        │  │    control-plane/planner/     │  │
        │  │    p-7f3a                     │  │
        │  └───────────────────────────────┘  │
        └─────────────────────────────────────┘
                          │
                          │ Workload API
                          ▼
        ┌─────────────────────────────────────┐
        │     AEGIS-T2A Agent Process         │
        │  - Fetches SVID on startup          │
        │  - Auto-rotates before expiry       │
        │  - Uses for mTLS connections        │
        └─────────────────────────────────────┘
```

---

## Implementation Steps

### Step 1: SPIRE Server Deployment (Improvement #1)

**File**: `controlplane/spire/server-deployment.yaml`

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: aegis-spire
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: spire-server
  namespace: aegis-spire
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: spire-server-trust-role
rules:
- apiGroups: [""]
  resources: ["pods", "nodes", "serviceaccounts"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["authentication.k8s.io"]
  resources: ["tokenreviews"]
  verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: spire-server-trust-role-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: spire-server-trust-role
subjects:
- kind: ServiceAccount
  name: spire-server
  namespace: aegis-spire
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: spire-server
  namespace: aegis-spire
data:
  server.conf: |
    server {
      bind_address = "0.0.0.0"
      bind_port = "8081"
      socket_path = "/tmp/spire-server/private/api.sock"
      trust_domain = "aegis.io"
      data_dir = "/run/spire/data"
      log_level = "INFO"
      ca_ttl = "168h"  # 7 days
      default_x509_svid_ttl = "1h"  # Short-lived for control plane
    }

    plugins {
      DataStore "sql" {
        plugin_data {
          database_type = "postgres"
          connection_string = "postgresql://spire:${POSTGRES_PASSWORD}@postgres:5432/spire?sslmode=require"
        }
      }

      NodeAttestor "k8s_psat" {
        plugin_data {
          clusters = {
            "aegis-cluster" = {
              service_account_allow_list = ["aegis-spire:spire-agent"]
            }
          }
        }
      }

      KeyManager "disk" {
        plugin_data {
          keys_path = "/run/spire/data/keys.json"
        }
      }

      Notifier "k8sbundle" {
        plugin_data {
          namespace = "aegis-spire"
        }
      }
    }

    health_checks {
      listener_enabled = true
      bind_address = "0.0.0.0"
      bind_port = "8080"
      live_path = "/live"
      ready_path = "/ready"
    }
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: spire-server
  namespace: aegis-spire
  labels:
    app: spire-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: spire-server
  serviceName: spire-server
  template:
    metadata:
      labels:
        app: spire-server
    spec:
      serviceAccountName: spire-server
      containers:
      - name: spire-server
        image: ghcr.io/spiffe/spire-server:1.10.0
        args:
          - -config
          - /run/spire/config/server.conf
        ports:
        - containerPort: 8081
          name: grpc
        volumeMounts:
        - name: spire-config
          mountPath: /run/spire/config
          readOnly: true
        - name: spire-data
          mountPath: /run/spire/data
        livenessProbe:
          httpGet:
            path: /live
            port: 8080
          initialDelaySeconds: 15
          periodSeconds: 60
        readinessProbe:
          httpGet:
            path: /ready
            port: 8080
          initialDelaySeconds: 5
          periodSeconds: 5
      volumes:
      - name: spire-config
        configMap:
          name: spire-server
  volumeClaimTemplates:
  - metadata:
      name: spire-data
    spec:
      accessModes:
        - ReadWriteOnce
      resources:
        requests:
          storage: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: spire-server
  namespace: aegis-spire
spec:
  type: ClusterIP
  ports:
    - name: grpc
      port: 8081
      targetPort: 8081
      protocol: TCP
  selector:
    app: spire-server
```

### Step 2: Workload Attestation (Improvement #2)

**File**: `controlplane/spire/registration-entries.sh`

```bash
#!/bin/bash
set -e

# Wait for SPIRE server to be ready
kubectl wait --for=condition=ready pod -l app=spire-server -n aegis-spire --timeout=300s

# Create registration entries for each agent role

# 1. Planner agents
kubectl exec -n aegis-spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://aegis.io/control-plane/planner \
  -parentID spiffe://aegis.io/spire/agent/k8s_psat/aegis-cluster \
  -selector k8s:ns:aegis-controlplane \
  -selector k8s:sa:planner \
  -selector k8s:container-image:ghcr.io/aegis-t2a/planner:latest \
  -ttl 3600

# 2. SME agents
kubectl exec -n aegis-spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://aegis.io/control-plane/sme \
  -parentID spiffe://aegis.io/spire/agent/k8s_psat/aegis-cluster \
  -selector k8s:ns:aegis-controlplane \
  -selector k8s:sa:sme \
  -selector k8s:container-image:ghcr.io/aegis-t2a/sme:latest \
  -ttl 3600

# 3. Executor agents (shorter TTL for higher risk)
kubectl exec -n aegis-spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://aegis.io/execution-plane/executor \
  -parentID spiffe://aegis.io/spire/agent/k8s_psat/aegis-cluster \
  -selector k8s:ns:aegis-execution \
  -selector k8s:sa:executor \
  -selector k8s:container-image:ghcr.io/aegis-t2a/executor:latest \
  -ttl 900  # 15 minutes for sandbox executors

# 4. Auditor agents
kubectl exec -n aegis-spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://aegis.io/control-plane/auditor \
  -parentID spiffe://aegis.io/spire/agent/k8s_psat/aegis-cluster \
  -selector k8s:ns:aegis-controlplane \
  -selector k8s:sa:auditor \
  -selector k8s:container-image:ghcr.io/aegis-t2a/auditor:latest \
  -ttl 3600

# 5. Facilitator agents
kubectl exec -n aegis-spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
  -spiffeID spiffe://aegis.io/control-plane/facilitator \
  -parentID spiffe://aegis.io/spire/agent/k8s_psat/aegis-cluster \
  -selector k8s:ns:aegis-controlplane \
  -selector k8s:sa:facilitator \
  -selector k8s:container-image:ghcr.io/aegis-t2a/facilitator:latest \
  -ttl 3600

echo "✓ All SPIRE registration entries created successfully"
```

### Step 3: SPIFFE ID Registry (Improvement #11)

**File**: `src/identity/spiffe-registry.ts`

```typescript
/**
 * SPIFFE Identity Registry
 *
 * Central registry linking agent instances to SPIFFE IDs, capabilities, and trust levels.
 * Enables rapid identity lookup and audit trail construction.
 */

import { Pool } from 'pg';
import { logger } from '../core/logger.js';

export interface SPIFFEIdentity {
  id: string;
  spiffeId: string;
  agentRole: 'sme' | 'planner' | 'executor' | 'auditor' | 'facilitator';
  agentInstanceId: string;
  trustLevel: 'intern' | 'junior' | 'senior' | 'principal';
  capabilities: string[];
  svidSerialNumber: string;
  svidExpiresAt: Date;
  createdAt: Date;
  lastRotatedAt: Date;
  status: 'active' | 'suspended' | 'revoked';
}

export interface CapabilitySet {
  role: string;
  trustLevel: string;
  capabilities: string[];
}

export class SPIFFERegistry {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Initialize the SPIFFE registry schema
   */
  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS spiffe_identities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        spiffe_id TEXT NOT NULL UNIQUE,
        agent_role TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        trust_level TEXT NOT NULL,
        capabilities TEXT[] NOT NULL,
        svid_serial_number TEXT NOT NULL,
        svid_expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'active',
        metadata JSONB,

        CONSTRAINT valid_role CHECK (agent_role IN ('sme', 'planner', 'executor', 'auditor', 'facilitator')),
        CONSTRAINT valid_trust_level CHECK (trust_level IN ('intern', 'junior', 'senior', 'principal')),
        CONSTRAINT valid_status CHECK (status IN ('active', 'suspended', 'revoked'))
      );

      CREATE INDEX IF NOT EXISTS idx_spiffe_id ON spiffe_identities(spiffe_id);
      CREATE INDEX IF NOT EXISTS idx_agent_instance_id ON spiffe_identities(agent_instance_id);
      CREATE INDEX IF NOT EXISTS idx_status ON spiffe_identities(status);
      CREATE INDEX IF NOT EXISTS idx_expires_at ON spiffe_identities(svid_expires_at);
    `);

    logger.info('[SPIFFERegistry] Schema initialized');
  }

  /**
   * Register a new SPIFFE identity
   */
  async registerIdentity(identity: Omit<SPIFFEIdentity, 'id' | 'createdAt' | 'lastRotatedAt'>): Promise<SPIFFEIdentity> {
    const result = await this.pool.query<SPIFFEIdentity>(`
      INSERT INTO spiffe_identities (
        spiffe_id, agent_role, agent_instance_id, trust_level,
        capabilities, svid_serial_number, svid_expires_at, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [
      identity.spiffeId,
      identity.agentRole,
      identity.agentInstanceId,
      identity.trustLevel,
      identity.capabilities,
      identity.svidSerialNumber,
      identity.svidExpiresAt,
      identity.status,
    ]);

    logger.info('[SPIFFERegistry] Registered identity', { spiffeId: identity.spiffeId });
    return result.rows[0];
  }

  /**
   * Look up identity by SPIFFE ID
   */
  async getIdentity(spiffeId: string): Promise<SPIFFEIdentity | null> {
    const result = await this.pool.query<SPIFFEIdentity>(
      'SELECT * FROM spiffe_identities WHERE spiffe_id = $1',
      [spiffeId]
    );

    return result.rows[0] || null;
  }

  /**
   * Record SVID rotation
   */
  async recordRotation(spiffeId: string, newSerialNumber: string, expiresAt: Date): Promise<void> {
    await this.pool.query(`
      UPDATE spiffe_identities
      SET svid_serial_number = $2,
          svid_expires_at = $3,
          last_rotated_at = NOW()
      WHERE spiffe_id = $1
    `, [spiffeId, newSerialNumber, expiresAt]);

    logger.info('[SPIFFERegistry] Rotated SVID', { spiffeId, newSerialNumber });
  }

  /**
   * Suspend an identity (e.g., on anomaly detection)
   */
  async suspendIdentity(spiffeId: string, reason: string): Promise<void> {
    await this.pool.query(`
      UPDATE spiffe_identities
      SET status = 'suspended',
          metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{suspension_reason}',
            to_jsonb($2::text)
          )
      WHERE spiffe_id = $1
    `, [spiffeId, reason]);

    logger.warn('[SPIFFERegistry] Identity suspended', { spiffeId, reason });
  }

  /**
   * Get all identities requiring rotation (expiring within 15 minutes)
   */
  async getExpiringIdentities(): Promise<SPIFFEIdentity[]> {
    const result = await this.pool.query<SPIFFEIdentity>(`
      SELECT * FROM spiffe_identities
      WHERE status = 'active'
        AND svid_expires_at < NOW() + INTERVAL '15 minutes'
    `);

    return result.rows;
  }

  /**
   * Get capability set for a SPIFFE ID
   */
  async getCapabilities(spiffeId: string): Promise<string[]> {
    const identity = await this.getIdentity(spiffeId);
    return identity?.capabilities || [];
  }
}
```

---

## Testing

### Unit Tests

**File**: `src/identity/__tests__/spiffe-registry.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { Pool } from 'pg';
import { SPIFFERegistry } from '../spiffe-registry.js';

describe('SPIFFERegistry', () => {
  let pool: Pool;
  let registry: SPIFFERegistry;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/aegis_test',
    });
    registry = new SPIFFERegistry(pool);
    await registry.initialize();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('should register and retrieve SPIFFE identity', async () => {
    const identity = await registry.registerIdentity({
      spiffeId: 'spiffe://aegis.io/control-plane/planner/p-test-001',
      agentRole: 'planner',
      agentInstanceId: 'p-test-001',
      trustLevel: 'junior',
      capabilities: ['plan:read', 'plan:write'],
      svidSerialNumber: '1234567890abcdef',
      svidExpiresAt: new Date(Date.now() + 3600000), // 1 hour
      status: 'active',
    });

    expect(identity.spiffeId).toBe('spiffe://aegis.io/control-plane/planner/p-test-001');

    const retrieved = await registry.getIdentity(identity.spiffeId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.agentRole).toBe('planner');
  });

  it('should track expiring identities', async () => {
    await registry.registerIdentity({
      spiffeId: 'spiffe://aegis.io/control-plane/planner/p-expiring',
      agentRole: 'planner',
      agentInstanceId: 'p-expiring',
      trustLevel: 'junior',
      capabilities: ['plan:read'],
      svidSerialNumber: 'expiring123',
      svidExpiresAt: new Date(Date.now() + 600000), // 10 minutes
      status: 'active',
    });

    const expiring = await registry.getExpiringIdentities();
    expect(expiring.length).toBeGreaterThan(0);
    expect(expiring.some(i => i.spiffeId.includes('p-expiring'))).toBe(true);
  });
});
```

---

## Deployment

```bash
# 1. Deploy SPIRE server
kubectl apply -f controlplane/spire/server-deployment.yaml

# 2. Wait for SPIRE server ready
kubectl wait --for=condition=ready pod -l app=spire-server -n aegis-spire --timeout=300s

# 3. Create registration entries
chmod +x controlplane/spire/registration-entries.sh
./controlplane/spire/registration-entries.sh

# 4. Verify SPIRE server health
kubectl exec -n aegis-spire spire-server-0 -- /opt/spire/bin/spire-server healthcheck

# 5. Run database migrations for SPIFFE registry
npm run db:migrate

# 6. Run tests
npm test -- src/identity/__tests__/spiffe-registry.test.ts
```

---

## Success Criteria

- [ ] SPIRE server deployed and healthy
- [ ] All agent roles have registration entries
- [ ] SPIFFE registry schema created
- [ ] Unit tests passing
- [ ] SVIDs can be fetched from workload API
- [ ] Certificate transparency logging configured

---

## Next Steps

**Week 2**: Zero-Trust Architecture (Improvements 16-30)
- CSA Agentic Trust Framework
- Behavioral monitoring
- Policy Decision Point
- Microsegmentation
