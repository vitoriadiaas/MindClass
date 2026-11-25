// Teste de integração: sobe o servidor com um banco temporário e valida segurança, permissões, administração,
// histórico de notas, relatórios, calendário, notificações e migração.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashSenha, novoSalt } from './auth.js';

const PORT = 3111, BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'mindclass-'));
const DBPATH = join(dir, 't.db');
const srv = spawn(process.execPath, ['server.js'], { cwd: import.meta.dirname, env: { ...process.env, PORT, DB_PATH: DBPATH }, stdio: ['ignore', 'ignore', 'inherit'] });
await new Promise((r) => setTimeout(r, 1500));
const dbt = new DatabaseSync(DBPATH);   // acesso direto ao banco apenas para preparar/violar cenários

let ok = 0, falhas = 0;
const check = (nome, cond, extra = '') => { if (cond) { ok++; console.log('  ✓', nome); } else { falhas++; console.log('  ✗', nome, extra); } };
const secao = (t) => console.log(`\n${t}`);

class Cli {
  cookie = '';
  async req(method, path, body, headers = {}) {
    const r = await fetch(BASE + path, { method, headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let j = {}; try { j = await r.json(); } catch {}
    return { s: r.status, j, h: r.headers };
  }
}
const [adm, pA, pB, aX, aW, aY, anon] = [new Cli(), new Cli(), new Cli(), new Cli(), new Cli(), new Cli(), new Cli()];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hoje = new Date(), amanha = ymd(new Date(hoje.getTime() + 864e5));
const mais = (dias) => ymd(new Date(hoje.getTime() + dias * 864e5));

try {
  /* ============================================================ */
  secao('Configuração inicial');
  const op = (await anon.req('GET', '/api/opcoes')).j;
  const MAT = op.materias.find((m) => m.nome === 'Matemática').id, HIS = op.materias.find((m) => m.nome === 'História').id, POR = op.materias.find((m) => m.nome === 'Português').id;
  const T1A = op.turmas.find((t) => t.nome === '6º ano A').id, T2B = op.turmas.find((t) => t.nome === '1º ano Administração').id, T3 = op.turmas.find((t) => t.nome === '2º ano Alimentos').id;
  const lim = Object.fromEntries(op.turmas.map((t) => [t.nome, t.num_horarios]));
  check('13 turmas oficiais; fundamental com 5 horários; médio 7/9/9/9/6',
    op.turmas.filter((t) => t.etapa !== 'outra').length === 13 && op.turmas.filter((t) => t.etapa === 'fundamental').every((t) => t.num_horarios === 5)
    && lim['1º ano Administração'] === 7 && lim['1º ano Agronegócio'] === 9 && lim['2º ano Alimentos'] === 9 && lim['3º ano Informática'] === 9 && lim['3º ano Regular'] === 6);
  check('opções trazem categorias de evento e média mínima', op.categorias.includes('prova') && op.media_minima === 6);

  // administrador: não existe cadastro público, então é criado direto no banco (como faz o npm run criar-admin)
  const salt = novoSalt();
  dbt.prepare('INSERT INTO usuarios(nome,email,senha_hash,salt,perfil,criado_em) VALUES(?,?,?,?,?,?)').run('Direção', 'diretoria@escola.com', await hashSenha('admin12345', salt), salt, 'administrador', new Date().toISOString());
  let r = await adm.req('POST', '/api/login', { email: 'diretoria@escola.com', senha: 'admin12345', perfil: 'administrador' });
  check('administrador faz login', r.s === 200 && r.j.perfil === 'administrador');
  check('cadastro público NÃO cria administrador', (await anon.req('POST', '/api/cadastro/aluno', { nome: 'Hack', email: 'hack@x.com', senha: 'senha1234', confirmacao: 'senha1234', turma_id: T3, perfil: 'administrador' })).j.perfil === 'aluno');

  /* ============================================================ */
  secao('Cadastro, senhas e validação');
  const cad = (b) => anon.req('POST', '/api/cadastro/aluno', { nome: 'Teste Silva', email: 'teste1@x.com', senha: 'senha1234', confirmacao: 'senha1234', turma_id: T1A, ...b });
  check('senha só numérica recusada', (await cad({ senha: '12345678', confirmacao: '12345678' })).s === 400);
  check('senha sem número recusada', (await cad({ senha: 'abcdefghij', confirmacao: 'abcdefghij' })).s === 400);
  check('senha curta recusada', (await cad({ senha: 'ab1', confirmacao: 'ab1' })).s === 400);
  check('senha muito comum recusada', (await cad({ senha: 'password1', confirmacao: 'password1' })).s === 400);
  check('senha contendo o e-mail recusada', (await cad({ email: 'joaozinho@x.com', senha: 'joaozinho1', confirmacao: 'joaozinho1' })).s === 400);
  check('confirmação divergente recusada', (await cad({ confirmacao: 'outra1234' })).s === 400);
  check('e-mail inválido recusado', (await cad({ email: 'sem-arroba' })).s === 400);
  check('nome vazio recusado', (await cad({ nome: '   ' })).s === 400);
  check('turma inexistente recusada', (await cad({ turma_id: 99999 })).s === 400);
  check('turma não numérica recusada', (await cad({ turma_id: 'abc' })).s === 400);

  r = await pA.req('POST', '/api/cadastro/professor', { nome: 'Ana Prof', email: 'ana@x.com', senha: 'senha1234', confirmacao: 'senha1234', turno: 'manhã', materias: [MAT, POR], turmas: [T1A] });
  check('professor A cadastrado: vínculos ficam PENDENTES (sem turmas aprovadas)', r.s === 200 && r.j.turmas.length === 0 && r.j.materias.length === 0 && r.j.pendentes.turmas.length === 1 && r.j.pendentes.materias.length === 2, JSON.stringify(r.j));
  r = await pB.req('POST', '/api/cadastro/professor', { nome: 'Bruno Prof', email: 'bruno@x.com', senha: 'senha1234', confirmacao: 'senha1234', turno: 'tarde', materias: [HIS], novas_materias: ['Robótica'], turmas: [T1A, T2B], novas_turmas: ['Turma inventada'] });
  check('professor B cadastrado; matéria nova criada; turma inventada ignorada', r.s === 200 && r.j.pendentes.materias.length === 2 && r.j.pendentes.turmas.length === 2 && !(await anon.req('GET', '/api/opcoes')).j.turmas.some((t) => t.nome === 'Turma inventada'));
  check('e-mail duplicado (sem diferenciar maiúsculas) recusado', (await cad({ email: 'ANA@x.com' })).s === 409);
  r = await aX.req('POST', '/api/cadastro/aluno', { nome: 'Xavier Aluno', email: 'x@x.com', senha: 'senha1234', confirmacao: 'senha1234', turma_id: T1A });
  const idX = r.j.id; check('aluno X cadastrado em 6º ano A', r.s === 200 && r.j.perfil === 'aluno');
  r = await aW.req('POST', '/api/cadastro/aluno', { nome: 'Wanda Aluna', email: 'w@x.com', senha: 'senha1234', confirmacao: 'senha1234', turma_id: T1A });
  const idW = r.j.id; check('aluno W cadastrado em 6º ano A', r.s === 200);
  r = await aY.req('POST', '/api/cadastro/aluno', { nome: 'Yara Aluna', email: 'y@x.com', senha: 'senha1234', confirmacao: 'senha1234', turma_id: T2B });
  const idY = r.j.id; check('aluno Y cadastrado em 1º ano Administração', r.s === 200);
  const idA = (await pA.req('GET', '/api/eu')).j.id, idB = (await pB.req('GET', '/api/eu')).j.id;
  check('administrador foi notificado das solicitações de vínculo', (await adm.req('GET', '/api/notificacoes')).j.itens.filter((n) => n.tipo === 'vinculo').length >= 2);

  /* ============================================================ */
  secao('Professor sem aprovação NÃO acessa turmas (correção de segurança)');
  check('não lista alunos da turma pendente', (await pA.req('GET', `/api/turmas/${T1A}/alunos`)).s === 403);
  check('não lança nota', (await pA.req('PUT', '/api/notas', { aluno_id: idX, materia_id: MAT, trimestre: 1, valor: 9 })).s === 403);
  check('não cria horário', (await pA.req('POST', '/api/horarios', { turma_id: T1A, materia_id: MAT, dia: 1, slot: 1 })).s === 403);
  check('não publica atividade', (await pA.req('POST', '/api/atividades', { turma_id: T1A, materia_id: MAT, titulo: 'x', prazo: `${mais(3)}T10:00` })).s === 403);
  check('não envia aviso', (await pA.req('POST', '/api/avisos', { turma_id: T1A, titulo: 'x', mensagem: 'y' })).s === 403);
  check('não vê relatório da turma', (await pA.req('GET', `/api/relatorios/turma?turma_id=${T1A}`)).s === 403);
  check('não vê relatório do aluno', (await pA.req('GET', `/api/relatorios/aluno?aluno_id=${idX}`)).s === 403);
  check('histórico de notas vem vazio (sem vínculo)', (await pA.req('GET', '/api/historico-notas')).j.total === 0);
  r = await pA.req('PUT', '/api/professor/vinculos', { materias: [MAT, POR], turmas: [T1A, T3] });
  check('professor não consegue se auto-aprovar: segue tudo pendente', r.s === 200 && r.j.turmas.length === 0 && r.j.pendentes.turmas.length === 2);
  check('professor não acessa rotas da administração', (await pA.req('GET', '/api/admin/resumo')).s === 403 && (await pA.req('POST', '/api/admin/pendencias', { professor_id: idA, aprovar: true })).s === 403);
  check('aluno não acessa rotas da administração', (await aX.req('GET', '/api/admin/usuarios')).s === 403);
  check('visitante recebe 401 nas rotas da administração', (await new Cli().req('GET', '/api/admin/resumo')).s === 401);

  /* ============================================================ */
  secao('Administração: aprovação de vínculos');
  r = await adm.req('GET', '/api/admin/pendencias');
  check('lista pendências com os dois professores', r.s === 200 && r.j.length === 2 && r.j.find((p) => p.id === idA).turmas_pendentes.length === 2);
  check('administrador rejeita só a turma 2º Alimentos', (await adm.req('POST', '/api/admin/pendencias', { professor_id: idA, tipo: 'turma', ref_id: T3, aprovar: false })).j.alterados === 1);
  check('aprova todas as pendências do professor A', (await adm.req('POST', '/api/admin/pendencias', { professor_id: idA, aprovar: true })).j.alterados === 3);
  check('aprova todas as pendências do professor B', (await adm.req('POST', '/api/admin/pendencias', { professor_id: idB, aprovar: true })).j.alterados === 4);
  r = await pA.req('GET', '/api/eu');
  check('professor A agora tem 1 turma e 2 matérias aprovadas', r.j.turmas.length === 1 && r.j.turmas[0].id === T1A && r.j.materias.length === 2 && r.j.pendentes.turmas.length === 0);
  check('professor foi notificado da aprovação', (await pA.req('GET', '/api/notificacoes')).j.itens.some((n) => n.tipo === 'vinculo' && /aprovad/i.test(n.titulo)));
  check('decisão sobre professor inexistente = 404', (await adm.req('POST', '/api/admin/pendencias', { professor_id: idX, aprovar: true })).s === 404);
  check('alunos da turma agora listados', (await pA.req('GET', `/api/turmas/${T1A}/alunos`)).j.length === 2);
  check('professor A ainda não acessa a turma que não foi aprovada', (await pA.req('GET', `/api/turmas/${T3}/alunos`)).s === 403);

  /* ============================================================ */
  secao('Sessões, cookies e login');
  r = await anon.req('POST', '/api/login', { email: 'x@x.com', senha: 'errada123' });
  const r2 = await anon.req('POST', '/api/login', { email: 'naoexiste@x.com', senha: 'errada123' });
  check('mesma mensagem para senha errada e e-mail inexistente (sem enumerar contas)', r.s === 401 && r2.s === 401 && r.j.erro === r2.j.erro);
  check('login com perfil trocado = 403', (await anon.req('POST', '/api/login', { email: 'x@x.com', senha: 'senha1234', perfil: 'professor' })).s === 403);
  const c1 = new Cli(), c2 = new Cli();
  r = await c1.req('POST', '/api/login', { email: 'x@x.com', senha: 'senha1234', perfil: 'aluno' });
  const sc = r.h.get('set-cookie');
  check('cookie de sessão é HttpOnly e SameSite=Strict', r.s === 200 && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Max-Age=\d+/.test(sc));
  await c2.req('POST', '/api/login', { email: 'x@x.com', senha: 'senha1234' });
  check('troca de senha exige a senha atual', (await c1.req('PATCH', '/api/perfil', { nova_senha: 'novasenha99', senha_atual: 'errada1' })).s === 403);
  check('troca de senha recusa senha fraca', (await c1.req('PATCH', '/api/perfil', { nova_senha: '12345678', senha_atual: 'senha1234' })).s === 400);
  check('troca de senha correta mantém a sessão atual', (await c1.req('PATCH', '/api/perfil', { nova_senha: 'novasenha99', senha_atual: 'senha1234' })).s === 200 && (await c1.req('GET', '/api/eu')).j.id === idX);
  check('troca de senha ENCERRA as outras sessões', (await c2.req('GET', '/api/horarios')).s === 401);
  check('senha antiga não funciona mais; a nova sim', (await anon.req('POST', '/api/login', { email: 'x@x.com', senha: 'senha1234' })).s === 401 && (await new Cli().req('POST', '/api/login', { email: 'x@x.com', senha: 'novasenha99' })).s === 200);
  const c3 = new Cli(); await c3.req('POST', '/api/login', { email: 'x@x.com', senha: 'novasenha99' });
  check('"sair de todos os dispositivos" derruba todas as sessões', (await c3.req('POST', '/api/logout-todas')).s === 200 && (await c1.req('GET', '/api/eu')).j.anonimo === true && (await c3.req('GET', '/api/horarios')).s === 401);
  await aX.req('POST', '/api/login', { email: 'x@x.com', senha: 'novasenha99' });
  dbt.prepare('UPDATE sessoes SET ultimo_uso=? WHERE usuario_id=?').run(new Date(Date.now() - 13 * 36e5).toISOString(), idX);
  check('sessão expira por inatividade (12 h)', (await aX.req('GET', '/api/horarios')).s === 401);
  await aX.req('POST', '/api/login', { email: 'x@x.com', senha: 'novasenha99' });
  dbt.prepare('UPDATE sessoes SET expira_em=? WHERE usuario_id=?').run(new Date(Date.now() - 1000).toISOString(), idX);
  check('sessão expira no prazo absoluto', (await aX.req('GET', '/api/horarios')).s === 401);
  await aX.req('POST', '/api/login', { email: 'x@x.com', senha: 'novasenha99' });
  check('logout encerra a sessão', (await aX.req('POST', '/api/logout')).s === 200 && (await aX.req('GET', '/api/horarios')).s === 401);
  await aX.req('POST', '/api/login', { email: 'x@x.com', senha: 'novasenha99' });
  let ultimo = 0; for (let i = 0; i < 12; i++) ultimo = (await anon.req('POST', '/api/login', { email: 'limite@x.com', senha: 'errada123' })).s;
  check('muitas tentativas de login erradas = 429', ultimo === 429);

  /* ============================================================ */
  secao('Segurança das requisições');
  check('sem login = 401', (await new Cli().req('GET', '/api/horarios')).s === 401);
  check('POST sem JSON = 415', (await fetch(BASE + '/api/login', { method: 'POST', body: 'x' })).status === 415);
  check('origem externa bloqueada', (await anon.req('POST', '/api/login', { email: 'x@x.com', senha: 'novasenha99' }, { Origin: 'http://evil.example' })).s === 403);
  check('Sec-Fetch-Site cross-site bloqueado', (await aX.req('POST', '/api/notificacoes/ler-todas', {}, { 'Sec-Fetch-Site': 'cross-site' })).s === 403);
  let gig; try { gig = (await anon.req('POST', '/api/login', { email: 'a@a.com', senha: 'x'.repeat(800_000) })).s; } catch { gig = 413; }
  check('corpo gigante = 413', gig === 413);
  check('JSON inválido = 400', (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })).status === 400);
  check('SQL injection no login não derruba nem entra', (await anon.req('POST', '/api/login', { email: "' OR 1=1 --@x.com", senha: "' OR '1'='1" })).s === 401);
  check('foto com conteúdo não-imagem recusada', (await aX.req('PATCH', '/api/perfil', { foto: 'data:text/html;base64,PHNjcmlwdD4=' })).s === 400);
  const home = await fetch(BASE + '/');
  check('cabeçalhos de segurança (CSP, nosniff, frame, permissões)', /script-src 'self'/.test(home.headers.get('content-security-policy')) && home.headers.get('x-content-type-options') === 'nosniff' && home.headers.get('x-frame-options') === 'DENY' && !!home.headers.get('permissions-policy'));
  check('arquivo inexistente com extensão = 404 (não cai na SPA)', (await fetch(BASE + '/nao-existe.js')).status === 404);
  const pt = await fetch(BASE + '/..%2f..%2fserver.js');
  check('path traversal bloqueado (não expõe código do servidor)', !(await pt.text()).includes('registrarAdmin'));
  const js = await fetch(BASE + '/app.js', { headers: { 'accept-encoding': 'gzip' } });
  const etag = js.headers.get('etag');
  check('app.js é servido comprimido (gzip) com ETag', js.headers.get('content-encoding') === 'gzip' && !!etag);
  check('revalidação por ETag responde 304', (await fetch(BASE + '/app.js', { headers: { 'if-none-match': etag } })).status === 304);

  /* ============================================================ */
  secao('Notas, permissões e HISTÓRICO imutável');
  r = await pA.req('PUT', '/api/notas', { aluno_id: idX, materia_id: MAT, trimestre: 1, valor: 8.5 });
  check('professor A lança nota de Matemática ao aluno X', r.s === 200 && r.j.valor === 8.5);
  const notaId = r.j.id;
  check('professor A não lança em História', (await pA.req('PUT', '/api/notas', { aluno_id: idX, materia_id: HIS, trimestre: 1, valor: 7 })).s === 403);
  check('professor A não lança a aluno de outra turma (Y)', (await pA.req('PUT', '/api/notas', { aluno_id: idY, materia_id: MAT, trimestre: 1, valor: 7 })).s === 403);
  check('nota fora de 0–10 / texto / 4º trimestre recusados', (await pA.req('PUT', '/api/notas', { aluno_id: idX, materia_id: MAT, trimestre: 2, valor: 11 })).s === 400 && (await pA.req('PUT', '/api/notas', { aluno_id: idX, materia_id: MAT, trimestre: 2, valor: 'abc' })).s === 400 && (await pA.req('PUT', '/api/notas', { aluno_id: idX, materia_id: MAT, trimestre: 4, valor: 5 })).s === 400);
  check('professor B não lê notas de Matemática', (await pB.req('GET', `/api/notas?turma_id=${T1A}&materia_id=${MAT}`)).s === 403);
  check('aluno NÃO lança nota nem lê a tela de edição', (await aX.req('PUT', '/api/notas', { aluno_id: idX, materia_id: MAT, trimestre: 1, valor: 10 })).s === 403 && (await aX.req('GET', `/api/notas?turma_id=${T1A}&materia_id=${MAT}`)).s === 403);
  check('aluno X vê só a própria nota; Y não vê a do X', (await aX.req('GET', '/api/aluno/notas')).j[0].media === 8.5 && (await aY.req('GET', '/api/aluno/notas')).j.length === 0);
  await pA.req('PUT', '/api/notas', { aluno_id: idX, materia_id: MAT, trimestre: 1, valor: 9 });
  await pA.req('PUT', '/api/notas', { aluno_id: idX, materia_id: MAT, trimestre: 1, valor: 9 });     // mesmo valor: não gera registro
  check('aluno notificado: nova nota e nota atualizada (e nada ao repetir o mesmo valor)', (await aX.req('GET', '/api/notificacoes')).j.itens.filter((n) => n.tipo === 'nota').map((n) => n.titulo).sort().join() === 'Nota atualizada,Nova nota cadastrada');
  check('aluno não exclui nota; professor B não exclui nota alheia', (await aX.req('DELETE', `/api/notas/${notaId}`)).s === 403 && (await pB.req('DELETE', `/api/notas/${notaId}`)).s === 403);
  check('professor A exclui a nota', (await pA.req('DELETE', `/api/notas/${notaId}`)).s === 200);
  check('após excluir, o aluno não vê mais a nota atual', (await aX.req('GET', '/api/aluno/notas')).j.length === 0);

  r = await aX.req('GET', '/api/historico-notas');
  check('histórico guarda criação, alteração e exclusão (3 registros), mais recentes primeiro', r.s === 200 && r.j.total === 3 && r.j.itens.map((h) => h.acao).join() === 'excluida,alterada,criada', JSON.stringify(r.j.itens?.map((h) => h.acao)));
  const [hEx, hAl, hCr] = r.j.itens;
  check('registro de alteração traz nota anterior e nova (8,5 → 9)', hAl.valor_anterior === 8.5 && hAl.valor_novo === 9);
  check('registro de criação: anterior nulo; exclusão: nova nula', hCr.valor_anterior === null && hCr.valor_novo === 8.5 && hEx.valor_anterior === 9 && hEx.valor_novo === null);
  check('registro identifica aluno, matéria, turma, professor, responsável, trimestre, ano e data', hAl.aluno === 'Xavier Aluno' && hAl.materia === 'Matemática' && hAl.turma === '6º ano A' && hAl.professor === 'Ana Prof' && hAl.alterado_por_nome === 'Ana Prof' && hAl.trimestre === 1 && hAl.ano_letivo === hoje.getFullYear() && /^\d{4}-\d\d-\d\dT/.test(hAl.alterado_em));
  check('o histórico permanece mesmo com a nota atual excluída', r.j.itens.length === 3);
  let bloqueou = 0;
  try { dbt.prepare('UPDATE notas_historico SET valor_novo=10 WHERE id=?').run(hAl.id); } catch { bloqueou++; }
  try { dbt.prepare('DELETE FROM notas_historico WHERE id=?').run(hAl.id); } catch { bloqueou++; }
  check('o banco IMPEDE alterar ou apagar registros do histórico (triggers)', bloqueou === 2);
  check('não existe rota para editar/excluir histórico', (await aX.req('PUT', `/api/historico-notas/${hAl.id}`, { valor_novo: 10 })).s === 404 && (await pA.req('DELETE', `/api/historico-notas/${hAl.id}`)).s === 404);
  check('aluno Y não vê o histórico do X; ?aluno_id= é ignorado para aluno', (await aY.req('GET', '/api/historico-notas')).j.total === 0 && (await aY.req('GET', `/api/historico-notas?aluno_id=${idX}`)).j.total === 0);
  check('professor A consulta o histórico das suas turmas', (await pA.req('GET', '/api/historico-notas')).j.total === 3);
  check('professor B (outra matéria) não vê histórico de Matemática', (await pB.req('GET', '/api/historico-notas')).j.total === 0 && (await pB.req('GET', `/api/historico-notas?aluno_id=${idX}`)).j.total === 0);
  check('administração vê o histórico geral', (await adm.req('GET', '/api/historico-notas')).j.total === 3);
  check('filtros: ação, matéria, trimestre, período, página', (await adm.req('GET', '/api/historico-notas?acao=excluida')).j.total === 1 && (await adm.req('GET', `/api/historico-notas?materia_id=${HIS}`)).j.total === 0
    && (await adm.req('GET', '/api/historico-notas?trimestre=2')).j.total === 0 && (await adm.req('GET', `/api/historico-notas?de=${ymd(hoje)}&ate=${ymd(hoje)}`)).j.total >= 0
    && (await adm.req('GET', '/api/historico-notas?por_pagina=1&pagina=2')).j.itens.length === 1 && (await adm.req('GET', `/api/historico-notas?turma_id=${T1A}`)).j.total === 3);
  check('filtro com data inválida = 400', (await adm.req('GET', '/api/historico-notas?de=2026-13-45')).s === 400);

  /* ============================================================ */
  secao('Relatórios de desempenho (dados reais)');
  const put = (c, a, m, b, v) => c.req('PUT', '/api/notas', { aluno_id: a, materia_id: m, trimestre: b, valor: v });
  await put(pA, idX, MAT, 1, 8); await put(pA, idX, MAT, 2, 6); await put(pA, idX, POR, 1, 4); await put(pA, idW, MAT, 1, 6);
  r = await aX.req('GET', '/api/relatorios/aluno');
  const rel = r.j, mat = rel.por_materia.find((m) => m.materia_id === MAT), por = rel.por_materia.find((m) => m.materia_id === POR);
  check('relatório do aluno: média por matéria (Mat 7,0 · Port 4,0) e média geral 5,5', r.s === 200 && mat.media === 7 && por.media === 4 && rel.geral.media === 5.5);
  check('desempenho por trimestre: 1º = 6,0 · 2º = 6,0 · sem dados nos demais', rel.por_trimestre[1] === 6 && rel.por_trimestre[2] === 6 && rel.por_trimestre[3] === null);
  check('comparação entre períodos (1º → 2º = 0)', rel.comparacao.length === 1 && rel.comparacao[0].de === 1 && rel.comparacao[0].para === 2 && rel.comparacao[0].delta === 0);
  check('matérias que precisam de atenção: Português (média baixa) e Matemática (queda de 2 pontos)', rel.atencao.length === 2 && rel.atencao.find((a) => a.materia_id === POR).motivo === 'media_baixa' && rel.atencao.find((a) => a.materia_id === MAT).motivo === 'queda');
  check('evolução por matéria (notas por trimestre) e tendência', mat.trimestres[1] === 8 && mat.trimestres[2] === 6 && mat.tendencia === -2);
  r = await aX.req('GET', '/api/relatorios/aluno?trimestre=2');
  check('filtro por trimestre: Mat 6,0 e Português sem nota', r.j.por_materia.find((m) => m.materia_id === MAT).media === 6 && r.j.por_materia.find((m) => m.materia_id === POR).situacao === 'sem_nota' && r.j.geral.media === 6);
  r = await aX.req('GET', `/api/relatorios/aluno?materia_id=${MAT}`);
  check('filtro por matéria', r.j.por_materia.length === 1 && r.j.geral.media === 7);
  check('trimestre inválido = 400', (await aX.req('GET', '/api/relatorios/aluno?trimestre=9')).s === 400);
  check('aluno não consegue ver o relatório de outro (?aluno_id= ignorado)', (await aX.req('GET', `/api/relatorios/aluno?aluno_id=${idW}`)).j.aluno.id === idX);
  check('aluno não acessa relatório de turma', (await aX.req('GET', `/api/relatorios/turma?turma_id=${T1A}`)).s === 403);
  r = await pA.req('GET', `/api/relatorios/aluno?aluno_id=${idX}`);
  check('professor A vê o relatório do aluno da sua turma', r.s === 200 && r.j.geral.media === 5.5);
  check('professor A não vê aluno de turma que não leciona', (await pA.req('GET', `/api/relatorios/aluno?aluno_id=${idY}`)).s === 403);
  check('professor B vê só as matérias que leciona (nenhuma nota de História)', (await pB.req('GET', `/api/relatorios/aluno?aluno_id=${idX}`)).j.por_materia.length === 0);
  check('relatório do aluno sem aluno_id (professor) = 400', (await pA.req('GET', '/api/relatorios/aluno')).s === 400);
  r = await pA.req('GET', `/api/relatorios/turma?turma_id=${T1A}`);
  const t = r.j;
  check('relatório da turma: 2 alunos, média geral 5,75, 1 aluno em atenção', r.s === 200 && t.alunos_total === 2 && t.geral.media === 5.75 && t.geral.em_atencao === 1);
  check('média por matéria da turma: Mat 6,5 (X=7, W=6) · Port 4,0', t.por_materia.find((m) => m.materia_id === MAT).media === 6.5 && t.por_materia.find((m) => m.materia_id === POR).media === 4);
  check('turma: por trimestre 6,0/6,0, distribuição de notas por faixa', t.por_trimestre[1] === 6 && t.por_trimestre[2] === 6 && t.distribuicao[1].alunos === 1 && t.distribuicao[2].alunos === 1 && t.distribuicao[0].alunos === 0);
  check('turma: lista de alunos com média e alerta', t.alunos.find((a) => a.id === idX).media === 5.5 && t.alunos.find((a) => a.id === idX).em_atencao === true && t.alunos.find((a) => a.id === idW).media === 6);
  r = await pA.req('GET', `/api/relatorios/turma?turma_id=${T1A}&materia_id=${MAT}&trimestre=1`);
  check('turma: filtros por matéria e trimestre', r.j.por_materia.length === 1 && r.j.por_materia[0].media === 7 && r.j.geral.media === 7);
  check('professor A não vê relatório de turma que não leciona', (await pA.req('GET', `/api/relatorios/turma?turma_id=${T2B}`)).s === 403);
  check('professor B vê a turma só com as suas matérias (sem notas de Mat/Port)', (await pB.req('GET', `/api/relatorios/turma?turma_id=${T1A}`)).j.por_materia.length === 0);
  check('administração vê relatórios de qualquer turma e aluno', (await adm.req('GET', `/api/relatorios/turma?turma_id=${T1A}`)).j.geral.media === 5.75 && (await adm.req('GET', `/api/relatorios/aluno?aluno_id=${idX}`)).j.geral.media === 5.5);

  /* ============================================================ */
  secao('Horários');
  r = await pA.req('POST', '/api/horarios', { turma_id: T1A, materia_id: MAT, dia: 1, slot: 1 });
  check('professor A cria aula no 1º horário (07:00–07:50)', r.s === 200 && r.j.inicio === '07:00' && r.j.fim === '07:50' && r.j.slot === 1); const hid = r.j.id;
  check('mesma turma/dia/horário = 409; outro professor na mesma turma = 409', (await pA.req('POST', '/api/horarios', { turma_id: T1A, materia_id: MAT, dia: 1, slot: 1 })).s === 409 && (await pB.req('POST', '/api/horarios', { turma_id: T1A, materia_id: HIS, dia: 1, slot: 1 })).s === 409);
  check('fundamental NÃO aceita 6º horário; aceita o 5º; horário 0 inválido', (await pA.req('POST', '/api/horarios', { turma_id: T1A, materia_id: MAT, dia: 2, slot: 6 })).s === 400 && (await pA.req('POST', '/api/horarios', { turma_id: T1A, materia_id: MAT, dia: 2, slot: 5 })).s === 200 && (await pA.req('POST', '/api/horarios', { turma_id: T1A, materia_id: MAT, dia: 2, slot: 0 })).s === 400);
  check('1º Administração: 7º horário ok, 8º recusado', (await pB.req('POST', '/api/horarios', { turma_id: T2B, materia_id: HIS, dia: 2, slot: 7 })).s === 200 && (await pB.req('POST', '/api/horarios', { turma_id: T2B, materia_id: HIS, dia: 2, slot: 8 })).s === 400);
  check('mesmo professor em duas turmas no mesmo horário = 409', (await pB.req('POST', '/api/horarios', { turma_id: T2B, materia_id: HIS, dia: 4, slot: 1 })).s === 200 && (await pB.req('POST', '/api/horarios', { turma_id: T1A, materia_id: HIS, dia: 4, slot: 1 })).s === 409);
  check('sábado = 400; professor A não cria aula de História', (await pA.req('POST', '/api/horarios', { turma_id: T1A, materia_id: MAT, dia: 6, slot: 2 })).s === 400 && (await pA.req('POST', '/api/horarios', { turma_id: T1A, materia_id: HIS, dia: 3, slot: 2 })).s === 403);
  check('B não edita/exclui horário do A; aluno não cria/edita horário', (await pB.req('PUT', `/api/horarios/${hid}`, { turma_id: T1A, materia_id: HIS, dia: 3, slot: 2 })).s === 403 && (await pB.req('DELETE', `/api/horarios/${hid}`)).s === 403
    && (await aX.req('POST', '/api/horarios', { turma_id: T1A, materia_id: MAT, dia: 3, slot: 2 })).s === 403 && (await aX.req('PUT', `/api/horarios/${hid}`, { turma_id: T1A, materia_id: MAT, dia: 3, slot: 2 })).s === 403);
  check('professor A edita o próprio horário (2º horário na terça → 07:50)', (await pA.req('PUT', `/api/horarios/${hid}`, { turma_id: T1A, materia_id: MAT, dia: 2, slot: 2 })).s === 200);
  check('aluno X vê a grade com professor e horário', (await aX.req('GET', '/api/horarios')).j.some((h) => h.professor === 'Ana Prof' && h.inicio === '07:50' && h.slot === 2));
  check('B cria História na turma de A; A vê "Ocupado" sem matéria/professor', (await pB.req('POST', '/api/horarios', { turma_id: T1A, materia_id: HIS, dia: 3, slot: 1 })).s === 200 && (await pA.req('GET', `/api/horarios?turma_id=${T1A}`)).j.some((h) => h.ocupado && !h.materia && !h.professor));
  check('A não vê a grade de turma que não leciona; administrador vê completa', (await pA.req('GET', `/api/horarios?turma_id=${T2B}`)).s === 403 && (await adm.req('GET', `/api/horarios?turma_id=${T1A}`)).j.every((h) => !h.ocupado));
  check('aluno Y não vê aulas da turma do X', !(await aY.req('GET', '/api/horarios')).j.some((h) => h.turma_id === T1A));

  /* ============================================================ */
  secao('Calendário escolar');
  const dia = '2026-12-10';
  const ev = (c, b) => c.req('POST', '/api/agenda', { titulo: 'Prova de Matemática', data: dia, inicio: '08:00', fim: '09:00', turma_id: T1A, materia_id: MAT, categoria: 'prova', ...b });
  r = await ev(pA, {});
  check('professor cria prova para a turma, com matéria, data, horário e categoria', r.s === 200 && r.j.categoria === 'prova' && r.j.materia === 'Matemática' && r.j.turma === '6º ano A'); const evP = r.j.id;
  check('evento duplicado = 409', (await ev(pA, {})).s === 409);
  check('conflito de horário na mesma turma = 409', (await ev(pA, { titulo: 'Outro', inicio: '08:30', fim: '09:30' })).s === 409);
  check('horário colado (09:00) não é conflito', (await ev(pB, { titulo: 'Aula de reforço', inicio: '09:00', fim: '10:00', materia_id: HIS, categoria: 'evento' })).s === 200);
  check('professor A não vincula evento a matéria que não leciona', (await ev(pA, { titulo: 'x', inicio: '15:00', fim: '16:00', materia_id: HIS })).s === 403);
  check('professor A não cria evento em turma que não leciona', (await ev(pA, { turma_id: T2B, titulo: 'x', inicio: '15:00', fim: '16:00' })).s === 403);
  check('categoria inválida / data inexistente / término antes do início = 400', (await ev(pA, { titulo: 'y', inicio: '15:00', fim: '16:00', categoria: 'festa' })).s === 400 && (await ev(pA, { titulo: 'y', data: '2026-02-30' })).s === 400 && (await ev(pA, { titulo: 'y', inicio: '16:00', fim: '15:00' })).s === 400);
  check('evento de dia inteiro sem horário aceito', (await ev(pA, { titulo: 'Feriado', inicio: '', fim: '', data: '2026-12-25', turma_id: T1A, materia_id: '', categoria: 'outro' })).s === 200);
  r = await aX.req('POST', '/api/agenda', { titulo: 'Reforço', data: dia, inicio: '14:00', fim: '15:00', categoria: 'trabalho' });
  check('aluno cria evento pessoal (sem turma)', r.s === 200 && r.j.turma_id === null); const evX = r.j.id;
  check('aluno NÃO cria evento para a turma', (await aX.req('POST', '/api/agenda', { titulo: 'x', data: dia, turma_id: T1A })).s === 403);
  check('conflito entre eventos pessoais do mesmo aluno = 409', (await aX.req('POST', '/api/agenda', { titulo: 'Outro', data: dia, inicio: '14:30', fim: '15:30' })).s === 409);
  r = await aX.req('GET', `/api/calendario?de=2026-12-01&ate=2026-12-31`);
  check('aluno vê eventos da turma + os próprios (3 em 10/12 e feriado)', r.s === 200 && r.j.filter((i) => i.data === dia).length === 3 && r.j.some((i) => i.data === '2026-12-25'));
  check('aluno Y (outra turma) não vê eventos da turma do X', (await aY.req('GET', '/api/calendario?de=2026-12-01&ate=2026-12-31')).j.length === 0);
  check('filtro por categoria (prova), matéria, turma', (await aX.req('GET', '/api/calendario?de=2026-12-01&ate=2026-12-31&categoria=prova')).j.length === 1
    && (await aX.req('GET', `/api/calendario?de=2026-12-01&ate=2026-12-31&materia_id=${HIS}`)).j.length === 1 && (await aX.req('GET', `/api/calendario?de=2026-12-01&ate=2026-12-31&turma_id=${T1A}`)).j.length === 3);
  check('período inválido, longo demais e categoria inválida = 400', (await aX.req('GET', '/api/calendario?de=2026-12-31&ate=2026-12-01')).s === 400 && (await aX.req('GET', '/api/calendario?de=2024-01-01&ate=2026-12-01')).s === 400 && (await aX.req('GET', '/api/calendario?categoria=x')).s === 400);
  r = await pA.req('POST', '/api/atividades', { turma_id: T1A, materia_id: MAT, titulo: 'Lista 1', descricao: 'Exercícios', prazo: `2026-12-12T23:59` });
  check('professor publica atividade', r.s === 200); const aid = r.j.id;
  r = await aX.req('GET', '/api/calendario?de=2026-12-01&ate=2026-12-31');
  check('prazo da atividade aparece no calendário (categoria "atividade", só leitura)', r.j.some((i) => i.tipo === 'atividade' && i.data === '2026-12-12' && i.categoria === 'atividade' && i.editavel === false));
  check('professor B enxerga eventos da turma, mas não edita os do A', (await pB.req('GET', '/api/calendario?de=2026-12-01&ate=2026-12-31')).j.find((i) => i.id === evP)?.editavel === false && (await pB.req('PUT', `/api/agenda/${evP}`, { titulo: 'x', data: dia })).s === 403);
  check('professor B não vê evento pessoal do aluno', !(await pB.req('GET', '/api/calendario?de=2026-12-01&ate=2026-12-31')).j.some((i) => i.id === evX && i.tipo === 'evento' && i.titulo === 'Reforço'));
  check('aluno não edita/exclui evento do professor; professor não edita evento do aluno', (await aX.req('PUT', `/api/agenda/${evP}`, { titulo: 'x', data: dia })).s === 403 && (await aX.req('DELETE', `/api/agenda/${evP}`)).s === 403 && (await pA.req('PUT', `/api/agenda/${evX}`, { titulo: 'x', data: dia })).s === 403);
  check('administração edita evento de turma, mas não evento pessoal de aluno', (await adm.req('PUT', `/api/agenda/${evP}`, { titulo: 'Prova de Matemática (revisada)', data: dia, inicio: '08:00', fim: '09:00', turma_id: T1A, materia_id: MAT, categoria: 'prova' })).s === 200 && (await adm.req('PUT', `/api/agenda/${evX}`, { titulo: 'x', data: dia })).s === 403);
  check('aluno edita e exclui o próprio evento', (await aX.req('PUT', `/api/agenda/${evX}`, { titulo: 'Reforço 2', data: '2026-12-11', categoria: 'trabalho' })).j.data === '2026-12-11' && (await aX.req('DELETE', `/api/agenda/${evX}`)).s === 200);
  check('aluno foi notificado do evento da turma (prova)', (await aX.req('GET', '/api/notificacoes')).j.itens.some((n) => n.tipo === 'evento' && /Prova/.test(n.titulo)));
  r = await pA.req('POST', '/api/agenda', { titulo: 'Prova amanhã', data: amanha, inicio: '08:00', fim: '09:00', turma_id: T1A, materia_id: MAT, categoria: 'prova' });
  check('lembrete automático de prova próxima (<48 h) para o aluno e o autor', r.s === 200 && (await aX.req('GET', '/api/notificacoes')).j.itens.some((n) => n.tipo === 'lembrete' && n.titulo === 'Prova próxima') && (await pA.req('GET', '/api/notificacoes')).j.itens.some((n) => n.titulo === 'Prova próxima'));
  const ac = new AbortController();
  const sse = await fetch(BASE + '/api/eventos', { headers: { cookie: aX.cookie }, signal: ac.signal });
  const leitor = sse.body.getReader(); let buf = ''; const dec = new TextDecoder();
  const espera = (async () => { while (!buf.includes('"recurso":"calendario"')) { const { value, done } = await leitor.read(); if (done) break; buf += dec.decode(value); } })();
  await pA.req('POST', '/api/agenda', { titulo: 'Reunião', data: '2026-12-15', inicio: '18:00', fim: '19:00', turma_id: T1A, categoria: 'reuniao' });
  await Promise.race([espera, new Promise((res) => setTimeout(res, 2500))]);
  check('telas abertas recebem "atualizacao" do calendário em tempo real (SSE)', buf.includes('event: atualizacao') && buf.includes('"recurso":"calendario"') && buf.includes('event: notificacao'));
  ac.abort();
  check('GET /api/agenda continua listando os eventos visíveis', (await aX.req('GET', '/api/agenda')).j.length >= 3);

  /* ============================================================ */
  secao('Atividades, avisos e painel');
  check('aluno e professor veem a atividade; aluno Y não', (await aX.req('GET', '/api/atividades')).j.length === 1 && (await aY.req('GET', '/api/atividades')).j.length === 0);
  check('aluno não cria/edita/exclui atividade; B não edita a do A', (await aX.req('POST', '/api/atividades', { turma_id: T1A, materia_id: MAT, titulo: 'x', prazo: `${mais(3)}T10:00` })).s === 403 && (await aX.req('PUT', `/api/atividades/${aid}`, { turma_id: T1A, materia_id: MAT, titulo: 'x', prazo: `${mais(3)}T10:00` })).s === 403 && (await pB.req('PUT', `/api/atividades/${aid}`, { turma_id: T1A, materia_id: HIS, titulo: 'x', prazo: `${mais(3)}T10:00` })).s === 403 && (await pB.req('DELETE', `/api/atividades/${aid}`)).s === 403);
  check('prazo inexistente recusado', (await pA.req('POST', '/api/atividades', { turma_id: T1A, materia_id: MAT, titulo: 'x', prazo: '2026-02-31T10:00' })).s === 400);
  check('aluno marca como concluída; aluno de outra turma não', (await aX.req('PUT', `/api/atividades/${aid}/concluida`, { concluida: true })).s === 200 && (await aX.req('GET', '/api/atividades')).j[0].concluida === 1 && (await aY.req('PUT', `/api/atividades/${aid}/concluida`, { concluida: true })).s === 403);
  r = await aX.req('GET', '/api/relatorios/aluno');
  check('relatório: atividades concluídas/pendentes contam dados reais (1 concluída, 0 pendente)', r.j.atividades.concluidas === 1 && r.j.atividades.pendentes === 0 && r.j.atividades.total === 1 && r.j.atividades.taxa_conclusao === 100);
  r = await pA.req('GET', `/api/relatorios/turma?turma_id=${T1A}`);
  check('relatório da turma: taxa de conclusão (1 de 2 alunos = 50%)', r.j.atividades.total === 1 && r.j.atividades.taxa_conclusao === 50 && r.j.atividades.recentes[0].concluidas === 1);
  check('professor publica aviso; aluno/B/não vinculado não', (await pA.req('POST', '/api/avisos', { turma_id: T1A, titulo: 'Prova', mensagem: 'Prova sexta' })).j.enviados === 2 && (await pA.req('POST', '/api/avisos', { turma_id: T2B, titulo: 'x', mensagem: 'y' })).s === 403 && (await aX.req('POST', '/api/avisos', { turma_id: T1A, titulo: 'x', mensagem: 'y' })).s === 403);
  r = await aX.req('GET', '/api/painel');
  check('painel do aluno traz notas, horários, atividades e próximos compromissos numa só chamada', r.s === 200 && Array.isArray(r.j.notas) && Array.isArray(r.j.horarios) && Array.isArray(r.j.atividades) && Array.isArray(r.j.proximos));
  r = await pA.req('GET', '/api/painel');
  check('painel do professor traz resumo, horários, atividades e próximos', r.s === 200 && r.j.resumo.turmas.length === 1 && Array.isArray(r.j.proximos));
  check('administrador não usa o painel de aluno/professor', (await adm.req('GET', '/api/painel')).s === 403);

  /* ============================================================ */
  secao('Painel administrativo: usuários');
  r = await adm.req('GET', '/api/admin/resumo');
  check('resumo: 2 professores, 4 alunos, 1 administrador, turmas com contagem', r.j.usuarios.professores === 2 && r.j.usuarios.alunos === 4 && r.j.usuarios.administradores === 1 && r.j.turmas.find((x) => x.id === T1A).alunos === 2 && r.j.alteracoes_notas >= 3, JSON.stringify(r.j.usuarios));
  check('lista com filtro por busca e perfil', (await adm.req('GET', '/api/admin/usuarios?q=xavier')).j.total === 1 && (await adm.req('GET', '/api/admin/usuarios?perfil=professor')).j.total === 2);
  check('busca trata % e _ como texto (sem curingas)', (await adm.req('GET', '/api/admin/usuarios?q=%25')).j.total === 0);
  r = await adm.req('GET', '/api/admin/usuarios?por_pagina=2&pagina=2');
  check('paginação', r.j.itens.length === 2 && r.j.total >= 7 && r.j.pagina === 2);
  r = await adm.req('POST', '/api/admin/usuarios', { nome: 'Carla Docente', email: 'carla@x.com', senha: 'professora77', perfil: 'professor', turno: 'noite', materias: [HIS], turmas: [T2B] });
  check('administrador cria professor já com vínculos aprovados', r.s === 200 && r.j.perfil === 'professor' && /Hist/.test(r.j.materias_prof) && r.j.pendentes === 0, JSON.stringify(r.j)); const idC = r.j.id;
  check('cria aluno com turma; recusa aluno sem turma, e-mail duplicado e senha fraca', (await adm.req('POST', '/api/admin/usuarios', { nome: 'Davi Aluno', email: 'davi@x.com', senha: 'estudante88', perfil: 'aluno', turma_id: T2B })).s === 200
    && (await adm.req('POST', '/api/admin/usuarios', { nome: 'Sem Turma', email: 'st@x.com', senha: 'senha1234', perfil: 'aluno' })).s === 400
    && (await adm.req('POST', '/api/admin/usuarios', { nome: 'Dup', email: 'CARLA@x.com', senha: 'senha1234', perfil: 'aluno', turma_id: T1A })).s === 409
    && (await adm.req('POST', '/api/admin/usuarios', { nome: 'Fraco', email: 'f@x.com', senha: '12345678', perfil: 'aluno', turma_id: T1A })).s === 400);
  check('a nova conta consegue entrar', (await new Cli().req('POST', '/api/login', { email: 'carla@x.com', senha: 'professora77' })).s === 200);
  check('edição: e-mail já usado = 409; troca de nome ok', (await adm.req('PATCH', `/api/admin/usuarios/${idC}`, { email: 'ana@x.com' })).s === 409 && (await adm.req('PATCH', `/api/admin/usuarios/${idC}`, { nome: 'Carla Souza' })).j.nome === 'Carla Souza');
  check('administrador troca a turma de um aluno', (await adm.req('PATCH', `/api/admin/usuarios/${idW}`, { turma_id: T2B })).j.turma_id === T2B && (await adm.req('PATCH', `/api/admin/usuarios/${idW}`, { turma_id: T1A })).j.turma_id === T1A);
  check('desativar usuário derruba a sessão e bloqueia o login', (await adm.req('PATCH', `/api/admin/usuarios/${idW}`, { ativo: false })).j.ativo === 0 && (await aW.req('GET', '/api/horarios')).s === 401
    && (await new Cli().req('POST', '/api/login', { email: 'w@x.com', senha: 'senha1234' })).s === 403);
  check('usuário desativado some das listas de alunos/relatórios', (await pA.req('GET', `/api/turmas/${T1A}/alunos`)).j.length === 1 && (await pA.req('GET', `/api/relatorios/turma?turma_id=${T1A}`)).j.alunos_total === 1);
  check('reativar permite entrar de novo', (await adm.req('PATCH', `/api/admin/usuarios/${idW}`, { ativo: true })).j.ativo === 1 && (await new Cli().req('POST', '/api/login', { email: 'w@x.com', senha: 'senha1234' })).s === 200);
  const idAdm = (await adm.req('GET', '/api/eu')).j.id;
  check('administrador não desativa a si mesmo nem o único administrador ativo', (await adm.req('PATCH', `/api/admin/usuarios/${idAdm}`, { ativo: false })).s === 400);
  check('redefinir senha: política vale; sessões do usuário são derrubadas', (await adm.req('POST', `/api/admin/usuarios/${idY}/senha`, { senha: '12345678' })).s === 400
    && (await adm.req('POST', `/api/admin/usuarios/${idY}/senha`, { senha: 'provisoria77' })).s === 200 && (await aY.req('GET', '/api/horarios')).s === 401
    && (await new Cli().req('POST', '/api/login', { email: 'y@x.com', senha: 'provisoria77' })).s === 200 && (await new Cli().req('POST', '/api/login', { email: 'y@x.com', senha: 'senha1234' })).s === 401);
  check('administração define vínculos diretamente (aprovados) e cria matéria', (await adm.req('PUT', `/api/admin/professores/${idC}/vinculos`, { materias: [HIS, MAT], turmas: [T2B, T1A] })).s === 200
    && (await new Cli().req('POST', '/api/admin/materias', { nome: 'X' })).s === 401 && (await adm.req('POST', '/api/admin/materias', { nome: 'Empreendedorismo' })).s === 200 && (await adm.req('POST', '/api/admin/materias', { nome: 'empreendedorismo' })).s === 409);
  r = await adm.req('GET', '/api/admin/auditoria');
  check('auditoria registra as ações administrativas (e é imutável no banco)', r.s === 200 && r.j.total >= 8 && r.j.itens.some((a) => a.acao === 'senha_redefinida') && r.j.itens.some((a) => a.acao === 'vinculo_aprovado') && r.j.itens[0].usuario);
  let aud = 0; try { dbt.prepare('DELETE FROM auditoria').run(); } catch { aud++; } try { dbt.prepare("UPDATE auditoria SET acao='x'").run(); } catch { aud++; }
  check('o banco impede apagar/alterar a auditoria', aud === 2);

  /* ============================================================ */
  secao('Notificações e perfil');
  r = await aX.req('GET', '/api/notificacoes'); const n0 = r.j.itens[0], antes = r.j.nao_lidas;
  check('marcar como lida / outro usuário não mexe / excluir', (await aX.req('PATCH', `/api/notificacoes/${n0.id}`, { lida: true })).s === 200 && (await aX.req('GET', '/api/notificacoes')).j.nao_lidas === antes - 1
    && (await pB.req('PATCH', `/api/notificacoes/${n0.id}`, { lida: false })).s === 404 && (await adm.req('DELETE', `/api/notificacoes/${n0.id}`)).s === 404 && (await aX.req('DELETE', `/api/notificacoes/${n0.id}`)).s === 200);
  check('marcar todas como lidas', (await aX.req('POST', '/api/notificacoes/ler-todas')).s === 200 && (await aX.req('GET', '/api/notificacoes')).j.nao_lidas === 0);
  check('aluno altera o próprio nome; não acessa vínculos de professor', (await aX.req('PATCH', '/api/perfil', { nome: 'Xavier Silva' })).j.nome === 'Xavier Silva' && (await aX.req('PUT', '/api/professor/vinculos', { materias: [1], turmas: [T1A] })).s === 403);

  /* ============================================================ */
  secao('Migração de banco antigo (dados preservados)');
  const mdir = join(dir, 'migra'); spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(mdir)},{recursive:true})`]);
  const legado = join(mdir, 'legado.db');
  const script = `
    import { DatabaseSync } from 'node:sqlite';
    const o = new DatabaseSync(process.env.DB_PATH);
    o.exec(\`PRAGMA foreign_keys=ON;
    CREATE TABLE usuarios(id INTEGER PRIMARY KEY,nome TEXT NOT NULL,email TEXT NOT NULL UNIQUE COLLATE NOCASE,senha_hash TEXT NOT NULL,salt TEXT NOT NULL,perfil TEXT NOT NULL CHECK(perfil IN ('professor','aluno')),foto TEXT,criado_em TEXT NOT NULL);
    CREATE TABLE professores(usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id),turno TEXT NOT NULL);
    CREATE TABLE alunos(usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id),matricula TEXT);
    CREATE TABLE materias(id INTEGER PRIMARY KEY,nome TEXT NOT NULL UNIQUE COLLATE NOCASE);
    CREATE TABLE turmas(id INTEGER PRIMARY KEY,nome TEXT NOT NULL UNIQUE COLLATE NOCASE);
    CREATE TABLE professor_materias(professor_id INTEGER NOT NULL,materia_id INTEGER NOT NULL,PRIMARY KEY(professor_id,materia_id));
    CREATE TABLE professor_turmas(professor_id INTEGER NOT NULL,turma_id INTEGER NOT NULL,PRIMARY KEY(professor_id,turma_id));
    CREATE TABLE aluno_turmas(aluno_id INTEGER NOT NULL,turma_id INTEGER NOT NULL,PRIMARY KEY(aluno_id,turma_id));
    CREATE TABLE horarios(id INTEGER PRIMARY KEY,turma_id INTEGER NOT NULL,materia_id INTEGER NOT NULL,professor_id INTEGER NOT NULL,dia INTEGER NOT NULL,inicio TEXT NOT NULL,fim TEXT NOT NULL);
    CREATE TABLE notas(id INTEGER PRIMARY KEY,aluno_id INTEGER NOT NULL,materia_id INTEGER NOT NULL,professor_id INTEGER NOT NULL,bimestre INTEGER NOT NULL,valor REAL NOT NULL,descricao TEXT,atualizado_em TEXT NOT NULL,UNIQUE(aluno_id,materia_id,bimestre));
    CREATE TABLE sessoes(token_hash TEXT PRIMARY KEY,usuario_id INTEGER NOT NULL,expira_em TEXT NOT NULL);
    INSERT INTO usuarios VALUES(1,'Prof Antigo','a@a.com','h','s','professor',NULL,'2026-01-01');
    INSERT INTO usuarios VALUES(2,'Aluno Antigo','b@a.com','h','s','aluno',NULL,'2026-01-01');
    INSERT INTO professores VALUES(1,'manhã'); INSERT INTO alunos VALUES(2,NULL);
    INSERT INTO materias(nome) VALUES('Matemática'); INSERT INTO turmas(nome) VALUES('1º Ano A');
    INSERT INTO professor_materias VALUES(1,1); INSERT INTO professor_turmas VALUES(1,1); INSERT INTO aluno_turmas VALUES(2,1);
    INSERT INTO horarios VALUES(1,1,1,1,2,'07:50','08:40');
    INSERT INTO notas VALUES(1,2,1,1,1,8.5,NULL,'2026-03-05T10:00:00.000Z');\`);
    o.close();
    const { db } = await import('./db.js');
    const adm = await db.run("INSERT INTO usuarios(nome,email,senha_hash,salt,perfil,criado_em) VALUES('A','adm@a.com','h','s','administrador','x')").then(() => true, () => false);
    console.log(JSON.stringify({
      usuarios: (await db.all('SELECT id,nome,ativo FROM usuarios WHERE id<3')), adm,
      vinculos: (await db.all('SELECT aprovado FROM professor_turmas')).concat((await db.all('SELECT aprovado FROM professor_materias'))),
      slot: (await db.get('SELECT slot FROM horarios')).slot, turma: (await db.get("SELECT etapa,num_horarios FROM turmas WHERE nome='1º Ano A'")),
      hist: (await db.all('SELECT acao,valor_novo,origem FROM notas_historico')), nota: (await db.get('SELECT valor FROM notas')).valor,
      indices: (await db.get("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'ix_%'")).n,
      fk: (await db.all('PRAGMA foreign_key_check')).length,
      colunas: (await db.all('PRAGMA table_info(notas)')).map((c) => c.name), tri: (await db.get('SELECT trimestre FROM notas')).trimestre,
    }));`;
  const m1 = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: import.meta.dirname, env: { ...process.env, DB_PATH: legado }, encoding: 'utf8' });
  let mig = {}; try { mig = JSON.parse(m1.stdout.trim().split('\n').at(-1)); } catch { console.log(m1.stdout, m1.stderr); }
  check('usuários, notas e horários antigos preservados', mig.usuarios?.length === 2 && mig.usuarios[0].nome === 'Prof Antigo' && mig.usuarios[0].ativo === 1 && mig.nota === 8.5 && mig.slot === 2);
  check('vínculos antigos continuam APROVADOS (ninguém perde acesso)', mig.vinculos?.length === 2 && mig.vinculos.every((v) => v.aprovado === 1));
  check('turma antiga vira "Outras turmas" com 9 horários', mig.turma?.etapa === 'outra' && mig.turma?.num_horarios === 9);
  check('perfil "administrador" passa a ser aceito (tabela reconstruída)', mig.adm === true);
  check('notas existentes entram no histórico como registro inicial (origem "migracao")', mig.hist?.length === 1 && mig.hist[0].acao === 'criada' && mig.hist[0].valor_novo === 8.5 && mig.hist[0].origem === 'migracao');
  check('índices criados e integridade referencial íntegra', mig.indices >= 15 && mig.fk === 0);
  check('coluna "bimestre" vira "trimestre" sem perder a nota', mig.colunas?.includes('trimestre') && !mig.colunas.includes('bimestre') && mig.tri === 1);
  check('cópia de segurança do banco antigo criada antes da migração', readdirSync(mdir).some((f) => f.includes('.backup-')));
} catch (e) { falhas++; console.error('ERRO NO TESTE', e, e.cause); }

console.log(`\n${ok} ok, ${falhas} falha(s)`);
srv.kill();
await new Promise((r) => setTimeout(r, 400));
try { dbt.close(); rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(falhas ? 1 : 0);
