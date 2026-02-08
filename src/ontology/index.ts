/**
 * Ontology System Entry
 */

export {
  upsertClass,
  upsertProperty,
  createInstance,
  linkInstances,
  listInstances,
  validateInstance,
} from './store.js';
export type {
  OntologyClass,
  OntologyProperty,
  OntologyInstance,
  OntologyEdge,
  OntologyConsistencyIssue,
} from './types.js';
