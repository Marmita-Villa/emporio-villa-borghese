const { processarComIA } = require('./ia');
const logger = require('./logger');

const MENU_MSG = `Olá! 👋 Bem-vindo ao *Villa Borghese Empório*!

Como prefere ser atendido?

1️⃣ *Maithe* — Atendente virtual por IA (disponível agora)
2️⃣ *Atendente humano* — Um de nossa equipe vai te chamar

Digite *1* ou *2*`;

// ─── CEP obrigatório no campo endereço para a API funcionar ───
const FORM_MSG = `Para prosseguir seu atendimento por WhatsApp, preencha os campos abaixo e aguarde que um de nossos colaboradores irá lhe atender:

*Nome Completo:*
*CPF:*
*Telefone:*
*Endereço (Rua, Número, Bairro, Cidade/UF, CEP):*
_Ex: Rua das Flores, 123, Boqueirão, Santos/SP, 11045-001_
*Forma de pagamento:*
*Pedido:*

_Exemplo:_
1 un molho de tomate tradicional sachet Pomarola
1 un leite integral qualquer marca
1 un manteiga Aviação com sal tablete
6 un batata lavada ou 1 kg

*Observações:*
- Especificar a quantidade, marca e produto;
- Antes de enviar o seu pedido, verifique se todos os itens estão de acordo com a sua preferência;
Você aceita marcas similares? ( ) sim ou ( ) não.
Agradecemos seu contato! 😊`;

const BOAS_VINDAS_MAITHE = `Oi! Sou a *Maithe*, atendente por IA do *Empório Villa Borghese* 🤖😊

Me diz seu *nome*, *CPF* ou *telefone* que eu te encontro aqui no sistema e já começamos!`;

const BOAS_VINDAS_HUMANO = `Olá! Seja bem-vindo ao delivery do *Empório Villa Borghese*! 😊

Estamos com mais um canal de atendimento para realizar suas compras, através do nosso site www.emporiovillaborghese.com.br`;

const NOVO_PEDIDO_MSG = `Que ótimo! 🛒 O que você quer pedir dessa vez?`;

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
      return BOAS_VINDAS_MAITHE;
    }

    if (escolheuHumano) {
      session.step = 'humano';
      session.transferredToHuman = true;
      logger.info(`Cliente solicitou atendente humano`, { phone: session.phone });
      return [BOAS_VINDAS_HUMANO, FORM_MSG];
    }

    // Opção inválida — repete o menu
    return `Não entendi 😅 Por favor, escolha:\n\n1️⃣ *Maithe* — Atendente virtual\n2️⃣ *Atendente humano*\n\nDigite *1* ou *2*`;
  }

  // ── Modo humano: aguarda formulário preenchido ──
  if (session.step === 'humano') {
    if (texto.trim() === '1') {
      session.step = 'ai';
      return [BOAS_VINDAS_MAITHE, FORM_MSG];
    }
    logger.info(`Formulário humano recebido`, { phone: session.phone });
    return `Recebemos seu pedido! ✅\n\nUm de nossos atendentes vai te chamar em breve para confirmar tudo. 😊\n\nSe mudar de ideia, manda *1* para falar com a Maithe agora.`;
  }

  // ── Pedido concluído: permite iniciar novo pedido sem reiniciar a conversa ──
  if (session.step === 'done') {
    const texto_lower = texto.trim().toLowerCase();
    const querNovoPedido =
      texto_lower.includes('novo pedido') ||
      texto_lower.includes('quero mais') ||
      texto_lower.includes('pedir mais') ||
      texto_lower.includes('mais alguma') ||
      texto_lower.includes('outro pedido') ||
      texto_lower.includes('sim') ||
      texto_lower === 's' ||
      texto_lower === '1';

    if (querNovoPedido) {
      // Reinicia histórico da IA mas mantém dados do cliente
      session.messages = [];
      session.cart = [];
      session.step = 'ai';
      return NOVO_PEDIDO_MSG;
    }

    return `Obrigada pela preferência! 😊 Se precisar de qualquer coisa, é só mandar mensagem que a gente te atende.\n\nAté a próxima! 👋`;
  }

  // ── Modo IA: Maithe processa o formulário e os pedidos ──
  return await processarComIA(session, texto);
}

module.exports = { processarMensagem, MENU_MSG };
