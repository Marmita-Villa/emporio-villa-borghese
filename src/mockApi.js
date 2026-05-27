// ─── Dados fictícios para teste local (sem API real) ───

const produtos = [
  { id: '001', nome: 'Arroz Tio João 5kg',        preco: 28.90, estoque: 15, categoria: 'grãos' },
  { id: '002', nome: 'Feijão Carioca 1kg',         preco:  8.50, estoque: 20, categoria: 'grãos' },
  { id: '003', nome: 'Feijão Preto 1kg',           preco:  9.20, estoque: 12, categoria: 'grãos' },
  { id: '004', nome: 'Óleo de Soja 900ml',         preco:  7.90, estoque: 30, categoria: 'óleos' },
  { id: '005', nome: 'Açúcar Cristal 1kg',         preco:  4.50, estoque: 25, categoria: 'mercearia' },
  { id: '006', nome: 'Macarrão Espaguete 500g',    preco:  3.90, estoque: 40, categoria: 'massas' },
  { id: '007', nome: 'Macarrão Parafuso 500g',     preco:  3.90, estoque: 35, categoria: 'massas' },
  { id: '008', nome: 'Leite Integral 1L',          preco:  5.20, estoque: 50, categoria: 'laticínios' },
  { id: '009', nome: 'Leite Desnatado 1L',         preco:  5.50, estoque: 20, categoria: 'laticínios' },
  { id: '010', nome: 'Manteiga 200g',              preco: 12.90, estoque: 15, categoria: 'laticínios' },
  { id: '011', nome: 'Queijo Mussarela 500g',      preco: 24.90, estoque:  8, categoria: 'laticínios' },
  { id: '012', nome: 'Refrigerante Coca-Cola 2L',  preco:  9.90, estoque: 24, categoria: 'bebidas' },
  { id: '013', nome: 'Refrigerante Guaraná 2L',    preco:  7.90, estoque: 18, categoria: 'bebidas' },
  { id: '014', nome: 'Água Mineral 1,5L',          preco:  2.50, estoque: 60, categoria: 'bebidas' },
  { id: '015', nome: 'Cerveja Skol Lata 350ml',    preco:  4.50, estoque: 48, categoria: 'bebidas' },
  { id: '016', nome: 'Pão de Forma 500g',          preco:  7.90, estoque: 10, categoria: 'padaria' },
  { id: '017', nome: 'Biscoito Maizena 400g',      preco:  5.90, estoque:  0, categoria: 'biscoitos' }, // sem estoque
  { id: '018', nome: 'Biscoito Recheado 130g',     preco:  3.50, estoque: 30, categoria: 'biscoitos' },
  { id: '019', nome: 'Sabão em Pó 1kg',            preco: 14.90, estoque: 20, categoria: 'limpeza' },
  { id: '020', nome: 'Detergente 500ml',           preco:  2.90, estoque: 35, categoria: 'limpeza' },
];

// Simula pedidos ativos no sistema (em produção vem da API real)
function getPedidosAtivos() {
  // Simula variação de demanda ao longo do dia
  const hora = new Date().getHours();
  let base;
  if (hora >= 11 && hora <= 13) base = 15; // horário de almoço
  else if (hora >= 18 && hora <= 21) base = 18; // horário de jantar
  else if (hora >= 8 && hora <= 10) base = 5;  // manhã tranquila
  else base = 8;
  // Adiciona variação aleatória
  return base + Math.floor(Math.random() * 6);
}

let pedidoCounter = 100;

async function getProdutos(categoria = null) {
  if (categoria) return produtos.filter(p => p.categoria === categoria);
  return produtos;
}

async function buscarProduto(termo) {
  const t = termo.toLowerCase();
  return produtos.filter(p =>
    p.nome.toLowerCase().includes(t) || p.categoria.toLowerCase().includes(t)
  );
}

async function verificarEstoque(produtoId) {
  const produto = produtos.find(p => p.id === produtoId);
  if (!produto) return { disponivel: false, quantidade: 0 };
  return { disponivel: produto.estoque > 0, quantidade: produto.estoque };
}

async function criarPedido(pedido) {
  pedidoCounter++;
  const numero = `PED-${pedidoCounter}`;
  console.log('\n📋 ─── PEDIDO CRIADO (MOCK) ───');
  console.log(JSON.stringify(pedido, null, 2));
  return {
    id: numero,
    numero,
    status: 'recebido',
    previsao_entrega: '30-45 minutos',
  };
}

async function consultarDemanda() {
  const ativos = getPedidosAtivos();
  let minutos, descricao;

  if (ativos <= 4)       { minutos = 30; descricao = 'baixa'; }
  else if (ativos <= 9)  { minutos = 45; descricao = 'moderada'; }
  else if (ativos <= 15) { minutos = 60; descricao = 'alta'; }
  else if (ativos <= 22) { minutos = 90; descricao = 'muito alta'; }
  else                   { minutos = 120; descricao = 'altíssima'; }

  return { pedidosAtivos: ativos, tempoEstimado: minutos, demanda: descricao };
}

module.exports = { getProdutos, buscarProduto, verificarEstoque, criarPedido, consultarDemanda };
