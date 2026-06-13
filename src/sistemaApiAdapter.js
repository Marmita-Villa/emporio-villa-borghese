/**
 * sistemaApiAdapter.js — Alterna entre API legacy e nova API v1
 *
 * Controle via variável de ambiente:
 *   API_VERSION=legacy  → usa sistemaApi.js    (padrão atual)
 *   API_VERSION=v1      → usa sistemaApiV1.js  (nova plataforma)
 */

const version = process.env.API_VERSION || 'legacy';

if (version === 'v1') {
  module.exports = require('./sistemaApiV1');
} else {
  module.exports = require('./sistemaApi');
}
