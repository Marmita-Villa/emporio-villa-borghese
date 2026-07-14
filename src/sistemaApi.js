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

// ─── Cache Redis compartilhado ───
// TTLs mais longos = menos chamadas ao Hipcom (protege o servidor local).
// Estoque fica curto (precisa ser fresco); produtos e ofertas ficam mais longos.
const { Redis } = require('@upstash/redis');
const _redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});
const CACHE_TTL    = (parseInt(process.env.ESTOQUE_CACHE_MIN  || '10', 10)) * 60; // estoque
const PRODUTOS_TTL = (parseInt(process.env.PRODUTOS_CACHE_MIN || '15', 10)) * 60; // busca de produtos
const OFERTAS_TTL  = (parseInt(process.env.OFERTAS_CACHE_MIN  || '30', 10)) * 60; // ofertas do dia

async function cacheGet(key) {
  try { return await _redis.get(key); } catch { return null; }
}
async function cacheSet(key, val, ttl = CACHE_TTL) {
  try { await _redis.set(key, val, { ex: ttl }); } catch {}
}

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
  const cached = await cacheGet(chave);
  if (cached) return cached;
  try {
    const termoOriginal = termo.trim();
    const ehCodBarras = pareceCodBarras(termoOriginal);
    // O Hipcom não trata acentos ("pão francês" não bate com "PAO FRANCES * KG") — remove antes de buscar
    const termoLimpo = ehCodBarras ? termoOriginal : removerAcentos(termoOriginal);
    const params = ehCodBarras
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

    await cacheSet(chave, produtos, PRODUTOS_TTL);
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

// ─── Detecta o setor/seção do produto Hipcom (nome do campo varia por instalação) ───
function detectarSetor(p) {
  const cand = p.departamento || p.nome_departamento || p.descricao_departamento || p.desc_departamento
            || p.depto || p.nome_depto
            || p.secao || p.nome_secao || p.descricao_secao
            || p.grupo || p.nome_grupo || p.departamento_descricao
            || p.categoria || p.familia || p.setor;
  return cand ? String(cand).trim() : null;
}

// ─── A.3 — Ofertas do dia: produtos com preço promocional (valor_promocao > 0) ───
// Tenta o filtro somente_promocao=S (se o Hipcom honrar, retorna só promoções); de
// qualquer forma filtra no cliente por valor_promocao. Cacheado no Redis (TTL 5 min).
async function getOfertas() {
  const chave = 'ofertas:dia';
  const cached = await cacheGet(chave);
  if (cached) return cached;
  try {
    const res = await hipcom.get('/produtos', {
      params: { loja: HIPCOM_LOJA_PRECO, somente_estoque_positivo: 'S', somente_promocao: 'S', limite: 500 },
    });
    const ofertas = (res.data?.produtos || [])
      .filter(p => p.ativo === 'S'
        && !HIPCOM_BLOCKED.includes(String(p.plu))
        && p.valor_promocao > 0
        && p.valor_promocao < p.valor_produto)
      .map(p => ({
        id:           String(p.plu),
        nome:         p.descricao,
        preco:        p.valor_promocao,
        preco_normal: p.valor_produto,
        setor:        detectarSetor(p),
        ean:          p.codigo_barra ? String(p.codigo_barra) : null,
      }));
    await cacheSet(chave, ofertas, OFERTAS_TTL);
    return ofertas;
  } catch (err) {
    logger.error('Erro ao buscar ofertas no Hipcom', { error: err.message });
    return [];
  }
}

// ─── A.2 — Verifica estoque via qtd_estoque_atual do endpoint de produtos ───
async function verificarEstoque(produtoId) {
  const chave = `estoque:${produtoId}`;
  const cached = await cacheGet(chave);
  if (cached) return cached;
  try {
    const res = await hipcom.get('/produtos', { params: { loja: HIPCOM_LOJA_PRECO, plu: produtoId } });
    const produto = res.data?.produtos?.[0];
    if (!produto) return { disponivel: true, quantidade: -1 };
    const quantidade = produto.qtd_estoque_atual || 0;
    const result = { disponivel: quantidade > 0, quantidade };
    await cacheSet(chave, result);
    return result;
  } catch (err) {
    logger.warn('verificar_estoque Hipcom falhou, assumindo disponível', { produtoId, error: err.message });
    return { disponivel: true, quantidade: -1, erro: true };
  }
}

// ─── B.1 — Busca cliente: cadastro no Supabase (base completa do Hipcom) + histórico na API de delivery ───
async function buscarCliente(identificador) {
  try {
    const { buscarClienteLocal } = require('./hipcomSync');
    const cliente = await buscarClienteLocal(identificador);
    if (!cliente) return null;
    await enriquecerHistorico(cliente); // adiciona total_pedidos, ultimo_pedido, favoritos, etc.
    return cliente;
  } catch (err) {
    logger.error('Erro ao buscar cliente', { identificador, error: err.message });
    return null;
  }
}

// ─── B.2 — Enriquece o cliente com histórico da API de delivery (incluir_historico=true) ───
// Cliente que existe no ERP mas nunca pediu no delivery volta sem histórico → tratado como novo.
async function enriquecerHistorico(cliente) {
  try {
    const cpf = String(cliente.cpf || '').replace(/\D/g, '');
    const tel = String(cliente.telefone || '').replace(/\D/g, '');
    const params = { incluir_historico: true };
    if (cpf) params.cpf = cpf;
    else if (tel) params.telefone = tel;
    else return;

    const res = await api.get('/clientes/buscar', { params });
    const data = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!data) return;

    // Copia apenas os campos de histórico/preferência que a IA usa (sobrescreve só se vierem)
    for (const campo of ['total_pedidos', 'ultimo_pedido', 'favoritos', 'favoritos_em_oferta', 'forma_pagamento_preferida']) {
      if (data[campo] != null) cliente[campo] = data[campo];
    }
  } catch (err) {
    // Sem histórico não é erro fatal — o atendimento segue com os dados cadastrais
    logger.warn('Não foi possível enriquecer histórico do cliente', { error: err.response?.status || err.message });
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

module.exports = { getProdutos, getOfertas, buscarProduto, verificarEstoque, criarPedido, consultarDemanda, buscarCliente };
