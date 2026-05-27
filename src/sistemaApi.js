const axios = require('axios');

const api = axios.create({
  baseURL: process.env.SISTEMA_API_URL,      // ex: https://meusite.com.br/api
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.SISTEMA_API_TOKEN}`,
  },
  timeout: 10000,
});

// ─── Busca todos os produtos disponíveis no estoque ───
async function getProdutos(categoria = null) {
  try {
    const params = categoria ? { categoria } : {};
    const res = await api.get('/produtos', { params });
    return res.data; // espera array de produtos
  } catch (err) {
    console.error('Erro ao buscar produtos:', err.message);
    return [];
  }
}

// ─── Verifica se o termo é um código de barras EAN (8–13 dígitos) ───
function pareceCodBarras(termo) {
  return /^\d{8,13}$/.test(termo.trim());
}

// ─── Busca produto por nome, marca, descrição, peso (kg/g) ou EAN13 ───
async function buscarProduto(termo) {
  try {
    const params = pareceCodBarras(termo.trim())
      ? { ean: termo.trim() }                  // busca direta por código de barras
      : { q: termo, campos: 'nome,marca,descricao,categoria,ean' }; // busca ampla

    const res = await api.get('/produtos/buscar', { params });
    return res.data;
  } catch (err) {
    console.error('Erro ao buscar produto:', err.message);
    return [];
  }
}

// ─── Verifica estoque de um produto específico ───
async function verificarEstoque(produtoId) {
  try {
    const res = await api.get(`/produtos/${produtoId}/estoque`);
    return res.data; // { disponivel: true, quantidade: 15 }
  } catch (err) {
    console.error('Erro ao verificar estoque:', err.message);
    return { disponivel: false, quantidade: 0 };
  }
}

// ─── Cria o pedido no sistema interno ───
async function criarPedido(pedido) {
  try {
    const payload = {
      cliente: {
        telefone: pedido.telefone,
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
      criado_em: new Date().toISOString(),
    };

    const res = await api.post('/pedidos', payload);
    console.log(`✅ Pedido #${res.data.id} criado no sistema`);
    return res.data; // { id, numero, status, previsao_entrega }
  } catch (err) {
    console.error('Erro ao criar pedido:', err.message);
    throw new Error('Não foi possível registrar o pedido no sistema.');
  }
}

// ─── Consulta pedidos ativos para calcular tempo de entrega ───
async function consultarDemanda() {
  try {
    const res = await api.get('/pedidos/ativos');
    const ativos = Array.isArray(res.data) ? res.data.length : (res.data.total || 0);
    let minutos, descricao;

    if (ativos <= 4)       { minutos = 30; descricao = 'baixa'; }
    else if (ativos <= 9)  { minutos = 45; descricao = 'moderada'; }
    else if (ativos <= 15) { minutos = 60; descricao = 'alta'; }
    else if (ativos <= 22) { minutos = 90; descricao = 'muito alta'; }
    else                   { minutos = 120; descricao = 'altíssima'; }

    return { pedidosAtivos: ativos, tempoEstimado: minutos, demanda: descricao };
  } catch (err) {
    console.error('Erro ao consultar demanda:', err.message);
    return { pedidosAtivos: 0, tempoEstimado: 45, demanda: 'desconhecida' };
  }
}

module.exports = { getProdutos, buscarProduto, verificarEstoque, criarPedido, consultarDemanda };
