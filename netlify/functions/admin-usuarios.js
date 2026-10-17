// Cadastro de pessoas com login. Só o administrador pode usar.
// Ações: criar, editar, remover, resetar_mfa.
const { rest, authAdmin, quemE, resposta } = require('./lib/util');

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

async function contarAdmins(exceto) {
  const lista = (await rest('perfis?papel=eq.admin&ativo=eq.true&select=id')) || [];
  return lista.filter((p) => p.id !== exceto).length;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resposta(405, { erro: 'Use POST.' });
  try {
    const eu = await quemE(event);
    if (!eu) return resposta(401, { erro: 'Sessão sem verificação em duas etapas. Saia e entre de novo com o código do app.' });
    if (eu.papel !== 'admin') return resposta(403, { erro: 'Só o administrador gerencia pessoas.' });

    const d = JSON.parse(event.body || '{}');

    if (d.acao === 'criar') {
      const nome = String(d.nome || '').trim(), email = String(d.email || '').trim().toLowerCase();
      if (!nome) return resposta(400, { erro: 'Informe o nome.' });
      if (!emailOk(email)) return resposta(400, { erro: 'E-mail inválido.' });
      if (String(d.senha || '').length < 8) return resposta(400, { erro: 'A senha precisa ter pelo menos 8 caracteres.' });
      const novo = await authAdmin('users', {
        method: 'POST',
        body: { email, password: d.senha, email_confirm: true, user_metadata: { nome } },
      });
      const papel = d.papel === 'admin' ? 'admin' : 'usuario';
      const perfil = await rest(`perfis?id=eq.${novo.id}`, {
        method: 'PATCH', prefer: 'return=representation',
        body: { nome, whatsapp: String(d.whatsapp || '').trim(), papel },
      });
      return resposta(200, { ok: true, perfil: perfil && perfil[0] });
    }

    if (d.acao === 'editar') {
      if (!d.id) return resposta(400, { erro: 'Pessoa não informada.' });
      const atual = ((await rest(`perfis?id=eq.${encodeURIComponent(d.id)}&select=*`)) || [])[0];
      if (!atual) return resposta(404, { erro: 'Pessoa não encontrada.' });
      const papel = d.papel === 'admin' ? 'admin' : 'usuario';
      const ativo = d.ativo !== false;
      if (atual.papel === 'admin' && (papel !== 'admin' || !ativo) && (await contarAdmins(atual.id)) < 1) {
        return resposta(400, { erro: 'Precisa existir pelo menos um administrador ativo.' });
      }
      const nome = String(d.nome || '').trim() || atual.nome;
      const patch = { nome, whatsapp: String(d.whatsapp || '').trim(), papel, ativo };
      const authPatch = { ban_duration: ativo ? 'none' : '876000h' };
      if (d.email && String(d.email).trim().toLowerCase() !== atual.email) {
        const email = String(d.email).trim().toLowerCase();
        if (!emailOk(email)) return resposta(400, { erro: 'E-mail inválido.' });
        authPatch.email = email; authPatch.email_confirm = true; patch.email = email;
      }
      if (d.senha) {
        if (String(d.senha).length < 8) return resposta(400, { erro: 'A senha precisa ter pelo menos 8 caracteres.' });
        authPatch.password = d.senha;
      }
      await authAdmin(`users/${atual.id}`, { method: 'PUT', body: authPatch });
      const perfil = await rest(`perfis?id=eq.${atual.id}`, { method: 'PATCH', prefer: 'return=representation', body: patch });
      return resposta(200, { ok: true, perfil: perfil && perfil[0] });
    }

    if (d.acao === 'remover') {
      if (!d.id) return resposta(400, { erro: 'Pessoa não informada.' });
      if (d.id === eu.id) return resposta(400, { erro: 'Você não pode remover a si mesmo.' });
      const alvo = ((await rest(`perfis?id=eq.${encodeURIComponent(d.id)}&select=*`)) || [])[0];
      if (alvo && alvo.papel === 'admin' && (await contarAdmins(alvo.id)) < 1) {
        return resposta(400, { erro: 'Precisa existir pelo menos um administrador ativo.' });
      }
      await authAdmin(`users/${d.id}`, { method: 'DELETE' });
      return resposta(200, { ok: true });
    }

    if (d.acao === 'resetar_mfa') {
      if (!d.id) return resposta(400, { erro: 'Pessoa não informada.' });
      if (d.id === eu.id) return resposta(400, { erro: 'Para trocar o seu aparelho, use Meu perfil. Se perdeu o seu celular, peça a outro administrador.' });
      const u = await authAdmin(`users/${encodeURIComponent(d.id)}`);
      const fatores = (u && u.factors) || [];
      for (const f of fatores) {
        await authAdmin(`users/${encodeURIComponent(d.id)}/factors/${encodeURIComponent(f.id)}`, { method: 'DELETE' });
      }
      return resposta(200, { ok: true, removidos: fatores.length });
    }

    return resposta(400, { erro: 'Ação desconhecida.' });
  } catch (e) {
    console.error('admin-usuarios:', e);
    return resposta(500, { erro: e.message || 'Erro inesperado.' });
  }
};
