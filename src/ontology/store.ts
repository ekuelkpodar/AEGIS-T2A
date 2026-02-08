/**
 * Ontology Store (SQLite)
 */

import { execute, queryAll, queryOne } from '../core/database.js';
import { generateId } from '../core/ids.js';
import type {
  OntologyClass,
  OntologyProperty,
  OntologyInstance,
  OntologyEdge,
  OntologyConsistencyIssue,
} from './types.js';

export function upsertClass(
  label: string,
  description?: string,
  parentClassId?: string,
  metadata?: Record<string, unknown>
): OntologyClass {
  const classId = label.toLowerCase().replace(/\s+/g, '_');
  const existing = queryOne<OntologyClass>(
    `SELECT class_id AS classId, label, description, parent_class_id AS parentClassId, metadata
     FROM ontology_classes WHERE class_id = ?`,
    [classId]
  );

  if (existing) {
    execute(
      `UPDATE ontology_classes SET description = ?, parent_class_id = ?, metadata = ?
       WHERE class_id = ?`,
      [
        description ?? existing.description ?? null,
        parentClassId ?? existing.parentClassId ?? null,
        JSON.stringify(metadata ?? existing.metadata ?? {}),
        classId,
      ]
    );
    return {
      ...existing,
      description: description ?? existing.description,
      parentClassId: parentClassId ?? existing.parentClassId,
      metadata: metadata ?? existing.metadata,
    };
  }

  execute(
    `INSERT INTO ontology_classes (class_id, label, description, parent_class_id, metadata)
     VALUES (?, ?, ?, ?, ?)`,
    [classId, label, description ?? null, parentClassId ?? null, JSON.stringify(metadata ?? {})]
  );

  return { classId, label, description, parentClassId, metadata };
}

export function upsertProperty(
  label: string,
  description?: string,
  domainClassId?: string,
  rangeClassId?: string,
  metadata?: Record<string, unknown>
): OntologyProperty {
  const propertyId = label.toLowerCase().replace(/\s+/g, '_');
  const existing = queryOne<OntologyProperty>(
    `SELECT property_id AS propertyId, label, description, domain_class_id AS domainClassId,
            range_class_id AS rangeClassId, metadata
     FROM ontology_properties WHERE property_id = ?`,
    [propertyId]
  );

  if (existing) {
    execute(
      `UPDATE ontology_properties
       SET description = ?, domain_class_id = ?, range_class_id = ?, metadata = ?
       WHERE property_id = ?`,
      [
        description ?? existing.description ?? null,
        domainClassId ?? existing.domainClassId ?? null,
        rangeClassId ?? existing.rangeClassId ?? null,
        JSON.stringify(metadata ?? existing.metadata ?? {}),
        propertyId,
      ]
    );
    return {
      ...existing,
      description: description ?? existing.description,
      domainClassId: domainClassId ?? existing.domainClassId,
      rangeClassId: rangeClassId ?? existing.rangeClassId,
      metadata: metadata ?? existing.metadata,
    };
  }

  execute(
    `INSERT INTO ontology_properties (property_id, label, description, domain_class_id, range_class_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      propertyId,
      label,
      description ?? null,
      domainClassId ?? null,
      rangeClassId ?? null,
      JSON.stringify(metadata ?? {}),
    ]
  );

  return { propertyId, label, description, domainClassId, rangeClassId, metadata };
}

export function createInstance(
  classId: string,
  properties: Record<string, unknown>,
  label?: string,
  metadata?: Record<string, unknown>
): OntologyInstance {
  const instanceId = generateId();
  const now = new Date().toISOString();
  execute(
    `INSERT INTO ontology_instances
     (instance_id, class_id, label, properties, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      instanceId,
      classId,
      label ?? null,
      JSON.stringify(properties),
      JSON.stringify(metadata ?? {}),
      now,
      now,
    ]
  );

  return {
    instanceId,
    classId,
    label,
    properties,
    metadata,
    createdAt: now,
    updatedAt: now,
  };
}

export function linkInstances(
  fromInstanceId: string,
  toInstanceId: string,
  predicate: string,
  metadata?: Record<string, unknown>
): OntologyEdge {
  const edgeId = generateId();
  const createdAt = new Date().toISOString();
  execute(
    `INSERT INTO ontology_edges
     (edge_id, from_instance_id, to_instance_id, predicate, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      edgeId,
      fromInstanceId,
      toInstanceId,
      predicate,
      JSON.stringify(metadata ?? {}),
      createdAt,
    ]
  );

  return { edgeId, fromInstanceId, toInstanceId, predicate, metadata, createdAt };
}

export function listInstances(classId: string): OntologyInstance[] {
  const rows = queryAll<{
    instance_id: string;
    class_id: string;
    label: string | null;
    properties: string;
    metadata: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT * FROM ontology_instances WHERE class_id = ? ORDER BY created_at DESC`,
    [classId]
  );

  return rows.map((row) => ({
    instanceId: row.instance_id,
    classId: row.class_id,
    label: row.label ?? undefined,
    properties: JSON.parse(row.properties),
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function validateInstance(
  classId: string,
  properties: Record<string, unknown>
): OntologyConsistencyIssue[] {
  const issues: OntologyConsistencyIssue[] = [];
  const props = queryAll<{ property_id: string; domain_class_id: string | null }>(
    `SELECT property_id, domain_class_id FROM ontology_properties`
  );

  for (const prop of props) {
    if (prop.domain_class_id && prop.domain_class_id !== classId) {
      continue;
    }
    if (!(prop.property_id in properties)) {
      issues.push({
        severity: 'warning',
        message: `Missing property ${prop.property_id} for class ${classId}`,
        classId,
        propertyId: prop.property_id,
      });
    }
  }

  return issues;
}
