const { processarComIA } = require('./ia');

const MENU_MSG = `Olá! 👋 Bem-vindo ao *Villa Borghese Empório*!

Como prefere ser atendido?

1️⃣ *Maithe* — Atendente virtual (disponível agora)
2️⃣ *Atendente humano* — Um de nossa equipe vai te chamar

Digite *1* ou *2*`;

// ─── Roteador principal de atendimento ───
async function processarMensagem(session, texto) {

  // ── Etapa 1: Exibe o menu ──
  if (session.step === 'menu') {
    session.step = 'aguardando_escolha';
    return MENU_MSG;
  }

  // ── Etapa 2: Processa a escolha ──
  if (session.step === 'aguardando_escolha') {
    const opcao = texto.trim().toLowerCase();
    const escolheuVirtual = opcao === '1' || opcao.includes('maithe') || opcao.includes('virtual');
    const escolheuHumano  = opcao === '2' || opcao.includes('humano') || opcao.includes('real') || opcao.includes('atendente');

    if (escolheuVirtual) {
      session.step = 'ai';
      // Inicia a conversa com a Maithe
      return await processarComIA(session, '__inicio__');
    }

    if (escolheuHumano) {
      session.step = 'humano';
      console.log(`🙋 Cliente ${session.phone} solicitou atendente humano`);
      return `Perfeito! 👤 Em breve um de nossos atendentes vai te chamar aqui no chat.\n\nAguarda um momento! 😊\n\n_Se mudar de ideia, manda *1* para falar com a Maithe agora._`;
    }

    // Opção inválida — repete o menu
    return `Não entendi 😅 Por favor, escolha:\n\n1️⃣ *Maithe* — Atendente virtual\n2️⃣ *Atendente humano*\n\nDigite *1* ou *2*`;
  }

  // ── Modo humano: permite voltar para a IA ──
  if (session.step === 'humano') {
    if (texto.trim() === '1') {
      session.step = 'ai';
      return await processarComIA(session, '__inicio__');
    }
    return `Oi! 😊 Um atendente humano já vai te chamar aqui.\n\nSe quiser falar com a Maithe agora, manda *1*.`;
  }

  // ── Modo IA: fluxo normal ──
  return await processarComIA(session, texto);
}

module.exports = { processarMensagem, MENU_MSG };
