// Função agendada (1 vez por dia, veja netlify.toml).
// Avisa o responsável (ou os administradores, se o cartão não tiver responsável) quando:
//  - o contrato foi assinado há X dias e nenhum pedido (empenho/AF) foi lançado;
//  - o órgão já pediu, mas está há Y dias sem novo pedido e ainda há saldo;
//  - a vigência acaba em Z dias e ainda há saldo.
// Os prazos X, Y e Z ficam na aba Contratos (padrão 30, 60 e 60 dias).
// O aviso se repete a cada novo ciclo de X (ou Y) dias enquanto a situação continuar.
const { rest, resposta, rotulo, avisarPessoa } = require('./lib/util');

function hojeBR() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
  return new Date(s + 'T00:00:00Z');
}
const dia = (s) => new Date(String(s).slice(0, 10) + 'T00:00:00Z');
const ymd = (d) => d.toISOString().slice(0, 10);
const dias = (a, b) => Math.round((b - a) / 864e5);
const addDias = (d, n) => new Date(d.getTime() + n * 864e5);
const br = (d) => `${ymd(d).slice(8, 10)}/${ymd(d).slice(5, 7)}/${ymd(d).slice(0, 4)}`;
const brl = (v) => 'R$ ' + (+v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

exports.handler = async () => {
  try {
    const hoje = hojeBR();
    const cfg = ((await rest('metas_config?id=eq.1&select=*')) || [])[0] || {};
    const X = +cfg.dias_sem_pedido || 30, Y = +cfg.dias_esfriou || 60, Z = +cfg.dias_vigencia || 60;

    const lics = (await rest('licitacoes?fase=eq.adjudicada&contrato_assinado=not.is.null&select=*')) || [];
    if (!lics.length) return resposta(200, { ok: true, verificados: 0, enviados: 0 });
    const peds = (await rest('empenhos?select=licitacao_id,valor,data')) || [];
    const perfis = (await rest('perfis?select=*')) || [];
    const admins = perfis.filter((p) => p.papel === 'admin' && p.ativo);

    let enviados = 0;
    for (const l of lics) {
      const ass = dia(l.contrato_assinado);
      const venc = l.vigencia_fim ? dia(l.vigencia_fim) : null;
      if (venc && venc < hoje) continue; // contrato encerrado
      const meus = peds.filter((p) => p.licitacao_id === l.id);
      const total = meus.reduce((s, p) => s + (+p.valor || 0), 0);
      const adj = l.valor_adjudicado == null ? null : +l.valor_adjudicado;
      const saldo = adj == null ? null : adj - total;
      const temSaldo = saldo == null || saldo > 0.009;
      const ultimo = meus.length ? meus.map((p) => dia(p.data)).sort((a, b) => b - a)[0] : null;

      const alertas = [];
      if (!meus.length) {
        const d = dias(ass, hoje);
        if (d >= X) {
          const ciclo = addDias(ass, Math.floor(d / X) * X);
          alertas.push({ tipo: 'ctr_sem', ref: ciclo, titulo: `Contrato sem nenhum pedido há ${d} dias`,
            linha: `Assinado em ${br(ass)}${adj != null ? ' · adjudicado ' + brl(adj) : ''}` });
        }
      } else if (temSaldo) {
        const d = dias(ultimo, hoje);
        if (d >= Y) {
          const ciclo = addDias(ultimo, Math.floor(d / Y) * Y);
          alertas.push({ tipo: 'ctr_esf', ref: ciclo, titulo: `Órgão sem novo pedido há ${d} dias`,
            linha: `Último pedido em ${br(ultimo)}${saldo != null ? ' · saldo ' + brl(saldo) : ''}` });
        }
      }
      if (venc && temSaldo && dias(hoje, venc) <= Z) {
        alertas.push({ tipo: 'ctr_vig', ref: venc, titulo: `Vigência acaba em ${dias(hoje, venc)} dias com saldo`,
          linha: `Fim em ${br(venc)}${saldo != null ? ' · saldo ' + brl(saldo) : ''}` });
      }

      for (const a of alertas) {
        // "reserva" o aviso: se já existir para este ciclo, ninguém envia de novo
        const reservado = await rest('lembretes_enviados', {
          method: 'POST',
          prefer: 'resolution=ignore-duplicates,return=representation',
          body: { licitacao_id: l.id, tipo: a.tipo, disputa: ymd(a.ref) + 'T00:00:00' },
        });
        if (!reservado || !reservado.length) continue;

        const resp = perfis.find((p) => p.id === l.responsavel_id && p.ativo);
        const alvos = resp ? [resp] : admins;
        const contato = [l.contato_setor, l.contato_nome, l.contato_fone].filter(Boolean).join(' · ');
        const texto = `📞 ${a.titulo}\n${rotulo(l)}\n${a.linha}` +
          (contato ? `\nContato: ${contato}` : '\nCadastre o contato do órgão no cartão.') +
          '\nLigue para a prefeitura/secretaria e registre o contato na aba Contratos.';
        for (const p of alvos) {
          await avisarPessoa(p, { tipo: 'contrato', licitacaoId: l.id, assunto: `${a.titulo}: ${l.orgao}`, texto });
          enviados++;
        }
      }
    }
    return resposta(200, { ok: true, verificados: lics.length, enviados });
  } catch (e) {
    console.error(e);
    return resposta(500, { erro: e.message });
  }
};
