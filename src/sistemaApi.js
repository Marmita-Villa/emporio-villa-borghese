const axios = require('axios');

// ─── Cliente HTTP — base: https://api.emporiovillaborghese.com.br ───
const api = axios.create({
  baseURL: process.env.SISTEMA_API_URL || 'https://api.emporiovillaborghese.com.br',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.SISTEMA_API_TOKEN}`,
  },
  timeout: 10000,
});

// ─── Remove acentos para compatibilidade com a API (não suporta caracteres acentuados) ───
function removerAcentos(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ─── Detecta se o termo é um código de barras EAN (8–13 dígitos numéricos) ───
function pareceCodBarras(termo) {
  return /^\d{8,13}$/.test(termo.trim());
}

// ─── A.1 — Busca produtos por nome, SKU ou EAN ───
// GET /produtos/buscar
// Params: q (nome parcial), ean (código de barras), campos, limit, page
async function buscarProduto(termo) {
  try {
    const termoLimpo = removerAcentos(termo.trim());
    const params = pareceCodBarras(termoLimpo)
      ? { ean: termoLimpo, campos: 'id,nome,preco,ean' }
      : { q: termoLimpo, campos: 'id,nome,preco,ean', limit: 8 };

    const res = await api.get('/produtos/buscar', { params });
    // Garante retorno de array mesmo se vier objeto único
    return Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
  } catch (err) {
    console.error('Erro ao buscar produto:', err.message);
    return [];
  }
}

// ─── A.1 — Alias para listagem geral (não usada pela IA mas exportada por compatibilidade) ───
async function getProdutos() {
  try {
    const res = await api.get('/produtos/buscar', { params: { limit: 'all', campos: 'id,nome,preco,estoque' } });
    return Array.isArray(res.data) ? res.data : [];
  } catch (err) {
    console.error('Erro ao listar produtos:', err.message);
    return [];
  }
}

// ─── A.2 — Verifica estoque de um produto específico ───
// GET /produtos/:id/estoque  →  { "disponivel": true, "quantidade": 99999 }
async function verificarEstoque(produtoId) {
  try {
    const res = await api.get(`/produtos/${produtoId}/estoque`);
    return res.data; // { disponivel: boolean, quantidade: number }
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 400) return { disponivel: false, quantidade: 0 };
    console.error('Erro ao verificar estoque:', err.message);
    return { disponivel: false, quantidade: 0 };
  }
}

// ─── B.1 — Busca cliente por CPF, telefone ou nome ───
// GET /clientes/buscar
// Params: cpf (sem pontuação), telefone (com DDD), nome, incluir_historico
// Resposta: { id, nome, cpf, telefone, endereco, forma_pagamento_preferida, ... }
async function buscarCliente(identificador) {
  try {
    const apenasNumeros = identificador.replace(/\D/g, '');
    let params = {};

    if (apenasNumeros.length === 11) {
      params = { cpf: apenasNumeros };           // CPF: exatamente 11 dígitos sem pontuação
    } else if (apenasNumeros.length >= 8) {
      params = { telefone: apenasNumeros };      // Telefone com DDD
    } else {
      params = { nome: removerAcentos(identificador) }; // Nome parcial sem acentos
    }

    const res = await api.get('/clientes/buscar', {
      params: { ...params, incluir_historico: true },
    });
    return res.data || null;
  } catch (err) {
    if (err.response?.status === 404) return null;
    console.error('Erro ao buscar cliente:', err.message);
    return null;
  }
}

// ─── C.1 — Cria pedido na retaguarda ───
// POST /pedidos
// Endereço obrigatório no formato: "Rua, Número, Bairro, Cidade/UF, CEP" (CEP com 8 dígitos)
// produto_id pode ser o objectId do Parse, SKU ou EAN
// Retorno: { id, numero, status: "recebido", previsao_entrega }
// Erro 400 se CEP não atendido: { status: 400, message: "Erro no endereço: Não entregamos para essa região." }
async function criarPedido(pedido) {
  try {
    const payload = {
      cliente: {
        telefone: pedido.telefone,
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
      canal: 'whatsapp',
    };

    const res = await api.post('/pedidos', payload);
    console.log(`✅ Pedido #${res.data.numero || res.data.id} criado no sistema`);
    return res.data; // { id, numero, status, previsao_entrega }
  } catch (err) {
    // Erro 400 = endereço fora de cobertura ou dados inválidos
    if (err.response?.status === 400) {
      const msg = err.response.data?.message || 'Endereço inválido ou fora de cobertura.';
      throw new Error(msg);
    }
    console.error('Erro ao criar pedido:', err.response?.data || err.message);
    throw new Error('Não foi possível registrar o pedido no sistema.');
  }
}

// ─── C.2 — Consulta pedidos ativos para estimar tempo de entrega ───
// GET /pedidos/ativos  →  { "ativos": 12 }
async function consultarDemanda() {
  try {
    const res = await api.get('/pedidos/ativos');
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
    console.error('Erro ao consultar demanda:', err.message);
    return { pedidosAtivos: 0, tempoEstimado: 45, demanda: 'desconhecida' };
  }
}

module.exports = { getProdutos, buscarProduto, verificarEstoque, criarPedido, consultarDemanda, buscarCliente };
