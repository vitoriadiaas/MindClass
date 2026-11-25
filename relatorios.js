// Relatórios de desempenho (aluno e turma) e histórico de notas. Todos os números vêm do banco.
export function registrarRelatorios(C) {
  const { rota, db, erro, inteiro, inteiroOpc, dataOk, ensinaTurma, materiasProf, MEDIA_MINIMA, localStr } = C;
  const todos = { auth: true };

  const media = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);
  const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  const lerTrimestre = (v) => {
    if (v === undefined || v === '' || v === 'todos') return null;
    const b = inteiro(v, 'Trimestre');
    if (b < 1 || b > 3) erro(400, 'Trimestre deve ser de 1 a 3.');
    return b;
  };
  // professor só enxerga as matérias que leciona; administração enxerga tudo
  const materiasPermitidas = async (user) => (user.perfil === 'professor' ? new Set((await materiasProf(user.id)).map((m) => m.id)) : null);
  const compara = (porBim) => {
    const bs = Object.keys(porBim).map(Number).filter((b) => porBim[b] != null).sort((a, b) => a - b), out = [];
    for (let i = 1; i < bs.length; i++) out.push({ de: bs[i - 1], para: bs[i], delta: r2(porBim[bs[i]] - porBim[bs[i - 1]]) });
    return out;
  };
  const faixa = (m) => (m < 5 ? 0 : m < 6 ? 1 : m < 8 ? 2 : 3);

  /* ---------- relatório individual do aluno ---------- */
  async function relatorioAluno(alunoId, { perm, materiaId, trimestre }) {
    const aluno = (await db.get('SELECT u.id,u.nome,u.email FROM usuarios u JOIN alunos a ON a.usuario_id=u.id WHERE u.id=?', alunoId));
    if (!aluno) erro(404, 'Aluno não encontrado.');
    const turmas = (await db.all('SELECT t.id,t.nome FROM aluno_turmas at JOIN turmas t ON t.id=at.turma_id WHERE at.aluno_id=?', alunoId));
    const ok = (m) => (!perm || perm.has(m)) && (!materiaId || m === materiaId);
    const rows = (await db.all('SELECT n.materia_id,m.nome materia,n.trimestre,n.valor FROM notas n JOIN materias m ON m.id=n.materia_id WHERE n.aluno_id=? AND n.trimestre<=3 ORDER BY m.nome,n.trimestre', alunoId)).filter((r) => ok(r.materia_id));

    const mats = new Map();
    for (const r of rows) {
      if (!mats.has(r.materia_id)) mats.set(r.materia_id, { materia_id: r.materia_id, materia: r.materia, trimestres: {} });
      mats.get(r.materia_id).trimestres[r.trimestre] = r.valor;
    }
    const por_materia = [...mats.values()].map((m) => {
      const periodo = trimestre ? (m.trimestres[trimestre] != null ? [m.trimestres[trimestre]] : []) : Object.values(m.trimestres);
      const md = media(periodo);
      const ordem = Object.keys(m.trimestres).map(Number).sort((a, b) => a - b);
      const tendencia = ordem.length >= 2 ? r2(m.trimestres[ordem.at(-1)] - m.trimestres[ordem.at(-2)]) : null;
      return { ...m, media: r2(md), tendencia, situacao: md == null ? 'sem_nota' : md < MEDIA_MINIMA ? 'atencao' : 'ok' };
    });
    const porBim = {};
    for (let b = 1; b <= 3; b++) { const v = rows.filter((r) => r.trimestre === b).map((r) => r.valor); porBim[b] = r2(media(v)); }
    const medias = por_materia.map((m) => m.media).filter((x) => x != null);
    const atencao = por_materia.filter((m) => m.media != null && (m.media < MEDIA_MINIMA || (m.tendencia != null && m.tendencia <= -1)))
      .map((m) => ({ materia_id: m.materia_id, materia: m.materia, media: m.media, tendencia: m.tendencia, motivo: m.media < MEDIA_MINIMA ? 'media_baixa' : 'queda' }));

    // atividades da(s) turma(s) do aluno
    const agora = localStr();
    const atv = (await db.all(`SELECT a.id,a.materia_id,m.nome materia,a.prazo,CASE WHEN EXISTS(SELECT 1 FROM atividades_concluidas c WHERE c.atividade_id=a.id AND c.aluno_id=?) THEN 1 ELSE 0 END concluida
      FROM atividades a JOIN materias m ON m.id=a.materia_id WHERE a.turma_id IN (SELECT turma_id FROM aluno_turmas WHERE aluno_id=?)`, alunoId, alunoId)).filter((a) => ok(a.materia_id));
    const atividades = { total: atv.length, concluidas: 0, pendentes: 0, atrasadas: 0, por_materia: [] };
    const pm = new Map();
    for (const a of atv) {
      const estado = a.concluida ? 'concluidas' : a.prazo >= agora ? 'pendentes' : 'atrasadas';
      atividades[estado]++;
      if (!pm.has(a.materia_id)) pm.set(a.materia_id, { materia: a.materia, concluidas: 0, pendentes: 0, atrasadas: 0 });
      pm.get(a.materia_id)[estado]++;
    }
    atividades.por_materia = [...pm.values()].sort((a, b) => a.materia.localeCompare(b.materia));
    atividades.taxa_conclusao = atv.length ? r2((atividades.concluidas / atv.length) * 100) : null;

    return {
      aluno, turmas, filtros: { materia_id: materiaId ?? null, trimestre: trimestre ?? null }, media_minima: MEDIA_MINIMA,
      geral: { media: r2(media(medias)), materias: por_materia.length, notas: rows.length },
      por_materia, por_trimestre: porBim, comparacao: compara(porBim), atencao,
      melhor: por_materia.filter((m) => m.media != null).sort((a, b) => b.media - a.media)[0] ?? null,
      atividades, gerado_em: new Date().toISOString(),
    };
  }

  rota('GET', '/api/relatorios/aluno', todos, async ({ user, query }) => {
    let alunoId, perm = null;
    if (user.perfil === 'aluno') alunoId = user.id;
    else {
      alunoId = inteiro(query.aluno_id, 'Aluno');
      if (user.perfil === 'professor') {
        const vinculado = (await db.get(`SELECT 1 FROM aluno_turmas at JOIN professor_turmas pt ON pt.turma_id=at.turma_id AND pt.professor_id=? AND pt.aprovado=1 WHERE at.aluno_id=?`, user.id, alunoId));
        if (!vinculado) erro(403, 'Este aluno não pertence a uma das suas turmas.');
        perm = (await materiasPermitidas(user));
      }
    }
    return (await relatorioAluno(alunoId, { perm, materiaId: inteiroOpc(query.materia_id, 'Matéria'), trimestre: lerTrimestre(query.trimestre) }));
  });

  /* ---------- relatório da turma ---------- */
  rota('GET', '/api/relatorios/turma', { auth: ['professor', 'administrador'] }, async ({ user, query }) => {
    const tid = inteiro(query.turma_id, 'Turma');
    const turma = (await db.get('SELECT id,nome,etapa FROM turmas WHERE id=?', tid));
    if (!turma) erro(404, 'Turma não encontrada.');
    if (user.perfil === 'professor' && !(await ensinaTurma(user.id, tid))) erro(403, 'Você não está vinculado a esta turma.');
    const perm = (await materiasPermitidas(user)), materiaId = inteiroOpc(query.materia_id, 'Matéria'), trimestre = lerTrimestre(query.trimestre);
    const ok = (m) => (!perm || perm.has(m)) && (!materiaId || m === materiaId);

    const alunos = (await db.all(`SELECT u.id,u.nome FROM aluno_turmas at JOIN usuarios u ON u.id=at.aluno_id WHERE at.turma_id=? AND u.ativo=1 ORDER BY u.nome`, tid));
    const rows = (await db.all(`SELECT n.aluno_id,n.materia_id,m.nome materia,n.trimestre,n.valor FROM notas n JOIN materias m ON m.id=n.materia_id
      WHERE n.trimestre<=3 AND n.aluno_id IN (SELECT aluno_id FROM aluno_turmas WHERE turma_id=?)`, tid)).filter((r) => ok(r.materia_id));
    const naTurma = new Set(alunos.map((a) => a.id));
    const dados = rows.filter((r) => naTurma.has(r.aluno_id));

    // matéria -> aluno -> trimestres
    const mats = new Map();
    for (const r of dados) {
      if (!mats.has(r.materia_id)) mats.set(r.materia_id, { materia_id: r.materia_id, materia: r.materia, alunos: new Map() });
      const am = mats.get(r.materia_id).alunos;
      if (!am.has(r.aluno_id)) am.set(r.aluno_id, {});
      am.get(r.aluno_id)[r.trimestre] = r.valor;
    }
    const periodo = (bims) => (trimestre ? (bims[trimestre] != null ? [bims[trimestre]] : []) : Object.values(bims));
    const mediasAluno = new Map();   // aluno -> [média por matéria]
    const por_materia = [...mats.values()].sort((a, b) => a.materia.localeCompare(b.materia)).map((m) => {
      const medias = [];
      for (const [aid, bims] of m.alunos) {
        const md = media(periodo(bims));
        if (md != null) { medias.push({ aid, md }); (mediasAluno.get(aid) ?? mediasAluno.set(aid, []).get(aid)).push(md); }
      }
      const por_trimestre = {};
      for (let b = 1; b <= 3; b++) por_trimestre[b] = r2(media(dados.filter((r) => r.materia_id === m.materia_id && r.trimestre === b).map((r) => r.valor)));
      return {
        materia_id: m.materia_id, materia: m.materia, media: r2(media(medias.map((x) => x.md))), por_trimestre,
        alunos_com_nota: medias.length, em_atencao: medias.filter((x) => x.md < MEDIA_MINIMA).length,
        maior: medias.length ? r2(Math.max(...medias.map((x) => x.md))) : null, menor: medias.length ? r2(Math.min(...medias.map((x) => x.md))) : null,
      };
    });
    const lista = alunos.map((a) => {
      const md = media(mediasAluno.get(a.id) ?? []);
      const porB = {};
      for (let b = 1; b <= 3; b++) porB[b] = r2(media(dados.filter((r) => r.aluno_id === a.id && r.trimestre === b).map((r) => r.valor)));
      return { id: a.id, nome: a.nome, media: r2(md), em_atencao: md != null && md < MEDIA_MINIMA, materias_em_atencao: (mediasAluno.get(a.id) ?? []).filter((x) => x < MEDIA_MINIMA).length, por_trimestre: porB };
    });
    const porBim = {};
    for (let b = 1; b <= 3; b++) porBim[b] = r2(media(dados.filter((r) => r.trimestre === b).map((r) => r.valor)));
    const dist = [0, 0, 0, 0];
    for (const a of lista) if (a.media != null) dist[faixa(a.media)]++;

    // atividades da turma (concluídas por todos os alunos)
    const atv = (await db.all(`SELECT a.id,a.titulo,a.prazo,a.materia_id,m.nome materia,
        (SELECT COUNT(*) FROM atividades_concluidas c JOIN aluno_turmas at ON at.aluno_id=c.aluno_id AND at.turma_id=a.turma_id WHERE c.atividade_id=a.id) concluidas
      FROM atividades a JOIN materias m ON m.id=a.materia_id WHERE a.turma_id=? ORDER BY a.prazo DESC`, tid)).filter((a) => ok(a.materia_id));
    const nAlunos = alunos.length, agora = localStr();
    const concl = atv.reduce((s, a) => s + a.concluidas, 0);
    return {
      turma, filtros: { materia_id: materiaId ?? null, trimestre: trimestre ?? null }, media_minima: MEDIA_MINIMA,
      alunos_total: nAlunos, geral: { media: r2(media(lista.map((a) => a.media).filter((x) => x != null))), em_atencao: lista.filter((a) => a.em_atencao).length, sem_nota: lista.filter((a) => a.media == null).length },
      por_materia, por_trimestre: porBim, comparacao: compara(porBim), alunos: lista,
      distribuicao: [
        { faixa: 'Abaixo de 5', alunos: dist[0] }, { faixa: '5 a 5,9', alunos: dist[1] }, { faixa: '6 a 7,9', alunos: dist[2] }, { faixa: '8 a 10', alunos: dist[3] },
      ],
      atividades: {
        total: atv.length, abertas: atv.filter((a) => a.prazo >= agora).length,
        taxa_conclusao: atv.length && nAlunos ? r2((concl / (atv.length * nAlunos)) * 100) : null,
        recentes: atv.slice(0, 10).map((a) => ({ id: a.id, titulo: a.titulo, materia: a.materia, prazo: a.prazo, concluidas: a.concluidas, alunos: nAlunos, pct: nAlunos ? r2((a.concluidas / nAlunos) * 100) : null })),
      },
      gerado_em: new Date().toISOString(),
    };
  });

  /* ---------- histórico de notas (somente leitura; os registros são imutáveis no banco) ---------- */
  rota('GET', '/api/historico-notas', todos, async ({ user, query }) => {
    const w = [], p = [];
    if (user.perfil === 'aluno') { w.push('h.aluno_id=?'); p.push(user.id); }
    else {
      if (user.perfil === 'professor') {
        w.push(`EXISTS(SELECT 1 FROM aluno_turmas at JOIN professor_turmas pt ON pt.turma_id=at.turma_id AND pt.professor_id=? AND pt.aprovado=1 WHERE at.aluno_id=h.aluno_id)
          AND EXISTS(SELECT 1 FROM professor_materias pm WHERE pm.professor_id=? AND pm.aprovado=1 AND pm.materia_id=h.materia_id)`);
        p.push(user.id, user.id);
      }
      const a = inteiroOpc(query.aluno_id, 'Aluno'); if (a) { w.push('h.aluno_id=?'); p.push(a); }
      const t = inteiroOpc(query.turma_id, 'Turma'); if (t) { w.push('h.aluno_id IN (SELECT aluno_id FROM aluno_turmas WHERE turma_id=?)'); p.push(t); }
    }
    const m = inteiroOpc(query.materia_id, 'Matéria'); if (m) { w.push('h.materia_id=?'); p.push(m); }
    const b = lerTrimestre(query.trimestre); if (b) { w.push('h.trimestre=?'); p.push(b); }
    if (query.acao) { if (!['criada', 'alterada', 'excluida'].includes(query.acao)) erro(400, 'Ação inválida.'); w.push('h.acao=?'); p.push(query.acao); }
    if (query.de) { w.push('date(h.alterado_em)>=?'); p.push(dataOk(query.de, 'Data inicial')); }
    if (query.ate) { w.push('date(h.alterado_em)<=?'); p.push(dataOk(query.ate, 'Data final')); }
    const onde = w.length ? `WHERE ${w.join(' AND ')}` : '';
    const por = Math.min(Math.max(Number(query.por_pagina) || 30, 1), 100), pagina = Math.max(Number(query.pagina) || 1, 1);
    const total = (await db.get(`SELECT COUNT(*) n FROM notas_historico h ${onde}`, ...p)).n;
    const itens = (await db.all(`SELECT h.id,h.aluno_id,ua.nome aluno,h.materia_id,m.nome materia,h.turma_id,t.nome turma,h.trimestre,h.ano_letivo,h.acao,
        h.valor_anterior,h.valor_novo,h.professor_id,up.nome professor,h.alterado_por,ux.nome alterado_por_nome,h.alterado_em,h.origem
      FROM notas_historico h JOIN usuarios ua ON ua.id=h.aluno_id JOIN materias m ON m.id=h.materia_id LEFT JOIN turmas t ON t.id=h.turma_id
      LEFT JOIN usuarios up ON up.id=h.professor_id JOIN usuarios ux ON ux.id=h.alterado_por
      ${onde} ORDER BY h.alterado_em DESC,h.id DESC LIMIT ? OFFSET ?`, ...p, por, (pagina - 1) * por));
    return { itens, total, pagina, por_pagina: por };
  });
}
