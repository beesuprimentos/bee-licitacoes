// Utilitários compartilhados pelas funções (sem dependências externas).
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function conferirConfig() {
  if (!SUPABASE_URL || !SERVICE) {
    throw new Error('Faltam as variáveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Netlify.');
  }
  if (!/^https:\/\/[^/]+$/.test(SUPABASE_URL)) {
    throw new Error('A variável SUPABASE_URL no Netlify deve ser só o endereço do projeto, ex.: https://abcd.supabase.co');
  }
  if (typeof fetch !== 'function') {
    throw new Error('O Netlify está usando uma versão antiga do Node. Em Site configuration > Environment variables, crie AWS_LAMBDA_JS_RUNTIME = nodejs20.x e faça novo deploy.');
  }
}

// Chaves novas do Supabase (sb_secret_...) vão só no cabeçalho apikey;
// a chave antiga service_role (eyJ...) vai também como Bearer.
function cabecalhos(extra) {
  const h = { apikey: SERVICE, 'Content-Type': 'application/json', ...(extra || {}) };
  if (!SERVICE.startsWith('sb_')) h.Authorization = `Bearer ${SERVICE}`;
  return h;
}

// Corta a chamada antes do limite de 10 s do Netlify, para devolver um erro claro em vez de 502.
async function buscar(url, opts) {
  try {
    return await fetch(url, { ...opts, signal: AbortSignal.timeout(8000) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error('O Supabase demorou para responder. Confira SUPABASE_URL no Netlify e se o projeto não está pausado.');
    throw new Error('Não foi possível falar com o Supabase: ' + (e && e.message));
  }
}

async function rest(caminho, { method = 'GET', body, prefer } = {}) {
  conferirConfig();
  const r = await buscar(`${SUPABASE_URL}/rest/v1/${caminho}`, {
    method,
    headers: cabecalhos(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

async function authAdmin(caminho, { method = 'GET', body } = {}) {
  conferirConfig();
  const r = await buscar(`${SUPABASE_URL}/auth/v1/admin/${caminho}`, {
    method,
    headers: cabecalhos(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const txt = await r.text();
  let json = null;
  try { json = txt ? JSON.parse(txt) : null; } catch (e) { /* ignora */ }
  if (!r.ok) {
    const msg = (json && (json.msg || json.message || json.error_description || json.error)) || txt || r.status;
    throw new Error(traduzAuth(String(msg), r.status));
  }
  return json;
}

function traduzAuth(m, status) {
  if (/already been registered|already registered|email_exists/i.test(m)) return 'Já existe um login com esse e-mail.';
  if (/Database error creating new user/i.test(m)) return 'O banco recusou o novo usuário (Database error). Rode de novo o supabase/schema.sql e tente outra vez.';
  if (/password/i.test(m) && /weak|short|least/i.test(m)) return 'A senha é fraca demais para as regras do Supabase. Use letras, números e símbolos.';
  if (status === 401 || status === 403 || /Invalid API key|invalid JWT|not authorized|No API key/i.test(m)) return 'A chave SUPABASE_SERVICE_ROLE_KEY no Netlify está errada. Copie de novo em Supabase > Project Settings > API Keys (a secreta).';
  return m;
}

// Descobre quem está chamando a função a partir do login enviado pelo navegador.
async function quemE(event) {
  conferirConfig();
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  const token = h.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await buscar(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  const linhas = await rest(`perfis?id=eq.${encodeURIComponent(u.id)}&select=*`);
  const p = linhas && linhas[0];
  return p && p.ativo ? p : null;
}

function resposta(status, obj) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// ---------- formatação ----------
function dataHora(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/.exec(s || '');
  return m ? `${m[3]}/${m[2]}/${m[1]} às ${m[4]}:${m[5]}` : 'sem data';
}
function rotulo(l) {
  return `${l.orgao}${l.numero ? ' — ' + (l.modalidade || '') + ' ' + l.numero : ''}`.trim();
}
function linkDoSite() {
  return process.env.SITE_URL || process.env.URL || '';
}

// ---------- envio: e-mail (Resend) ----------
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function enviarEmail(para, assunto, texto) {
  const key = process.env.RESEND_API_KEY, from = process.env.EMAIL_FROM;
  if (!key || !from) return { canal: 'email', ok: false, motivo: 'e-mail não configurado' };
  if (!para) return { canal: 'email', ok: false, motivo: 'pessoa sem e-mail' };
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1E1C1C">' +
    texto.split('\n').map((l) => `<p style="margin:0 0 8px">${escHtml(l)}</p>`).join('') + '</div>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [para], subject: assunto, text: texto, html }),
  });
  return { canal: 'email', ok: r.ok, motivo: r.ok ? '' : await r.text() };
}

// ---------- envio: WhatsApp (Z-API) ----------
function normalizarFone(n) {
  let d = String(n || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d.length >= 12 ? d : '';
}
async function enviarWhatsApp(numero, texto) {
  const inst = process.env.ZAPI_INSTANCE, tok = process.env.ZAPI_TOKEN, cli = process.env.ZAPI_CLIENT_TOKEN;
  if (!inst || !tok) return { canal: 'whatsapp', ok: false, motivo: 'WhatsApp não configurado' };
  const fone = normalizarFone(numero);
  if (!fone) return { canal: 'whatsapp', ok: false, motivo: 'pessoa sem WhatsApp válido' };
  const r = await fetch(`https://api.z-api.io/instances/${encodeURIComponent(inst)}/token/${encodeURIComponent(tok)}/send-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cli ? { 'Client-Token': cli } : {}) },
    body: JSON.stringify({ phone: fone, message: texto }),
  });
  return { canal: 'whatsapp', ok: r.ok, motivo: r.ok ? '' : await r.text() };
}

// Grava o aviso dentro do sistema (sino) e envia por e-mail e WhatsApp.
async function avisarPessoa(perfil, { tipo, licitacaoId, assunto, texto, semSino }) {
  if (!semSino) {
    await rest('avisos', {
      method: 'POST',
      body: { para_id: perfil.id, licitacao_id: licitacaoId || null, tipo, texto: texto.split('\n').slice(0, 2).join(' · ') },
    });
  }
  const link = linkDoSite();
  const corpo = link ? `${texto}\nAbrir o painel: ${link}` : texto;
  const res = await Promise.allSettled([
    enviarEmail(perfil.email, assunto, corpo),
    enviarWhatsApp(perfil.whatsapp, corpo),
  ]);
  return res.map((x) => (x.status === 'fulfilled' ? x.value : { ok: false, motivo: String(x.reason) }));
}

module.exports = { rest, authAdmin, quemE, resposta, dataHora, rotulo, avisarPessoa, conferirConfig };
