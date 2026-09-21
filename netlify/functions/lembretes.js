// Função agendada (a cada 15 minutos, veja netlify.toml).
// Avisa o responsável 24 horas antes e 1 hora antes de cada disputa.
const { rest, resposta, dataHora, rotulo, avisarPessoa } = require('./lib/util');

// "Agora" no horário de Brasília, como um Date cujos campos UTC mostram a hora local.
function agoraBR() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // 2026-09-20 18:40:00
  return new Date(s.replace(' ', 'T') + 'Z');
}
const iso = (d) => d.toISOString().slice(0, 19); // 2026-09-20T18:40:00
const paraData = (s) => new Date(String(s).slice(0, 19) + 'Z');

exports.handler = async () => {
  try {
    const agora = agoraBR();
    const limite = new Date(agora.getTime() + 24 * 3600 * 1000);
    const lista = await rest(
      `licitacoes?fase=not.in.(adjudicada,nao)&responsavel_id=not.is.null` +
      `&disputa=gt.${iso(agora)}&disputa=lte.${iso(limite)}&select=*`
    );
    let enviados = 0;
    for (const l of lista || []) {
      const falta = paraData(l.disputa).getTime() - agora.getTime();
      const tipo = falta <= 3600 * 1000 ? 'h1' : 'd1';

      // "reserva" o lembrete: se já existir, ninguém envia de novo
      const reservado = await rest('lembretes_enviados', {
        method: 'POST',
        prefer: 'resolution=ignore-duplicates,return=representation',
        body: { licitacao_id: l.id, tipo, disputa: String(l.disputa).slice(0, 19) },
      });
      if (!reservado || !reservado.length) continue;

      const alvo = ((await rest(`perfis?id=eq.${l.responsavel_id}&select=*`)) || [])[0];
      if (!alvo || !alvo.ativo) continue;

      const quando = tipo === 'h1' ? 'em menos de 1 hora' : 'nas próximas 24 horas';
      const alerta = l.fase === 'elaboracao' ? '\n⚠️ A proposta ainda está em elaboração.' : '';
      const texto = `⏰ Disputa ${quando}\n${rotulo(l)}\nDisputa: ${dataHora(l.disputa)}${alerta}`;
      await avisarPessoa(alvo, { tipo: 'lembrete', licitacaoId: l.id, assunto: `Disputa ${quando}: ${l.orgao}`, texto });
      enviados++;
    }
    return resposta(200, { ok: true, verificadas: (lista || []).length, enviados });
  } catch (e) {
    console.error(e);
    return resposta(500, { erro: e.message });
  }
};
