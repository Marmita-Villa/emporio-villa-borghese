require('dotenv').config();
const express = require('express');
const path = require('path');
const { handleIncomingMessage, handleNonTextMessage, enviarMensagem } = require('./whatsapp');
const logger = require('./logger');
const { getOrCreateSession, clearSession, verificarSessoesExpiradas } = require('./session');
const { saveSession, salvarConversa } = require('./db');
const agentesRouter = require('./agentes');
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

// ─── API do dashboard de relatórios ───
app.get('/api/dashboard', async (req, res) => {
  if (req.query.key !== process.env.DASHBOARD_KEY) return res.status(401).json({ error: 'Não autorizado' });

  const { periodo = '30d', from: fromParam, to: toParam } = req.query;
  const agora = new Date();
  let fromDate, toDate = agora;

  if (fromParam && toParam) {
    fromDate = new Date(fromParam);
    toDate = new Date(toParam + 'T23:59:59');
  } else {
    switch (periodo) {
      case 'hoje': fromDate = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()); break;
      case '7d':   fromDate = new Date(Date.now() - 7  * 86400000); break;
      default:     fromDate = new Date(Date.now() - 30 * 86400000);
    }
  }

  const { createClient } = require('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

  const [ordersRes, convsRes, humanConvsRes, msgsPorAgenteRes] = await Promise.all([
    sb.from('orders').select('*').gte('created_at', fromDate.toISOString()).lte('created_at', toDate.toISOString()),
    sb.from('conversations').select('phone,customer_name,step,converted,transferred_to_human,created_at,started_at,updated_at').gte('created_at', fromDate.toISOString()).lte('created_at', toDate.toISOString()),
    sb.from('conversations').select('assigned_name,human_started_at,human_ended_at').not('assigned_name', 'is', null).not('human_started_at', 'is', null).gte('human_started_at', fromDate.toISOString()).lte('human_started_at', toDate.toISOString()),
    sb.from('human_messages').select('agent_name').eq('direction', 'out').not('agent_name', 'is', null).gte('created_at', fromDate.toISOString()).lte('created_at', toDate.toISOString()),
  ]);

  const orders = ordersRes.data || [];
  const convs  = convsRes.data  || [];

  // KPIs
  const totalVendido      = orders.reduce((s, o) => s + (o.total || 0), 0);
  const totalPedidos      = orders.length;
  const ticketMedio       = totalPedidos > 0 ? totalVendido / totalPedidos : 0;
  const totalAtendimentos = convs.length;
  const convertidos       = convs.filter(c => c.converted).length;
  const taxaConversao     = totalAtendimentos > 0 ? (convertidos / totalAtendimentos * 100) : 0;
  const transf            = convs.filter(c => c.transferred_to_human).length;
  const apenasBot         = totalAtendimentos - transf;

  // Top produtos (todos os itens somados)
  const prodMap = {};
  for (const o of orders) {
    for (const item of (o.itens || [])) {
      if (!item.nome) continue;
      prodMap[item.nome] = prodMap[item.nome] || { nome: item.nome, quantidade: 0, valor: 0 };
      prodMap[item.nome].quantidade += item.quantidade || 1;
      prodMap[item.nome].valor += (item.quantidade || 1) * (item.preco || 0);
    }
  }
  const topProdutos = Object.values(prodMap).sort((a, b) => b.quantidade - a.quantidade).slice(0, 15);

  // Top ofertas
  const ofMap = {};
  for (const o of orders) {
    for (const item of (o.itens_oferta || [])) {
      if (!item.nome) continue;
      ofMap[item.nome] = ofMap[item.nome] || { nome: item.nome, quantidade: 0, valor: 0 };
      ofMap[item.nome].quantidade += item.quantidade || 1;
      ofMap[item.nome].valor += (item.quantidade || 1) * (item.preco || 0);
    }
  }
  const topOfertas = Object.values(ofMap).sort((a, b) => b.quantidade - a.quantidade).slice(0, 15);

  // Top itens combinados (produtos + ofertas)
  const todosItens = { ...prodMap };
  for (const [k, v] of Object.entries(ofMap)) {
    todosItens[k] = todosItens[k]
      ? { nome: k, quantidade: todosItens[k].quantidade + v.quantidade, valor: todosItens[k].valor + v.valor }
      : v;
  }
  const topItens = Object.values(todosItens).sort((a, b) => b.quantidade - a.quantidade).slice(0, 15);

  // Top clientes por pedidos e valor
  const clienteMap = {};
  for (const o of orders) {
    const key = o.customer_name || o.phone || '?';
    clienteMap[key] = clienteMap[key] || { nome: key, pedidos: 0, valor: 0 };
    clienteMap[key].pedidos++;
    clienteMap[key].valor += o.total || 0;
  }
  const topClientes = Object.values(clienteMap)
    .sort((a, b) => b.pedidos - a.pedidos || b.valor - a.valor)
    .slice(0, 15);

  // Vendas por dia
  const vendaDia = {};
  for (const o of orders) {
    const d = o.created_at.substring(0, 10);
    vendaDia[d] = vendaDia[d] || { data: d, total: 0, pedidos: 0 };
    vendaDia[d].total += o.total || 0;
    vendaDia[d].pedidos++;
  }

  // Vendas por dia da semana
  const DS = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  const porDiaSemana = DS.map(d => ({ dia: d, pedidos: 0, total: 0 }));
  for (const o of orders) {
    const idx = new Date(o.created_at).getDay();
    porDiaSemana[idx].pedidos++;
    porDiaSemana[idx].total += o.total || 0;
  }

  // Formas de pagamento
  const pagamentos = {};
  for (const o of orders) {
    const fp = o.forma_pagamento || 'não informado';
    pagamentos[fp] = (pagamentos[fp] || 0) + 1;
  }

  // Atendimentos por hora
  const porHora = Array(24).fill(0);
  for (const c of convs) { porHora[new Date(c.created_at).getHours()]++; }

  // Relatório por atendente (com mensagens enviadas)
  const msgCount = {};
  for (const m of (msgsPorAgenteRes.data || [])) {
    msgCount[m.agent_name] = (msgCount[m.agent_name] || 0) + 1;
  }

  const humanConvs = humanConvsRes.data || [];
  const agentMap = {};
  for (const c of humanConvs) {
    const nome = c.assigned_name;
    if (!nome) continue;
    agentMap[nome] = agentMap[nome] || { nome, conversas: 0, tempoTotal: 0, comTempo: 0 };
    agentMap[nome].conversas++;
    if (c.human_started_at && c.human_ended_at) {
      const dur = (new Date(c.human_ended_at) - new Date(c.human_started_at)) / 60000;
      if (dur > 0 && dur < 480) {
        agentMap[nome].tempoTotal += dur;
        agentMap[nome].comTempo++;
      }
    }
  }
  const relatorioAtendentes = Object.values(agentMap).map(a => ({
    nome: a.nome,
    conversas: a.conversas,
    tempoMedio: a.comTempo > 0 ? Math.round(a.tempoTotal / a.comTempo) : null,
    mensagens: msgCount[a.nome] || 0,
  })).sort((a, b) => b.conversas - a.conversas);

  res.json({
    periodo: { from: fromDate, to: toDate },
    kpis: { totalVendido, totalPedidos, ticketMedio, totalAtendimentos, taxaConversao, transferidosHumano: transf, apenasBot, convertidos },
    topProdutos,
    topOfertas,
    topItens,
    topClientes,
    vendasPorDia: Object.values(vendaDia).sort((a, b) => a.data.localeCompare(b.data)),
    vendasPorDiaSemana: porDiaSemana,
    pagamentos,
    atendimentosPorHora: porHora,
    relatorioAtendentes,
    ultimosPedidos: [...orders].reverse().slice(0, 20).map(o => ({
      numero: o.order_number, cliente: o.customer_name, total: o.total,
      forma_pagamento: o.forma_pagamento, created_at: o.created_at,
    })),
  });
});

// ─── Endpoint de teste local (sem WhatsApp) ───
app.post('/chat', async (req, res) => {
  const { mensagem, telefone = 'teste_local' } = req.body;
  if (!mensagem) return res.status(400).json({ error: 'mensagem é obrigatória' });

  const session = await getOrCreateSession(telefone);
  try {
    const resposta = await processarMensagem(session, mensagem);
    await saveSession(session);
    salvarConversa(session).catch(() => {});
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

// ─── Rotas das interfaces web ───
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '../public/dashboard.html')));
app.get('/atendimento', (req, res) => res.sendFile(path.join(__dirname, '../public/atendimento.html')));
app.use('/api', agentesRouter);
app.use(express.static(path.join(__dirname, '../public')));

// ─── Monitor de sessões inativas (verifica a cada 2 minutos) ───
setInterval(async () => {
  const expiradas = await verificarSessoesExpiradas();
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
