// Conector IBGE (servicodados.ibge.gov.br): municípios por UF e CNAE (seções / classes).
import { buscarJson } from '../lib/http.js';
import { comCache, DIA_MS } from '../lib/cache.js';

export const IBGE_BASE = 'https://servicodados.ibge.gov.br/api';
const TTL = () => (Number(process.env.CACHE_TTL_IBGE_DIAS) || 30) * DIA_MS;

export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
];

export function normalizarUf(uf = 'MS') {
  const sigla = String(uf).trim().toUpperCase();
  if (!UFS.includes(sigla)) throw new Error(`UF inválida: "${uf}". Use uma sigla como MS, SP, PR.`);
  return sigla;
}

export function normalizarMunicipio(m) {
  return {
    id: m.id,
    nome: m.nome,
    microrregiao: m.microrregiao?.nome ?? null,
    mesorregiao: m.microrregiao?.mesorregiao?.nome ?? null,
    regiaoImediata: m['regiao-imediata']?.nome ?? null,
    regiaoIntermediaria: m['regiao-imediata']?.['regiao-intermediaria']?.nome ?? null,
  };
}

/** Lista os municípios de uma UF (padrão MS). */
export async function listarMunicipios(uf = 'MS') {
  const sigla = normalizarUf(uf);
  const url = `${IBGE_BASE}/v1/localidades/estados/${sigla}/municipios`;
  const { dados, doCache } = await comCache('ibge', `municipios_${sigla}`, TTL(), async () =>
    (await buscarJson(url)).map(normalizarMunicipio)
  );
  return { uf: sigla, total: dados.length, municipios: dados, fonte: url, doCache };
}

/** Lista as 21 seções da CNAE 2.x. */
export async function listarSecoesCnae() {
  const url = `${IBGE_BASE}/v2/cnae/secoes`;
  const { dados, doCache } = await comCache('ibge', 'cnae_secoes', TTL(), async () =>
    (await buscarJson(url)).map((s) => ({ id: s.id, descricao: s.descricao }))
  );
  return { total: dados.length, secoes: dados, fonte: url, doCache };
}

export function normalizarClasse(c) {
  return {
    id: c.id,
    descricao: c.descricao,
    grupo: c.grupo?.id ?? null,
    divisao: c.grupo?.divisao?.id ?? null,
    secao: c.grupo?.divisao?.secao?.id ?? null,
    secaoDescricao: c.grupo?.divisao?.secao?.descricao ?? null,
  };
}

/** Lista as classes CNAE (≈673), opcionalmente filtradas por seção (A..U). */
export async function listarClassesCnae(secao) {
  const url = `${IBGE_BASE}/v2/cnae/classes`;
  const { dados, doCache } = await comCache('ibge', 'cnae_classes', TTL(), async () =>
    (await buscarJson(url, { timeoutMs: 20_000 })).map(normalizarClasse)
  );
  let classes = dados;
  if (secao) {
    const s = String(secao).trim().toUpperCase();
    if (!/^[A-U]$/.test(s)) throw new Error(`Seção CNAE inválida: "${secao}". Use uma letra de A a U.`);
    classes = dados.filter((c) => c.secao === s);
  }
  return { secao: secao ? String(secao).toUpperCase() : null, total: classes.length, classes, fonte: url, doCache };
}
