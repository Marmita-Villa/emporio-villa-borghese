require('dotenv').config();
const express = require('express');
const path = require('path');
const { handleIncomingMessage } = require('./whatsapp');
const { getOrCreateSession, clearSession } = require('./session');
const { processarMensagem } = require('./atendimento');

const app = express();
app.use(express.json());

// ─── Verificação do webhook (Meta exige isso na configuração inicial) ───
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado pela Meta');
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
    const from = message.from; // número do cliente
    const text = message.text?.body;

    if (message.type === 'text' && text) {
      console.log(`📩 Mensagem de ${from}: ${text}`);
      await handleIncomingMessage(from, text);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.sendStatus(500);
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

app.get('/debug', (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  res.json({
    mock_mode: process.env.MOCK_MODE,
    api_key_carregada: !!key,
    api_key_inicio: key ? key.substring(0, 15) + '...' : 'NÃO ENCONTRADA',
  });
});

// ─── Endpoint de teste local (sem WhatsApp) ───
app.post('/chat', async (req, res) => {
  const { mensagem, telefone = 'teste_local' } = req.body;
  if (!mensagem) return res.status(400).json({ error: 'mensagem é obrigatória' });

  const session = getOrCreateSession(telefone);
  try {
    const resposta = await processarMensagem(session, mensagem);
    res.json({ resposta });
  } catch (err) {
    console.error('Erro no chat de teste:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Reinicia conversa de teste ───
app.post('/nova-conversa', (req, res) => {
  clearSession('teste_local');
  res.json({ ok: true });
});

// ─── Interface web de teste ───
app.use(express.static(path.join(__dirname, '../public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot rodando na porta ${PORT}`));
