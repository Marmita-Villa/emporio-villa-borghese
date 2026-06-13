/**
 * sistemaApiV1.js — Adaptador para a nova API (API_VERSION=v1)
 *
 * Implementa os mesmos métodos exportados pelo sistemaApi.js (legacy),
 * mas usando os endpoints da nova plataforma.
 * Preencha BASE_URL e os endpoints conforme a documentação da nova API.
 */

const axios = require('axios');
const https = require('https');
const logger = require('./logger');

const api = axios.create({
  baseURL: process.env.SISTEMA_API_V1_URL || 'https://api-nova.emporiovillaborghese.com.br',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.SISTEMA_API_V1_TOKEN}`,
  },
  timeout: 8000,
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

function removerAcentos(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizarTelefone(tel) {
  const nums = String(tel || '').replace(/\D/g, '');
  if (nums.length === 13 && nums.startsWith('55')) return nums.slice(2);
  if (nums.length === 12 && nums.startsWith('0')) return nums.slice(1);
  return nums;
}

// ─── Busca cliente por telefone ou CPF ───
// TODO: ajustar endpoint conforme documentação da nova API
async function buscarCliente(identificador) {
  const chave = `v1:cliente:${identificador}`;
  const cached = cacheGet(chave);
  if (cached) return cached;

  const apenasNumeros = identificador.replace(/\D/g, '');
  const params = apenasNumeros.length >= 10
    ? { telefone: apenasNumeros }
    : { cpf: apenasNumeros || identificador };

  try {
    const res = await api.get('/clientes/buscar', { params });
    if (res.data) { cacheSet(chave, res.data); return res.data; }
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 400) return null;
    logger.error('[v1] Erro ao buscar cliente', { identificador, status, error: err.message });
  }
  return null;
}

// ─── Busca produtos por nome/EAN ───
// TODO: ajustar endpoint conforme documentação da nova API
async function buscarProduto(termo) {
  const chave = `v1:prod:${removerAcentos(termo.trim().toLowerCase())}`;
  const cached = cacheGet(chave);
  if (cached) return cached;

  try {
    const termoLimpo = removerAcentos(termo.trim());
    const res = await api.get('/produtos/buscar', {
      params: { q: termoLimpo, limit: 8 },
    });
    const result = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
    cacheSet(chave, result);
    return result;
  } catch (err) {
    logger.error('[v1] Erro ao buscar produto', { termo, error: err.message });
    return [];
  }
}

// ─── Verifica estoque ───
// TODO: ajustar endpoint conforme documentação da nova API
async function verificarEstoque(produtoId) {
  const chave = `v1:estoque:${produtoId}`;
  const cached = cacheGet(chave);
  if (cached) return cached;

  try {
    const res = await api.get(`/produtos/${produtoId}/estoque`);
    cacheSet(chave, res.data);
    return res.data;
  } catch (err) {
    logger.warn('[v1] verificar_estoque falhou, assumindo disponível', { produtoId, error: err.message });
    return { disponivel: true, quantidade: -1, erro: true };
  }
}

// ─── Cria pedido ───
// TODO: ajustar payload conforme documentação da nova API
async function criarPedido(pedido) {
  try {
    const payload = {
      cliente: {
        telefone: normalizarTelefone(pedido.telefone),
        nome: pedido.nomeCliente,
        endereco: pedido.endereco,
      },
      itens: pedido.itens.map(item => ({
        produto_id: item.id,
        nome: item.nome,
        quantidade: item.quantidade,
        preco_unitario: item.preco,
      })),
      total: pedido.total,
      forma_pagamento: pedido.formaPagamento,
      observacoes: pedido.observacoes || '',
      canal: 'whatsapp',
    };

    const res = await api.post('/pedidos', payload);
    logger.info(`[v1] Pedido criado`, { numero: res.data.numero || res.data.id });
    return res.data;
  } catch (err) {
    if (err.response?.status === 400) {
      throw new Error(err.response.data?.message || 'Endereço inválido ou fora de cobertura.');
    }
    logger.error('[v1] Erro ao criar pedido', { error: err.response?.data || err.message });
    throw new Error('Não foi possível registrar o pedido.');
  }
}

// ─── Consulta demanda/tempo de entrega ───
// TODO: ajustar endpoint conforme documentação da nova API
async function consultarDemanda() {
  try {
    const res = await api.get('/pedidos/ativos');
    const ativos = Array.isArray(res.data) ? res.data.length : (res.data?.ativos ?? 0);
    let minutos, descricao;
    if (ativos <= 4)       { minutos = 30;  descricao = 'baixa'; }
    else if (ativos <= 9)  { minutos = 45;  descricao = 'moderada'; }
    else if (ativos <= 15) { minutos = 60;  descricao = 'alta'; }
    else if (ativos <= 22) { minutos = 90;  descricao = 'muito alta'; }
    else                   { minutos = 120; descricao = 'altíssima'; }
    return { pedidosAtivos: ativos, tempoEstimado: minutos, demanda: descricao };
  } catch (err) {
    logger.error('[v1] Erro ao consultar demanda', { error: err.message });
    return { pedidosAtivos: 0, tempoEstimado: 45, demanda: 'desconhecida' };
  }
}

// getProdutos mantido por compatibilidade
async function getProdutos() { return []; }

module.exports = { getProdutos, buscarProduto, verificarEstoque, criarPedido, consultarDemanda, buscarCliente };
