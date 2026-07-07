// ─── Dados fictícios para teste local (sem API real) ───

// ─── Produtos (com campo oferta) ───
const produtos = [
  { id: '001', nome: 'Arroz Tio João 5kg',        marca: 'Tio João',   descricao: 'Arroz branco tipo 1 pacote 5kg',         preco: 28.90, estoque: 15, categoria: 'grãos',      ean: '7896048007500', oferta: true,  preco_oferta: 24.90, descricao_oferta: '🔥 Promoção da semana!' },
  { id: '002', nome: 'Feijão Carioca Camil 1kg',  marca: 'Camil',      descricao: 'Feijão carioca tipo 1 pacote 1kg',        preco:  8.50, estoque: 20, categoria: 'grãos',      ean: '7896006716018', oferta: false },
  { id: '003', nome: 'Feijão Preto Camil 1kg',    marca: 'Camil',      descricao: 'Feijão preto tipo 1 pacote 1kg',          preco:  9.20, estoque: 12, categoria: 'grãos',      ean: '7896006716025', oferta: false },
  { id: '004', nome: 'Óleo de Soja Soya 900ml',   marca: 'Soya',       descricao: 'Óleo de soja refinado garrafa 900ml',     preco:  7.90, estoque: 30, categoria: 'óleos',      ean: '7891107101621', oferta: false },
  { id: '005', nome: 'Açúcar Cristal União 1kg',  marca: 'União',      descricao: 'Açúcar cristal pacote 1kg',               preco:  4.50, estoque: 25, categoria: 'mercearia',  ean: '7891910000181', oferta: false },
  { id: '006', nome: 'Macarrão Espaguete Barilla 500g', marca: 'Barilla', descricao: 'Macarrão espaguete nº5 pacote 500g',  preco:  3.90, estoque: 40, categoria: 'massas',     ean: '8076800195057', oferta: false },
  { id: '007', nome: 'Macarrão Parafuso Barilla 500g',  marca: 'Barilla', descricao: 'Macarrão parafuso fusilli pacote 500g', preco: 3.90, estoque: 35, categoria: 'massas',    ean: '8076800195064', oferta: false },
  { id: '008', nome: 'Leite Integral Parmalat 1L', marca: 'Parmalat',  descricao: 'Leite UHT integral caixa 1 litro',        preco:  5.20, estoque: 50, categoria: 'laticínios', ean: '7891097100047', oferta: true,  preco_oferta: 4.50, descricao_oferta: '🥛 Leve 6 por R$ 27,00!' },
  { id: '009', nome: 'Leite Desnatado Parmalat 1L', marca: 'Parmalat', descricao: 'Leite UHT desnatado caixa 1 litro',       preco:  5.50, estoque: 20, categoria: 'laticínios', ean: '7891097100054', oferta: false },
  { id: '010', nome: 'Manteiga Aviação 200g',      marca: 'Aviação',   descricao: 'Manteiga com sal tablete 200g',           preco: 12.90, estoque: 15, categoria: 'laticínios', ean: '7891097100078', oferta: false },
  { id: '011', nome: 'Queijo Mussarela Faixa Azul 500g', marca: 'Faixa Azul', descricao: 'Queijo mussarela fatiado 500g',   preco: 24.90, estoque:  8, categoria: 'laticínios', ean: '7891097100092', oferta: false },
  { id: '012', nome: 'Refrigerante Coca-Cola 2L',  marca: 'Coca-Cola', descricao: 'Refrigerante cola garrafa 2 litros',      preco:  9.90, estoque: 24, categoria: 'bebidas',    ean: '7894900011517', oferta: true,  preco_oferta: 8.50, descricao_oferta: '🥤 Oferta relâmpago!' },
  { id: '013', nome: 'Refrigerante Guaraná Antarctica 2L', marca: 'Antarctica', descricao: 'Refrigerante guaraná garrafa 2L', preco: 7.90, estoque: 18, categoria: 'bebidas',   ean: '7891991010051', oferta: false },
  { id: '014', nome: 'Água Mineral Crystal 1,5L',  marca: 'Crystal',   descricao: 'Água mineral sem gás garrafa 1,5 litro',  preco:  2.50, estoque: 60, categoria: 'bebidas',    ean: '7894900700015', oferta: false },
  { id: '015', nome: 'Cerveja Skol Lata 350ml',    marca: 'Skol',      descricao: 'Cerveja pilsen lata 350ml',               preco:  4.50, estoque: 48, categoria: 'bebidas',    ean: '7891991000052', oferta: false },
  { id: '016', nome: 'Pão de Forma Wickbold 500g', marca: 'Wickbold',  descricao: 'Pão de forma tradicional fatiado 500g',   preco:  7.90, estoque: 10, categoria: 'padaria',    ean: '7896071012108', oferta: false },
  { id: '017', nome: 'Biscoito Maizena Piraquê 400g', marca: 'Piraquê', descricao: 'Biscoito maizena pacote 400g',          preco:  5.90, estoque:  0, categoria: 'biscoitos',  ean: '7896024400012', oferta: false }, // sem estoque
  { id: '018', nome: 'Biscoito Recheado Oreo 130g', marca: 'Oreo',     descricao: 'Biscoito recheado chocolate pacote 130g', preco:  3.50, estoque: 30, categoria: 'biscoitos',  ean: '7622300441937', oferta: false },
  { id: '019', nome: 'Sabão em Pó OMO 1kg',        marca: 'OMO',       descricao: 'Sabão em pó multiação pacote 1kg',        preco: 14.90, estoque: 20, categoria: 'limpeza',    ean: '7891150062108', oferta: true,  preco_oferta: 12.90, descricao_oferta: '🧺 Desconto especial!' },
  { id: '020', nome: 'Detergente Ypê 500ml',       marca: 'Ypê',       descricao: 'Detergente neutro frasco 500ml',          preco:  2.90, estoque: 35, categoria: 'limpeza',    ean: '7896098900244', oferta: false },
];

// ─── Base de clientes com histórico de pedidos ───
const clientes = [
  {
    id: 'CLI001',
    nome: 'Ana Paula Silva',
    cpf: '123.456.789-00',
    telefone: '13991234567',
    email: 'ana@email.com',
    endereco: 'Rua das Flores, 123, Boqueirão, Santos/SP',
    forma_pagamento_preferida: 'Pix',
    historico_pedidos: [
      { data: '2025-05-20', numero: 'PED-135', itens: [
        { id: '001', nome: 'Arroz Tio João 5kg', quantidade: 1 },
        { id: '008', nome: 'Leite Integral Parmalat 1L', quantidade: 6 },
        { id: '010', nome: 'Manteiga Aviação 200g', quantidade: 1 },
        { id: '020', nome: 'Detergente Ypê 500ml', quantidade: 2 },
      ]},
      { data: '2025-05-05', numero: 'PED-121', itens: [
        { id: '001', nome: 'Arroz Tio João 5kg', quantidade: 1 },
        { id: '002', nome: 'Feijão Carioca Camil 1kg', quantidade: 2 },
        { id: '008', nome: 'Leite Integral Parmalat 1L', quantidade: 6 },
        { id: '019', nome: 'Sabão em Pó OMO 1kg', quantidade: 1 },
      ]},
      { data: '2025-04-18', numero: 'PED-108', itens: [
        { id: '001', nome: 'Arroz Tio João 5kg', quantidade: 2 },
        { id: '008', nome: 'Leite Integral Parmalat 1L', quantidade: 12 },
        { id: '010', nome: 'Manteiga Aviação 200g', quantidade: 2 },
      ]},
    ],
  },
  {
    id: 'CLI002',
    nome: 'Carlos Eduardo Mendes',
    cpf: '987.654.321-00',
    telefone: '13996543210',
    email: 'carlos@email.com',
    endereco: 'Av. Ana Costa, 456, Vila Belmiro, Santos/SP',
    forma_pagamento_preferida: 'Cartão de crédito',
    historico_pedidos: [
      { data: '2025-04-15', numero: 'PED-098', itens: [
        { id: '012', nome: 'Refrigerante Coca-Cola 2L', quantidade: 3 },
        { id: '015', nome: 'Cerveja Skol Lata 350ml', quantidade: 12 },
        { id: '018', nome: 'Biscoito Recheado Oreo 130g', quantidade: 4 },
      ]},
    ],
  },
  {
    id: 'CLI003',
    nome: 'Matheus Martins',
    cpf: '111.222.333-44',
    telefone: '13996091024',
    email: 'matheus@emporiovillaborghese.com.br',
    endereco: 'Rua Mato Grosso, 404, Santos/SP',
    forma_pagamento_preferida: 'Pix',
    historico_pedidos: [
      { data: '2025-05-27', numero: 'PED-147', itens: [
        { id: '001', nome: 'Arroz Tio João 5kg', quantidade: 2 },
        { id: '008', nome: 'Leite Integral Parmalat 1L', quantidade: 6 },
        { id: '010', nome: 'Manteiga Aviação 200g', quantidade: 1 },
        { id: '019', nome: 'Sabão em Pó OMO 1kg', quantidade: 2 },
      ]},
      { data: '2025-05-15', numero: 'PED-139', itens: [
        { id: '001', nome: 'Arroz Tio João 5kg', quantidade: 2 },
        { id: '002', nome: 'Feijão Carioca Camil 1kg', quantidade: 3 },
        { id: '008', nome: 'Leite Integral Parmalat 1L', quantidade: 6 },
        { id: '012', nome: 'Refrigerante Coca-Cola 2L', quantidade: 2 },
      ]},
      { data: '2025-05-01', numero: 'PED-128', itens: [
        { id: '001', nome: 'Arroz Tio João 5kg', quantidade: 2 },
        { id: '008', nome: 'Leite Integral Parmalat 1L', quantidade: 12 },
        { id: '019', nome: 'Sabão em Pó OMO 1kg', quantidade: 2 },
        { id: '010', nome: 'Manteiga Aviação 200g', quantidade: 2 },
      ]},
    ],
  },
];

// ─── Calcula itens favoritos e cruza com ofertas ───
function analisarHistorico(cliente) {
  if (!cliente.historico_pedidos || cliente.historico_pedidos.length === 0) {
    return { ultimo_pedido: null, favoritos: [], favoritos_em_oferta: [] };
  }

  // Último pedido
  const ultimo = cliente.historico_pedidos[0];

  // Contagem total por produto em todos os pedidos
  const contagem = {};
  for (const pedido of cliente.historico_pedidos) {
    for (const item of pedido.itens) {
      if (!contagem[item.id]) contagem[item.id] = { id: item.id, nome: item.nome, total: 0 };
      contagem[item.id].total += item.quantidade;
    }
  }

  // Ordena por quantidade total (favoritos primeiro)
  const favoritos = Object.values(contagem)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  // Cruza favoritos com produtos em oferta
  const favoritosEmOferta = favoritos
    .map(fav => {
      const prod = produtos.find(p => p.id === fav.id);
      if (prod && prod.oferta && prod.estoque > 0) {
        return {
          id: fav.id,
          nome: fav.nome,
          preco_normal: prod.preco,
          preco_oferta: prod.preco_oferta,
          descricao_oferta: prod.descricao_oferta,
        };
      }
      return null;
    })
    .filter(Boolean);

  return {
    ultimo_pedido: {
      data: ultimo.data,
      numero: ultimo.numero,
      itens: ultimo.itens,
    },
    favoritos,
    favoritos_em_oferta: favoritosEmOferta,
  };
}

// ─── Normaliza unidades de peso/volume para busca ───
function normalizarUnidades(texto) {
  return texto
    .toLowerCase()
    .replace(/(\d+[,.]?\d*)\s*(kg|g|ml|l\b|litro|litros)/gi, (_, num, unit) => {
      return `${num.replace(',', '.')}${unit.toLowerCase().replace('litro', 'l').replace('litros', 'l')}`;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Verifica se o termo parece um EAN13 (só números, 8 a 13 dígitos) ───
function pareceCodBarras(termo) {
  return /^\d{8,13}$/.test(termo.trim());
}

// ─── Busca produtos por nome, marca, descrição, categoria, peso ou EAN13 ───
async function buscarProduto(termo) {
  const original = termo.trim();

  if (pareceCodBarras(original)) {
    const porEan = produtos.filter(p => p.ean === original || p.ean.endsWith(original));
    if (porEan.length) return porEan;
  }

  const t = normalizarUnidades(original);

  return produtos.filter(p => {
    const campos = [p.nome, p.marca, p.descricao, p.categoria, p.ean].map(c => normalizarUnidades(c));
    return campos.some(c => c.includes(t));
  });
}

// ─── Simula pedidos ativos ───
function getPedidosAtivos() {
  const hora = new Date().getHours();
  let base;
  if (hora >= 11 && hora <= 13) base = 15;
  else if (hora >= 18 && hora <= 21) base = 18;
  else if (hora >= 8 && hora <= 10) base = 5;
  else base = 8;
  return base + Math.floor(Math.random() * 6);
}

let pedidoCounter = 100;

async function getProdutos(categoria = null) {
  if (categoria) return produtos.filter(p => p.categoria === categoria);
  return produtos;
}

async function getOfertas() {
  return produtos
    .filter(p => p.oferta && p.estoque > 0)
    .map(p => ({
      id:           p.id,
      nome:         p.nome,
      preco:        p.preco_oferta,
      preco_normal: p.preco,
      setor:        p.categoria,
      ean:          p.ean,
      descricao_oferta: p.descricao_oferta,
    }));
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
  return { id: numero, numero, status: 'recebido', previsao_entrega: '30-45 minutos' };
}

async function consultarDemanda() {
  const ativos = getPedidosAtivos();
  let minutos, descricao;
  if (ativos <= 4)       { minutos = 30;  descricao = 'baixa'; }
  else if (ativos <= 9)  { minutos = 45;  descricao = 'moderada'; }
  else if (ativos <= 15) { minutos = 60;  descricao = 'alta'; }
  else if (ativos <= 22) { minutos = 90;  descricao = 'muito alta'; }
  else                   { minutos = 120; descricao = 'altíssima'; }
  return { pedidosAtivos: ativos, tempoEstimado: minutos, demanda: descricao };
}

// ─── Busca cliente por CPF, telefone ou nome + histórico ───
async function buscarCliente(identificador) {
  const id = identificador.replace(/\D/g, '');

  const cliente = clientes.find(c => {
    const cpfLimpo = c.cpf.replace(/\D/g, '');
    const telLimpo = c.telefone.replace(/\D/g, '');
    const nomeLower = c.nome.toLowerCase();
    return (
      cpfLimpo === id ||
      telLimpo === id ||
      telLimpo.endsWith(id) ||
      nomeLower.includes(identificador.toLowerCase())
    );
  });

  if (!cliente) return null;

  const historico = analisarHistorico(cliente);
  return {
    id: cliente.id,
    nome: cliente.nome,
    cpf: cliente.cpf,
    telefone: cliente.telefone,
    endereco: cliente.endereco,
    forma_pagamento_preferida: cliente.forma_pagamento_preferida,
    total_pedidos: cliente.historico_pedidos.length,
    ...historico,
  };
}

module.exports = { getProdutos, getOfertas, buscarProduto, verificarEstoque, criarPedido, consultarDemanda, buscarCliente };
