/**
 * hipcomSync.js — Sincroniza clientes do Hipcom para o Supabase
 *
 * - Sync incremental a cada hora (usa data_ultima_alteracao)
 * - Sync inicial baixa todos os clientes paginado
 * - Upsert por (codigo, loja)
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { Redis } = require('@upstash/redis');
const logger = require('./logger');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const redis = new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });

const HIPCOM_URL    = process.env.HIPCOM_URL    || 'http://emporiovilla.dyndns.info:2222/api/hipcom';
const HIPCOM_USER   = process.env.HIPCOM_USER   || 'hipcomfull';
const HIPCOM_PASS   = process.env.HIPCOM_PASS   || '';
const HIPCOM_CNPJ   = process.env.HIPCOM_CNPJ   || '1325134000145';
const HIPCOM_SENHA  = process.env.HIPCOM_SENHA  || '';
const HIPCOM_LOJA   = parseInt(process.env.HIPCOM_CLIENT_STORE || '1', 10);
const BATCH         = 1000;
const SYNC_KEY      = 'hipcom_clientes_sync';

const hipcom = axios.create({
  baseURL: HIPCOM_URL,
  auth: { username: HIPCOM_USER, password: HIPCOM_PASS },
  headers: { cnpj: HIPCOM_CNPJ, senha: HIPCOM_SENHA },
  timeout: 30000,
});

// ─── Busca última data de sync salva no Redis ───
// (Redis evita o conflito de schema com bot_config, que usa colunas chave/valor no config.js)
async function getUltimaSync() {
  try {
    return (await redis.get(SYNC_KEY)) || null;
  } catch (err) {
    logger.warn('hipcomSync: falha ao ler última sync do Redis', { error: err.message });
    return null;
  }
}

async function salvarUltimaSync(ts) {
  try {
    await redis.set(SYNC_KEY, ts);
  } catch (err) {
    logger.warn('hipcomSync: falha ao salvar última sync no Redis', { error: err.message });
  }
}

// ─── Busca página de clientes no Hipcom ───
async function fetchPagina(offset, dataAlteracao = null) {
  const params = { loja: HIPCOM_LOJA, limite: BATCH, offset };
  if (dataAlteracao) params.data_ultima_alteracao = dataAlteracao;
  const res = await hipcom.get('/clientes', { params });
  return res.data?.clientes || [];
}

// ─── Normaliza telefone removendo formatação ───
function normalizar(tel) {
  return (tel || '').replace(/\D/g, '') || null;
}

// ─── Faz upsert em lote no Supabase ───
async function upsertClientes(clientes) {
  if (!clientes.length) return;
  // sb já importado no topo
  const rows = clientes.map(c => ({
    codigo:               c.codigo,
    loja:                 c.loja,
    cpfcnpj:              (() => {
      const raw = String(c.cpfcnpj || '').replace(/\D/g, '');
      if (!raw) return null;
      // CPF tem 11 dígitos, CNPJ tem 14 — padeia com zero à esquerda se necessário
      return raw.length <= 11 ? raw.padStart(11, '0') : raw.padStart(14, '0');
    })(),
    nome:                 c.nome || null,
    email:                c.email || null,
    cep:                  (c.cep || '').replace(/\D/g, '') || null,
    endereco:             c.endereco || null,
    complemento:          c.complemento_endereco || null,
    bairro:               c.bairro || null,
    uf:                   c.uf || null,
    cidade:               c.cidade || null,
    telefone:             normalizar(c.telefone),
    telefone_secundario:  normalizar(c.telefone_secundario),
    situacao:             c.situacao ?? null,
    data_ultima_alteracao: c.data_ultima_alteracao || null,
  }));
  const { error } = await sb.from('hipcom_clientes').upsert(rows, { onConflict: 'codigo,loja' });
  if (error) throw new Error(`Upsert falhou: ${error.message} | code: ${error.code}`);
}

// ─── Sync principal ───
async function sincronizarClientes() {
  const inicio = Date.now();
  const ultimaSync = await getUltimaSync();
  const agora = new Date().toISOString().slice(0, 19).replace('T', ' ');

  logger.info('hipcomSync: iniciando', { incremental: !!ultimaSync, desde: ultimaSync });

  let offset = 0;
  let total = 0;

  while (true) {
    let pagina;
    pagina = await fetchPagina(offset, ultimaSync);

    if (!pagina.length) break;

    await upsertClientes(pagina);
    total += pagina.length;
    offset += BATCH;

    logger.info('hipcomSync: pagina processada', { offset, total });

    if (pagina.length < BATCH) break; // última página
  }

  await salvarUltimaSync(agora);
  logger.info('hipcomSync: concluído', { total, ms: Date.now() - inicio });
}

// ─── Busca cliente no Supabase (usada pelo bot) ───
async function buscarClienteLocal(identificador) {
  // sb já importado no topo
  const apenasNums = identificador.replace(/\D/g, '');

  // Tenta CPF/CNPJ (com e sem zero à esquerda — Hipcom às vezes omite o zero inicial)
  if (apenasNums.length >= 10) {
    const cpfPadded = apenasNums.padStart(11, '0');
    const cpfStrip  = apenasNums.replace(/^0+/, '') || apenasNums;
    const { data } = await sb
      .from('hipcom_clientes')
      .select('*')
      .or(`cpfcnpj.eq.${cpfPadded},cpfcnpj.eq.${cpfStrip}`)
      .gte('loja', 1)
      .limit(1)
      .single();
    if (data) return normalizado(data);
  }

  // Tenta telefone (com e sem DDD)
  if (apenasNums.length >= 8) {
    const { data } = await sb
      .from('hipcom_clientes')
      .select('*')
      .or(`telefone.eq.${apenasNums},telefone_secundario.eq.${apenasNums}`)
      .gte('loja', 1)
      .limit(1)
      .single();
    if (data) return normalizado(data);
  }

  // Tenta nome
  if (!apenasNums.length || identificador.replace(/\d/g, '').trim().length > 2) {
    const { data } = await sb
      .from('hipcom_clientes')
      .select('*')
      .ilike('nome', `%${identificador}%`)
      .gte('loja', 1)
      .limit(1)
      .single();
    if (data) return normalizado(data);
  }

  return null;
}

function normalizado(c) {
  return {
    id:         c.codigo,
    nome:       c.nome,
    cpf:        c.cpfcnpj,
    telefone:   c.telefone,
    email:      c.email,
    cep:        c.cep,
    endereco:   c.endereco,
    complemento: c.complemento,
    bairro:     c.bairro,
    cidade:     c.cidade,
    uf:         c.uf,
  };
}

// ─── Inicia sync periódico (a cada 1 hora) ───
function iniciarSyncPeriodico() {
  sincronizarClientes().catch(err => logger.error('hipcomSync: erro inicial', { error: err.message }));
  setInterval(() => {
    sincronizarClientes().catch(err => logger.error('hipcomSync: erro periódico', { error: err.message }));
  }, 60 * 60 * 1000);
}

module.exports = { iniciarSyncPeriodico, sincronizarClientes, buscarClienteLocal };
