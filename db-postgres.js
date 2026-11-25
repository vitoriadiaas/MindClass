// Banco PostgreSQL (Supabase). O esquema é criado por supabase/schema.sql.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

// devolve os mesmos formatos que o restante do sistema espera
const { types } = pg;
types.setTypeParser(20, Number);                                          // bigint
types.setTypeParser(1700, Number);                                        // numeric
types.setTypeParser(1184, (v) => new Date(v).toISOString());              // timestamptz
types.setTypeParser(1082, (v) => v);                                      // date  -> AAAA-MM-DD
types.setTypeParser(1083, (v) => v.slice(0, 5));                          // time  -> HH:MM
types.setTypeParser(1114, (v) => v.slice(0, 16).replace(' ', 'T'));       // timestamp -> AAAA-MM-DDTHH:MM

let url;
try { url = new URL(process.env.DATABASE_URL); } catch {
  console.error('\nDATABASE_URL inválida no arquivo .env. Se a senha tiver caracteres como @ # / ?, codifique-os (ex.: @ vira %40).\n');
  process.exit(1);
}
if (/YOUR[-_]|SUA-SENHA/i.test(decodeURIComponent(url.password))) {
  console.error('\nTroque o texto de exemplo no arquivo .env pela senha real do banco.\n');
  process.exit(1);
}
url.searchParams.delete('sslmode');
const local = ['localhost', '127.0.0.1'].includes(url.hostname);
const ca = process.env.DATABASE_CA;
if (!local && !ca) console.warn('[banco] conexão criptografada SEM verificar o certificado. Para verificar, baixe o certificado no painel do Supabase e defina DATABASE_CA no .env.');

const pool = new pg.Pool({
  connectionString: url.toString(),
  ssl: local ? false : ca ? { ca: readFileSync(ca, 'utf8') } : { rejectUnauthorized: false },
  max: 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000,
});
pool.on('error', (e) => console.error('[banco] conexão perdida:', e.message));

try { await pool.query('select id from public.usuarios limit 1'); } catch (e) {
  const dica = e.code === '42P01' ? 'As tabelas não existem. Rode supabase/schema.sql no SQL Editor do Supabase.'
    : e.code === '28P01' ? 'Senha ou usuário incorretos no .env.'
      : ['ENOTFOUND', 'ENETUNREACH', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(e.code) || /timeout/i.test(e.message)
        ? 'Não foi possível alcançar o servidor. Use a string "Session pooler" do botão Connect (o endereço direto só funciona com IPv6).'
        : 'Confira a DATABASE_URL no .env.';
  console.error(`\nFalha ao conectar no PostgreSQL (${e.code || 'erro'}): ${e.message}\n${dica}\n`);
  process.exit(1);
}

const convertidos = new Map();
const converter = (sql) => {
  let s = convertidos.get(sql);
  if (!s) { let i = 0; s = sql.replace(/\?/g, () => `$${++i}`); if (convertidos.size > 400) convertidos.clear(); convertidos.set(sql, s); }
  return s;
};
const transacao = new AsyncLocalStorage();
const consultar = (sql, p) => (transacao.getStore() ?? pool).query(converter(sql), p.map((v) => (v === undefined ? null : v)));

export default {
  tipo: 'postgres',
  async get(sql, ...p) { return (await consultar(sql, p)).rows[0]; },
  async all(sql, ...p) { return (await consultar(sql, p)).rows; },
  async run(sql, ...p) { return { changes: (await consultar(sql, p)).rowCount }; },
  async tx(fn) {
    if (transacao.getStore()) return fn();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await transacao.run(c, fn);
      await c.query('COMMIT');
      return r;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  },
  fechar: () => pool.end(),
};
