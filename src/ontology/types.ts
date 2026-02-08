/**
 * Ontology Types
 */

export interface OntologyClass {
  classId: string;
  label: string;
  description?: string;
  parentClassId?: string;
  metadata?: Record<string, unknown>;
}

export interface OntologyProperty {
  propertyId: string;
  label: string;
  description?: string;
  domainClassId?: string;
  rangeClassId?: string;
  metadata?: Record<string, unknown>;
}

export interface OntologyInstance {
  instanceId: string;
  classId: string;
  label?: string;
  properties: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface OntologyEdge {
  edgeId: string;
  fromInstanceId: string;
  toInstanceId: string;
  predicate: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface OntologyConsistencyIssue {
  severity: 'warning' | 'error';
  message: string;
  instanceId?: string;
  classId?: string;
  propertyId?: string;
}
