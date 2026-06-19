// Append-only lifecycle log (JSONL). Each line is one real bundle submission with its full history.
import { appendFileSync, mkdirSync } from 'fs';
mkdirSync('logs', { recursive: true });
const FILE = process.env.LOG_FILE || 'logs/lifecycle.jsonl';
export function logEntry(e) { appendFileSync(FILE, JSON.stringify(e) + '\n'); }
export const LOG_FILE = FILE;
