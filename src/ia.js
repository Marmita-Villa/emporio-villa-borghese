const Anthropic = require('@anthropic-ai/sdk');
const apiModule = process.env.MOCK_MODE === 'true' ? require('./mockApi') : require('./sistemaApi');
const { getProdutos, buscarProduto, verificarEstoque, criarPedido, consultarDemanda } = apiModule;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Ferramentas disponíveis para a IA ───
const tools = [
  {
    name: 'buscar_produtos',
    description: 'Busca produtos no estoque da mercearia por nome, categoria ou termo. Use para verificar o que tem disponível.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Nome do produto ou categoria (ex: arroz, laticínios, bebidas)' },
      },
      required: ['termo'],
    },
  },
  {
    name: 'verificar_estoque',
    description: 'Verifica se um produto específico tem estoque disponível e a quantidade.',
    input_schema: {
      type: 'object',
      properties: {
        produto_id: { type: 'string', description: 'ID do produto' },
        produto_nome: { type: 'string', description: 'Nome do produto para exibir ao cliente' },
      },
      required: ['produto_id', 'produto_nome'],
    },
  },
  {
    name: 'verificar_tempo_entrega',
    description: 'Consulta a demanda atual de pedidos no sistema e retorna o tempo estimado de entrega. Use SEMPRE antes de confirmar um pedido.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'finalizar_pedido',
    description: 'Finaliza e registra o pedido no sistema quando o cliente confirmar. Só use após confirmação explícita do cliente.',
    input_schema: {
      type: 'object',
      properties: {
        itens: {
          type: 'array',
          description: 'Lista de itens do pedido',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              nome: { type: 'string' },
              quantidade: { type: 'number' },
              preco: { type: 'number' },
            },
          },
        },
        endereco: { type: 'string', description: 'Endereço de entrega do cliente' },
        forma_pagamento: { type: 'string', description: 'Forma de pagamento: dinheiro, pix, cartão' },
        nome_cliente: { type: 'string', description: 'Nome do cliente' },
        observacoes: { type: 'string', description: 'Observações adicionais do pedido' },
      },
      required: ['itens', 'endereco', 'forma_pagamento'],
    },
  },
];

// ─── Executa a ferramenta chamada pela IA ───
async function executarFerramenta(nomeFerramenta, inputs, session) {
  console.log(`🔧 IA chamou ferramenta: ${nomeFerramenta}`, inputs);

  if (nomeFerramenta === 'buscar_produtos') {
    const produtos = await buscarProduto(inputs.termo);
    if (!produtos.length) return `Não encontrei produtos com o termo "${inputs.termo}".`;

    const lista = produtos.slice(0, 8).map(p =>
      `• ${p.nome} — R$ ${p.preco.toFixed(2)} (ID: ${p.id}) ${p.estoque > 0 ? '✅ em estoque' : '❌ sem estoque'}`
    ).join('\n');
    return `Produtos encontrados:\n${lista}`;
  }

  if (nomeFerramenta === 'verificar_estoque') {
    const estoque = await verificarEstoque(inputs.produto_id);
    if (estoque.disponivel) {
      return `"${inputs.produto_nome}" está disponível. Quantidade em estoque: ${estoque.quantidade} unidades.`;
    }
    return `"${inputs.produto_nome}" está SEM ESTOQUE no momento.`;
  }

  if (nomeFerramenta === 'verificar_tempo_entrega') {
    const demanda = await consultarDemanda();
    const msgs = {
      baixa: 'Estamos tranquilos agora',
      moderada: 'Temos um movimento moderado',
      alta: 'Estamos com bastante movimento',
      'muito alta': 'Estamos bem cheios agora',
      altíssima: 'Estamos com demanda altíssima',
      desconhecida: 'Não foi possível verificar a demanda',
    };
    return `${msgs[demanda.demanda] || 'Verificado'}. Pedidos em andamento: ${demanda.pedidosAtivos}. Tempo estimado de entrega: ${demanda.tempoEstimado} minutos.`;
  }

  if (nomeFerramenta === 'finalizar_pedido') {
    const total = inputs.itens.reduce((sum, i) => sum + (i.preco * i.quantidade), 0);
    const pedido = await criarPedido({
      telefone: session.phone,
      nomeCliente: inputs.nome_cliente || session.customerName || 'Cliente WhatsApp',
      endereco: inputs.endereco,
      itens: inputs.itens,
      total,
      formaPagamento: inputs.forma_pagamento,
      observacoes: inputs.observacoes,
    });
    session.step = 'done';
    return `Pedido registrado com sucesso! Número: #${pedido.id || pedido.numero}. Total: R$ ${total.toFixed(2)}. Previsão de entrega: ${pedido.previsao_entrega || '30-50 minutos'}.`;
  }

  return 'Ferramenta não reconhecida.';
}

// ─── Prompt do sistema — personalidade e regras da IA ───
function getSystemPrompt() {
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', hour: '2-digit', minute: '2-digit' });
  return `Você é a Maithe do Villa, atendente do Villa Borghese Empório — um empório premium em Santos/SP que faz delivery.

QUEM VOCÊ É:
Você é uma pessoa real, calorosa e animada. Fala como uma amiga que entende bem de produtos e adora ajudar. Seu jeito é descontraído, próximo e genuíno — nunca robotizado. Você se importa de verdade com cada cliente e fica feliz quando consegue resolver o que precisam.

DATA E HORA ATUAL: ${agora}

O cliente já foi recebido com boas-vindas e um formulário. A primeira mensagem que você vai receber é o formulário preenchido com: Nome Completo, CPF, Telefone, Endereço, Forma de pagamento, Pedido e se aceita marcas similares. Cumprimente o cliente pelo nome, extraia todos os itens do pedido, verifique o estoque de cada um e processe o pedido normalmente.

NOSSAS UNIDADES E HORÁRIOS:
• Rua Mato Grosso, 404, Santos/SP — Seg. a Sáb. das 8h às 21h | Dom. das 8h às 14h
• Rua Azevedo Sodré, 144, Santos/SP — Seg. a Sáb. das 8h às 23h | Dom. das 8h às 21h
Telefone: (13) 2104-7575

Se o cliente entrar em contato fora do horário de funcionamento de AMBAS as unidades, avise com simpatia que estamos fechados e informe quando abrimos novamente.

SEU JEITO DE FALAR:
- Português informal, como uma conversa de WhatsApp entre amigos
- Use expressões naturais: "Boa escolha!", "Ai sim!", "Deixa comigo!", "Perfeito!", "Boa notícia:", "Ah, esse tá voando aqui..."
- Varie as saudações: "Oi!", "Olá!", "Oi, tudo bem?", "Oiii, que bom te ver por aqui no Villa Borghese!"
- Quando se apresentar, sempre diga: "Sou a Maithe do Villa"
- Demonstre entusiasmo quando o cliente faz um bom pedido
- Quando faltar produto, mostre empatia antes de sugerir: "Ai, que pena... esse acabou agora pouco 😅 Mas tenho uma ótima opção pra você:"
- Nunca responda como um robô ou lista fria de informações
- Use emojis com naturalidade, sem exagero — como qualquer pessoa usaria no WhatsApp
- Mensagens curtas e diretas. Nada de parágrafos longos

SUAS RESPONSABILIDADES:
- Consultar o estoque antes de confirmar qualquer produto
- Quando faltar um item, sentir empatia e sugerir 2 alternativas similares com entusiasmo
- Montar o carrinho conforme o cliente pede, confirmando cada item
- Antes de finalizar, verificar o tempo de entrega atual via ferramenta e incluir no resumo
- Mostrar o resumo completo do pedido com o tempo estimado
- Registrar o pedido SOMENTE após o cliente confirmar

REGRAS QUE NUNCA QUEBRA:
- Jamais confirma disponibilidade sem verificar o estoque
- Sempre mostra preço de cada item e o total no resumo
- Pergunta endereço e forma de pagamento antes de fechar
- Se o cliente pedir algo que não existe no sistema, sugere o mais próximo disponível

TAXAS DE ENTREGA (por região):
• Borghese: R$ 7,50
• Decanter: R$ 20,00
• Guarujá: R$ 19,90
• Litoral Norte: R$ 55,00
• Peruíbe: R$ 35,00
• Riviera: R$ 39,00
• São Vicente / Praia Grande: R$ 15,00
• São Paulo: R$ 50,00

Quando o cliente informar o endereço, identifique a região e informe a taxa correspondente antes de confirmar o pedido. Some a taxa ao total do pedido no resumo final.

FORMAS DE PAGAMENTO: Pix, cartão de débito, cartão de crédito (Visa, Mastercard, American Express) ou dinheiro na entrega.

FORMATO DO RESUMO DO PEDIDO:
🛒 *Resumo do seu pedido:*
• [item] x[qtd] — R$ [valor]
• [item] x[qtd] — R$ [valor]
🛵 *Taxa de entrega: R$ [taxa]*
💰 *Total: R$ [total com taxa]*
📍 Endereço: [endereço]
💳 Pagamento: [forma]
⏱️ *Previsão de entrega: ~[tempo] minutos*

Posso confirmar? 😊`;
}

// ─── Função principal: processa mensagem com loop de ferramentas ───
async function processarComIA(session, novaMensagem) {
  // Adiciona mensagem do cliente ao histórico
  session.messages.push({ role: 'user', content: novaMensagem });

  let messages = [...session.messages];

  // Loop de ferramenta: a IA pode chamar várias ferramentas antes de responder
  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: getSystemPrompt(),
      tools,
      messages,
    });

    // Se a IA quer usar uma ferramenta
    if (response.stop_reason === 'tool_use') {
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

      // Adiciona resposta da IA (com todos os tool_use) ao histórico
      messages.push({ role: 'assistant', content: response.content });

      // Executa TODAS as ferramentas em paralelo
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const resultado = await executarFerramenta(block.name, block.input, session);
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: resultado,
          };
        })
      );

      // Devolve todos os resultados de uma vez
      messages.push({ role: 'user', content: toolResults });

      continue; // continua o loop para a IA processar os resultados
    }

    // IA terminou — extrai resposta em texto
    const textoResposta = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Salva resposta da IA no histórico da sessão
    session.messages.push({ role: 'assistant', content: textoResposta });

    return textoResposta;
  }
}

module.exports = { processarComIA };
