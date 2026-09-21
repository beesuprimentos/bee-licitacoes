// Chamada pelo painel quando uma licitação é remarcada ou passa para outra pessoa.
// Grava o aviso no sino e envia e-mail / WhatsApp para o responsável.
const { rest, quemE, resposta, dataHora, rotulo, avisarPessoa } = require('./lib/util');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resposta(405, { erro: 'Use POST.' });
  try {
    const eu = await quemE(event);
    if (!eu) return resposta(401, { erro: 'Faça login novamente.' });

    const { licitacao_id: id, tipo } = JSON.parse(event.body || '{}');
    if (!id || !['remarcada', 'atribuida'].includes(tipo)) return resposta(400, { erro: 'Pedido inválido.' });
    if (tipo === 'atribuida' && eu.papel !== 'admin') return resposta(403, { erro: 'Só o administrador atribui licitações.' });

    const l = ((await rest(`licitacoes?id=eq.${encodeURIComponent(id)}&select=*`)) || [])[0];
    if (!l) return resposta(404, { erro: 'Licitação não encontrada.' });
    if (!l.responsavel_id) return resposta(200, { ok: true, enviado: false, motivo: 'Sem responsável.' });
    if (l.responsavel_id === eu.id) return resposta(200, { ok: true, enviado: false, motivo: 'Quem fez a mudança já é o responsável.' });

    if (tipo === 'remarcada') {
      const recente = l.remarcada_em && Date.now() - new Date(l.remarcada_em).getTime() < 10 * 60 * 1000;
      if (!recente) return resposta(200, { ok: true, enviado: false, motivo: 'Nenhuma remarcação recente.' });
    }

    const alvo = ((await rest(`perfis?id=eq.${l.responsavel_id}&select=*`)) || [])[0];
    if (!alvo || !alvo.ativo) return resposta(200, { ok: true, enviado: false, motivo: 'Responsável inativo.' });

    let assunto, texto;
    if (tipo === 'remarcada') {
      assunto = `Licitação remarcada: ${l.orgao}`;
      texto = `⚠️ Licitação remarcada\n${rotulo(l)}\nAntes: ${dataHora(l.disputa_anterior)}\nAgora: ${dataHora(l.disputa)}`;
    } else {
      assunto = `Nova licitação para você: ${l.orgao}`;
      texto = `📌 Você ficou responsável por\n${rotulo(l)}\nDisputa: ${dataHora(l.disputa)}`;
    }
    const canais = await avisarPessoa(alvo, { tipo, licitacaoId: l.id, assunto, texto });
    return resposta(200, { ok: true, enviado: true, canais });
  } catch (e) {
    return resposta(500, { erro: e.message });
  }
};
