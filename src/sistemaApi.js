const axios = require('axios');
const https = require('https');
const logger = require('./logger');

// ─── Cliente HTTP — retaguarda (pedidos) ───
const api = axios.create({
  baseURL: process.env.SISTEMA_API_URL || 'https://api.emporiovillaborghese.com.br',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.SISTEMA_API_TOKEN}`,
  },
  timeout: 8000,
  httpsAgent: new https.Agent({ keepAlive: false }),
});

// ─── Cliente HTTP — Hipcom (produtos, estoque) ───
const hipcom = axios.create({
  baseURL: process.env.HIPCOM_URL || 'http://emporiovilla.dyndns.info:2222/api/hipcom',
  auth: {
    username: process.env.HIPCOM_USER || 'hipcomfull',
    password: process.env.HIPCOM_PASS || '',
  },
  timeout: 10000,
  httpsAgent: new https.Agent({ keepAlive: false }),
});

const HIPCOM_LOJA_PRECO  = parseInt(process.env.HIPCOM_PRICE_STORE  || '6', 10);
const HIPCOM_LOJAS_ESTOQUE = (process.env.HIPCOM_STOCK_STORES || '1,6').split(',').map(Number).filter(Boolean);
const HIPCOM_BLOCKED     = (process.env.HIPCOM_BLOCKED_ITEMS || '').split(',').map(s => s.trim()).filter(Boolean);

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

// ─── A.1 — Busca produtos por nome ou código de barras via Hipcom ───
async function buscarProduto(termo) {
  const chave = `prod:${termo.trim().toLowerCase()}`;
  const cached = cacheGet(chave);
  if (cached) return cached;
  try {
    const termoLimpo = termo.trim();
    const params = pareceCodBarras(termoLimpo)
      ? { loja: HIPCOM_LOJA_PRECO, plu: termoLimpo, somente_estoque_positivo: 'S' }
      : { loja: HIPCOM_LOJA_PRECO, descricao: termoLimpo, somente_estoque_positivo: 'S', limite: 8 };

    const res = await hipcom.get('/produtos', { params });
    const produtos = (res.data?.produtos || [])
      .filter(p => p.ativo === 'S' && !HIPCOM_BLOCKED.includes(String(p.plu)))
      .map(p => ({
        id:    String(p.plu),
        nome:  p.descricao,
        preco: p.valor_promocao > 0 ? p.valor_promocao : p.valor_produto,
        ean:   p.codigo_barra ? String(p.codigo_barra) : null,
      }));

    cacheSet(chave, produtos);
    return produtos;
  } catch (err) {
    logger.error('Erro ao buscar produto no Hipcom', { termo, error: err.message });
    return [];
  }
}

// ─── A.1 — Alias para listagem geral ───
async function getProdutos() {
  try {
    const res = await hipcom.get('/produtos', { params: { loja: HIPCOM_LOJA_PRECO, somente_estoque_positivo: 'S', limite: 100 } });
    return (res.data?.produtos || []).map(p => ({
      id:    String(p.plu),
      nome:  p.descricao,
      preco: p.valor_promocao > 0 ? p.valor_promocao : p.valor_produto,
    }));
  } catch (err) {
    logger.error('Erro ao listar produtos no Hipcom', { error: err.message });
    return [];
  }
}

// ─── A.2 — Verifica estoque somando lojas 1 e 6 ───
async function verificarEstoque(produtoId) {
  const chave = `estoque:${produtoId}`;
  const cached = cacheGet(chave);
  if (cached) return cached;
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const resultados = await Promise.all(
      HIPCOM_LOJAS_ESTOQUE.map(loja =>
        hipcom.get('/estoquesprodutos', { params: { loja, data: hoje, plu: produtoId } })
          .then(r => r.data?.estoques?.[0]?.quantidade_total || 0)
          .catch(() => 0)
      )
    );
    const quantidade = resultados.reduce((a, b) => a + b, 0);
    const result = { disponivel: quantidade > 0, quantidade };
    cacheSet(chave, result);
    return result;
  } catch (err) {
    logger.warn('verificar_estoque Hipcom falhou, assumindo disponível', { produtoId, error: err.message });
    return { disponivel: true, quantidade: -1, erro: true };
  }
}

// ─── B.1 — Busca cliente no Supabase (sincronizado do Hipcom via hipcomSync.js) ───
async function buscarCliente(identificador) {
  try {
    const { buscarClienteLocal } = require('./hipcomSync');
    return await buscarClienteLocal(identificador);
  } catch (err) {
    logger.error('Erro ao buscar cliente', { identificador, error: err.message });
    return null;
  }
}

// ─── C.1 — Cria pedido na retaguarda ───
// POST /pedidos
// Endereço obrigatório no formato: "Rua, Número, Bairro, Cidade/UF, CEP" (CEP com 8 dígitos)
// produto_id pode ser o objectId do Parse, SKU ou EAN
// Retorno: { id, numero, status: "recebido", previsao_entrega }
// Erro 400 se CEP não atendido: { status: 400, message: "Erro no endereço: Não entregamos para essa região." }
function normalizarTelefone(tel) {
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
