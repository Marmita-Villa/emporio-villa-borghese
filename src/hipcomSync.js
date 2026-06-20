/**
 * hipcomSync.js — Sincroniza clientes do Hipcom para o Supabase
 *
 * - Sync incremental a cada hora (usa data_ultima_alteracao)
 * - Sync inicial baixa todos os clientes paginado
 * - Upsert por (codigo, loja)
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

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

// ─── Busca última data de sync salva no Supabase ───
async function getUltimaSync() {
  // sb já importado no topo
  const { data } = await sb.from('bot_config').select('value').eq('key', SYNC_KEY).single();
  return data?.value || null;
}

async function salvarUltimaSync(ts) {
  // sb já importado no topo
  await sb.from('bot_config').upsert({ key: SYNC_KEY, value: ts }, { onConflict: 'key' });
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
    cpfcnpj:              (c.cpfcnpj || '').replace(/\D/g, '') || null,
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
  if (error) logger.error('hipcomSync: erro no upsert', { error: error.message });
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
    try {
      pagina = await fetchPagina(offset, ultimaSync);
    } catch (err) {
      logger.error('hipcomSync: erro ao buscar pagina', { offset, error: err.message });
      break;
    }

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

  // Tenta CPF/CNPJ
  if (apenasNums.length >= 11) {
    const { data } = await sb
      .from('hipcom_clientes')
      .select('*')
      .eq('cpfcnpj', apenasNums)
      .eq('loja', HIPCOM_LOJA)
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
      .eq('loja', HIPCOM_LOJA)
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
      .eq('loja', HIPCOM_LOJA)
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
