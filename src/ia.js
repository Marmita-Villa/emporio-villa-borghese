const Anthropic = require('@anthropic-ai/sdk');
const apiModule = process.env.MOCK_MODE === 'true' ? require('./mockApi') : require('./sistemaApiAdapter');
const { getProdutos, getOfertas, buscarProduto, verificarEstoque, criarPedido, consultarDemanda, buscarCliente } = apiModule;
const { saveSession, salvarConversa, salvarPedido } = require('./db');
const logger = require('./logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Cache de demanda (TTL 3 min) para evitar chamada à API a cada mensagem ───
let _demandaCache = null;
let _demandaCacheTs = 0;
async function consultarDemandaCached() {
  if (_demandaCache && Date.now() - _demandaCacheTs < 3 * 60 * 1000) return _demandaCache;
  _demandaCache = await consultarDemanda();
  _demandaCacheTs = Date.now();
  return _demandaCache;
}

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
    description: 'Busca produtos por nome, marca, descrição, peso (ex: 500g, 1kg), volume (ex: 900ml, 2L) ou código de barras EAN13. Retorna nome, preço e ID. Após buscar, chame verificar_estoque para cada produto encontrado antes de confirmar ao cliente.',
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
    description: 'Verifica se um produto tem estoque disponível. Chame para cada produto encontrado no buscar_produtos antes de oferecer ao cliente. Se precisar verificar múltiplos produtos, chame várias vezes na mesma resposta — serão executadas em paralelo.',
    input_schema: {
      type: 'object',
      properties: {
        produto_id: { type: 'string', description: 'ID exato retornado pelo buscar_produtos. NUNCA invente ou deduza o ID — use SOMENTE o ID recebido na resposta da busca.' },
        produto_nome: { type: 'string', description: 'Nome do produto para exibir ao cliente' },
      },
      required: ['produto_id', 'produto_nome'],
    },
  },
  {
    name: 'buscar_ofertas',
    description: 'Ofertas do dia por setor. Chame SEM setor para obter a lista de setores que têm ofertas (ex: FLV, Mercearia, Limpeza). Chame COM setor para listar as ofertas daquele setor. Use quando o cliente pedir para ver ofertas/promoções.',
    input_schema: {
      type: 'object',
      properties: {
        setor: { type: 'string', description: 'Setor escolhido pelo cliente (ex: "mercearia", "flv", "limpeza"). Deixe vazio para listar os setores disponíveis.' },
      },
      required: [],
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
    description: 'OBRIGATÓRIO: registra o pedido no sistema. DEVE ser chamada imediatamente quando o cliente confirmar o pedido (disser "sim", "pode confirmar", "fechado", etc). NUNCA diga que o pedido foi confirmado sem antes chamar esta ferramenta.',
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
        telefone: { type: 'string', description: 'Telefone do cliente com DDD (ex: 13991765890). Obrigatório se não encontrado no cadastro.' },
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
    // Coleta todos os identificadores únicos — inclui telefone do WhatsApp como fallback
    const whatsappPhone = session.phone && session.phone !== 'teste_local' ? session.phone : null;
    const ids = [...new Set([inputs.cpf, inputs.telefone, inputs.nome, whatsappPhone].filter(Boolean))];
    let cliente = null;
    for (const id of ids) {
      cliente = await buscarCliente(id);
      if (cliente) break;
    }
    if (!cliente) {
      return `Cliente não encontrado no cadastro. Tratar como novo cliente.`;
    }
    // Salva dados do cliente na sessão para uso no pedido
    session.customerName = cliente.nome;
    if (cliente.telefone) session.customerPhone = cliente.telefone;

    // Monta endereço completo a partir dos campos separados do Hipcom
    const enderecoCompleto = [
      cliente.endereco,
      cliente.complemento,
      cliente.bairro,
      cliente.cidade && cliente.uf ? `${cliente.cidade}/${cliente.uf}` : (cliente.cidade || cliente.uf),
      cliente.cep ? `CEP ${cliente.cep}` : null,
    ].filter(Boolean).join(', ');
    if (enderecoCompleto) session.customerAddress = enderecoCompleto;

    const vezes = cliente.total_pedidos || 0;
    const perfil = vezes >= 10 ? 'fiel e muito frequente' : vezes >= 3 ? 'recorrente' : vezes > 0 ? 'já comprou antes' : 'novo';

    let resposta = `Cliente encontrado! ✅
Nome: ${cliente.nome}
CPF: ${cliente.cpf}
Telefone: ${cliente.telefone}
Endereço cadastrado: ${enderecoCompleto || '(não informado)'}
Pagamento preferido: ${cliente.forma_pagamento_preferida || 'não informado'}
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
      session.currentOffers = cliente.favoritos_em_oferta;
      const ofertas = cliente.favoritos_em_oferta.map(f =>
        `${f.nome} (de R$ ${f.preco_normal.toFixed(2)} por R$ ${f.preco_oferta.toFixed(2)} — ${f.descricao_oferta})`
      ).join('; ');
      resposta += `\n\n⭐ ITENS FAVORITOS EM OFERTA AGORA: ${ofertas}`;
      resposta += `\n→ Mencionar com entusiasmo! Cliente vai adorar saber.`;
    }

    return resposta;
  }

  if (nomeFerramenta === 'buscar_produtos') {
    const CACHE_TTL = 5 * 60 * 1000;
    const chave = inputs.termo.toLowerCase().trim();
    const cached = session.productCache?.[chave];
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      logger.debug(`Cache hit produtos`, { termo: inputs.termo });
      return cached.result;
    }

    const produtos = await buscarProduto(inputs.termo);
    if (!produtos.length) return `Não encontrei produtos com o termo "${inputs.termo}".`;

    const lista = produtos.slice(0, 8).map(p =>
      `• ${p.nome} — R$ ${p.preco.toFixed(2)} (ID: ${p.id})`
    ).join('\n');
    const result = `Produtos encontrados:\n${lista}`;

    if (session.productCache) session.productCache[chave] = { result, ts: Date.now() };

    // Salva mapa nome→{id,preco} na sessão para uso no rascunho de pedido
    if (!session.productMap) session.productMap = {};
    for (const p of produtos.slice(0, 8)) {
      session.productMap[p.nome.toLowerCase()] = { id: p.id, nome: p.nome, preco: p.preco };
    }

    return result;
  }

  if (nomeFerramenta === 'verificar_estoque') {
    const estoque = await verificarEstoque(inputs.produto_id);
    if (estoque.erro) {
      return `Não foi possível verificar o estoque de "${inputs.produto_nome}" agora (erro de comunicação). Trate como disponível e informe ao cliente que a disponibilidade será confirmada na separação.`;
    }
    if (estoque.disponivel) {
      return `"${inputs.produto_nome}" está disponível. Quantidade em estoque: ${estoque.quantidade} unidades.`;
    }
    return `"${inputs.produto_nome}" está SEM ESTOQUE no momento.`;
  }

  if (nomeFerramenta === 'buscar_ofertas') {
    const ofertas = await getOfertas();
    if (!ofertas.length) return 'Não há ofertas cadastradas no momento. Não invente promoções.';

    const filtro = (inputs.setor || '').trim().toLowerCase();
    const temSetores = ofertas.some(o => o.setor);

    // Sem setor escolhido: se há setores, apresenta os setores para o cliente escolher
    if (!filtro && temSetores) {
      const contagem = {};
      for (const o of ofertas) {
        const s = o.setor || 'Outros';
        contagem[s] = (contagem[s] || 0) + 1;
      }
      const listaSetores = Object.entries(contagem)
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `• ${s} (${n} ${n === 1 ? 'oferta' : 'ofertas'})`)
        .join('\n');
      return `Temos ofertas nestes setores:\n${listaSetores}\n\nPeça as ofertas de um setor (ex: "ofertas mercearia") e eu listo pra você.`;
    }

    // Com setor (ou sem setores no dado): filtra
    let lista = ofertas;
    if (filtro) {
      lista = ofertas.filter(o => {
        const s = (o.setor || '').toLowerCase();
        return s.includes(filtro) || filtro.includes(s);
      });
      if (!lista.length) {
        const disp = [...new Set(ofertas.map(o => o.setor).filter(Boolean))].join(', ');
        return `Não encontrei ofertas no setor "${inputs.setor}". Setores com ofertas: ${disp || 'nenhum específico'}.`;
      }
    }

    // Registra as ofertas exibidas na sessão (converte pelo nome e marca itens_oferta nas métricas)
    const novas = lista.map(o => ({ nome: o.nome, preco_oferta: o.preco, preco_normal: o.preco_normal }));
    session.currentOffers = [...(session.currentOffers || []), ...novas];
    if (!session.productMap) session.productMap = {};
    for (const o of lista.slice(0, 30)) {
      session.productMap[o.nome.toLowerCase()] = { id: o.id, nome: o.nome, preco: o.preco };
    }

    const texto = lista.slice(0, 20).map(o => {
      const de = o.preco_normal ? `de R$ ${Number(o.preco_normal).toFixed(2)} ` : '';
      return `• ${o.nome} — ${de}por R$ ${Number(o.preco).toFixed(2)} (ID: ${o.id})`;
    }).join('\n');
    const cabecalho = filtro ? `Ofertas de ${inputs.setor}` : 'Ofertas do dia';
    const rodape = lista.length > 20 ? `\n(mostrando 20 de ${lista.length})` : '';
    return `${cabecalho} (${lista.length}):\n${texto}${rodape}`;
  }

  if (nomeFerramenta === 'verificar_tempo_entrega') {
    const demanda = await consultarDemandaCached();
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
    // Corrige IDs inventados usando o productMap da sessão (busca por nome do item)
    const map = session.productMap || {};
    const itensCorrigidos = inputs.itens.map(item => {
      const chave = item.nome?.toLowerCase();
      const real = map[chave] || Object.values(map).find(p => chave?.includes(p.nome?.toLowerCase()?.split(' ')[0]));
      if (real && real.id && real.id !== item.id) {
        logger.warn('ID de produto corrigido', { nome: item.nome, idFalso: item.id, idReal: real.id });
        return { ...item, id: real.id, preco: real.preco };
      }
      return item;
    });

    const total = itensCorrigidos.reduce((sum, i) => sum + (i.preco * i.quantidade), 0);
    try {
      const telefone = inputs.telefone || session.customerPhone || session.phone;
      const pedido = await criarPedido({
        telefone,
        nomeCliente: inputs.nome_cliente || session.customerName || 'Cliente WhatsApp',
        endereco: inputs.endereco,
        itens: itensCorrigidos,
        total,
        formaPagamento: inputs.forma_pagamento,
        observacoes: [inputs.observacoes, 'FEITO PELO BOT AI'].filter(Boolean).join(' | '),
      });
      session.step = 'done';
      session.converted = true;

      // Detecta quais itens pedidos estavam em oferta
      const offerNames = new Set((session.currentOffers || []).map(o => o.nome?.toLowerCase()));
      const itensOferta = inputs.itens.filter(i => offerNames.has(i.nome?.toLowerCase()));

      // Grava pedido no Supabase para histórico e métricas
      salvarPedido({
        phone: session.phone,
        customerName: inputs.nome_cliente || session.customerName,
        orderNumber: String(pedido.numero || pedido.id),
        total,
        formaPagamento: inputs.forma_pagamento,
        endereco: inputs.endereco,
        itens: inputs.itens,
        itensOferta,
      }).catch(() => {}); // fire-and-forget, não bloqueia a resposta

      return `Pedido registrado com sucesso! Número: #${pedido.numero || pedido.id}. Total: R$ ${total.toFixed(2)}. Previsão de entrega: ${pedido.previsao_entrega || '30-50 minutos'}.`;
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
  return `Você é a mAI do Villa, atendente do Villa Borghese Empório — um empório premium em Santos/SP que faz delivery.

QUEM VOCÊ É:
Você é uma IA (Inteligência Artificial) com nome mAI, criada para atender o Empório Villa Borghese. Quando perguntada se é uma IA, robô ou humano, responda com naturalidade e honestidade: "Sou uma IA! 🤖 Mas pode falar comigo como se fosse uma pessoa — estou aqui pra te ajudar de verdade!" Apesar de ser uma IA, seu jeito é caloroso, descontraído e genuíno — nunca frio ou robotizado. Você se importa com cada cliente e fica feliz quando consegue resolver o que precisam.

DATA E HORA ATUAL: ${agora}

O cliente já foi saudado e pediu para digitar seu nome, CPF ou telefone. A primeira mensagem que você vai receber é essa identificação.

AO RECEBER A IDENTIFICAÇÃO DO CLIENTE:
1. Use SEMPRE a ferramenta buscar_cliente com o que o cliente enviou. Regras de preenchimento:
   - Número com 11 dígitos: passe nos campos TANTO cpf QUANTO telefone ao mesmo tempo (pode ser qualquer um)
   - Número com 10 dígitos ou menos: passe só em telefone
   - Texto (nome): passe só em nome
   - CPF com pontuação (ex: 108.485.758-81): passe só em cpf
2. Se encontrar cadastro:
   - Cumprimente pelo nome com carinho e mencione o número de pedidos ("Já é seu 12º pedido!")
   - Se tiver último pedido: pergunte se quer repetir ("Da última vez você levou X e Y — quer repetir?")
   - Se tiver itens favoritos em oferta: avise com entusiasmo ("Boa notícia! Seu [item favorito] está em promoção hoje!")
   - Se o pedido atual não incluir algum item que sempre pede: sugira com naturalidade ("Notei que você costuma pedir [item] — quer incluir?")
   - Pergunte o que deseja pedir hoje de forma natural
3. Se não encontrar cadastro: NÃO diga que houve erro técnico ou problema no sistema. Simplesmente cumprimente pelo nome, diga "Não encontrei seu cadastro, mas pode deixar que te atendo normalmente!" e pergunte o que deseja pedir. Trate como novo cliente sem fazer drama.
4. ENDEREÇO E PAGAMENTO:
   - Se o cadastro tiver endereço: USE-O automaticamente — NUNCA peça o endereço novamente. Apenas pergunte se quer entregar no endereço cadastrado OU se mudou: "Entrego no endereço cadastrado (Rua X, nº Y, Bairro, Cidade/UF, CEP) — tá certo ou mudou?"
   - Se o cliente confirmar o endereço: use o endereço COMPLETO do cadastro (incluindo CEP), parta para a forma de pagamento
   - Se o cadastro tiver forma de pagamento preferida: sugira ela ("Vai ser no Pix como de costume?")
   - Só peça endereço completo se for novo cliente ou se o cliente quiser mudar
   - Ao finalizar: se o endereço do cadastro já tiver CEP (8 dígitos), use-o direto. Só peça o CEP se o endereço confirmado realmente não tiver CEP nenhum.

OFERTAS DO DIA (por setor):
- Ao cumprimentar o cliente, NÃO liste as ofertas de cara. Apenas avise, de forma animada, que hoje tem ótimas ofertas e convide a ver: "Ah, e hoje temos ótimas ofertas! 🔥 Se quiser dar uma olhada, é só me mandar *ver ofertas* 😊".
- Quando o cliente pedir para ver ofertas (ex: "ver ofertas", "tem promoção?"), chame buscar_ofertas SEM o parâmetro setor. Isso retorna os SETORES que têm oferta (ex: FLV, Mercearia, Limpeza). Apresente os setores de forma clara e peça para ele escolher: "Temos ofertas em [setores]. Qual você quer ver? Ex: *ofertas mercearia* 😊".
- Quando o cliente escolher um setor (ex: "ofertas mercearia", "quero as de limpeza", "FLV"), chame buscar_ofertas COM o parâmetro setor e liste as ofertas daquele setor de forma organizada e animada.
- Se não houver ofertas no momento, avise com naturalidade e siga ajudando com os produtos normalmente.
- Use SOMENTE os setores e ofertas retornados pela ferramenta. NUNCA invente promoções, preços, setores ou descontos.
- Mostrar oferta é convite, não inclusão: só adiciona ao pedido o que o cliente confirmar.

NOSSAS UNIDADES E HORÁRIOS:
• Rua Mato Grosso, 404, Santos/SP — Seg. a Sáb. das 8h às 21h | Dom. das 8h às 14h
• Rua Azevedo Sodré, 144, Santos/SP — Seg. a Sáb. das 8h às 23h | Dom. das 8h às 21h
Telefone: (13) 2104-7575

Se o cliente entrar em contato fora do horário de funcionamento de AMBAS as unidades, avise com simpatia que estamos fechados e informe quando abrimos novamente.

SEU JEITO DE FALAR:
- Português informal, como uma conversa de WhatsApp entre amigos
- Use expressões naturais: "Boa escolha!", "Ai sim!", "Deixa comigo!", "Perfeito!", "Boa notícia:", "Ah, esse tá voando aqui..."
- Varie as saudações: "Oi!", "Olá!", "Oi, tudo bem?", "Oiii, que bom te ver por aqui no Villa Borghese!"
- Quando se apresentar, sempre diga: "Sou a mAI do Villa"
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
Quando um produto for vendido por peso (ex: batata, carne, queijo, frios, frutas, legumes):
- O preço da API é sempre por KG. Se o cliente pedir "2kg de manga" e o preço é R$ 11,96/kg, o total é R$ 23,92.
- No resumo, exiba como: "Manga Palmer 2kg — R$ 23,92 (aprox.)"
- NUNCA exiba como "x2kg" — use apenas o peso solicitado seguido do preço total calculado
- Sempre avise: "O preço é aproximado pois é pesado na hora. O valor exato será confirmado após a separação. 😊"

PESOS MÉDIOS POR UNIDADE (use quando o cliente pedir por unidade e não por kg):
Frutas:
- Manga Palmer / Haden / Shely / Keith: ~350g cada
- Manga Coquinho: ~150g cada | Manga Borbom: ~200g cada
- Laranja Seleta: ~200g cada
- Limão Galego: ~80g cada | Limão Rosa: ~100g cada
- Uva (cacho Sapphire/Moscatel/Jubileu): ~500g cada
- Abacaxi Hawai: ~1,2kg cada
Legumes/Verduras:
- Cebola: ~150g cada | Cebola Pirulito: ~100g cada
- Batata Lavada/Escovada: ~150g cada | Batata Doce: ~180g cada
- Cenoura: ~100g cada | Tomate Carmem: ~120g cada
Para itens não listados acima (carnes, queijos, frios, embutidos): SEMPRE pergunte "Quantos kg você quer?" antes de calcular.

REGRA CRÍTICA — ITENS DO PEDIDO:
JAMAIS adicione ao pedido itens que o cliente NÃO solicitou explicitamente, mesmo que sejam favoritos, itens em promoção ou sugestões. Você pode SUGERIR ("Quer aproveitar e incluir X?"), mas NUNCA adicionar sem o cliente confirmar. O resumo final deve conter SOMENTE o que o cliente pediu.

REGRA DE QUANTIDADE:
Quando você perguntou "Quantas unidades/garrafas/kg quer?" e o cliente responde com um número ou quantidade (ex: "2", "3 unidades", "meio kg"), NÃO faça nova busca de produtos. Aplique a quantidade ao produto que estava sendo discutido imediatamente antes.

REGRAS QUE NUNCA QUEBRA:
- Jamais confirma disponibilidade sem verificar o estoque
- Sempre mostra preço de cada item e o total no resumo
- Pergunta endereço e forma de pagamento antes de fechar
- Se o cliente pedir algo que não existe no sistema, sugere o mais próximo disponível
- Se o endereço já tiver CEP (do cadastro ou informado pelo cliente), use-o. Só peça CEP se o endereço não tiver nenhum número de CEP.
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

// ─── System prompt com dados da sessão injetados ───
function getSystemPromptComSessao(session) {
  let prompt = getSystemPrompt();
  if (session.customerName) {
    prompt += `\n\nCLIENTE IDENTIFICADO: ${session.customerName}`;
  }
  if (session.customerAddress) {
    prompt += `\nENDEREÇO CADASTRADO DO CLIENTE: ${session.customerAddress}`;
    prompt += `\n→ USE este endereço automaticamente. Pergunte apenas "Entrego no ${session.customerAddress} — tá certo ou mudou?" antes de fechar o pedido. NUNCA peça o endereço completo novamente.`;
  }
  if (session.customerPhone) {
    prompt += `\nTELEFONE DO CLIENTE: ${session.customerPhone}`;
  }
  return prompt;
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
      system: getSystemPromptComSessao(session),
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

    // Mantém só as últimas 20 mensagens (10 trocas) para conter tokens/custo.
    // O array é sempre pares user→assistant, então o corte par preserva o início em 'user'.
    const MAX_MENSAGENS = 20;
    if (session.messages.length > MAX_MENSAGENS) {
      session.messages = session.messages.slice(session.messages.length - MAX_MENSAGENS);
    }

    logger.debug(`Resposta da IA`, { phone: session.phone, chars: textoResposta.length });

    // Persiste sessão no Redis e histórico no Supabase (fire-and-forget)
    saveSession(session).catch(() => {});
    salvarConversa(session).catch(() => {});

    return textoResposta;
  }
}

// ─── Extrai dados do pedido da conversa para transferência ao atendente ───
async function extrairDadosPedido(session) {
  if (!session.messages || session.messages.length < 2) return null;

  // Monta texto da conversa filtrando apenas mensagens de texto (ignora tool_use blocks)
  const conversa = session.messages
    .filter(m => typeof m.content === 'string' && m.content.trim())
    .map(m => `${m.role === 'user' ? 'Cliente' : 'mAI'}: ${m.content}`)
    .join('\n');

  if (!conversa) return null;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Analise esta conversa de atendimento e extraia os dados do pedido. Retorne APENAS um JSON válido, sem markdown.

CONVERSA:
${conversa}

JSON esperado:
{
  "nome_cliente": "nome ou null",
  "itens": [{"nome": "string", "quantidade": 1, "preco": 0.0, "id": "id ou null"}],
  "endereco": "endereço completo ou null",
  "forma_pagamento": "pix/cartão/dinheiro ou null",
  "observacoes": "obs do cliente ou null",
  "total": 0.0,
  "campos_faltando": ["lista de campos que ainda não foram informados"]
}`,
      }],
    });

    const texto = response.content[0]?.text || '';
    const match = texto.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const resultado = JSON.parse(match[0]);

    // Completa IDs ausentes usando o mapa de produtos da sessão
    if (resultado.itens && session.productMap) {
      for (const item of resultado.itens) {
        if (!item.id) {
          const chave = item.nome?.toLowerCase();
          const encontrado = session.productMap[chave] ||
            Object.values(session.productMap).find(p => chave?.includes(p.nome.toLowerCase()) || p.nome.toLowerCase().includes(chave));
          if (encontrado) {
            item.id = encontrado.id;
            if (!item.preco) item.preco = encontrado.preco;
          }
        }
      }
    }

    return resultado;
  } catch (err) {
    logger.warn('Erro ao extrair dados do pedido para transferência', { error: err.message });
    return null;
  }
}

module.exports = { processarComIA, extrairDadosPedido };
