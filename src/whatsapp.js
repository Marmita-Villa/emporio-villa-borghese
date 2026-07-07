const axios = require('axios');
const { getOrCreateSession } = require('./session');
const { saveSession, salvarConversa, salvarMensagemHumana, tocarConversa } = require('./db');
const { processarMensagem } = require('./atendimento');
const logger = require('./logger');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ─── Mensagens amigáveis para tipos de mídia não suportados ───
const RESPOSTAS_NAO_TEXTO = {
  audio:    '🎧 Recebi seu áudio, mas ainda não consigo ouvir mensagens de voz por aqui. Pode me escrever o que precisa? 😊',
  image:    '📷 Recebi sua imagem! Por enquanto só consigo atender por texto. Me escreve o que você quer pedir? 😊',
  video:    '🎥 Recebi seu vídeo, mas atendo apenas por texto por aqui. O que posso ajudar? 😊',
  document: '📄 Recebi um documento! Para pedidos e dúvidas, pode me escrever normalmente. 😊',
  sticker:  '😄 Que sticker fofo! Me conta o que você quer pedir? 😊',
  location: '📍 Recebi sua localização! Se precisar informar o endereço de entrega, pode digitar normalmente no chat. 😊',
  contacts: '👤 Recebi um contato! Para pedidos, é só me escrever. 😊',
  reaction: null, // reações não precisam de resposta
};

// ─── Envia mensagem de texto pelo WhatsApp ───
async function enviarMensagem(para, texto) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: para,
        type: 'text',
        text: { body: texto },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    logger.info(`Mensagem enviada`, { para, messageId: response.data?.messages?.[0]?.id });
  } catch (err) {
    logger.error(`Erro ao enviar mensagem WhatsApp`, err.response?.data || err.message);
  }
}

// ─── Orquestra o fluxo de atendimento para mensagens de texto ───
async function handleIncomingMessage(phone, texto, messageId) {
  const session = await getOrCreateSession(phone);

  // Quando em atendimento humano: salva mensagem e não responde (agente responde pelo painel)
  if (session.step === 'humano') {
    await salvarMensagemHumana({ phone, direction: 'in', content: texto });
    tocarConversa(phone).catch(() => {}); // sinaliza novidade no painel (fire-and-forget)
    logger.info('Mensagem recebida em modo humano', { phone });
    return;
  }

  await enviarIndicadorDigitando(messageId);

  try {
    const resposta = await processarMensagem(session, texto);

    // Persiste sessão no Redis e Supabase após qualquer mudança de step
    await saveSession(session);
    salvarConversa(session).catch(() => {});

    if (Array.isArray(resposta)) {
      for (const msg of resposta) {
        await enviarMensagem(phone, msg);
        await new Promise(r => setTimeout(r, 800));
      }
    } else if (resposta) {
      await enviarMensagem(phone, resposta);
    }
  } catch (err) {
    logger.error(`Erro no atendimento`, { phone, error: err.message });
    await enviarMensagem(phone, '😅 Tive um probleminha aqui. Pode repetir o que você disse?');
  }
}

// ─── Responde mensagens de mídia/não-texto com aviso amigável ───
async function handleNonTextMessage(phone, type) {
  const resposta = RESPOSTAS_NAO_TEXTO[type];
  if (!resposta) return; // reações e tipos desconhecidos: ignora silenciosamente
  logger.info(`Mensagem não-texto recebida`, { phone, type });
  await enviarMensagem(phone, resposta);
}

// ─── Marca a mensagem como lida e mostra o "digitando..." nativo ───
// A WhatsApp Cloud API exige o message_id da mensagem recebida. Dura ~25s ou
// até enviarmos a resposta. Sem messageId (ex: chat de teste), não faz nada.
async function enviarIndicadorDigitando(messageId) {
  if (!messageId) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (_) { /* silencioso — não é crítico */ }
}

module.exports = { handleIncomingMessage, handleNonTextMessage, enviarMensagem };
