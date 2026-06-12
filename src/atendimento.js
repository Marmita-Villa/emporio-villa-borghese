const { processarComIA, extrairDadosPedido } = require('./ia');
const { getMsg } = require('./config');
const logger = require('./logger');
const { createClient } = require('@supabase/supabase-js');
const apiModule = process.env.MOCK_MODE === 'true' ? require('./mockApi') : require('./sistemaApi');

// ─── Gera rascunho do pedido e nota interna quando cliente solicita transferência ───
async function gerarRascunhoPedido(session) {
  try {
    const dados = await extrairDadosPedido(session);
    if (!dados || !dados.itens?.length) return;

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    let pedidoNumero = null;

    // Tenta criar pedido na retaguarda se tiver os dados obrigatórios
    const temDados = dados.itens.length > 0 && dados.endereco && dados.forma_pagamento;
    if (temDados) {
      try {
        const total = dados.total || dados.itens.reduce((s, i) => s + (i.preco || 0) * (i.quantidade || 1), 0);
        const pedido = await apiModule.criarPedido({
          telefone: session.phone,
          nomeCliente: dados.nome_cliente || session.customerName || 'Cliente WhatsApp',
          endereco: dados.endereco,
          itens: dados.itens.map(i => ({ id: i.id || '', nome: i.nome, quantidade: i.quantidade || 1, preco: i.preco || 0 })),
          total,
          formaPagamento: dados.forma_pagamento,
          observacoes: `⚠️ Transferido do bot para atendente humano.${dados.observacoes ? ' ' + dados.observacoes : ''}`,
        });
        pedidoNumero = pedido.id || pedido.numero;
        logger.info('Rascunho de pedido criado na retaguarda', { phone: session.phone, pedido: pedidoNumero });
      } catch (err) {
        logger.warn('Não foi possível criar rascunho na retaguarda', { phone: session.phone, error: err.message });
      }
    }

    // Monta nota interna para o atendente
    const itensList = dados.itens.map(i =>
      `• ${i.quantidade || 1}x ${i.nome}${i.preco ? ` — R$ ${((i.preco) * (i.quantidade || 1)).toFixed(2)}` : ''}`
    ).join('\n');

    let nota = `📋 *Resumo coletado pelo bot:*\n${itensList}`;
    if (dados.endereco)       nota += `\n📍 Endereço: ${dados.endereco}`;
    if (dados.forma_pagamento) nota += `\n💳 Pagamento: ${dados.forma_pagamento}`;
    if (dados.total)           nota += `\n💰 Total estimado: R$ ${Number(dados.total).toFixed(2)}`;
    if (dados.observacoes)     nota += `\n📝 Obs: ${dados.observacoes}`;

    if (pedidoNumero) {
      nota += `\n\n✅ *Pedido #${pedidoNumero} criado na retaguarda. Confirmar com o cliente.*`;
    } else {
      const falta = dados.campos_faltando?.length ? dados.campos_faltando.join(', ') : 'endereço e/ou forma de pagamento';
      nota += `\n\n⚠️ *Pedido NÃO criado automaticamente.*\nFalta coletar: ${falta}`;
    }

    await sb.from('human_messages').insert({
      phone: session.phone,
      direction: 'internal',
      content: nota,
      agent_name: 'Sistema',
    });
  } catch (err) {
    logger.error('Erro em gerarRascunhoPedido', { phone: session.phone, error: err.message });
  }
}

// ─── Roteador principal de atendimento ───
async function processarMensagem(session, texto) {

  // ── Etapa 1: Exibe o menu ──
  if (session.step === 'menu') {
    session.step = 'aguardando_escolha';
    return await getMsg('msg_menu');
  }

  // ── Etapa 2: Processa a escolha ──
  if (session.step === 'aguardando_escolha') {
    const opcao = texto.trim().toLowerCase();
    const escolheuVirtual = opcao === '1' || (opcao.includes('maithe') && !opcao.includes('humano')) || opcao.includes('virtual');
    const escolheuHumano  = opcao === '2' || opcao.includes('humano') || opcao.includes('real') || opcao.includes('atendente');

    if (escolheuVirtual) {
      session.step = 'ai';
      return await getMsg('msg_boas_vindas_maithe');
    }

    if (escolheuHumano) {
      session.step = 'humano';
      session.transferredToHuman = true;
      logger.info(`Cliente solicitou atendente humano`, { phone: session.phone });
      return [await getMsg('msg_boas_vindas_humano'), await getMsg('msg_formulario_humano')];
    }

    return `Não entendi 😅 Por favor, escolha:\n\n1️⃣ *Maithe* — Atendente virtual\n2️⃣ *Atendente humano*\n\nDigite *1* ou *2*`;
  }

  // ── Modo humano: aguarda formulário preenchido ──
  if (session.step === 'humano') {
    if (texto.trim() === '1') {
      session.step = 'ai';
      return [await getMsg('msg_boas_vindas_maithe'), await getMsg('msg_formulario_humano')];
    }
    logger.info(`Formulário humano recebido`, { phone: session.phone });
    return `Recebemos seu pedido! ✅\n\nUm de nossos atendentes vai te chamar em breve para confirmar tudo. 😊\n\nSe mudar de ideia, manda *1* para falar com a Maithe agora.`;
  }

  // ── Pedido concluído ──
  if (session.step === 'done') {
    const texto_lower = texto.trim().toLowerCase();
    const querNovoPedido =
      texto_lower.includes('novo pedido') || texto_lower.includes('quero mais') ||
      texto_lower.includes('pedir mais')  || texto_lower.includes('mais alguma') ||
      texto_lower.includes('outro pedido')|| texto_lower.includes('sim') ||
      texto_lower === 's' || texto_lower === '1';

    if (querNovoPedido) {
      session.messages = [];
      session.cart = [];
      session.productMap = {};
      session.productCache = {};
      session.currentOffers = [];
      session.step = 'ai';
      return `Que ótimo! 🛒 O que você quer pedir dessa vez?`;
    }

    return `Obrigada pela preferência! 😊 Se precisar de qualquer coisa, é só mandar mensagem que a gente te atende.\n\nAté a próxima! 👋`;
  }

  // ── Modo IA: detecta pedido de atendente humano ──
  const textoLower = texto.trim().toLowerCase();
  const querHumano =
    textoLower.includes('atendente') || textoLower.includes('humano') ||
    textoLower.includes('pessoa')    || textoLower.includes('falar com alguem') ||
    textoLower.includes('falar com alguém') || textoLower.includes('quero falar') ||
    textoLower.includes('chamar atendente') || textoLower.includes('suporte humano');

  if (session.step === 'ai' && querHumano) {
    session.step = 'humano';
    session.transferredToHuman = true;
    logger.info('Cliente solicitou atendente humano no meio da conversa IA', { phone: session.phone });
    // Gera rascunho do pedido e nota interna para o atendente (fire-and-forget)
    gerarRascunhoPedido(session).catch(() => {});
    return `Claro! 😊 Vou chamar um atendente para você agora.\n\nAguarda um momento que alguém da nossa equipe vai assumir essa conversa aqui mesmo pelo WhatsApp. 🙌`;
  }

  return await processarComIA(session, texto);
}

module.exports = { processarMensagem };
