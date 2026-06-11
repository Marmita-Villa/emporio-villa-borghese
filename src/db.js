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
  } catch (err) {
    logger.error('Redis saveSession error', { phone: session.phone, error: err.message });
  }
}

async function deleteSession(phone) {
  try {
    await redis.del(`session:${phone}`);
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

module.exports = {
  getOrCreateSession,
  saveSession,
  clearSession,
  salvarConversa,
  salvarPedido,
};
