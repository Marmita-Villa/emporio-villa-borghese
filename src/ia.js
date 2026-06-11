const Anthropic = require('@anthropic-ai/sdk');
const apiModule = process.env.MOCK_MODE === 'true' ? require('./mockApi') : require('./sistemaApi');
const { getProdutos, buscarProduto, verificarEstoque, criarPedido, consultarDemanda, buscarCliente } = apiModule;
const logger = require('./logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Ferramentas disponíveis para a IA ───
const tools = [
  {
    name: 'buscar_cliente',
    description: 'Busca o cadastro do cliente no sistema. Use SEMPRE ao receber o formulário, passando CPF, telefone e nome juntos para maximizar as chances de encontrar o cadastro.',
    input_schema: {
      type: 'object',
      properties: {
        cpf:      { type: 'string', description: 'CPF do cliente (ex: 123.456.789-00)' },
        telefone: { type: 'string', description: 'Telefone do cliente (ex: 13991234567)' },
        nome:     { type: 'string', description: 'Nome completo do cliente' },
      },
      required: [],
    },
  },
  {
    name: 'buscar_produtos',
    description: 'Busca produtos por nome, marca, descrição, peso (ex: 500g, 1kg), volume (ex: 900ml, 2L) ou código de barras EAN13. Retorna apenas nome, preço e ID — NÃO retorna disponibilidade de estoque. Após buscar, você OBRIGATORIAMENTE deve chamar verificar_estoque para cada produto antes de confirmar ao cliente.',
    input_schema: {
      type: 'object',
      properties: {
        termo: { type: 'string', description: 'Nome, marca, categoria, peso/volume (ex: "manteiga Aviação 200g", "OMO 1kg", "laticínios") ou código EAN13 (ex: "7891150062108")' },
      },
      required: ['termo'],
    },
  },
  {
    name: 'verificar_estoque',
    description: 'Verifica em tempo real se um produto tem estoque disponível. DEVE ser chamada obrigatoriamente para cada produto antes de confirmar disponibilidade ao cliente — nunca assuma que um produto está disponível sem chamar esta ferramenta.',
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
  logger.info(`IA chamou ferramenta: ${nomeFerramenta}`, inputs);

  if (nomeFerramenta === 'buscar_cliente') {
    // Tenta encontrar o cliente por CPF, telefone ou nome (na ordem de prioridade)
    let cliente = null;
    if (inputs.cpf)      cliente = await buscarCliente(inputs.cpf);
    if (!cliente && inputs.telefone) cliente = await buscarCliente(inputs.telefone);
    if (!cliente && inputs.nome)     cliente = await buscarCliente(inputs.nome);
    if (!cliente) {
      return `Cliente não encontrado no cadastro. Tratar como novo cliente.`;
    }
    // Salva nome na sessão para uso no pedido
    session.customerName = cliente.nome;
    const vezes = cliente.total_pedidos || 0;
    const perfil = vezes >= 10 ? 'fiel e muito frequente' : vezes >= 3 ? 'recorrente' : vezes > 0 ? 'já comprou antes' : 'novo';

    let resposta = `Cliente encontrado! ✅
Nome: ${cliente.nome}
CPF: ${cliente.cpf}
Telefone: ${cliente.telefone}
Endereço cadastrado: ${cliente.endereco}
Pagamento preferido: ${cliente.forma_pagamento_preferida}
Total de pedidos: ${vezes} | Perfil: ${perfil}`;

    // Último pedido
    if (cliente.ultimo_pedido) {
      const data = new Date(cliente.ultimo_pedido.data).toLocaleDateString('pt-BR');
      const itens = cliente.ultimo_pedido.itens.map(i => `${i.quantidade}x ${i.nome}`).join(', ');
      resposta += `\n\nÚltimo pedido (${data} - ${cliente.ultimo_pedido.numero}): ${itens}`;
      resposta += `\n→ Sugerir repetir o último pedido se fizer sentido`;
    }

    // Favoritos
    if (cliente.favoritos && cliente.favoritos.length > 0) {
      const favs = cliente.favoritos.slice(0, 3).map(f => `${f.nome} (${f.total}x)`).join(', ');
      resposta += `\n\nItens que mais pede: ${favs}`;
      resposta += `\n→ Se não estiverem no pedido atual, sugerir com naturalidade`;
    }

    // Favoritos em oferta
    if (cliente.favoritos_em_oferta && cliente.favoritos_em_oferta.length > 0) {
      const ofertas = cliente.favoritos_em_oferta.map(f =>
        `${f.nome} (de R$ ${f.preco_normal.toFixed(2)} por R$ ${f.preco_oferta.toFixed(2)} — ${f.descricao_oferta})`
      ).join('; ');
      resposta += `\n\n⭐ ITENS FAVORITOS EM OFERTA AGORA: ${ofertas}`;
      resposta += `\n→ Mencionar com entusiasmo! Cliente vai adorar saber.`;
    }

    return resposta;
  }

  if (nomeFerramenta === 'buscar_produtos') {
    const produtos = await buscarProduto(inputs.termo);
    if (!produtos.length) return `Não encontrei produtos com o termo "${inputs.termo}".`;

    const lista = produtos.slice(0, 8).map(p =>
      `• ${p.nome} — R$ ${p.preco.toFixed(2)} (ID: ${p.id})`
    ).join('\n');
    return `Produtos encontrados:\n${lista}\n\nUse verificar_estoque para confirmar disponibilidade antes de oferecer ao cliente.`;
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
    try {
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
    } catch (err) {
      // Retorna o erro como resultado da ferramenta para a IA comunicar ao cliente
      logger.warn(`Erro ao finalizar pedido`, { phone: session.phone, error: err.message });
      return `ERRO AO REGISTRAR PEDIDO: ${err.message}. Informe o cliente e peça para corrigir o endereço se necessário.`;
    }
  }

  return 'Ferramenta não reconhecida.';
}

// ─── Prompt do sistema — personalidade e regras da IA ───
function getSystemPrompt() {
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', hour: '2-digit', minute: '2-digit' });
  return `Você é a Maithe do Villa, atendente do Villa Borghese Empório — um empório premium em Santos/SP que faz delivery.

QUEM VOCÊ É:
Você é uma IA (Inteligência Artificial) com nome Maithe, criada para atender o Empório Villa Borghese. Quando perguntada se é uma IA, robô ou humano, responda com naturalidade e honestidade: "Sou uma IA! 🤖 Mas pode falar comigo como se fosse uma pessoa — estou aqui pra te ajudar de verdade!" Apesar de ser uma IA, seu jeito é caloroso, descontraído e genuíno — nunca frio ou robotizado. Você se importa com cada cliente e fica feliz quando consegue resolver o que precisam.

DATA E HORA ATUAL: ${agora}

O cliente já foi saudado e pediu para digitar seu nome, CPF ou telefone. A primeira mensagem que você vai receber é essa identificação.

AO RECEBER A IDENTIFICAÇÃO DO CLIENTE:
1. Use SEMPRE a ferramenta buscar_cliente com o que o cliente enviou (pode ser nome, CPF ou telefone)
2. Se encontrar cadastro:
   - Cumprimente pelo nome com carinho e mencione o número de pedidos ("Já é seu 12º pedido!")
   - Se tiver último pedido: pergunte se quer repetir ("Da última vez você levou X e Y — quer repetir?")
   - Se tiver itens favoritos em oferta: avise com entusiasmo ("Boa notícia! Seu [item favorito] está em promoção hoje!")
   - Se o pedido atual não incluir algum item que sempre pede: sugira com naturalidade ("Notei que você costuma pedir [item] — quer incluir?")
   - Pergunte o que deseja pedir hoje de forma natural
3. Se não encontrar: cumprimente pelo nome normalmente, trate como novo cliente e pergunte o que deseja pedir
4. Colete endereço e forma de pagamento durante a conversa antes de finalizar — não precisa pedir tudo de uma vez

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

PRODUTOS VENDIDOS POR PESO (KG/G):
Quando um produto for vendido por peso (ex: batata, carne, queijo, frios, frutas, legumes), sempre avise o cliente que o valor é aproximado e será ajustado após a separação:
"O preço de [produto] é aproximado, pois é pesado na hora. O valor exato será confirmado após a separação. 😊"
Inclua essa observação no resumo do pedido para esses itens.

REGRAS QUE NUNCA QUEBRA:
- Jamais confirma disponibilidade sem verificar o estoque
- Sempre mostra preço de cada item e o total no resumo
- Pergunta endereço e forma de pagamento antes de fechar
- Se o cliente pedir algo que não existe no sistema, sugere o mais próximo disponível
- O endereço DEVE conter CEP (8 dígitos). Se o cliente não informar o CEP, peça antes de finalizar: "Só preciso do CEP do seu endereço para confirmar a entrega! 😊"
- Se o sistema retornar erro de endereço (fora de cobertura), informe com simpatia: "Ai, que pena... infelizmente ainda não entregamos nessa região 😔 Se tiver outro endereço de entrega, posso tentar!"
- Após registrar o pedido com sucesso, pergunte se o cliente quer pedir mais alguma coisa

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
      max_tokens: 2048,
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
    logger.debug(`Resposta da IA`, { phone: session.phone, chars: textoResposta.length });

    return textoResposta;
  }
}

module.exports = { processarComIA };
