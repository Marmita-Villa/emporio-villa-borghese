const { Redis } = require('@upstash/redis');
const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

// ─── Redis (sessões) ───
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN,
});

// ─── Supabase (histórico e pedidos) ───
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const SESSION_TTL = 15 * 60; // 15 minutos em segundos

// ─── Rastreamento de inatividade ───
// Sorted set com score = lastActivity. Só entram sessões em modo bot; ao expirar
// (mais de INATIVIDADE_MS sem atividade) o cliente recebe msg_inatividade uma única vez.
const ATIVIDADE_KEY = 'bot:atividade';
const INATIVIDADE_MS = SESSION_TTL * 1000; // casa com o TTL da sessão
const STEPS_BOT = ['menu', 'aguardando_escolha', 'ai'];

async function trackAtividade(phone, ts) {
  try { await redis.zadd(ATIVIDADE_KEY, { score: ts, member: phone }); }
  catch (err) { logger.warn('Redis trackAtividade error', { phone, error: err.message }); }
}

async function untrackAtividade(phone) {
  try { await redis.zrem(ATIVIDADE_KEY, phone); }
  catch (err) { logger.warn('Redis untrackAtividade error', { phone, error: err.message }); }
}

// Retorna os telefones inativos há mais de INATIVIDADE_MS e os remove do set (notifica 1x)
async function pegarInativos(agora) {
  try {
    const limite = agora - INATIVIDADE_MS;
    const inativos = await redis.zrange(ATIVIDADE_KEY, 0, limite, { byScore: true });
    if (inativos && inativos.length) await redis.zrem(ATIVIDADE_KEY, ...inativos);
    return inativos || [];
  } catch (err) {
    logger.warn('Redis pegarInativos error', { error: err.message });
    return [];
  }
}

// ──────────────────────────────────────────
// SESSÕES — Redis
// ──────────────────────────────────────────

async function getSession(phone) {
  try {
    const data = await redis.get(`session:${phone}`);
    if (!data) return null;
    logger.debug('Sessão recuperada do Redis', { phone });
    return data;
  } catch (err) {
    logger.error('Redis getSession error', { phone, error: err.message });
    return null;
  }
}

async function saveSession(session) {
  try {
    await redis.set(`session:${session.phone}`, session, { ex: SESSION_TTL });
    // Rastreia inatividade só em modo bot; em atendimento humano/finalizado, para de rastrear
    if (STEPS_BOT.includes(session.step)) {
      await trackAtividade(session.phone, session.lastActivity || Date.now());
    } else {
      await untrackAtividade(session.phone);
    }
  } catch (err) {
    logger.error('Redis saveSession error', { phone: session.phone, error: err.message });
  }
}

async function deleteSession(phone) {
  try {
    await redis.del(`session:${phone}`);
    await untrackAtividade(phone);
  } catch (err) {
    logger.error('Redis deleteSession error', { phone, error: err.message });
  }
}

function createSessionObj(phone) {
  return {
    phone,
    messages: [],
    cart: [],
    step: 'menu',
    lastActivity: Date.now(),
    startedAt: Date.now(),
    customerName: null,
    productCache: {},
    productMap: {},
    currentOffers: [],
    converted: false,
    transferredToHuman: false,
  };
}

async function getOrCreateSession(phone) {
  let session = await getSession(phone);

  // Sessão expirada ou inexistente
  if (!session) {
    session = createSessionObj(phone);
    await saveSession(session);
    return session;
  }

  // Renova TTL a cada acesso
  session.lastActivity = Date.now();
  await saveSession(session);
  return session;
}

async function clearSession(phone) {
  await deleteSession(phone);
}

// ──────────────────────────────────────────
// HISTÓRICO — Supabase
// ──────────────────────────────────────────

function resolverStatus(session) {
  if (session.converted) return 'encerrado';
  if (session.transferredToHuman) return 'aguardando';
  return 'bot';
}

async function salvarConversa(session) {
  try {
    const { error } = await supabase
      .from('conversations')
      .upsert({
        phone: session.phone,
        customer_name: session.customerName,
        step: session.step,
        messages: session.messages,
        started_at: session.startedAt ? new Date(session.startedAt).toISOString() : new Date().toISOString(),
        converted: session.converted || false,
        transferred_to_human: session.transferredToHuman || false,
        status: resolverStatus(session),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'phone' });

    if (error) logger.error('Supabase salvarConversa error', { error: error.message });
  } catch (err) {
    logger.error('Supabase salvarConversa exception', { error: err.message });
  }
}

async function salvarPedido({ phone, customerName, orderNumber, total, formaPagamento, endereco, itens, itensOferta = [] }) {
  try {
    const { error } = await supabase
      .from('orders')
      .insert({
        phone,
        customer_name: customerName,
        order_number: orderNumber,
        total,
        forma_pagamento: formaPagamento,
        endereco,
        itens,
        itens_oferta: itensOferta,
      });

    if (error) logger.error('Supabase salvarPedido error', { error: error.message });
  } catch (err) {
    logger.error('Supabase salvarPedido exception', { error: err.message });
  }
}

async function salvarMensagemHumana({ phone, direction, content }) {
  try {
    await supabase.from('human_messages').insert({ phone, direction, content });
  } catch (err) {
    logger.error('Erro ao salvar mensagem humana', { error: err.message });
  }
}

module.exports = {
  getOrCreateSession,
  saveSession,
  clearSession,
  salvarConversa,
  salvarPedido,
  salvarMensagemHumana,
  pegarInativos,
};
