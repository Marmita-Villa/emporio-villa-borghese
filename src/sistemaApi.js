const axios = require('axios');
const https = require('https');
const logger = require('./logger');

// ─── Cliente HTTP — base: https://api.emporiovillaborghese.com.br ───
const api = axios.create({
  baseURL: process.env.SISTEMA_API_URL || 'https://api.emporiovillaborghese.com.br',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.SISTEMA_API_TOKEN}`,
  },
  timeout: 8000,
  // Desativa keep-alive para garantir que o timeout funcione corretamente
  httpsAgent: new https.Agent({ keepAlive: false }),
});

// ─── Cache simples em memória (TTL 5 min) ───
const _cache = new Map();
function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > 5 * 60 * 1000) { _cache.delete(key); return null; }
  return entry.val;
}
function cacheSet(key, val) { _cache.set(key, { val, ts: Date.now() }); }

// ─── Remove acentos para compatibilidade com a API (não suporta caracteres acentuados) ───
function removerAcentos(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ─── Retry automático — tenta novamente uma vez em caso de erro 5xx ───
async function comRetry(fn, tentativas = 2) {
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      if (i < tentativas - 1 && status >= 500) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      throw err;
    }
  }
}

// ─── Detecta se o termo é um código de barras EAN (8–13 dígitos numéricos) ───
function pareceCodBarras(termo) {
  return /^\d{8,13}$/.test(termo.trim());
}

// ─── A.1 — Busca produtos por nome, SKU ou EAN ───
// GET /produtos/buscar
// Params: q (nome parcial), ean (código de barras), campos, limit, page
async function buscarProduto(termo) {
  const chave = `prod:${removerAcentos(termo.trim().toLowerCase())}`;
  const cached = cacheGet(chave);
  if (cached) return cached;
  try {
    const termoLimpo = removerAcentos(termo.trim());
    const params = pareceCodBarras(termoLimpo)
      ? { ean: termoLimpo, campos: 'id,nome,preco,ean' }
      : { q: termoLimpo, campos: 'id,nome,preco,ean', limit: 8 };

    const res = await comRetry(() => api.get('/produtos/buscar', { params }));
    const result = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
    cacheSet(chave, result);
    return result;
  } catch (err) {
    logger.error('Erro ao buscar produto', { termo, error: err.message });
    return [];
  }
}

// ─── A.1 — Alias para listagem geral (não usada pela IA mas exportada por compatibilidade) ───
async function getProdutos() {
  try {
    const res = await api.get('/produtos/buscar', { params: { limit: 'all', campos: 'id,nome,preco,estoque' } });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    logger.error('Erro ao listar produtos', { error: err.message });
    return [];
  }
}

// ─── A.2 — Verifica estoque de um produto específico ───
// GET /produtos/:id/estoque  →  { "disponivel": true, "quantidade": 99999 }
async function verificarEstoque(produtoId) {
  const chave = `estoque:${produtoId}`;
  const cached = cacheGet(chave);
  if (cached) return cached;
  try {
    const res = await api.get(`/produtos/${produtoId}/estoque`);
    cacheSet(chave, res.data);
    return res.data;
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 400) return { disponivel: false, quantidade: 0 };
    logger.error('Erro ao verificar estoque', { produtoId, error: err.message });
    return { disponivel: true, quantidade: -1, erro: true };
  }
}

// ─── B.1 — Busca cliente por CPF, telefone ou nome ───
// GET /clientes/buscar
// Params: cpf (sem pontuação), telefone (com DDD), nome, incluir_historico
// Resposta: { id, nome, cpf, telefone, endereco, forma_pagamento_preferida, ... }
async function buscarCliente(identificador) {
  const apenasNumeros = identificador.replace(/\D/g, '');

  // Monta lista de tentativas — telefone tem prioridade sobre CPF quando ambíguo (11 dígitos)
  const tentativas = [];
  if (apenasNumeros.length >= 10 && apenasNumeros.length <= 11) {
    tentativas.push({ telefone: apenasNumeros });           // tenta como telefone primeiro
  }
  if (apenasNumeros.length === 11) {
    tentativas.push({ cpf: apenasNumeros });                // fallback: pode ser CPF
  } else if (apenasNumeros.length >= 8) {
    tentativas.push({ telefone: apenasNumeros });
  }
  if (!tentativas.length) {
    tentativas.push({ nome: removerAcentos(identificador) });
  }

  for (const params of tentativas) {
    try {
      const res = await comRetry(() => api.get('/clientes/buscar', { params }));
      if (res.data) return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 404) continue;
      logger.error('Erro ao buscar cliente', {
        identificador,
        status,
        body: err.response?.data,
        error: err.message,
      });
      if (status === 400) continue; // pode ser formato inválido — tenta próximo
      return null;
    }
  }
  return null;
}

// ─── C.1 — Cria pedido na retaguarda ───
// POST /pedidos
// Endereço obrigatório no formato: "Rua, Número, Bairro, Cidade/UF, CEP" (CEP com 8 dígitos)
// produto_id pode ser o objectId do Parse, SKU ou EAN
// Retorno: { id, numero, status: "recebido", previsao_entrega }
// Erro 400 se CEP não atendido: { status: 400, message: "Erro no endereço: Não entregamos para essa região." }
async function normalizarTelefone(tel) {
  const nums = String(tel || '').replace(/\D/g, '');
  // Remove código do país 55 se tiver 13 dígitos (ex: 5513991765890 → 13991765890)
  if (nums.length === 13 && nums.startsWith('55')) return nums.slice(2);
  // Remove 0 inicial se tiver 12 dígitos
  if (nums.length === 12 && nums.startsWith('0')) return nums.slice(1);
  return nums;
}

async function criarPedido(pedido) {
  try {
    const payload = {
      cliente: {
        telefone: normalizarTelefone(pedido.telefone),
        nome: pedido.nomeCliente,
        endereco: pedido.endereco, // "Rua, Número, Bairro, Cidade/UF, CEP"
      },
      itens: pedido.itens.map(item => ({
        produto_id: item.id,
        nome: item.nome,
        quantidade: item.quantidade,
        // Nota: a API não exige preco_unitario no body, mas enviamos para registro
        preco_unitario: item.preco,
      })),
      total: pedido.total,
      forma_pagamento: pedido.formaPagamento,
      observacoes: pedido.observacoes || '',
      canal: 'web',
    };

    const res = await api.post('/pedidos', payload);
    logger.info(`Pedido criado no sistema`, { numero: res.data.numero || res.data.id });
    return res.data;
  } catch (err) {
    if (err.response?.status === 400) {
      const msg = err.response.data?.message || 'Endereço inválido ou fora de cobertura.';
      throw new Error(msg);
    }
    logger.error('Erro ao criar pedido', { error: err.response?.data || err.message });
    throw new Error('Não foi possível registrar o pedido no sistema.');
  }
}

// ─── C.2 — Consulta pedidos ativos para estimar tempo de entrega ───
// GET /pedidos/ativos  →  { "ativos": 12 }
async function consultarDemanda() {
  try {
    const res = await comRetry(() => api.get('/pedidos/ativos'));
    // API retorna array de pedidos ativos (ex: [{"id":"PED-52136"}, ...])
    const ativos = Array.isArray(res.data) ? res.data.length : (res.data?.ativos ?? 0);

    let minutos, descricao;
    if (ativos <= 4)       { minutos = 30;  descricao = 'baixa'; }
    else if (ativos <= 9)  { minutos = 45;  descricao = 'moderada'; }
    else if (ativos <= 15) { minutos = 60;  descricao = 'alta'; }
    else if (ativos <= 22) { minutos = 90;  descricao = 'muito alta'; }
    else                   { minutos = 120; descricao = 'altíssima'; }

    return { pedidosAtivos: ativos, tempoEstimado: minutos, demanda: descricao };
  } catch (err) {
    logger.error('Erro ao consultar demanda', { error: err.message });
    return { pedidosAtivos: 0, tempoEstimado: 45, demanda: 'desconhecida' };
  }
}

module.exports = { getProdutos, buscarProduto, verificarEstoque, criarPedido, consultarDemanda, buscarCliente };
