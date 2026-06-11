require('dotenv').config();
const express = require('express');
const path = require('path');
const { handleIncomingMessage, handleNonTextMessage, enviarMensagem } = require('./whatsapp');
const logger = require('./logger');
const { getOrCreateSession, clearSession, verificarSessoesExpiradas } = require('./session');
const { processarMensagem } = require('./atendimento');

const app = express();
app.use(express.json());

// ─── Deduplicação de mensagens (evita reprocessar webhooks duplicados da Meta) ───
const mensagensProcessadas = new Set();
setInterval(() => mensagensProcessadas.clear(), 10 * 60 * 1000); // limpa a cada 10 min

// ─── Rate limiting simples por número de telefone ───
const rateLimitMap = new Map(); // phone → { count, resetAt }
const RATE_LIMIT_MAX = 10;       // máximo de mensagens por janela
const RATE_LIMIT_JANELA_MS = 60 * 1000; // janela de 1 minuto

function checkRateLimit(phone) {
  const agora = Date.now();
  const entrada = rateLimitMap.get(phone);

  if (!entrada || agora > entrada.resetAt) {
    rateLimitMap.set(phone, { count: 1, resetAt: agora + RATE_LIMIT_JANELA_MS });
    return true;
  }

  entrada.count++;
  if (entrada.count > RATE_LIMIT_MAX) return false;
  return true;
}

setInterval(() => {
  const agora = Date.now();
  for (const [phone, entrada] of rateLimitMap.entries()) {
    if (agora > entrada.resetAt) rateLimitMap.delete(phone);
  }
}, 5 * 60 * 1000);

// ─── Verificação do webhook (Meta exige isso na configuração inicial) ───
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    logger.info('Webhook verificado pela Meta');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Recebe mensagens do WhatsApp ───
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return res.sendStatus(404);

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return res.sendStatus(200);

    const message = messages[0];
    const from = message.from;
    const text = message.text?.body;
    const messageId = message.id;

    // Ignora mensagem já processada (webhook duplicado da Meta)
    if (messageId && mensagensProcessadas.has(messageId)) {
      return res.sendStatus(200);
    }
    if (messageId) mensagensProcessadas.add(messageId);

    // Bloqueia se o número ultrapassou o rate limit
    if (!checkRateLimit(from)) {
      logger.warn(`Rate limit atingido`, { from });
      return res.sendStatus(200);
    }

    if (message.type === 'text' && text) {
      logger.info(`Mensagem recebida`, { from, text: text.substring(0, 80) });
      await handleIncomingMessage(from, text);
    } else if (message.type !== 'text') {
      // Áudio, imagem, vídeo, sticker, localização, etc.
      await handleNonTextMessage(from, message.type);
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error('Erro no webhook', err.message);
    res.sendStatus(500);
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ─── Endpoint de teste local (sem WhatsApp) ───
app.post('/chat', async (req, res) => {
  const { mensagem, telefone = 'teste_local' } = req.body;
  if (!mensagem) return res.status(400).json({ error: 'mensagem é obrigatória' });

  const session = await getOrCreateSession(telefone);
  try {
    const resposta = await processarMensagem(session, mensagem);
    const texto = Array.isArray(resposta) ? resposta.join('\n\n') : resposta;
    res.json({ resposta: texto });
  } catch (err) {
    logger.error('Erro no chat de teste', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Reinicia conversa de teste ───
app.post('/nova-conversa', async (req, res) => {
  await clearSession('teste_local');
  res.json({ ok: true });
});

// ─── Interface web de teste ───
app.use(express.static(path.join(__dirname, '../public')));

// ─── Monitor de sessões inativas (verifica a cada 2 minutos) ───
setInterval(async () => {
  const expiradas = verificarSessoesExpiradas();
  for (const { phone } of expiradas) {
    logger.info(`Sessão expirada por inatividade`, { phone });
    try {
      await enviarMensagem(
        phone,
        '👋 Sua conversa foi encerrada por inatividade.\n\nSe precisar de algo é só mandar uma mensagem! 😊'
      );
    } catch (err) {
      logger.error(`Erro ao notificar encerramento`, { phone, error: err.message });
    }
  }
}, 2 * 60 * 1000); // a cada 2 minutos

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => logger.info(`Bot rodando`, { porta: PORT, env: process.env.MOCK_MODE === 'true' ? 'mock' : 'produção' }));
