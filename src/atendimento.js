const { processarComIA } = require('./ia');
const { getMsg } = require('./config');
const logger = require('./logger');

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
    const escolheuVirtual = opcao === '1' || opcao.includes('maithe') || opcao.includes('virtual');
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
    return `Claro! 😊 Vou chamar um atendente para você agora.\n\nAguarda um momento que alguém da nossa equipe vai assumir essa conversa aqui mesmo pelo WhatsApp. 🙌`;
  }

  return await processarComIA(session, texto);
}

module.exports = { processarMensagem };
