// Copia as contas REAIS do banco local para o Supabase (contas @teste.com de demonstração ficam de fora).
//   npm run copiar-supabase                 -> só mostra o que seria copiado
//   npm run copiar-supabase -- --confirmar  -> grava no Supabase
// Copia: conta (com a mesma senha), perfil, turma do aluno e vínculos do professor. Não apaga nada.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { db, usandoPostgres } from './db.js';

if (!usandoPostgres) { console.error('Crie o arquivo .env com DATABASE_URL antes (veja .env.exemplo).'); process.exit(1); }
const i = process.argv.indexOf('--arquivo');
const arquivo = i > -1 ? process.argv[i + 1] : join(import.meta.dirname, 'data', 'teste.db');
const local = new DatabaseSync(arquivo, { readOnly: true });
const confirmar = process.argv.includes('--confirmar');

const contas = local.prepare("SELECT * FROM usuarios WHERE lower(email) NOT LIKE '%@teste.com' ORDER BY id").all();
console.log(`${contas.length} conta(s) em ${arquivo}:`);
for (const u of contas) console.log(` - ${u.nome} (${u.perfil})`);
if (!confirmar) { console.log('\nNada foi gravado. Para copiar, rode:  node copiar-para-supabase.js --confirmar'); await db.fechar(); process.exit(0); }

const idDe = async (tabela, nome) => (await db.get(`SELECT id FROM ${tabela} WHERE nome=?`, nome))?.id;
for (const u of contas) {
  if (await db.get('SELECT 1 FROM usuarios WHERE email=?', u.email)) { console.log(`já existe, ignorada: ${u.nome}`); continue; }
  await db.tx(async () => {
    const { id } = await db.get(`INSERT INTO usuarios(nome,email,senha_hash,salt,perfil,foto,ativo,criado_em) VALUES(?,?,?,?,?,?,?,?) RETURNING id`,
      u.nome, u.email, u.senha_hash, u.salt, u.perfil, u.foto, u.ativo, u.criado_em);
    if (u.perfil === 'aluno') {
      const a = local.prepare('SELECT matricula FROM alunos WHERE usuario_id=?').get(u.id);
      await db.run('INSERT INTO alunos VALUES(?,?)', id, a?.matricula);
      for (const t of local.prepare('SELECT t.nome FROM aluno_turmas x JOIN turmas t ON t.id=x.turma_id WHERE x.aluno_id=?').all(u.id)) {
        const tid = await idDe('turmas', t.nome);
        if (tid) await db.run('INSERT INTO aluno_turmas VALUES(?,?)', id, tid);
      }
    }
    if (u.perfil === 'professor') {
      await db.run('INSERT INTO professores VALUES(?,?)', id, local.prepare('SELECT turno FROM professores WHERE usuario_id=?').get(u.id).turno);
      for (const [tab, ref, col] of [['professor_materias', 'materias', 'materia_id'], ['professor_turmas', 'turmas', 'turma_id']])
        for (const v of local.prepare(`SELECT r.nome,x.aprovado FROM ${tab} x JOIN ${ref} r ON r.id=x.${col} WHERE x.professor_id=?`).all(u.id)) {
          if (ref === 'materias') await db.run('INSERT INTO materias(nome) VALUES(?) ON CONFLICT DO NOTHING', v.nome);
          const rid = await idDe(ref, v.nome);
          if (rid) await db.run(`INSERT INTO ${tab}(professor_id,${col},aprovado) VALUES(?,?,?)`, id, rid, v.aprovado);
        }
    }
  });
  console.log(`copiada: ${u.nome}`);
}
await db.fechar();
