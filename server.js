import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { db, usandoPostgres, SLOTS } from './db.js';
import { hashSenha, novoSalt, confere, problemaSenha } from './auth.js';
import { registrarAdmin } from './admin.js';
import { registrarRelatorios } from './relatorios.js';

const gzip = promisify(zlib.gzip);
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = join(import.meta.dirname, 'public');
const COOKIE = 'sid';
const SECURE = process.env.COOKIE_SECURE === '1';          // defina em produção com HTTPS
const SESSAO_DIAS = 7;                                      // validade absoluta
const OCIOSO_MS = 12 * 36e5;                                // expira após 12 h sem uso
const MEDIA_MINIMA = 6;                                     // média abaixo disso = "precisa de atenção"
const CATEGORIAS = ['prova', 'trabalho', 'atividade', 'evento', 'reuniao', 'outro'];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const erro = (s, m) => { throw new HttpError(s, m); };

/* ---------- utilidades ---------- */
const agora = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const txt = (v, max, campo, obrig = true) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) { if (obrig) erro(400, `${campo} é obrigatório.`); return null; }
  if (s.length > max) erro(400, `${campo} deve ter no máximo ${max} caracteres.`);
  return s;
};
const inteiro = (v, campo) => { const n = Number(v); if (v === '' || v === null || typeof v === 'boolean' || !Number.isInteger(n)) erro(400, `${campo} inválido.`); return n; };
const inteiroOpc = (v, campo) => (v === undefined || v === null || v === '' ? null : inteiro(v, campo));
const hora = (v, campo) => { if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) erro(400, `${campo} inválido (use HH:MM).`); return v; };
const dataOk = (v, campo = 'Data') => {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  const d = m && new Date(+m[1], +m[2] - 1, +m[3]);
  if (!m || d.getDate() !== +m[3] || d.getMonth() !== +m[2] - 1 || +m[1] < 2000 || +m[1] > 2100) erro(400, `${campo} inválida.`);
  return v;
};
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStr = (d = new Date()) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const emailOk = (e) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 120;
const foto = (v) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) erro(400, 'Foto inválida.');
  if (v.length > 400_000) erro(400, 'Foto muito grande (máximo ~300 KB).');
  return v;
};
const TURNOS = ['manhã', 'tarde', 'noite', 'integral'];
const ORDEM_ETAPA = "CASE t.etapa WHEN 'fundamental' THEN 0 WHEN 'medio' THEN 1 ELSE 2 END";

/* ---------- tempo real (SSE) ---------- */
const streams = new Map();
const MAX_STREAMS = 5;
function push(uid, evento, dados) {
  for (const res of streams.get(uid) || []) res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
}
async function notificar(uid, tipo, titulo, mensagem, chave = null) {
  const nova = (await db.get('INSERT INTO notificacoes(usuario_id,tipo,titulo,mensagem,chave,criado_em) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING *', uid, tipo, titulo, mensagem, chave, agora()));
  if (nova) push(uid, 'notificacao', nova);
}
// avisa as telas abertas que um recurso mudou, para recarregarem sozinhas
function atualizar(uids, recurso) { for (const u of new Set(uids)) push(u, 'atualizacao', { recurso }); }
const idsAlunosTurma = async (turmaId) => (await db.all('SELECT aluno_id id FROM aluno_turmas WHERE turma_id=?', turmaId)).map((x) => x.id);
const idsProfessoresTurma = async (turmaId) => (await db.all('SELECT professor_id id FROM professor_turmas WHERE turma_id=? AND aprovado=1', turmaId)).map((x) => x.id);
const idsAdmins = async () => (await db.all("SELECT id FROM usuarios WHERE perfil='administrador' AND ativo=1")).map((x) => x.id);
const nomeMateria = async (id) => (await db.get('SELECT nome FROM materias WHERE id=?', id))?.nome ?? '';
const nomeTurma = async (id) => (await db.get('SELECT nome FROM turmas WHERE id=?', id))?.nome ?? '';
const DIAS = ['', 'segunda', 'terça', 'quarta', 'quinta', 'sexta'];

/* ---------- permissões (verificadas SEMPRE no servidor; só vínculos aprovados valem) ---------- */
const leciona = async (profId, turmaId, materiaId) => !!(await db.get(
  `SELECT 1 FROM professor_turmas pt JOIN professor_materias pm ON pm.professor_id=pt.professor_id AND pm.aprovado=1
   WHERE pt.professor_id=? AND pt.turma_id=? AND pt.aprovado=1 AND pm.materia_id=?`, profId, turmaId, materiaId));
const ensinaTurma = async (profId, turmaId) => !!(await db.get('SELECT 1 FROM professor_turmas WHERE professor_id=? AND turma_id=? AND aprovado=1', profId, turmaId));
const ensinaMateria = async (profId, materiaId) => !!(await db.get('SELECT 1 FROM professor_materias WHERE professor_id=? AND materia_id=? AND aprovado=1', profId, materiaId));
// professor só mexe na nota se leciona a matéria E o aluno está em turma dele
const podeNota = async (profId, alunoId, materiaId) => !!(await db.get(
  `SELECT 1 FROM aluno_turmas a JOIN professor_turmas pt ON pt.turma_id=a.turma_id AND pt.professor_id=? AND pt.aprovado=1
   JOIN professor_materias pm ON pm.professor_id=pt.professor_id AND pm.materia_id=? AND pm.aprovado=1
   WHERE a.aluno_id=?`, profId, materiaId, alunoId));
const turmaDaNota = async (profId, alunoId) => (await db.get(
  `SELECT a.turma_id id FROM aluno_turmas a JOIN professor_turmas pt ON pt.turma_id=a.turma_id AND pt.professor_id=? AND pt.aprovado=1
   WHERE a.aluno_id=? LIMIT 1`, profId, alunoId))?.id ?? null;
const alunoNaTurma = async (alunoId, turmaId) => !!(await db.get('SELECT 1 FROM aluno_turmas WHERE aluno_id=? AND turma_id=?', alunoId, turmaId));
const exigeLeciona = async (u, turmaId, materiaId) => {
  if (!(await leciona(u.id, turmaId, materiaId))) erro(403, 'Você não leciona esta matéria nesta turma (ou o vínculo ainda não foi aprovado).');
};
const turmasProf = async (uid, aprovado = 1) => (await db.all(
  `SELECT t.id,t.nome,t.etapa,t.num_horarios FROM professor_turmas pt JOIN turmas t ON t.id=pt.turma_id
   WHERE pt.professor_id=? AND pt.aprovado=? ORDER BY ${ORDEM_ETAPA},t.id`, uid, aprovado));
const materiasProf = async (uid, aprovado = 1) => (await db.all(
  'SELECT m.id,m.nome FROM professor_materias pm JOIN materias m ON m.id=pm.materia_id WHERE pm.professor_id=? AND pm.aprovado=? ORDER BY m.nome', uid, aprovado));

async function auditar(user, acao, alvo, detalhe, req) {
  (await db.run('INSERT INTO auditoria(usuario_id,acao,alvo,detalhe,ip,em) VALUES(?,?,?,?,?,?)', user?.id ?? null, acao, alvo ?? null, detalhe ? JSON.stringify(detalhe) : null, req?.socket?.remoteAddress ?? null, agora()));
}

/* ---------- sessão ---------- */
const cookie = (valor, maxAge) => `${COOKIE}=${valor}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`;
async function criarSessao(res, uid) {
  const token = crypto.randomBytes(32).toString('hex');
  const t = agora();
  (await db.run('INSERT INTO sessoes(token_hash,usuario_id,expira_em,ultimo_uso) VALUES(?,?,?,?)', sha(token), uid, new Date(Date.now() + SESSAO_DIAS * 864e5).toISOString(), t));
  res.setHeader('Set-Cookie', cookie(token, SESSAO_DIAS * 86400));
}
async function usuarioDaReq(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const h = sha(m[1]);
  const u = (await db.get(`SELECT u.id,u.nome,u.email,u.perfil,u.foto,s.ultimo_uso FROM sessoes s JOIN usuarios u ON u.id=s.usuario_id
    WHERE s.token_hash=? AND s.expira_em>? AND s.ultimo_uso>? AND u.ativo=1`, h, agora(), new Date(Date.now() - OCIOSO_MS).toISOString()));
  if (!u) return null;
  if (Date.now() - Date.parse(u.ultimo_uso) > 60e3) (await db.run('UPDATE sessoes SET ultimo_uso=? WHERE token_hash=?', agora(), h));
  u.tokenHash = h;
  return u;
}
async function revogarSessoes(uid, manterHash = null) {
  if (manterHash) await db.run('DELETE FROM sessoes WHERE usuario_id=? AND token_hash<>?', uid, manterHash);
  else await db.run('DELETE FROM sessoes WHERE usuario_id=?', uid);
  if (!manterHash) for (const res of streams.get(uid) || []) res.end();
}

/* ---------- limites de tentativas ---------- */
const tentativas = new Map();
function limite(chave, max, janelaMs) {
  const f = (tentativas.get(chave) || []).filter((t) => Date.now() - t < janelaMs);
  tentativas.set(chave, f);
  if (f.length >= max) erro(429, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
  return () => tentativas.get(chave).push(Date.now());
}
setInterval(() => { for (const [k, v] of tentativas) if (!v.some((t) => Date.now() - t < 3600e3)) tentativas.delete(k); }, 10 * 60e3).unref();

/* ---------- rotas ---------- */
const rotas = [];
const rota = (metodo, caminho, opt, fn) => {
  if (typeof opt === 'function') { fn = opt; opt = {}; }
  rotas.push({ metodo, re: new RegExp('^' + caminho.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), opt, fn });
};
const permitido = (auth, perfil) => auth === true || [].concat(auth).includes(perfil);
const PROF_ADM = ['professor', 'administrador'];

const perfilCompleto = async (u) => {
  const base = { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, foto: u.foto };
  if (u.perfil === 'professor') {
    base.turno = (await db.get('SELECT turno FROM professores WHERE usuario_id=?', u.id))?.turno;
    base.materias = (await materiasProf(u.id));
    base.turmas = (await turmasProf(u.id));
    base.pendentes = { turmas: (await turmasProf(u.id, 0)), materias: (await materiasProf(u.id, 0)) };
  } else if (u.perfil === 'aluno') {
    base.turmas = (await db.all(`SELECT t.id,t.nome,t.etapa,t.num_horarios FROM aluno_turmas at JOIN turmas t ON t.id=at.turma_id WHERE at.aluno_id=?`, u.id));
  }
  return base;
};

// --- público
rota('GET', '/api/opcoes', async () => ({
  materias: (await db.all('SELECT id,nome FROM materias ORDER BY nome')),
  turmas: (await db.all(`SELECT id,nome,etapa,num_horarios FROM turmas t ORDER BY ${ORDEM_ETAPA},id`)),
  slots: SLOTS.map(([inicio, fim], i) => ({ n: i + 1, inicio, fim })),
  turnos: TURNOS,
  categorias: CATEGORIAS,
  media_minima: MEDIA_MINIMA,
}));

async function prepararUsuario(b) {
  const nome = txt(b.nome, 100, 'Nome completo');
  const email = txt(b.email, 120, 'E-mail').toLowerCase();
  if (!emailOk(email)) erro(400, 'E-mail inválido.');
  const senha = typeof b.senha === 'string' ? b.senha : '';
  const pb = problemaSenha(senha, { email, nome });
  if (pb) erro(400, pb);
  if (senha !== b.confirmacao) erro(400, 'A confirmação de senha não confere.');
  const f = foto(b.foto);
  if ((await db.get('SELECT 1 FROM usuarios WHERE email=?', email))) erro(409, 'Este e-mail já está cadastrado.');
  const salt = novoSalt();
  return { nome, email, salt, hash: await hashSenha(senha, salt), foto: f };
}
async function inserirUsuario(d, perfil) {
  if ((await db.get('SELECT 1 FROM usuarios WHERE email=?', d.email))) erro(409, 'Este e-mail já está cadastrado.');
  const r = (await db.get('INSERT INTO usuarios(nome,email,senha_hash,salt,perfil,foto,senha_alterada_em,criado_em) VALUES(?,?,?,?,?,?,?,?) RETURNING id', d.nome, d.email, d.hash, d.salt, perfil, d.foto, agora(), agora()));
  return r.id;
}
const obterOuCriar = async (tabela, nome) => {
  const n = txt(nome, 60, 'Nome');
  (await db.run(`INSERT INTO ${tabela}(nome) VALUES(?) ON CONFLICT DO NOTHING`, n));
  return (await db.get(`SELECT id FROM ${tabela} WHERE nome=?`, n)).id;
};
async function resolverVinculos(b) {
  const lista = (v) => (Array.isArray(v) ? v : []).slice(0, 50);
  const mats = new Set(lista(b.materias).map((x) => inteiro(x, 'Matéria')));
  const turs = new Set(lista(b.turmas).map((x) => inteiro(x, 'Turma')));
  for (const n of lista(b.novas_materias)) mats.add((await obterOuCriar('materias', n)));
  for (const id of mats) if (!(await db.get('SELECT 1 FROM materias WHERE id=?', id))) erro(400, 'Matéria inexistente.');
  for (const id of turs) if (!(await db.get('SELECT 1 FROM turmas WHERE id=?', id))) erro(400, 'Turma inexistente.');
  if (!mats.size) erro(400, 'Selecione ao menos uma matéria.');
  if (!turs.size) erro(400, 'Selecione ao menos uma turma.');
  return { mats: [...mats], turs: [...turs] };
}
// aprovado=1 grava direto (administração); aprovado=0 cria solicitações pendentes. Retorna quantas pendências novas surgiram.
async function gravarVinculos(profId, { mats, turs }, aprovado) {
  let novas = 0;
  const sync = async (tabela, coluna, ids) => {
    const atuais = new Map((await db.all(`SELECT ${coluna} id,aprovado FROM ${tabela} WHERE professor_id=?`, profId)).map((x) => [x.id, x.aprovado]));
    for (const id of atuais.keys()) if (!ids.includes(id)) (await db.run(`DELETE FROM ${tabela} WHERE professor_id=? AND ${coluna}=?`, profId, id));
    for (const id of ids) {
      if (!atuais.has(id)) { (await db.run(`INSERT INTO ${tabela}(professor_id,${coluna},aprovado) VALUES(?,?,?)`, profId, id, aprovado)); if (!aprovado) novas++; }
      else if (aprovado && !atuais.get(id)) (await db.run(`UPDATE ${tabela} SET aprovado=1 WHERE professor_id=? AND ${coluna}=?`, profId, id));
    }
  };
  (await sync('professor_materias', 'materia_id', mats));
  (await sync('professor_turmas', 'turma_id', turs));
  return novas;
}
const avisarAdminsPendencia = async (nome) => { for (const a of (await idsAdmins())) (await notificar(a, 'vinculo', 'Solicitação de vínculo', `${nome} solicitou turmas/matérias e aguarda aprovação.`)); };

rota('POST', '/api/cadastro/professor', async ({ body: b, res, req }) => {
  limite(`cad|${req.socket.remoteAddress}`, 60, 3600e3)();
  const turno = TURNOS.includes(b.turno) ? b.turno : erro(400, 'Selecione o turno de trabalho.');
  const dados = await prepararUsuario(b);
  const id = (await db.tx(async () => {
    const v = (await resolverVinculos(b));
    const uid = (await inserirUsuario(dados, 'professor'));
    (await db.run('INSERT INTO professores VALUES(?,?)', uid, turno));
    (await gravarVinculos(uid, v, 0));
    (await notificar(uid, 'aviso', 'Bem-vindo ao MindClass!', 'Cadastro concluído. As turmas e matérias solicitadas aguardam aprovação da administração; depois disso você poderá montar a grade, lançar notas e publicar atividades.'));
    return uid;
  }));
  (await avisarAdminsPendencia(dados.nome));
  (await criarSessao(res, id));
  return (await perfilCompleto((await db.get('SELECT * FROM usuarios WHERE id=?', id))));
});

rota('POST', '/api/cadastro/aluno', async ({ body: b, res, req }) => {
  limite(`cad|${req.socket.remoteAddress}`, 60, 3600e3)();
  const turmaId = inteiro(b.turma_id, 'Turma');
  if (!(await db.get('SELECT 1 FROM turmas WHERE id=?', turmaId))) erro(400, 'Turma inexistente.');
  const matricula = txt(b.matricula, 30, 'Matrícula', false);
  const dados = await prepararUsuario(b);
  const id = (await db.tx(async () => {
    const uid = (await inserirUsuario(dados, 'aluno'));
    (await db.run('INSERT INTO alunos VALUES(?,?)', uid, matricula));
    (await db.run('INSERT INTO aluno_turmas VALUES(?,?)', uid, turmaId));
    (await notificar(uid, 'aviso', 'Bem-vindo ao MindClass!', `Você foi vinculado à turma ${(await nomeTurma(turmaId))}.`));
    for (const p of (await idsProfessoresTurma(turmaId))) (await notificar(p, 'turma', 'Novo aluno na turma', `${dados.nome} foi vinculado(a) à turma ${(await nomeTurma(turmaId))}.`));
    return uid;
  }));
  atualizar((await idsProfessoresTurma(turmaId)), 'alunos');
  (await criarSessao(res, id));
  return (await perfilCompleto((await db.get('SELECT * FROM usuarios WHERE id=?', id))));
});

rota('POST', '/api/login', async ({ body: b, res, req }) => {
  const email = txt(b.email, 120, 'E-mail').toLowerCase();
  const ip = req.socket.remoteAddress;
  const falhouIp = limite(`login-ip|${ip}`, 40, 15 * 60e3), falhouConta = limite(`login|${ip}|${email}`, 10, 15 * 60e3);
  const u = (await db.get('SELECT * FROM usuarios WHERE email=?', email));
  if (!(await confere(b.senha, u))) { falhouIp(); falhouConta(); (await auditar(null, 'login_falhou', email, null, req)); erro(401, 'E-mail ou senha incorretos.'); }
  if (!u.ativo) erro(403, 'Conta desativada. Procure a administração da escola.');
  if (b.perfil && b.perfil !== u.perfil) erro(403, `Esta conta é de ${u.perfil}. Selecione o tipo de acesso correto.`);
  (await db.run('UPDATE usuarios SET ultimo_login=? WHERE id=?', agora(), u.id));
  (await criarSessao(res, u.id));
  return (await perfilCompleto(u));
});

rota('POST', '/api/logout', { auth: true }, async ({ user, res }) => {
  (await db.run('DELETE FROM sessoes WHERE token_hash=?', user.tokenHash));
  res.setHeader('Set-Cookie', cookie('', 0));
  return { ok: true };
});
rota('POST', '/api/logout-todas', { auth: true }, async ({ user, res }) => {
  (await revogarSessoes(user.id));
  res.setHeader('Set-Cookie', cookie('', 0));
  return { ok: true };
});

rota('GET', '/api/eu', async ({ user }) => (user ? (await perfilCompleto(user)) : { anonimo: true }));

rota('PATCH', '/api/perfil', { auth: true }, async ({ user, body: b }) => {
  const nome = b.nome !== undefined ? txt(b.nome, 100, 'Nome completo') : user.nome;
  const f = b.foto !== undefined ? foto(b.foto) : user.foto;
  let nova = null;
  if (b.nova_senha) {
    const u = (await db.get('SELECT * FROM usuarios WHERE id=?', user.id));
    limite(`senha|${user.id}`, 8, 15 * 60e3);
    if (!(await confere(b.senha_atual, u))) { tentativas.get(`senha|${user.id}`).push(Date.now()); erro(403, 'Senha atual incorreta.'); }
    const pb = problemaSenha(b.nova_senha, { email: user.email, nome });
    if (pb) erro(400, pb);
    const salt = novoSalt();
    nova = { salt, hash: await hashSenha(b.nova_senha, salt) };
  }
  if (user.perfil === 'professor' && b.turno !== undefined && !TURNOS.includes(b.turno)) erro(400, 'Turno inválido.');
  (await db.tx(async () => {
    (await db.run('UPDATE usuarios SET nome=?,foto=? WHERE id=?', nome, f, user.id));
    if (nova) (await db.run('UPDATE usuarios SET salt=?,senha_hash=?,senha_alterada_em=? WHERE id=?', nova.salt, nova.hash, agora(), user.id));
    if (user.perfil === 'professor' && b.turno !== undefined) (await db.run('UPDATE professores SET turno=? WHERE usuario_id=?', b.turno, user.id));
  }));
  if (nova) (await revogarSessoes(user.id, user.tokenHash));   // trocar a senha encerra as outras sessões
  return (await perfilCompleto((await db.get('SELECT * FROM usuarios WHERE id=?', user.id))));
});

// o professor SOLICITA turmas/matérias; só passam a valer depois da aprovação da administração
rota('PUT', '/api/professor/vinculos', { auth: 'professor' }, async ({ user, body: b }) => {
  const novas = (await db.tx(async () => (await gravarVinculos(user.id, (await resolverVinculos(b)), 0))));
  if (novas) (await avisarAdminsPendencia(user.nome));
  return (await perfilCompleto(user));
});

/* ---------- professor: resumo e alunos ---------- */
async function resumoProf(uid) {
  return {
    turmas: (await db.all(`SELECT t.id,t.nome,(SELECT COUNT(*) FROM aluno_turmas a WHERE a.turma_id=t.id) alunos
      FROM professor_turmas pt JOIN turmas t ON t.id=pt.turma_id WHERE pt.professor_id=? AND pt.aprovado=1 ORDER BY ${ORDEM_ETAPA},t.id`, uid)),
    aulas: (await db.get('SELECT COUNT(*) n FROM horarios WHERE professor_id=?', uid)).n,
    atividades_abertas: (await db.get('SELECT COUNT(*) n FROM atividades WHERE professor_id=? AND prazo>=?', uid, localStr())).n,
  };
}
rota('GET', '/api/professor/resumo', { auth: 'professor' }, async ({ user }) => (await resumoProf(user.id)));

rota('GET', '/api/turmas/:id/alunos', { auth: PROF_ADM }, async ({ user, params }) => {
  const tid = inteiro(params.id, 'Turma');
  if (user.perfil === 'professor' && !(await ensinaTurma(user.id, tid))) erro(403, 'Você não está vinculado a esta turma.');
  return (await db.all(`SELECT u.id,u.nome,u.email,u.foto,a.matricula FROM aluno_turmas at JOIN alunos a ON a.usuario_id=at.aluno_id
    JOIN usuarios u ON u.id=a.usuario_id WHERE at.turma_id=? AND u.ativo=1 ORDER BY u.nome`, tid));
});

/* ---------- notas (com histórico imutável) ---------- */
async function registrarHistorico({ aluno, materia, turma, trimestre, acao, anterior, novo, professor, autor }) {
  (await db.run(`INSERT INTO notas_historico(aluno_id,materia_id,turma_id,trimestre,ano_letivo,acao,valor_anterior,valor_novo,professor_id,alterado_por,alterado_em)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, aluno, materia, turma, trimestre, new Date().getFullYear(), acao, anterior, novo, professor, autor, agora()));
}

rota('GET', '/api/notas', { auth: 'professor' }, async ({ user, query }) => {
  const tid = inteiro(query.turma_id, 'Turma'), mid = inteiro(query.materia_id, 'Matéria');
  (await exigeLeciona(user, tid, mid));
  const alunos = (await db.all(`SELECT u.id,u.nome FROM aluno_turmas at JOIN usuarios u ON u.id=at.aluno_id WHERE at.turma_id=? AND u.ativo=1 ORDER BY u.nome`, tid));
  const notas = (await db.all('SELECT * FROM notas WHERE trimestre<=3 AND materia_id=? AND aluno_id IN (SELECT aluno_id FROM aluno_turmas WHERE turma_id=?)', mid, tid));
  return alunos.map((a) => ({ ...a, notas: notas.filter((n) => n.aluno_id === a.id) }));
});

rota('PUT', '/api/notas', { auth: 'professor' }, async ({ user, body: b }) => {
  const aid = inteiro(b.aluno_id, 'Aluno'), mid = inteiro(b.materia_id, 'Matéria'), bim = inteiro(b.trimestre, 'Trimestre');
  const valor = Number(b.valor);
  if (!(bim >= 1 && bim <= 3)) erro(400, 'Trimestre deve ser de 1 a 3.');
  if (b.valor === '' || b.valor == null || typeof b.valor === 'boolean' || !Number.isFinite(valor) || valor < 0 || valor > 10) erro(400, 'A nota deve estar entre 0 e 10.');
  if (!(await podeNota(user.id, aid, mid))) erro(403, 'Você não pode lançar notas desta matéria para este aluno.');
  const v = Math.round(valor * 10) / 10, descricao = txt(b.descricao, 200, 'Descrição', false);
  const turma = (await turmaDaNota(user.id, aid));
  const { ant, linha } = (await db.tx(async () => {
    const ant = (await db.get('SELECT valor FROM notas WHERE aluno_id=? AND materia_id=? AND trimestre=?', aid, mid, bim));
    (await db.run(`INSERT INTO notas(aluno_id,materia_id,professor_id,trimestre,valor,descricao,atualizado_em) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(aluno_id,materia_id,trimestre) DO UPDATE SET valor=excluded.valor,descricao=excluded.descricao,professor_id=excluded.professor_id,atualizado_em=excluded.atualizado_em`, aid, mid, user.id, bim, v, descricao, agora()));
    if (!ant || ant.valor !== v)
      (await registrarHistorico({ aluno: aid, materia: mid, turma, trimestre: bim, acao: ant ? 'alterada' : 'criada', anterior: ant?.valor ?? null, novo: v, professor: user.id, autor: user.id }));
    return { ant, linha: (await db.get('SELECT * FROM notas WHERE aluno_id=? AND materia_id=? AND trimestre=?', aid, mid, bim)) };
  }));
  if (!ant) (await notificar(aid, 'nota', 'Nova nota cadastrada', `${(await nomeMateria(mid))} — ${bim}º trimestre: ${v.toFixed(1)}`));
  else if (ant.valor !== v) (await notificar(aid, 'nota', 'Nota atualizada', `${(await nomeMateria(mid))} — ${bim}º trimestre: ${ant.valor.toFixed(1)} → ${v.toFixed(1)}`));
  atualizar([aid], 'notas');
  return linha;
});

rota('DELETE', '/api/notas/:id', { auth: 'professor' }, async ({ user, params }) => {
  const n = (await db.get('SELECT * FROM notas WHERE id=?', inteiro(params.id, 'Nota')));
  if (!n) erro(404, 'Nota não encontrada.');
  if (!(await podeNota(user.id, n.aluno_id, n.materia_id))) erro(403, 'Você não pode excluir esta nota.');
  (await db.tx(async () => {
    (await registrarHistorico({ aluno: n.aluno_id, materia: n.materia_id, turma: (await turmaDaNota(user.id, n.aluno_id)), trimestre: n.trimestre, acao: 'excluida', anterior: n.valor, novo: null, professor: n.professor_id, autor: user.id }));
    (await db.run('DELETE FROM notas WHERE id=?', n.id));
  }));
  (await notificar(n.aluno_id, 'nota', 'Nota removida', `${(await nomeMateria(n.materia_id))} — ${n.trimestre}º trimestre.`));
  atualizar([n.aluno_id], 'notas');
  return { ok: true };
});

async function notasAluno(uid) {
  const notas = (await db.all('SELECT n.*,m.nome materia FROM notas n JOIN materias m ON m.id=n.materia_id WHERE n.aluno_id=? AND n.trimestre<=3 ORDER BY m.nome,n.trimestre', uid));
  const por = new Map();
  for (const n of notas) {
    if (!por.has(n.materia_id)) por.set(n.materia_id, { materia_id: n.materia_id, materia: n.materia, trimestres: {}, media: 0 });
    por.get(n.materia_id).trimestres[n.trimestre] = n.valor;
  }
  for (const m of por.values()) { const v = Object.values(m.trimestres); m.media = v.reduce((a, b) => a + b, 0) / v.length; }
  return [...por.values()];
}
rota('GET', '/api/aluno/notas', { auth: 'aluno' }, async ({ user }) => (await notasAluno(user.id)));

rota('GET', '/api/aluno/professores', { auth: 'aluno' }, async ({ user }) => (await db.all(
  `SELECT DISTINCT u.id,u.nome,u.email,u.foto,m.nome materia FROM aluno_turmas at
   JOIN professor_turmas pt ON pt.turma_id=at.turma_id AND pt.aprovado=1
   JOIN professor_materias pm ON pm.professor_id=pt.professor_id AND pm.aprovado=1
   JOIN materias m ON m.id=pm.materia_id JOIN usuarios u ON u.id=pt.professor_id AND u.ativo=1
   WHERE at.aluno_id=? ORDER BY m.nome,u.nome`, user.id)));

/* ---------- horários ---------- */
const SQL_HOR = `SELECT h.*,m.nome materia,t.nome turma,u.nome professor FROM horarios h JOIN materias m ON m.id=h.materia_id
  JOIN turmas t ON t.id=h.turma_id JOIN usuarios u ON u.id=h.professor_id`;
const horariosDo = async (user) => (user.perfil === 'professor'
  ? (await db.all(`${SQL_HOR} WHERE h.professor_id=? ORDER BY h.dia,h.slot`, user.id))
  : (await db.all(`${SQL_HOR} WHERE h.turma_id IN (SELECT turma_id FROM aluno_turmas WHERE aluno_id=?) ORDER BY h.dia,h.slot`, user.id)));

rota('GET', '/api/horarios', { auth: true }, async ({ user, query }) => {
  if (user.perfil === 'aluno') return (await horariosDo(user));
  if (query.turma_id === undefined) return user.perfil === 'professor' ? (await horariosDo(user)) : [];
  const tid = inteiro(query.turma_id, 'Turma');
  if (user.perfil === 'administrador') return (await db.all(`${SQL_HOR} WHERE h.turma_id=? ORDER BY h.dia,h.slot`, tid));
  // professor: vê só as aulas das matérias que leciona; as demais aparecem apenas como "ocupado"
  if (!(await ensinaTurma(user.id, tid))) erro(403, 'Você não está vinculado a esta turma.');
  const minhas = new Set((await materiasProf(user.id)).map((x) => x.id));
  return (await db.all(`${SQL_HOR} WHERE h.turma_id=? ORDER BY h.dia,h.slot`, tid))
    .map((h) => (minhas.has(h.materia_id) ? h : { ocupado: true, turma_id: h.turma_id, dia: h.dia, slot: h.slot, inicio: h.inicio, fim: h.fim }));
});

async function lerHorario(user, b, ignorarId = 0) {
  const tid = inteiro(b.turma_id, 'Turma'), mid = inteiro(b.materia_id, 'Matéria'), dia = inteiro(b.dia, 'Dia');
  if (dia < 1 || dia > 5) erro(400, 'O dia deve ser de segunda a sexta.');
  const slot = inteiro(b.slot, 'Horário');
  const turma = (await db.get('SELECT nome,num_horarios FROM turmas WHERE id=?', tid));
  if (!turma) erro(400, 'Turma inexistente.');
  if (slot < 1 || slot > Math.min(turma.num_horarios, SLOTS.length)) erro(400, `A turma ${turma.nome} tem apenas ${turma.num_horarios} horários por dia.`);
  const [inicio, fim] = SLOTS[slot - 1];
  (await exigeLeciona(user, tid, mid));
  const c = (await db.get(`SELECT h.inicio,h.fim,h.turma_id,h.professor_id FROM horarios h WHERE h.dia=? AND h.id<>? AND h.inicio<? AND h.fim>?
    AND (h.professor_id=? OR h.turma_id=?)`, dia, ignorarId, fim, inicio, user.id, tid));
  if (c) erro(409, c.professor_id === user.id ? `Você já tem aula das ${c.inicio} às ${c.fim} neste dia.` : `A turma já tem aula das ${c.inicio} às ${c.fim} neste dia.`);
  return { tid, mid, dia, inicio, fim, slot };
}
const avisoHorario = async (acao, h) => {
  const txtH = `${(await nomeMateria(h.materia_id))} — ${DIAS[h.dia]}-feira, ${h.inicio} às ${h.fim}`;
  const alunos = (await idsAlunosTurma(h.turma_id));
  for (const a of alunos) (await notificar(a, 'horario', `Horário de aula ${acao}`, txtH));
  (await notificar(h.professor_id, 'horario', `Grade de horários: aula ${acao}`, `${(await nomeTurma(h.turma_id))} · ${txtH}`));
  atualizar([...alunos, h.professor_id, ...(await idsProfessoresTurma(h.turma_id))], 'horarios');
};

rota('POST', '/api/horarios', { auth: 'professor' }, async ({ user, body: b }) => {
  const h = (await lerHorario(user, b));
  const r = (await db.get('INSERT INTO horarios(turma_id,materia_id,professor_id,dia,inicio,fim,slot) VALUES(?,?,?,?,?,?,?) RETURNING id', h.tid, h.mid, user.id, h.dia, h.inicio, h.fim, h.slot));
  (await avisoHorario('adicionada', { turma_id: h.tid, materia_id: h.mid, professor_id: user.id, dia: h.dia, inicio: h.inicio, fim: h.fim }));
  return (await db.get(`${SQL_HOR} WHERE h.id=?`, r.id));
});
rota('PUT', '/api/horarios/:id', { auth: 'professor' }, async ({ user, params, body: b }) => {
  const id = inteiro(params.id, 'Horário');
  const atual = (await db.get('SELECT * FROM horarios WHERE id=?', id));
  if (!atual || atual.professor_id !== user.id) erro(403, 'Você só pode editar seus próprios horários.');
  const h = (await lerHorario(user, b, id));
  (await db.run('UPDATE horarios SET turma_id=?,materia_id=?,dia=?,inicio=?,fim=?,slot=? WHERE id=?', h.tid, h.mid, h.dia, h.inicio, h.fim, h.slot, id));
  if (atual.turma_id !== h.tid) (await avisoHorario('cancelada', atual));
  (await avisoHorario(atual.turma_id !== h.tid ? 'adicionada' : 'alterada', { turma_id: h.tid, materia_id: h.mid, professor_id: user.id, dia: h.dia, inicio: h.inicio, fim: h.fim }));
  return (await db.get(`${SQL_HOR} WHERE h.id=?`, id));
});
rota('DELETE', '/api/horarios/:id', { auth: 'professor' }, async ({ user, params }) => {
  const h = (await db.get('SELECT * FROM horarios WHERE id=?', inteiro(params.id, 'Horário')));
  if (!h || h.professor_id !== user.id) erro(403, 'Você só pode excluir seus próprios horários.');
  (await db.run('DELETE FROM horarios WHERE id=?', h.id));
  (await avisoHorario('cancelada', h));
  return { ok: true };
});

/* ---------- atividades ---------- */
const SQL_ATV = `SELECT a.*,m.nome materia,t.nome turma,u.nome professor FROM atividades a JOIN materias m ON m.id=a.materia_id
  JOIN turmas t ON t.id=a.turma_id JOIN usuarios u ON u.id=a.professor_id`;
const SQL_ATV_ALUNO = SQL_ATV.replace('SELECT a.*', 'SELECT a.*,CASE WHEN EXISTS(SELECT 1 FROM atividades_concluidas c WHERE c.atividade_id=a.id AND c.aluno_id=?) THEN 1 ELSE 0 END concluida');
const atividadesDe = async (user) => (user.perfil === 'professor'
  ? (await db.all(`${SQL_ATV} WHERE a.professor_id=? ORDER BY a.prazo DESC`, user.id))
  : user.perfil === 'aluno'
    ? (await db.all(`${SQL_ATV_ALUNO} WHERE a.turma_id IN (SELECT turma_id FROM aluno_turmas WHERE aluno_id=?) ORDER BY a.prazo`, user.id, user.id))
    : (await db.all(`${SQL_ATV} ORDER BY a.prazo DESC LIMIT 500`)));
rota('GET', '/api/atividades', { auth: true }, async ({ user }) => (await atividadesDe(user)));

async function lerAtividade(user, b) {
  const tid = inteiro(b.turma_id, 'Turma'), mid = inteiro(b.materia_id, 'Matéria');
  (await exigeLeciona(user, tid, mid));
  const prazo = typeof b.prazo === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(b.prazo) ? b.prazo : erro(400, 'Prazo inválido.');
  dataOk(prazo.slice(0, 10), 'Prazo');
  return { tid, mid, titulo: txt(b.titulo, 120, 'Título'), descricao: txt(b.descricao, 1000, 'Descrição', false), prazo: prazo.length === 10 ? prazo + 'T23:59' : prazo };
}
const alvosAtividade = async (turmaId, prof) => [...(await idsAlunosTurma(turmaId)), prof, ...(await idsProfessoresTurma(turmaId))];
rota('POST', '/api/atividades', { auth: 'professor' }, async ({ user, body: b }) => {
  const a = (await lerAtividade(user, b));
  const r = (await db.get('INSERT INTO atividades(turma_id,materia_id,professor_id,titulo,descricao,prazo,criado_em) VALUES(?,?,?,?,?,?,?) RETURNING id', a.tid, a.mid, user.id, a.titulo, a.descricao, a.prazo, agora()));
  for (const al of (await idsAlunosTurma(a.tid))) (await notificar(al, 'atividade', 'Nova atividade publicada', `${(await nomeMateria(a.mid))}: ${a.titulo} (prazo ${a.prazo.replace('T', ' ')})`));
  (await lembretes());
  atualizar((await alvosAtividade(a.tid, user.id)), 'atividades');
  return (await db.get(`${SQL_ATV} WHERE a.id=?`, r.id));
});
rota('PUT', '/api/atividades/:id', { auth: 'professor' }, async ({ user, params, body: b }) => {
  const id = inteiro(params.id, 'Atividade');
  const at = (await db.get('SELECT * FROM atividades WHERE id=?', id));
  if (!at || at.professor_id !== user.id) erro(403, 'Você só pode editar suas próprias atividades.');
  const a = (await lerAtividade(user, b));
  (await db.run('UPDATE atividades SET turma_id=?,materia_id=?,titulo=?,descricao=?,prazo=? WHERE id=?', a.tid, a.mid, a.titulo, a.descricao, a.prazo, id));
  (await db.run("DELETE FROM notificacoes WHERE chave LIKE ? AND lida=0", `lembrete:${id}:%`));
  for (const al of (await idsAlunosTurma(a.tid))) (await notificar(al, 'atividade', 'Atividade atualizada', `${(await nomeMateria(a.mid))}: ${a.titulo} (prazo ${a.prazo.replace('T', ' ')})`));
  (await lembretes());
  atualizar((await alvosAtividade(a.tid, user.id)), 'atividades');
  return (await db.get(`${SQL_ATV} WHERE a.id=?`, id));
});
rota('DELETE', '/api/atividades/:id', { auth: 'professor' }, async ({ user, params }) => {
  const at = (await db.get('SELECT * FROM atividades WHERE id=?', inteiro(params.id, 'Atividade')));
  if (!at || at.professor_id !== user.id) erro(403, 'Você só pode excluir suas próprias atividades.');
  (await db.run('DELETE FROM atividades WHERE id=?', at.id));
  for (const al of (await idsAlunosTurma(at.turma_id))) (await notificar(al, 'atividade', 'Atividade cancelada', `${(await nomeMateria(at.materia_id))}: ${at.titulo}`));
  atualizar((await alvosAtividade(at.turma_id, user.id)), 'atividades');
  return { ok: true };
});
rota('PUT', '/api/atividades/:id/concluida', { auth: 'aluno' }, async ({ user, params, body: b }) => {
  const at = (await db.get('SELECT turma_id FROM atividades WHERE id=?', inteiro(params.id, 'Atividade')));
  if (!at || !(await alunoNaTurma(user.id, at.turma_id))) erro(403, 'Atividade não disponível para você.');
  const id = Number(params.id);
  if (b.concluida) (await db.run('INSERT INTO atividades_concluidas VALUES(?,?) ON CONFLICT DO NOTHING', user.id, id));
  else (await db.run('DELETE FROM atividades_concluidas WHERE aluno_id=? AND atividade_id=?', user.id, id));
  return { ok: true };
});

/* ---------- calendário escolar ---------- */
const SQL_EV = `SELECT c.*,t.nome turma,m.nome materia,u.nome autor FROM calendario c LEFT JOIN turmas t ON t.id=c.turma_id
  LEFT JOIN materias m ON m.id=c.materia_id JOIN usuarios u ON u.id=c.usuario_id`;

async function eventosVisiveis(user, f = {}) {
  const w = [], p = [];
  if (user.perfil === 'aluno') { w.push('(c.usuario_id=? OR c.turma_id IN (SELECT turma_id FROM aluno_turmas WHERE aluno_id=?))'); p.push(user.id, user.id); }
  else if (user.perfil === 'professor') { w.push('(c.usuario_id=? OR c.turma_id IN (SELECT turma_id FROM professor_turmas WHERE professor_id=? AND aprovado=1))'); p.push(user.id, user.id); }
  else { w.push('(c.usuario_id=? OR c.turma_id IS NOT NULL)'); p.push(user.id); }
  if (f.de) { w.push('c.data>=?'); p.push(f.de); }
  if (f.ate) { w.push('c.data<=?'); p.push(f.ate); }
  if (f.turma_id) { w.push('c.turma_id=?'); p.push(f.turma_id); }
  if (f.materia_id) { w.push('c.materia_id=?'); p.push(f.materia_id); }
  if (f.categoria) { w.push('c.categoria=?'); p.push(f.categoria); }
  return (await db.all(`${SQL_EV} WHERE ${w.join(' AND ')} ORDER BY c.data,c.inicio`, ...p));
}
async function atividadesNoPeriodo(user, f) {
  const w = ['date(a.prazo)>=?', 'date(a.prazo)<=?'], p = [f.de, f.ate];
  let sql = SQL_ATV, extra = [];
  if (user.perfil === 'aluno') { sql = SQL_ATV_ALUNO; extra = [user.id]; w.push('a.turma_id IN (SELECT turma_id FROM aluno_turmas WHERE aluno_id=?)'); p.push(user.id); }
  else if (user.perfil === 'professor') { w.push('a.professor_id=?'); p.push(user.id); }
  if (f.turma_id) { w.push('a.turma_id=?'); p.push(f.turma_id); }
  if (f.materia_id) { w.push('a.materia_id=?'); p.push(f.materia_id); }
  return (await db.all(`${sql} WHERE ${w.join(' AND ')} ORDER BY a.prazo`, ...extra, ...p));
}
// lista unificada (eventos + prazos de atividades) usada pelo calendário e pela página inicial
async function itensCalendario(user, f) {
  const eventos = (await eventosVisiveis(user, f)).map((e) => ({
    tipo: 'evento', id: e.id, titulo: e.titulo, descricao: e.descricao, data: e.data, inicio: e.inicio, fim: e.fim, categoria: e.categoria,
    turma_id: e.turma_id, turma: e.turma, materia_id: e.materia_id, materia: e.materia, autor: e.autor,
    editavel: e.usuario_id === user.id || (user.perfil === 'administrador' && e.turma_id != null),
  }));
  const ativ = !f.categoria || f.categoria === 'atividade'
    ? (await atividadesNoPeriodo(user, f)).map((a) => ({
      tipo: 'atividade', id: a.id, titulo: a.titulo, descricao: a.descricao, data: a.prazo.slice(0, 10), inicio: a.prazo.slice(11), fim: null, categoria: 'atividade',
      turma_id: a.turma_id, turma: a.turma, materia_id: a.materia_id, materia: a.materia, autor: a.professor, editavel: false, concluida: a.concluida ? 1 : 0,
    })) : [];
  return [...eventos, ...ativ].sort((a, b) => (a.data + (a.inicio || '')).localeCompare(b.data + (b.inicio || '')));
}
function lerFiltros(query) {
  const hoje = new Date(), de = query.de ? dataOk(query.de, 'Data inicial') : ymd(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
  const ate = query.ate ? dataOk(query.ate, 'Data final') : ymd(new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0));
  if (ate < de || (Date.parse(ate) - Date.parse(de)) / 864e5 > 400) erro(400, 'Período inválido (máximo de 400 dias).');
  const f = { de, ate, turma_id: inteiroOpc(query.turma_id, 'Turma'), materia_id: inteiroOpc(query.materia_id, 'Matéria') };
  if (query.categoria) { if (!CATEGORIAS.includes(query.categoria)) erro(400, 'Categoria inválida.'); f.categoria = query.categoria; }
  return f;
}
rota('GET', '/api/calendario', { auth: true }, async ({ user, query }) => (await itensCalendario(user, lerFiltros(query))));
rota('GET', '/api/agenda', { auth: true }, async ({ user }) => (await eventosVisiveis(user)));

const addMin = (hhmm, m) => { const t = Math.min(23 * 60 + 59, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + m); return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };
async function lerEvento(user, b) {
  const data = dataOk(b.data);
  const inicio = b.inicio ? hora(b.inicio, 'Início') : null, fim = b.fim ? hora(b.fim, 'Término') : null;
  if (fim && !inicio) erro(400, 'Informe o horário de início.');
  if (inicio && fim && inicio >= fim) erro(400, 'O término deve ser depois do início.');
  const categoria = b.categoria === undefined || b.categoria === '' ? 'evento' : b.categoria;
  if (!CATEGORIAS.includes(categoria)) erro(400, 'Categoria inválida.');
  const materia = inteiroOpc(b.materia_id, 'Matéria');
  if (materia && !(await db.get('SELECT 1 FROM materias WHERE id=?', materia))) erro(400, 'Matéria inexistente.');
  let turma = null;
  if (b.turma_id !== undefined && b.turma_id !== null && b.turma_id !== '') {
    if (user.perfil === 'aluno') erro(403, 'Alunos só podem criar eventos pessoais.');
    turma = inteiro(b.turma_id, 'Turma');
    if (!(await db.get('SELECT 1 FROM turmas WHERE id=?', turma))) erro(400, 'Turma inexistente.');
    if (user.perfil === 'professor' && !(await ensinaTurma(user.id, turma))) erro(403, 'Você não está vinculado a esta turma.');
    if (user.perfil === 'professor' && materia && !(await leciona(user.id, turma, materia))) erro(403, 'Você não leciona esta matéria nesta turma.');
  } else if (user.perfil === 'professor' && materia && !(await ensinaMateria(user.id, materia))) erro(403, 'Você não leciona esta matéria.');
  return { titulo: txt(b.titulo, 80, 'Título'), descricao: txt(b.descricao, 300, 'Descrição', false), data, inicio, fim, turma, categoria, materia };
}
// evita eventos repetidos e choque de horário na mesma turma (ou entre eventos pessoais do mesmo usuário)
async function checarEvento(user, e, ignorarId = 0) {
  const mesmos = e.turma
    ? (await db.all('SELECT * FROM calendario WHERE data=? AND turma_id=? AND id<>?', e.data, e.turma, ignorarId))
    : (await db.all('SELECT * FROM calendario WHERE data=? AND turma_id IS NULL AND usuario_id=? AND id<>?', e.data, user.id, ignorarId));
  const dup = mesmos.find((o) => o.titulo.toLowerCase() === e.titulo.toLowerCase() && (o.inicio || '') === (e.inicio || '') && (o.materia_id || 0) === (e.materia || 0));
  if (dup) erro(409, 'Já existe um evento igual nesta data.');
  if (e.inicio) {
    const fimNovo = e.fim || addMin(e.inicio, 60);
    const c = mesmos.find((o) => o.inicio && o.inicio < fimNovo && (o.fim || addMin(o.inicio, 60)) > e.inicio);
    if (c) erro(409, `Conflito de horário com "${c.titulo}" (${c.inicio}${c.fim ? '–' + c.fim : ''}).`);
  }
}
const alvosEvento = async (turma, autor) => (turma ? [autor, ...(await idsAlunosTurma(turma)), ...(await idsProfessoresTurma(turma))] : [autor]);
const avisoEvento = async (acao, e) => {
  if (!e.turma) return;
  const quando = `${e.data.split('-').reverse().join('/')}${e.inicio ? ' às ' + e.inicio : ''}`;
  for (const a of (await idsAlunosTurma(e.turma))) (await notificar(a, 'evento', `${e.categoria === 'prova' ? 'Prova' : 'Evento'} ${acao}`, `${e.titulo} — ${quando}`));
};
rota('POST', '/api/agenda', { auth: true }, async ({ user, body: b }) => {
  const e = (await lerEvento(user, b));
  const id = (await db.tx(async () => {
    (await checarEvento(user, e));
    return (await db.get('INSERT INTO calendario(usuario_id,turma_id,titulo,descricao,data,inicio,fim,categoria,materia_id) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id', user.id, e.turma, e.titulo, e.descricao, e.data, e.inicio, e.fim, e.categoria, e.materia)).id;
  }));
  (await avisoEvento('adicionado', e));
  (await lembretes());
  atualizar((await alvosEvento(e.turma, user.id)), 'calendario');
  return (await db.get(`${SQL_EV} WHERE c.id=?`, id));
});
async function eventoEditavel(user, id) {
  const at = (await db.get('SELECT * FROM calendario WHERE id=?', id));
  if (!at || !(at.usuario_id === user.id || (user.perfil === 'administrador' && at.turma_id != null))) erro(403, 'Você não tem permissão para alterar este evento.');
  return at;
}
rota('PUT', '/api/agenda/:id', { auth: true }, async ({ user, params, body: b }) => {
  const id = inteiro(params.id, 'Evento');
  const at = (await eventoEditavel(user, id));
  const e = (await lerEvento(user, b));
  (await db.tx(async () => {
    (await checarEvento(user, e, id));
    (await db.run('UPDATE calendario SET turma_id=?,titulo=?,descricao=?,data=?,inicio=?,fim=?,categoria=?,materia_id=? WHERE id=?', e.turma, e.titulo, e.descricao, e.data, e.inicio, e.fim, e.categoria, e.materia, id));
  }));
  (await db.run('DELETE FROM notificacoes WHERE chave LIKE ? AND lida=0', `ev:${id}:%`));
  (await avisoEvento('alterado', e));
  (await lembretes());
  atualizar([...(await alvosEvento(e.turma, at.usuario_id)), ...(await alvosEvento(at.turma_id, at.usuario_id))], 'calendario');
  return (await db.get(`${SQL_EV} WHERE c.id=?`, id));
});
rota('DELETE', '/api/agenda/:id', { auth: true }, async ({ user, params }) => {
  const at = (await eventoEditavel(user, inteiro(params.id, 'Evento')));
  (await db.run('DELETE FROM calendario WHERE id=?', at.id));
  (await avisoEvento('cancelado', { turma: at.turma_id, titulo: at.titulo, data: at.data, inicio: at.inicio, categoria: at.categoria }));
  atualizar((await alvosEvento(at.turma_id, at.usuario_id)), 'calendario');
  return { ok: true };
});

/* ---------- avisos dos professores ---------- */
rota('POST', '/api/avisos', { auth: 'professor' }, async ({ user, body: b }) => {
  const tid = inteiro(b.turma_id, 'Turma');
  if (!(await ensinaTurma(user.id, tid))) erro(403, 'Você não está vinculado a esta turma.');
  const titulo = txt(b.titulo, 100, 'Título'), msg = txt(b.mensagem, 600, 'Mensagem');
  const ids = (await idsAlunosTurma(tid));
  for (const a of ids) (await notificar(a, 'aviso', `Aviso: ${titulo}`, `${user.nome} (${(await nomeTurma(tid))}): ${msg}`));
  return { enviados: ids.length };
});

/* ---------- painel consolidado (uma requisição por tela inicial) ---------- */
rota('GET', '/api/painel', { auth: ['aluno', 'professor'] }, async ({ user }) => {
  const hoje = new Date(), de = ymd(hoje), ate = ymd(new Date(hoje.getTime() + 14 * 864e5));
  const base = { horarios: (await horariosDo(user)), atividades: (await atividadesDe(user)), proximos: (await itensCalendario(user, { de, ate })).filter((i) => i.tipo === 'evento' || !i.concluida).slice(0, 6) };
  return user.perfil === 'aluno' ? { ...base, notas: (await notasAluno(user.id)) } : { ...base, resumo: (await resumoProf(user.id)) };
});

/* ---------- notificações ---------- */
rota('GET', '/api/notificacoes', { auth: true }, async ({ user }) => ({
  itens: (await db.all('SELECT * FROM notificacoes WHERE usuario_id=? ORDER BY criado_em DESC,id DESC LIMIT 200', user.id)),
  nao_lidas: (await db.get('SELECT COUNT(*) n FROM notificacoes WHERE usuario_id=? AND lida=0', user.id)).n,
}));
rota('POST', '/api/notificacoes/ler-todas', { auth: true }, async ({ user }) => { (await db.run('UPDATE notificacoes SET lida=1 WHERE usuario_id=?', user.id)); return { ok: true }; });
rota('PATCH', '/api/notificacoes/:id', { auth: true }, async ({ user, params, body: b }) => {
  const r = (await db.run('UPDATE notificacoes SET lida=? WHERE id=? AND usuario_id=?', b.lida ? 1 : 0, inteiro(params.id, 'Notificação'), user.id));
  if (!r.changes) erro(404, 'Notificação não encontrada.');
  return { ok: true };
});
rota('DELETE', '/api/notificacoes/:id', { auth: true }, async ({ user, params }) => {
  const r = (await db.run('DELETE FROM notificacoes WHERE id=? AND usuario_id=?', inteiro(params.id, 'Notificação'), user.id));
  if (!r.changes) erro(404, 'Notificação não encontrada.');
  return { ok: true };
});
rota('GET', '/api/eventos', { auth: true, raw: true }, async ({ user, req, res }) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 4000\n\n');
  if (!streams.has(user.id)) streams.set(user.id, new Set());
  const set = streams.get(user.id);
  while (set.size >= MAX_STREAMS) { const velho = set.values().next().value; set.delete(velho); velho.end(); }
  set.add(res);
  const hb = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(hb); streams.get(user.id)?.delete(res); });
});

/* ---------- lembretes de prazo e de eventos (48 h) ---------- */
async function lembretes() {
  const ini = new Date(), fim = new Date(Date.now() + 48 * 36e5);
  for (const a of (await db.all('SELECT * FROM atividades WHERE prazo>=? AND prazo<=?', localStr(ini), localStr(fim)))) {
    const msg = `${(await nomeMateria(a.materia_id))}: ${a.titulo} vence em ${a.prazo.replace('T', ' ')}`;
    const chave = `lembrete:${a.id}:${a.prazo}`;
    for (const al of (await db.all('SELECT aluno_id id FROM aluno_turmas WHERE turma_id=? AND aluno_id NOT IN (SELECT aluno_id FROM atividades_concluidas WHERE atividade_id=?)', a.turma_id, a.id)))
      (await notificar(al.id, 'lembrete', 'Atividade perto do prazo', msg, chave));
    (await notificar(a.professor_id, 'lembrete', 'Atividade perto do prazo', `${(await nomeTurma(a.turma_id))} · ${msg}`, chave));
  }
  for (const e of (await db.all('SELECT * FROM calendario WHERE data>=? AND data<=?', ymd(ini), ymd(fim)))) {
    if (e.inicio && (localStr(new Date(`${e.data}T${e.inicio}`)) < localStr(ini) || localStr(new Date(`${e.data}T${e.inicio}`)) > localStr(fim))) continue;
    const rot = e.categoria === 'prova' ? 'Prova próxima' : e.categoria === 'trabalho' ? 'Trabalho próximo' : 'Compromisso próximo';
    const msg = `${e.titulo} — ${e.data.split('-').reverse().join('/')}${e.inicio ? ' às ' + e.inicio : ''}`;
    const chave = `ev:${e.id}:${e.data}:${e.inicio || ''}`;
    const dest = new Set([e.usuario_id, ...(e.turma_id ? (await idsAlunosTurma(e.turma_id)) : [])]);
    for (const u of dest) (await notificar(u, 'lembrete', rot, msg, chave));
  }
}
setInterval(async () => {
  try {
    await lembretes();
    (await db.run('DELETE FROM sessoes WHERE expira_em<? OR ultimo_uso<?', agora(), new Date(Date.now() - OCIOSO_MS).toISOString()));
    (await db.run('DELETE FROM notificacoes WHERE lida=1 AND criado_em<?', new Date(Date.now() - 90 * 864e5).toISOString()));
  } catch (e) { console.error(e); }
}, 5 * 60e3).unref();

/* ---------- módulos: administração, relatórios e histórico ---------- */
const ctx = {
  rota, db, erro, txt, inteiro, inteiroOpc, hora, dataOk, ymd, localStr, agora, notificar, atualizar, auditar, revogarSessoes, limite,
  leciona, ensinaTurma, ensinaMateria, alunoNaTurma, turmasProf, materiasProf, gravarVinculos, prepararUsuario, inserirUsuario, resolverVinculos,
  idsAlunosTurma, idsProfessoresTurma, idsAdmins, nomeMateria, nomeTurma, emailOk, foto, hashSenha, novoSalt, problemaSenha,
  TURNOS, CATEGORIAS, MEDIA_MINIMA, perfilCompleto, ORDEM_ETAPA,
};
registrarAdmin(ctx);
registrarRelatorios(ctx);

/* ---------- servidor HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const COMPRIMIVEL = new Set(['.html', '.css', '.js', '.svg', '.json']);
const SEC = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  ...(SECURE ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

async function lerCorpo(req) {
  let tam = 0; const partes = [];
  for await (const c of req) { tam += c.length; if (tam > 700_000) erro(413, 'Requisição muito grande.'); partes.push(c); }
  if (!partes.length) return {};
  try { const j = JSON.parse(Buffer.concat(partes).toString()); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { erro(400, 'JSON inválido.'); }
}
const aceitaGzip = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '');
async function json(req, res, status, obj) {
  let corpo = Buffer.from(JSON.stringify(obj));
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...SEC };
  if (status === 413) h.Connection = 'close';   // o corpo não foi lido por inteiro: não reutilizar a conexão
  if (corpo.length > 1024 && aceitaGzip(req)) { corpo = await gzip(corpo); h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = corpo.length;
  res.writeHead(status, h); res.end(corpo);
}

const estaticos = new Map();
async function servirEstatico(req, res, url) {
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p || p.endsWith('/') || p.endsWith('\\')) p += 'index.html';
  let arq = join(PUBLIC, p);
  if (!arq.startsWith(PUBLIC)) erro(403, 'Acesso negado.');
  let st = await stat(arq).catch(() => null);
  if (!st?.isFile()) {
    if (extname(p)) erro(404, 'Arquivo não encontrado.');     // só rotas sem extensão caem na SPA
    p = 'index.html'; arq = join(PUBLIC, p); st = await stat(arq);
  }
  const ext = extname(p), etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
  const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ...SEC };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
  let e = estaticos.get(arq);
  if (!e || e.etag !== etag) { e = { etag, buf: await readFile(arq), gz: null }; estaticos.set(arq, e); }
  let corpo = e.buf;
  if (COMPRIMIVEL.has(ext) && corpo.length > 1024 && aceitaGzip(req)) { e.gz ??= await gzip(e.buf); corpo = e.gz; h['Content-Encoding'] = 'gzip'; }
  h['Content-Length'] = corpo.length;
  res.writeHead(200, h); res.end(corpo);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) {
      const r = rotas.find((x) => x.metodo === req.method && x.re.test(url.pathname));
      if (!r) erro(404, 'Rota não encontrada.');
      const mutacao = req.method !== 'GET';
      if (mutacao) {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) erro(415, 'Content-Type deve ser application/json.');
        const sfs = req.headers['sec-fetch-site'];
        if (sfs && sfs !== 'same-origin' && sfs !== 'none') erro(403, 'Origem não permitida.');
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) erro(403, 'Origem não permitida.');
      }
      const user = (await usuarioDaReq(req));
      if (r.opt.auth) {
        if (!user) erro(401, 'Faça login para continuar.');
        if (!permitido(r.opt.auth, user.perfil)) erro(403, 'Seu perfil não tem permissão para esta ação.');
      }
      const c = { req, res, user, params: r.re.exec(url.pathname).groups || {}, query: Object.fromEntries(url.searchParams), body: mutacao ? await lerCorpo(req) : {} };
      const out = await r.fn(c);
      if (r.opt.raw) return;
      return await json(req, res, 200, out ?? { ok: true });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') erro(405, 'Método não permitido.');
    await servirEstatico(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return json(req, res, e.status, { erro: e.message });
    if (e instanceof URIError) return json(req, res, 400, { erro: 'Endereço inválido.' });
    console.error(e);
    json(req, res, 500, { erro: 'Erro interno do servidor.' });
  }
}).listen(PORT, HOST, async () => {
  await lembretes().catch((e) => console.error(e));
  console.log(`Banco de dados: ${usandoPostgres ? 'PostgreSQL (Supabase)' : 'SQLite local'}`);
  console.log(`MindClass rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!(await idsAdmins()).length) console.warn('\n  ATENÇÃO: nenhum administrador cadastrado. Professores só ganham acesso às turmas após aprovação.\n  Crie um com:  node criar-admin.js\n');
});
