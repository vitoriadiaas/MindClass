// Banco local (SQLite): usado nos testes e quando não há DATABASE_URL. Cria e migra o esquema.
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SLOTS, TURMAS_OFICIAIS, MATERIAS } from './dados.js';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, 'data');
mkdirSync(dir, { recursive: true });
const arquivo = process.env.DB_PATH || join(dir, 'organizae.db');
const db = new DatabaseSync(arquivo);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

const existe = (nome) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(nome);
const colunas = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const adicionar = (tabela, coluna, ddl) => { if (!colunas(tabela).includes(coluna)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${ddl}`); };

const USUARIOS_DDL = `(
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  senha_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK(perfil IN ('professor','aluno','administrador')),
  foto TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  ultimo_login TEXT,
  senha_alterada_em TEXT,
  criado_em TEXT NOT NULL
)`;

/* ---------- 1) banco antigo: backup + reconstrução da tabela usuarios (novo perfil e colunas) ---------- */
if (existe('usuarios') && !db.prepare("SELECT sql FROM sqlite_master WHERE name='usuarios'").get().sql.includes('administrador')) {
  if (arquivo !== ':memory:') {
    const bak = `${arquivo}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
    console.log(`[migração] cópia de segurança criada: ${bak}`);
  }
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec('BEGIN');
  try {
    db.exec(`CREATE TABLE usuarios_novo ${USUARIOS_DDL}`);
    db.exec(`INSERT INTO usuarios_novo(id,nome,email,senha_hash,salt,perfil,foto,criado_em)
             SELECT id,nome,email,senha_hash,salt,perfil,foto,criado_em FROM usuarios`);
    db.exec('DROP TABLE usuarios');
    db.exec('ALTER TABLE usuarios_novo RENAME TO usuarios');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  db.exec('PRAGMA foreign_keys=ON');
  if (db.prepare('PRAGMA foreign_key_check').all().length) console.warn('[migração] atenção: há referências órfãs após a migração.');
}

/* ---------- 2) esquema base ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS usuarios ${USUARIOS_DDL};
CREATE TABLE IF NOT EXISTS professores(
  usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  turno TEXT NOT NULL CHECK(turno IN ('manhã','tarde','noite','integral'))
);
CREATE TABLE IF NOT EXISTS alunos(
  usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  matricula TEXT
);
CREATE TABLE IF NOT EXISTS materias(
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS turmas(
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
  etapa TEXT NOT NULL DEFAULT 'outra',
  num_horarios INTEGER NOT NULL DEFAULT 9
);
CREATE TABLE IF NOT EXISTS professor_materias(
  professor_id INTEGER NOT NULL REFERENCES professores(usuario_id) ON DELETE CASCADE,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  aprovado INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(professor_id, materia_id)
);
CREATE TABLE IF NOT EXISTS professor_turmas(
  professor_id INTEGER NOT NULL REFERENCES professores(usuario_id) ON DELETE CASCADE,
  turma_id INTEGER NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
  aprovado INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(professor_id, turma_id)
);
CREATE TABLE IF NOT EXISTS aluno_turmas(
  aluno_id INTEGER NOT NULL REFERENCES alunos(usuario_id) ON DELETE CASCADE,
  turma_id INTEGER NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
  PRIMARY KEY(aluno_id, turma_id)
);
CREATE TABLE IF NOT EXISTS horarios(
  id INTEGER PRIMARY KEY,
  turma_id INTEGER NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  professor_id INTEGER NOT NULL REFERENCES professores(usuario_id) ON DELETE CASCADE,
  dia INTEGER NOT NULL CHECK(dia BETWEEN 1 AND 5),
  inicio TEXT NOT NULL,
  fim TEXT NOT NULL,
  slot INTEGER,
  CHECK(inicio < fim)
);
CREATE TABLE IF NOT EXISTS eventos(
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  turma_id INTEGER REFERENCES turmas(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  descricao TEXT,
  dia INTEGER NOT NULL CHECK(dia BETWEEN 1 AND 5),
  inicio TEXT NOT NULL,
  fim TEXT NOT NULL,
  CHECK(inicio < fim)
);
CREATE TABLE IF NOT EXISTS calendario(
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  turma_id INTEGER REFERENCES turmas(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  descricao TEXT,
  data TEXT NOT NULL,
  inicio TEXT,
  fim TEXT,
  categoria TEXT NOT NULL DEFAULT 'evento' CHECK(categoria IN ('prova','trabalho','atividade','evento','reuniao','outro')),
  materia_id INTEGER REFERENCES materias(id) ON DELETE SET NULL,
  CHECK(inicio IS NULL OR fim IS NULL OR inicio < fim)
);
CREATE TABLE IF NOT EXISTS notas(
  id INTEGER PRIMARY KEY,
  aluno_id INTEGER NOT NULL REFERENCES alunos(usuario_id) ON DELETE CASCADE,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  professor_id INTEGER NOT NULL REFERENCES professores(usuario_id),
  trimestre INTEGER NOT NULL CHECK(trimestre BETWEEN 1 AND 3),
  valor REAL NOT NULL CHECK(valor BETWEEN 0 AND 10),
  descricao TEXT,
  atualizado_em TEXT NOT NULL,
  UNIQUE(aluno_id, materia_id, trimestre)
);
CREATE TABLE IF NOT EXISTS atividades(
  id INTEGER PRIMARY KEY,
  turma_id INTEGER NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
  materia_id INTEGER NOT NULL REFERENCES materias(id) ON DELETE CASCADE,
  professor_id INTEGER NOT NULL REFERENCES professores(usuario_id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  descricao TEXT,
  prazo TEXT NOT NULL,
  criado_em TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS atividades_concluidas(
  aluno_id INTEGER NOT NULL REFERENCES alunos(usuario_id) ON DELETE CASCADE,
  atividade_id INTEGER NOT NULL REFERENCES atividades(id) ON DELETE CASCADE,
  PRIMARY KEY(aluno_id, atividade_id)
);
CREATE TABLE IF NOT EXISTS notificacoes(
  id INTEGER PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  mensagem TEXT,
  chave TEXT,
  lida INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_notif_chave ON notificacoes(usuario_id, chave) WHERE chave IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_notif_user ON notificacoes(usuario_id, criado_em DESC);
CREATE TABLE IF NOT EXISTS sessoes(
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL,
  ultimo_uso TEXT
);
`);

/* ---------- 3) colunas novas em bancos antigos (nenhum dado é perdido) ---------- */
adicionar('turmas', 'etapa', "TEXT NOT NULL DEFAULT 'outra'");
adicionar('turmas', 'num_horarios', 'INTEGER NOT NULL DEFAULT 9');
adicionar('horarios', 'slot', 'INTEGER');
adicionar('professor_materias', 'aprovado', 'INTEGER NOT NULL DEFAULT 1');   // vínculos já existentes continuam aprovados
adicionar('professor_turmas', 'aprovado', 'INTEGER NOT NULL DEFAULT 1');
adicionar('calendario', 'categoria', "TEXT NOT NULL DEFAULT 'evento'");
adicionar('calendario', 'materia_id', 'INTEGER REFERENCES materias(id) ON DELETE SET NULL');
adicionar('sessoes', 'ultimo_uso', 'TEXT');
db.prepare('UPDATE sessoes SET ultimo_uso=? WHERE ultimo_uso IS NULL').run(new Date().toISOString());

/* ---------- as notas são por TRIMESTRE: bancos que usavam "bimestre" têm a coluna renomeada ---------- */
const antigas = ['notas', 'notas_historico'].filter((t) => existe(t) && colunas(t).includes('bimestre'));
if (antigas.length) {
  if (arquivo !== ':memory:' && db.prepare('SELECT 1 FROM notas LIMIT 1').get()) {
    const bak = `${arquivo}.backup-trimestre-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
    console.log(`[migração] cópia de segurança criada: ${bak}`);
  }
  for (const t of antigas) db.exec(`ALTER TABLE ${t} RENAME COLUMN bimestre TO trimestre`);
}
/* ---------- 4) migração SQL versionada (histórico de notas, auditoria, índices) ---------- */
db.exec(readFileSync(join(import.meta.dirname, 'migracoes', '002_historico_relatorios_calendario.sql'), 'utf8'));

// notas que já existiam entram no histórico como registro inicial (origem "migracao")
if (!db.prepare('SELECT 1 FROM notas_historico LIMIT 1').get() && db.prepare('SELECT 1 FROM notas LIMIT 1').get()) {
  db.exec(`INSERT INTO notas_historico(aluno_id,materia_id,turma_id,trimestre,ano_letivo,acao,valor_anterior,valor_novo,professor_id,alterado_por,alterado_em,origem)
    SELECT n.aluno_id,n.materia_id,(SELECT turma_id FROM aluno_turmas a WHERE a.aluno_id=n.aluno_id LIMIT 1),n.trimestre,
           CAST(substr(n.atualizado_em,1,4) AS INTEGER),'criada',NULL,n.valor,n.professor_id,n.professor_id,n.atualizado_em,'migracao'
    FROM notas n`);
}

/* ---------- 5) dados de referência ---------- */
const min = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
for (const h of db.prepare('SELECT id,inicio FROM horarios WHERE slot IS NULL').all()) {
  let melhor = 1, d = Infinity;
  SLOTS.forEach(([i], k) => { const x = Math.abs(min(i) - min(h.inicio)); if (x < d) { d = x; melhor = k + 1; } });
  db.prepare('UPDATE horarios SET slot=? WHERE id=?').run(melhor, h.id);
}

for (const [nome, etapa, n] of TURMAS_OFICIAIS)
  db.prepare('INSERT INTO turmas(nome,etapa,num_horarios) VALUES(?,?,?) ON CONFLICT(nome) DO UPDATE SET etapa=excluded.etapa,num_horarios=excluded.num_horarios').run(nome, etapa, n);

for (const m of MATERIAS)
  db.prepare('INSERT OR IGNORE INTO materias(nome) VALUES(?)').run(m);

/* ---------- 6) interface assíncrona (a mesma do PostgreSQL) ---------- */
const cache = new Map();
const preparar = (sql) => {
  let st = cache.get(sql);
  if (!st) { if (cache.size > 400) cache.clear(); st = db.prepare(sql); cache.set(sql, st); }
  return st;
};
const limpar = (p) => p.map((v) => (v === undefined ? null : v));
// há uma única conexão: durante uma transação, as demais consultas esperam
const dentro = new AsyncLocalStorage();
let trava = null;
const esperar = async () => { while (trava && !dentro.getStore()) await trava; };

export default {
  tipo: 'sqlite',
  async get(sql, ...p) { await esperar(); return preparar(sql).get(...limpar(p)); },
  async all(sql, ...p) { await esperar(); return preparar(sql).all(...limpar(p)); },
  async run(sql, ...p) { await esperar(); return { changes: Number(preparar(sql).run(...limpar(p)).changes) }; },
  async tx(fn) {
    if (dentro.getStore()) return fn();
    while (trava) await trava;
    let liberar;
    trava = new Promise((r) => { liberar = r; });
    try {
      db.exec('BEGIN');
      try { const r = await dentro.run(true, fn); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    } finally { trava = null; liberar(); }
  },
};