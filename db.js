// Escolhe o banco: PostgreSQL/Supabase quando há DATABASE_URL (arquivo .env); senão, SQLite local.
// DB_PATH (testes e ambiente de teste) sempre força o SQLite, para nunca mexer no banco real.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const env = join(import.meta.dirname, '.env');
if (existsSync(env)) process.loadEnvFile(env);

export const usandoPostgres = !!process.env.DATABASE_URL && !process.env.DB_PATH;
export const db = (await import(usandoPostgres ? './db-postgres.js' : './db-sqlite.js')).default;
export { SLOTS, TURMAS_OFICIAIS, MATERIAS } from './dados.js';
