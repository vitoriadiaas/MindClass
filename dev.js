// Ambiente de teste local: banco separado (data/teste.db) com turmas e contas de exemplo.
// Uso: npm run teste        (mantém os dados)   |   npm run teste:reset   (recomeça do zero)
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';

const dir = join(import.meta.dirname, 'data');
mkdirSync(dir, { recursive: true });
const arquivo = join(dir, 'teste.db');
if (process.argv.includes('--reset')) for (const s of ['', '-wal', '-shm']) rmSync(arquivo + s, { force: true });

process.env.DB_PATH = arquivo;
process.env.PORT ||= '3000';
const { db } = await import('./db.js');

if (!(await db.get('SELECT 1 FROM usuarios LIMIT 1'))) {
  const SENHA = 'teste1234', agora = () => new Date().toISOString();
  const usuario = async (nome, email, perfil) => {
    const salt = crypto.randomBytes(16).toString('hex');
    return (await db.get('INSERT INTO usuarios(nome,email,senha_hash,salt,perfil,criado_em) VALUES(?,?,?,?,?,?) RETURNING id',
      nome, email, crypto.scryptSync(SENHA, salt, 64).toString('hex'), salt, perfil, agora())).id;
  };
  const id = async (t, n) => (await db.get(`SELECT id FROM ${t} WHERE nome=?`, n)).id;
  await db.tx(async () => {
    await usuario('Direção MindClass', 'admin@teste.com', 'administrador');
    const p1 = await usuario('Marina Souza', 'prof@teste.com', 'professor');
    const p2 = await usuario('Carlos Lima', 'prof2@teste.com', 'professor');
    await db.run('INSERT INTO professores VALUES(?,?)', p1, 'manhã');
    await db.run('INSERT INTO professores VALUES(?,?)', p2, 'tarde');
    for (const m of ['Matemática', 'Português']) await db.run('INSERT INTO professor_materias(professor_id,materia_id) VALUES(?,?)', p1, await id('materias', m));
    await db.run('INSERT INTO professor_materias(professor_id,materia_id) VALUES(?,?)', p2, await id('materias', 'História'));
    for (const t of ['6º ano A', '1º ano Administração']) for (const p of [p1, p2]) await db.run('INSERT INTO professor_turmas(professor_id,turma_id) VALUES(?,?)', p, await id('turmas', t));
    const al = [['Ana Beatriz', 'aluno@teste.com', '6º ano A'], ['João Pedro', 'aluno2@teste.com', '6º ano A'], ['Larissa Costa', 'aluno3@teste.com', '1º ano Administração']];
    const ids = [];
    for (const [n, e, t] of al) { const u = await usuario(n, e, 'aluno'); await db.run('INSERT INTO alunos VALUES(?,?)', u, null); await db.run('INSERT INTO aluno_turmas VALUES(?,?)', u, await id('turmas', t)); ids.push(u); }
    const T = await id('turmas', '6º ano A'), MAT = await id('materias', 'Matemática'), POR = await id('materias', 'Português'), HIS = await id('materias', 'História');
    const hor = (...v) => db.run('INSERT INTO horarios(turma_id,materia_id,professor_id,dia,inicio,fim,slot) VALUES(?,?,?,?,?,?,?)', ...v);
    await hor(T, MAT, p1, 1, '07:00', '07:50', 1); await hor(T, POR, p1, 2, '07:50', '08:40', 2); await hor(T, MAT, p1, 4, '07:00', '07:50', 1); await hor(T, HIS, p2, 3, '09:50', '10:40', 4);
    const nota = (...v) => db.run('INSERT INTO notas(aluno_id,materia_id,professor_id,trimestre,valor,atualizado_em) VALUES(?,?,?,?,?,?)', ...v);
    const hist = (...v) => db.run(`INSERT INTO notas_historico(aluno_id,materia_id,turma_id,trimestre,ano_letivo,acao,valor_anterior,valor_novo,professor_id,alterado_por,alterado_em)
      VALUES(?,?,?,?,?,'criada',NULL,?,?,?,?)`, ...v);
    for (const [a, m, b, v] of [[0, MAT, 1, 8.5], [0, MAT, 2, 7.0], [0, POR, 1, 9.0], [1, MAT, 1, 5.5]]) {
      await nota(ids[a], m, p1, b, v, agora());
      await hist(ids[a], m, T, b, new Date().getFullYear(), v, p1, p1, agora());
    }
    const prazo = new Date(Date.now() + 3 * 864e5); const p = (n) => String(n).padStart(2, '0');
    await db.run('INSERT INTO atividades(turma_id,materia_id,professor_id,titulo,descricao,prazo,criado_em) VALUES(?,?,?,?,?,?,?)',
      T, MAT, p1, 'Lista de equações', 'Exercícios 1 a 12 do capítulo 4', `${prazo.getFullYear()}-${p(prazo.getMonth() + 1)}-${p(prazo.getDate())}T23:59`, agora());
  });
  console.log('Banco de teste criado com dados de exemplo.');
}

console.log(`\n  Ambiente de TESTE  ->  http://localhost:${process.env.PORT}`);
console.log('  Banco: data/teste.db   (senha de todas as contas de exemplo: teste1234)');
console.log('  Administrador: admin@teste.com (entrar em /#/entrar/administrador)');
console.log('  Professor: prof@teste.com | prof2@teste.com    Aluno: aluno@teste.com | aluno2@teste.com | aluno3@teste.com');
console.log('  Turmas: 6º ao 9º ano (A/B, 5 horários) e Ensino Médio (Administração 7, Agronegócio 9, Alimentos 9, Informática 9, Regular 6)\n');
await import('./server.js');
