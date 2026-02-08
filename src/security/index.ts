/**
 * AEGIS-T2A Security Module
 *
 * Advanced security features for LLM-based automation:
 * - Prompt injection detection and prevention
 * - LLM output safety guardrails
 * - PII/secret redaction
 * - Rate limiting and cost controls
 *
 * Implements OWASP LLM Top 10 mitigations.
 */

export * from './prompt-injection-detector.js';
export * from './llm-guardrails.js';
export * from './intent-alignment.js';
