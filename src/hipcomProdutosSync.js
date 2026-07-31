/**
 * hipcomProdutosSync.js — Sincroniza o catálogo completo de produtos do Hipcom para o Supabase
 *
 * Resolve o padrão de abreviações do Hipcom na descrição (REQJ., QJ., CHOC., etc.) de
 * uma vez por todas: em vez de tentar corrigir termo por termo, buscamos localmente
 * no catálogo espelhado, comparando palavra por palavra (sem depender de substring
 * contíguo nem do vocabulário exato usado pelo Hipcom).
 *
 * - Catálogo é grande (5000+ itens ativos) e o Hipcom é lento pra consultas grandes
 *   (~14s pra 5000 itens) — por isso a sincronização roda em background, periódica,
 *   nunca no caminho de uma mensagem do cliente.
 * - A verificação de estoque no fechamento do pedido continua em tempo real no Hipcom
 *   (verificarEstoque em sistemaApi.js) — esta tabela serve só para ACHAR o produto.
 */

const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { Redis } = require('@upstash/redis');
const logger = require('./logger');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const redis = new Redis({ url: process.env.UPSTASH_REDIS_URL, token: process.env.UPSTASH_REDIS_TOKEN });

const HIPCOM_URL   = process.env.HIPCOM_URL   || 'http://emporiovilla.dyndns.info:2222/api/hipcom';
const HIPCOM_USER  = process.env.HIPCOM_USER  || 'hipcomfull';
const HIPCOM_PASS  = process.env.HIPCOM_PASS  || '';
const HIPCOM_LOJA  = parseInt(process.env.HIPCOM_PRICE_STORE || '6', 10);
const BATCH        = 1000;
const MAX_PAGINAS  = 60; // trava de segurança: 60 x 1000 = 60mil itens, bem acima do catálogo real
const SYNC_KEY     = 'hipcom_produtos_sync';

const hipcom = axios.create({
  baseURL: HIPCOM_URL,
  auth: { username: HIPCOM_USER, password: HIPCOM_PASS },
  timeout: 30000,
});

// ─── Remove acentos e baixa a caixa — usado tanto ao gravar quanto ao buscar ───
function normalizarTexto(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function getUltimaSync() {
  try { return (await redis.get(SYNC_KEY)) || null; }
  catch (err) { logger.warn('hipcomProdutosSync: falha ao ler última sync', { error: err.message }); return null; }
}

async function salvarUltimaSync(ts) {
  try { await redis.set(SYNC_KEY, ts); }
  catch (err) { logger.warn('hipcomProdutosSync: falha ao salvar última sync', { error: err.message }); }
}

// ─── Busca uma página de produtos no Hipcom ───
async function fetchPagina(offset) {
  // NÃO usa somente_estoque_positivo: itens fracionados/produção (pães, frios, queijos por
  // peso) ficam com estoque negativo por não reconciliar produção x venda, mas estão sempre
  // disponíveis (ex: PAO FRANCES * KG com estoque -5350) — esse filtro os excluiria da
  // sincronização inteira. O filtro de disponibilidade real é aplicado na busca
  // (buscarProdutoLocal), que já considera fracionado='S' como sempre disponível.
  const res = await hipcom.get('/produtos', {
    params: { loja: HIPCOM_LOJA, limite: BATCH, offset },
  });
  return res.data?.produtos || [];
}

// ─── Upsert em lote no Supabase ───
async function upsertProdutos(produtos) {
  if (!produtos.length) return;
  const rows = produtos.map(p => ({
    plu:                   p.plu,
    loja:                  HIPCOM_LOJA,
    descricao:             p.descricao || null,
    descricao_normalizada: normalizarTexto(p.descricao),
    departamento:          p.departamento || null,
    secao:                 p.secao || null,
    grupo:                 p.grupo || null,
    preco:                 p.valor_produto ?? null,
    preco_promocao:        p.valor_promocao > 0 ? p.valor_promocao : null,
    estoque:               p.qtd_estoque_atual ?? 0,
    fracionado:            p.fracionado || null,
    ativo:                 p.ativo || null,
    ean:                   p.codigo_barra ? String(p.codigo_barra) : null,
    data_ultima_alteracao: p.data_ultima_alteracao || null,
    updated_at:            new Date().toISOString(),
  }));

  // O Hipcom pode retornar o mesmo PLU mais de uma vez na mesma página (ex: registros de
  // movimentação/entrada) — um único upsert não aceita duas linhas com o mesmo conflito
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time"). Mantém a última
  // ocorrência de cada (plu, loja).
  const porChave = new Map();
  for (const row of rows) porChave.set(`${row.plu}|${row.loja}`, row);
  const rowsUnicas = [...porChave.values()];

  const { error } = await sb.from('hipcom_produtos').upsert(rowsUnicas, { onConflict: 'plu,loja' });
  if (error) throw new Error(`Upsert de produtos falhou: ${error.message} | code: ${error.code}`);
}

// ─── Sync principal — pagina até acabar, com trava de segurança contra paginação quebrada ───
async function sincronizarProdutos() {
  const inicio = Date.now();
  logger.info('hipcomProdutosSync: iniciando');

  let offset = 0;
  let total = 0;
  let pluAnterior = null;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const itens = await fetchPagina(offset);
    if (!itens.length) break;

    // Se a página não mudou (mesmo primeiro PLU da anterior), o offset não está
    // sendo respeitado pelo Hipcom — aborta em vez de girar em loop repetindo os mesmos itens
    if (pluAnterior !== null && itens[0].plu === pluAnterior) {
      logger.error('hipcomProdutosSync: paginação parece não avançar (offset ignorado pelo Hipcom) — abortando', { offset, plu: itens[0].plu });
      break;
    }
    pluAnterior = itens[0].plu;

    await upsertProdutos(itens);
    total += itens.length;
    offset += BATCH;

    logger.info('hipcomProdutosSync: página processada', { offset, total });

    if (itens.length < BATCH) break; // última página
  }

  await salvarUltimaSync(new Date().toISOString());
  logger.info('hipcomProdutosSync: concluído', { total, ms: Date.now() - inicio });
  return total;
}

// ─── Palavras que o Hipcom abrevia na descrição — mesmo mapeamento usado na busca ao
// vivo (sistemaApi.js). Sem isso, "chocolate lindt" nunca acharia "CHOC. LINDT..." porque
// a palavra "chocolate" nunca aparece por extenso no catálogo.
const ABREVIACOES_CONHECIDAS = {
  requeijao: 'reqj', requeijoes: 'reqj',
  queijo: 'qj', queijos: 'qj',
  chocolate: 'choc', chocolates: 'choc',
};

// Conectores/palavras de contexto que raramente aparecem na descrição curta do Hipcom
// (ex: "barra de chocolate" — "barra" e "de" não existem na descrição real do produto)
const PALAVRAS_IGNORAVEIS = new Set(['de', 'do', 'da', 'e', 'a', 'o', 'com', 'para', 'um', 'uma', 'barra', 'barrinha', 'tablete', 'pacote']);

// "Média" é ambígua demais pra virar palavra-chave de OR (aparece como tamanho em vela,
// escova, azeitona etc.) — precisa de substituição do termo INTEIRO, não palavra a palavra.
function apelidoTermoInteiro(termoNormalizado) {
  const t = termoNormalizado.toLowerCase();
  if (/\bmedia(s)?\b/.test(t)) return 'pao frances'; // "média(s) clarinha(s)"
  if (/\b(pao|paes)\b/.test(t) && /\bfrances(es)?\b/.test(t)) return 'pao frances';
  return null;
}

// ─── Busca produtos no catálogo local (Supabase) — tokenizada, sem depender de ───
// ─── substring contíguo nem do vocabulário/abreviação exata do Hipcom ───
async function buscarProdutoLocal(termo, opts = {}) {
  const { limite = 8 } = opts;
  const termoNormalizado = normalizarTexto(termo);
  // Slangs que só fazem sentido como termo inteiro (ex: "média" é ambígua demais pra
  // virar palavra-chave solta — aparece em vela, escova, azeitona etc.)
  const substituicao = apelidoTermoInteiro(termoNormalizado);
  let palavras = (substituicao || termoNormalizado).split(/\s+/).filter(Boolean)
    .map(p => ABREVIACOES_CONHECIDAS[p] || p);

  const palavrasRelevantes = palavras.filter(p => !PALAVRAS_IGNORAVEIS.has(p) && p.length >= 2);
  if (!palavrasRelevantes.length) palavrasRelevantes.push(...palavras);
  if (!palavrasRelevantes.length) return [];

  // Busca candidatos que batem em QUALQUER uma das palavras (OR) — não só a "mais longa".
  // Escolher uma única palavra "principal" falha sempre que ela não existe no vocabulário
  // abreviado do Hipcom mas outra (ex: marca) existe — foi exatamente o bug encontrado.
  const orFiltro = palavrasRelevantes.map(p => `descricao_normalizada.ilike.%${p}%`).join(',');
  const { data, error } = await sb
    .from('hipcom_produtos')
    .select('plu,descricao,descricao_normalizada,preco,preco_promocao,estoque,fracionado,ativo,ean,departamento')
    .eq('loja', HIPCOM_LOJA)
    .eq('ativo', 'S')
    .or(orFiltro)
    .limit(500);

  if (error) {
    logger.error('hipcomProdutosSync: erro na busca local', { termo, error: error.message });
    return [];
  }

  // Pontua por quantas palavras do termo aparecem na descrição — não exige que todas
  // batam (algumas podem ser ruído: "barra", "de", marca incomum etc.). Itens que batem
  // em mais palavras (ex: marca + tipo) ficam no topo.
  const pontuados = (data || [])
    .filter(p => p.fracionado === 'S' || p.estoque > 0) // mesmo critério de disponibilidade do buscarProduto
    .map(p => ({
      produto: p,
      matches: palavrasRelevantes.filter(palavra => p.descricao_normalizada.includes(palavra)).length,
    }))
    .filter(x => x.matches > 0)
    .sort((a, b) => b.matches - a.matches);

  return pontuados.slice(0, limite).map(x => ({
    id:    String(x.produto.plu),
    nome:  x.produto.descricao,
    preco: x.produto.preco_promocao > 0 ? x.produto.preco_promocao : x.produto.preco,
    ean:   x.produto.ean,
  }));
}

// ─── Verifica se o catálogo local já tem dados (rede de segurança: enquanto vazio,
// buscarProduto usa a busca ao vivo no Hipcom como antes). Cache em memória por 10 min
// pra não bater no Supabase a cada mensagem só pra checar isso. ───
let _catalogoDisponivel = null;
let _catalogoCheckTs = 0;
const CATALOGO_CHECK_TTL = 10 * 60 * 1000;

async function catalogoLocalDisponivel() {
  if (_catalogoDisponivel && Date.now() - _catalogoCheckTs < CATALOGO_CHECK_TTL) return true;
  try {
    const { count, error } = await sb
      .from('hipcom_produtos')
      .select('*', { count: 'exact', head: true })
      .eq('loja', HIPCOM_LOJA);
    _catalogoCheckTs = Date.now();
    _catalogoDisponivel = !error && count > 0;
    return _catalogoDisponivel;
  } catch {
    return _catalogoDisponivel || false;
  }
}

// ─── Inicia sync periódico (intervalo configurável, padrão 4h) ───
// Mais frequente que o de clientes (6h) porque preço/estoque mudam mais rápido —
// mas o estoque exibido ao cliente sempre é reconfirmado ao vivo antes de fechar o pedido.
const SYNC_INTERVAL_H  = parseInt(process.env.HIPCOM_PRODUTOS_SYNC_INTERVAL_H || '4', 10);
const SYNC_INTERVAL_MS = SYNC_INTERVAL_H * 60 * 60 * 1000;

function iniciarSyncProdutosPeriodico() {
  sincronizarProdutos().catch(err => logger.error('hipcomProdutosSync: erro inicial', { error: err.message }));
  setInterval(() => {
    sincronizarProdutos().catch(err => logger.error('hipcomProdutosSync: erro periódico', { error: err.message }));
  }, SYNC_INTERVAL_MS);
  logger.info('hipcomProdutosSync: agendado', { intervaloHoras: SYNC_INTERVAL_H });
}

module.exports = { iniciarSyncProdutosPeriodico, sincronizarProdutos, buscarProdutoLocal, catalogoLocalDisponivel, fetchPagina, upsertProdutos };
