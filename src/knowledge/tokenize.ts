/**
 * Simple tokenizer for RAG indexing.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'of', 'to', 'in', 'on', 'for', 'with', 'as', 'by', 'at', 'from', 'into',
  'that', 'this', 'these', 'those', 'it', 'its', 'they', 'them', 'we', 'you',
  'your', 'our', 'i', 'me', 'my', 'mine', 'their', 'theirs',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}
