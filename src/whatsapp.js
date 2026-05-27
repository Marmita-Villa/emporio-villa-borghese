const axios = require('axios');
const { getOrCreateSession, addMessageToSession } = require('./session');
const { processarMensagem } = require('./atendimento');

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

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
    console.log(`📤 Mensagem enviada para ${para}`);
    console.log('✅ Resposta Meta:', JSON.stringify(response.data));
  } catch (err) {
    console.error('Erro ao enviar mensagem WhatsApp:', err.response?.data || err.message);
  }
}

// ─── Orquestra o fluxo completo de atendimento ───
async function handleIncomingMessage(phone, texto) {
  const session = getOrCreateSession(phone);

  // Envia indicador de digitação (boa UX)
  await enviarIndicadorDigitando(phone);

  try {
    const resposta = await processarMensagem(session, texto);

    // Suporte a múltiplas mensagens (array) ou mensagem única (string)
    if (Array.isArray(resposta)) {
      for (const msg of resposta) {
        await enviarMensagem(phone, msg);
        await new Promise(r => setTimeout(r, 800)); // pausa entre mensagens
      }
    } else {
      await enviarMensagem(phone, resposta);
    }
  } catch (err) {
    console.error('Erro no atendimento:', err);
    await enviarMensagem(
      phone,
      '😅 Tive um probleminha aqui. Pode repetir o que você disse?'
    );
  }
}

// ─── Envia status "digitando..." ───
async function enviarIndicadorDigitando(para) {
  try {
    await axios.post(
      `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: para,
        type: 'reaction',  // workaround — WhatsApp não tem "typing" na Cloud API
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
  } catch (_) { /* silencioso */ }
}

module.exports = { handleIncomingMessage, enviarMensagem };
