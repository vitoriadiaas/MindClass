// Painel administrativo: usuários, aprovação de vínculos dos professores e auditoria.
export function registrarAdmin(C) {
  const { rota, db, erro, txt, inteiro, inteiroOpc, notificar, atualizar, auditar, revogarSessoes, nomeTurma,
    prepararUsuario, inserirUsuario, gravarVinculos, resolverVinculos, emailOk, hashSenha, novoSalt, problemaSenha, TURNOS, localStr, ORDEM_ETAPA } = C;
  const ADM = { auth: 'administrador' };
  const PERFIS = ['professor', 'aluno', 'administrador'];

  /* ---------- visão geral ---------- */
  rota('GET', '/api/admin/resumo', ADM, async () => ({
    usuarios: (await db.get(`SELECT
        SUM(CASE WHEN perfil='professor' THEN 1 ELSE 0 END) professores, SUM(CASE WHEN perfil='aluno' THEN 1 ELSE 0 END) alunos,
        SUM(CASE WHEN perfil='administrador' THEN 1 ELSE 0 END) administradores, SUM(CASE WHEN ativo=0 THEN 1 ELSE 0 END) inativos FROM usuarios`)),
    turmas: (await db.all(`SELECT t.id,t.nome,t.etapa,t.num_horarios,
        (SELECT COUNT(*) FROM aluno_turmas a WHERE a.turma_id=t.id) alunos,
        (SELECT COUNT(*) FROM professor_turmas p WHERE p.turma_id=t.id AND p.aprovado=1) professores
        FROM turmas t ORDER BY ${ORDEM_ETAPA},t.id`)),
    pendencias: (await db.get(`SELECT COUNT(DISTINCT professor_id) n FROM (
        SELECT professor_id FROM professor_turmas WHERE aprovado=0 UNION ALL SELECT professor_id FROM professor_materias WHERE aprovado=0) p`)).n,
    notas: (await db.get('SELECT COUNT(*) n FROM notas')).n,
    alteracoes_notas: (await db.get('SELECT COUNT(*) n FROM notas_historico')).n,
    atividades_abertas: (await db.get('SELECT COUNT(*) n FROM atividades WHERE prazo>=?', localStr())).n,
  }));

  /* ---------- usuários ---------- */
  const SQL_USR = `SELECT u.id,u.nome,u.email,u.perfil,u.ativo,u.criado_em,u.ultimo_login,
      (SELECT string_agg(CAST(t.nome AS TEXT),', ') FROM aluno_turmas at JOIN turmas t ON t.id=at.turma_id WHERE at.aluno_id=u.id) turma_aluno,
      (SELECT string_agg(CAST(t.nome AS TEXT),', ') FROM professor_turmas pt JOIN turmas t ON t.id=pt.turma_id WHERE pt.professor_id=u.id AND pt.aprovado=1) turmas_prof,
      (SELECT string_agg(CAST(m.nome AS TEXT),', ') FROM professor_materias pm JOIN materias m ON m.id=pm.materia_id WHERE pm.professor_id=u.id AND pm.aprovado=1) materias_prof,
      (SELECT COUNT(*) FROM professor_turmas WHERE professor_id=u.id AND aprovado=0) + (SELECT COUNT(*) FROM professor_materias WHERE professor_id=u.id AND aprovado=0) pendentes,
      (SELECT turno FROM professores WHERE usuario_id=u.id) turno,
      (SELECT turma_id FROM aluno_turmas WHERE aluno_id=u.id LIMIT 1) turma_id,
      (SELECT matricula FROM alunos WHERE usuario_id=u.id) matricula
    FROM usuarios u`;

  rota('GET', '/api/admin/usuarios', ADM, async ({ query }) => {
    const w = [], p = [];
    if (query.perfil) { if (!PERFIS.includes(query.perfil)) erro(400, 'Perfil inválido.'); w.push('u.perfil=?'); p.push(query.perfil); }
    if (query.ativo === '0' || query.ativo === '1') { w.push('u.ativo=?'); p.push(Number(query.ativo)); }
    if (query.q) { const q = `%${String(query.q).slice(0, 60).replace(/[\\%_]/g, '\\$&')}%`; w.push("(lower(u.nome) LIKE lower(?) ESCAPE '\\' OR lower(CAST(u.email AS TEXT)) LIKE lower(?) ESCAPE '\\')"); p.push(q, q); }
    const onde = w.length ? `WHERE ${w.join(' AND ')}` : '';
    const por = Math.min(Math.max(Number(query.por_pagina) || 20, 1), 100), pagina = Math.max(Number(query.pagina) || 1, 1);
    const total = (await db.get(`SELECT COUNT(*) n FROM usuarios u ${onde}`, ...p)).n;
    const itens = (await db.all(`${SQL_USR} ${onde} ORDER BY lower(u.nome) LIMIT ? OFFSET ?`, ...p, por, (pagina - 1) * por));
    return { itens, total, pagina, por_pagina: por };
  });

  const adminsAtivos = async () => (await db.get("SELECT COUNT(*) n FROM usuarios WHERE perfil='administrador' AND ativo=1")).n;

  rota('POST', '/api/admin/usuarios', ADM, async ({ user, body: b, req }) => {
    const perfil = PERFIS.includes(b.perfil) ? b.perfil : erro(400, 'Perfil inválido.');
    const turno = perfil === 'professor' ? (TURNOS.includes(b.turno) ? b.turno : erro(400, 'Selecione o turno.')) : null;
    const turma = perfil === 'aluno' ? inteiro(b.turma_id, 'Turma') : null;
    if (turma && !(await db.get('SELECT 1 FROM turmas WHERE id=?', turma))) erro(400, 'Turma inexistente.');
    const dados = await prepararUsuario({ ...b, confirmacao: b.senha });
    const id = (await db.tx(async () => {
      const uid = (await inserirUsuario(dados, perfil));
      if (perfil === 'professor') {
        (await db.run('INSERT INTO professores VALUES(?,?)', uid, turno));
        if ((b.materias?.length || b.novas_materias?.length) && b.turmas?.length) (await gravarVinculos(uid, (await resolverVinculos(b)), 1));
      }
      if (perfil === 'aluno') {
        (await db.run('INSERT INTO alunos VALUES(?,?)', uid, txt(b.matricula, 30, 'Matrícula', false)));
        (await db.run('INSERT INTO aluno_turmas VALUES(?,?)', uid, turma));
      }
      (await auditar(user, 'usuario_criado', `${dados.email}`, { perfil }, req));
      return uid;
    }));
    (await notificar(id, 'aviso', 'Bem-vindo ao MindClass!', 'Sua conta foi criada pela administração da escola.'));
    atualizar([user.id], 'usuarios');
    return (await db.get(`${SQL_USR} WHERE u.id=?`, id));
  });

  rota('PATCH', '/api/admin/usuarios/:id', ADM, async ({ user, params, body: b, req }) => {
    const id = inteiro(params.id, 'Usuário');
    const alvo = (await db.get('SELECT * FROM usuarios WHERE id=?', id));
    if (!alvo) erro(404, 'Usuário não encontrado.');
    const nome = b.nome !== undefined ? txt(b.nome, 100, 'Nome completo') : alvo.nome;
    const email = b.email !== undefined ? txt(b.email, 120, 'E-mail').toLowerCase() : alvo.email;
    if (!emailOk(email)) erro(400, 'E-mail inválido.');
    if ((await db.get('SELECT 1 FROM usuarios WHERE email=? AND id<>?', email, id))) erro(409, 'Este e-mail já está em uso.');
    const ativo = b.ativo === undefined ? alvo.ativo : (b.ativo ? 1 : 0);
    if (!ativo && id === user.id) erro(400, 'Você não pode desativar a própria conta.');
    if (!ativo && alvo.ativo && alvo.perfil === 'administrador' && (await adminsAtivos()) <= 1) erro(400, 'Não é possível desativar o único administrador ativo.');
    if (b.turno !== undefined && alvo.perfil === 'professor' && !TURNOS.includes(b.turno)) erro(400, 'Turno inválido.');
    const turma = b.turma_id !== undefined && alvo.perfil === 'aluno' ? inteiro(b.turma_id, 'Turma') : null;
    if (turma && !(await db.get('SELECT 1 FROM turmas WHERE id=?', turma))) erro(400, 'Turma inexistente.');
    (await db.tx(async () => {
      (await db.run('UPDATE usuarios SET nome=?,email=?,ativo=? WHERE id=?', nome, email, ativo, id));
      if (alvo.perfil === 'professor' && b.turno !== undefined) (await db.run('UPDATE professores SET turno=? WHERE usuario_id=?', b.turno, id));
      if (alvo.perfil === 'aluno') {
        if (b.matricula !== undefined) (await db.run('UPDATE alunos SET matricula=? WHERE usuario_id=?', txt(b.matricula, 30, 'Matrícula', false), id));
        if (turma) { (await db.run('DELETE FROM aluno_turmas WHERE aluno_id=?', id)); (await db.run('INSERT INTO aluno_turmas VALUES(?,?)', id, turma)); }
      }
      (await auditar(user, 'usuario_editado', alvo.email, { ativo: !!ativo, mudou_email: email !== alvo.email, turma }, req));
    }));
    if (!ativo) (await revogarSessoes(id));
    if (turma) (await notificar(id, 'aviso', 'Turma alterada', `Você agora está na turma ${(await nomeTurma(turma))}.`));
    atualizar([id], 'perfil');
    return (await db.get(`${SQL_USR} WHERE u.id=?`, id));
  });

  rota('POST', '/api/admin/usuarios/:id/senha', ADM, async ({ user, params, body: b, req }) => {
    const id = inteiro(params.id, 'Usuário');
    const alvo = (await db.get('SELECT * FROM usuarios WHERE id=?', id));
    if (!alvo) erro(404, 'Usuário não encontrado.');
    const pb = problemaSenha(b.senha, { email: alvo.email, nome: alvo.nome });
    if (pb) erro(400, pb);
    const salt = novoSalt(), hash = await hashSenha(b.senha, salt);
    (await db.run('UPDATE usuarios SET salt=?,senha_hash=?,senha_alterada_em=? WHERE id=?', salt, hash, new Date().toISOString(), id));
    (await revogarSessoes(id));
    (await auditar(user, 'senha_redefinida', alvo.email, null, req));
    (await notificar(id, 'aviso', 'Senha redefinida', 'Sua senha foi redefinida pela administração. Entre novamente com a nova senha.'));
    return { ok: true };
  });

  /* ---------- aprovação dos vínculos dos professores ---------- */
  rota('GET', '/api/admin/pendencias', ADM, async () => {
    const profs = (await db.all(`SELECT DISTINCT u.id,u.nome,u.email,(SELECT turno FROM professores WHERE usuario_id=u.id) turno
      FROM usuarios u WHERE u.id IN (SELECT professor_id FROM professor_turmas WHERE aprovado=0 UNION SELECT professor_id FROM professor_materias WHERE aprovado=0)
      ORDER BY u.nome`));
    return Promise.all(profs.map(async (p) => ({
      ...p,
      turmas_pendentes: (await db.all('SELECT t.id,t.nome FROM professor_turmas pt JOIN turmas t ON t.id=pt.turma_id WHERE pt.professor_id=? AND pt.aprovado=0', p.id)),
      materias_pendentes: (await db.all('SELECT m.id,m.nome FROM professor_materias pm JOIN materias m ON m.id=pm.materia_id WHERE pm.professor_id=? AND pm.aprovado=0', p.id)),
      turmas_aprovadas: (await db.all('SELECT t.id,t.nome FROM professor_turmas pt JOIN turmas t ON t.id=pt.turma_id WHERE pt.professor_id=? AND pt.aprovado=1', p.id)),
      materias_aprovadas: (await db.all('SELECT m.id,m.nome FROM professor_materias pm JOIN materias m ON m.id=pm.materia_id WHERE pm.professor_id=? AND pm.aprovado=1', p.id)),
    })));
  });

  // aprova ou rejeita: tudo de um professor, ou um item específico (tipo + ref_id)
  rota('POST', '/api/admin/pendencias', ADM, async ({ user, body: b, req }) => {
    const pid = inteiro(b.professor_id, 'Professor');
    if (!(await db.get("SELECT 1 FROM usuarios WHERE id=? AND perfil='professor'", pid))) erro(404, 'Professor não encontrado.');
    const aprovar = !!b.aprovar;
    const tabelas = b.tipo === 'turma' ? [['professor_turmas', 'turma_id']] : b.tipo === 'materia' ? [['professor_materias', 'materia_id']]
      : b.tipo === undefined ? [['professor_turmas', 'turma_id'], ['professor_materias', 'materia_id']] : erro(400, 'Tipo inválido.');
    const ref = b.ref_id === undefined ? null : inteiro(b.ref_id, 'Item');
    let n = 0;
    (await db.tx(async () => {
      for (const [tab, col] of tabelas) {
        const filtro = ref === null ? '' : ` AND ${col}=?`, args = ref === null ? [pid] : [pid, ref];
        n += (await db.run(aprovar
          ? `UPDATE ${tab} SET aprovado=1 WHERE professor_id=? AND aprovado=0${filtro}`
          : `DELETE FROM ${tab} WHERE professor_id=? AND aprovado=0${filtro}`, ...args)).changes;
      }
      (await auditar(user, aprovar ? 'vinculo_aprovado' : 'vinculo_rejeitado', String(pid), { itens: n, tipo: b.tipo ?? 'todos', ref }, req));
    }));
    if (n) (await notificar(pid, 'vinculo', aprovar ? 'Vínculos aprovados' : 'Vínculos não aprovados',
      aprovar ? 'A administração aprovou suas turmas/matérias. Já pode usar notas, horários e atividades.' : 'A administração não aprovou parte das turmas/matérias solicitadas.'));
    atualizar([pid], 'vinculos');
    return { alterados: n };
  });

  // a administração também pode definir os vínculos diretamente (já aprovados)
  rota('PUT', '/api/admin/professores/:id/vinculos', ADM, async ({ user, params, body: b, req }) => {
    const pid = inteiro(params.id, 'Professor');
    if (!(await db.get("SELECT 1 FROM usuarios WHERE id=? AND perfil='professor'", pid))) erro(404, 'Professor não encontrado.');
    const ids = (v, campo) => (Array.isArray(v) ? v : []).slice(0, 60).map((x) => inteiro(x, campo));
    const mats = ids(b.materias, 'Matéria'), turs = ids(b.turmas, 'Turma');
    for (const m of mats) if (!(await db.get('SELECT 1 FROM materias WHERE id=?', m))) erro(400, 'Matéria inexistente.');
    for (const t of turs) if (!(await db.get('SELECT 1 FROM turmas WHERE id=?', t))) erro(400, 'Turma inexistente.');
    (await db.tx(async () => { (await gravarVinculos(pid, { mats, turs }, 1)); (await auditar(user, 'vinculos_definidos', String(pid), { materias: mats, turmas: turs }, req)); }));
    (await notificar(pid, 'vinculo', 'Vínculos atualizados', 'A administração atualizou suas turmas e matérias.'));
    atualizar([pid], 'vinculos');
    return { ok: true };
  });

  rota('POST', '/api/admin/materias', ADM, async ({ user, body: b, req }) => {
    const nome = txt(b.nome, 60, 'Nome da matéria');
    if ((await db.get('SELECT 1 FROM materias WHERE nome=?', nome))) erro(409, 'Matéria já cadastrada.');
    const r = (await db.get('INSERT INTO materias(nome) VALUES(?) RETURNING id', nome));
    (await auditar(user, 'materia_criada', nome, null, req));
    return { id: r.id, nome };
  });

  /* ---------- auditoria ---------- */
  rota('GET', '/api/admin/auditoria', ADM, async ({ query }) => {
    const por = Math.min(Math.max(Number(query.por_pagina) || 50, 1), 200), pagina = Math.max(Number(query.pagina) || 1, 1);
    const total = (await db.get('SELECT COUNT(*) n FROM auditoria')).n;
    const itens = (await db.all(`SELECT a.id,a.acao,a.alvo,a.detalhe,a.ip,a.em,u.nome usuario FROM auditoria a LEFT JOIN usuarios u ON u.id=a.usuario_id
      ORDER BY a.em DESC,a.id DESC LIMIT ? OFFSET ?`, por, (pagina - 1) * por));
    return { itens, total, pagina, por_pagina: por };
  });
}
