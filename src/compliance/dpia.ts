/**
 * Data Protection Impact Assessment (DPIA) templates.
 */

import { execute, queryAll, queryOne } from '../core/database.js';
import { generateId } from '../core/ids.js';

export interface DpiaSection {
  title: string;
  description: string;
  questions: string[];
}

export interface DpiaTemplate {
  templateId: string;
  name: string;
  description?: string;
  sections: DpiaSection[];
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_TEMPLATE: DpiaSection[] = [
  {
    title: 'Processing Overview',
    description: 'Describe the processing activity and objectives.',
    questions: [
      'What is the purpose of the processing?',
      'Which systems and components are involved?',
      'What is the expected duration of processing?'
    ]
  },
  {
    title: 'Data Inventory',
    description: 'Document data categories and data subjects.',
    questions: [
      'What categories of data are processed?',
      'Who are the data subjects?',
      'Are special categories of data involved?'
    ]
  },
  {
    title: 'Risk Assessment',
    description: 'Identify risks to rights and freedoms.',
    questions: [
      'What are the main privacy risks?',
      'What is the likelihood and impact of each risk?',
      'Are any cross-border transfers involved?'
    ]
  },
  {
    title: 'Mitigations',
    description: 'Specify technical and organizational measures.',
    questions: [
      'Which security measures reduce the risks?',
      'What human oversight mechanisms exist?',
      'How are incidents detected and handled?'
    ]
  },
  {
    title: 'Approval & Review',
    description: 'Define approval gates and review cadence.',
    questions: [
      'Who approves the DPIA?',
      'What is the review interval?',
      'What triggers a re-assessment?'
    ]
  }
];

export function ensureDefaultTemplate(): DpiaTemplate {
  const existing = queryOne<DpiaTemplate>(
    `SELECT template_id AS templateId, name, description, sections_json AS sections, created_at AS createdAt, updated_at AS updatedAt
     FROM dpia_templates WHERE name = ?`,
    ['Standard DPIA']
  );

  if (existing) {
    return {
      ...existing,
      sections: JSON.parse((existing as unknown as { sections: string }).sections),
    } as DpiaTemplate;
  }

  const now = new Date().toISOString();
  const templateId = generateId();
  execute(
    `INSERT INTO dpia_templates
     (template_id, name, description, sections_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      templateId,
      'Standard DPIA',
      'Default DPIA template aligned with GDPR Article 35',
      JSON.stringify(DEFAULT_TEMPLATE),
      now,
      now,
    ]
  );

  return {
    templateId,
    name: 'Standard DPIA',
    description: 'Default DPIA template aligned with GDPR Article 35',
    sections: DEFAULT_TEMPLATE,
    createdAt: now,
    updatedAt: now,
  };
}

export function listDpiaTemplates(): DpiaTemplate[] {
  const rows = queryAll<{
    template_id: string;
    name: string;
    description: string | null;
    sections_json: string;
    created_at: string;
    updated_at: string;
  }>(`SELECT * FROM dpia_templates ORDER BY updated_at DESC`);

  return rows.map((row) => ({
    templateId: row.template_id,
    name: row.name,
    description: row.description ?? undefined,
    sections: JSON.parse(row.sections_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function getDpiaTemplate(templateId: string): DpiaTemplate | null {
  const row = queryOne<{
    template_id: string;
    name: string;
    description: string | null;
    sections_json: string;
    created_at: string;
    updated_at: string;
  }>(`SELECT * FROM dpia_templates WHERE template_id = ?`, [templateId]);

  if (!row) return null;
  return {
    templateId: row.template_id,
    name: row.name,
    description: row.description ?? undefined,
    sections: JSON.parse(row.sections_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
