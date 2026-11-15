// Conector PNCP (Portal Nacional de Contratações Públicas — api/consulta/v1/contratos).
// A API oficial consulta por janela de publicação (dataInicial/dataFinal em yyyyMMdd, páginas de até 500).
// LGPD: contratos de fornecedor pessoa física (tipoPessoa !== 'PJ') são descartados na leitura;
// campos com dados pessoais (usuarioNome, subcontratado, informacaoComplementar) nunca são lidos.
import { requisitar } from '../lib/http.js';
import { limitar } from '../lib/throttle.js';
import { validarCnpj } from './cnpj.js';

export const PNCP_CONTRATOS_URL = 'https://pncp.gov.br/api/consulta/v1/contratos';
export const TAMANHO_PAGINA_PNCP = 500;
const INTERVALO_PNCP = () => Number(process.env.PNCP_INTERVALO_MS ?? 400);
const TIMEOUT_PNCP = () => Number(process.env.PNCP_TIMEOUT_MS ?? 20_000);

const isoData = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v).slice(0, 10) : null);

/** Converte 'AAAA-MM-DD' → 'AAAAMMDD' validando data real. */
export function formatarDataPncp(dataIso) {
  const s = String(dataIso ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Data inválida: "${dataIso}" (esperado AAAA-MM-DD)`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`Data inexistente: "${dataIso}"`);
  return s.replaceAll('-', '');
}

/** Lista cada dia ('AAAA-MM-DD') entre desde e ate, inclusive. */
export function diasEntre(desde, ate) {
  formatarDataPncp(desde);
  formatarDataPncp(ate);
  if (desde > ate) throw new Error(`Período inválido: ${desde} > ${ate}`);
  const dias = [];
  const cursor = new Date(`${desde}T00:00:00Z`);
  const fim = new Date(`${ate}T00:00:00Z`);
  while (cursor <= fim) {
    dias.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dias;
}

/**
 * Normaliza um item de /v1/contratos no formato aceito por ContratoPncpEntrada (+ metadados de filtro).
 * Retorna null se o fornecedor não for PJ (LGPD) ou se CNPJ/controle forem inválidos.
 */
export function normalizarContratoPncp(c) {
  if (!c || c.tipoPessoa !== 'PJ') return null;
  const forn = validarCnpj(c.niFornecedor);
  if (!forn.valido) return null;
  const controle = String(c.numeroControlePNCP ?? '').trim();
  if (!controle) return null;

  const orgaoVal = c.orgaoEntidade?.cnpj ? validarCnpj(c.orgaoEntidade.cnpj) : { valido: false };
  const orgaoCnpj = orgaoVal.valido ? orgaoVal.cnpj : null;
  const valorNum = Number(c.valorGlobal);
  const valor = Number.isFinite(valorNum) && valorNum >= 0 ? Math.round(valorNum * 100) / 100 : null;
  const objeto = String(c.objetoContrato ?? '').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  const ano = Number.isInteger(c.anoContrato) ? c.anoContrato : null;
  const seq = Number.isInteger(c.sequencialContrato) ? c.sequencialContrato : null;
  const urlFonte = orgaoCnpj && ano && seq
    ? `https://pncp.gov.br/app/contratos/${orgaoCnpj}/${ano}/${seq}`
    : `${PNCP_CONTRATOS_URL}?numeroControlePNCP=${encodeURIComponent(controle)}`;

  return {
    cnpj_fornecedor: forn.cnpj,
    cnpj_basico: forn.cnpj.slice(0, 8),
    razao_social_fornecedor: String(c.nomeRazaoSocialFornecedor ?? '').trim() || null,
    numero_controle_pncp: controle,
    orgao_cnpj: orgaoCnpj,
    orgao_nome: String(c.orgaoEntidade?.razaoSocial ?? '').trim() || null,
    uf_orgao: String(c.unidadeOrgao?.ufSigla ?? '').trim().toUpperCase() || null,
    municipio_orgao: String(c.unidadeOrgao?.municipioNome ?? '').trim() || null,
    objeto,
    valor_global: valor,
    data_assinatura: isoData(c.dataAssinatura),
    data_vigencia_fim: isoData(c.dataVigenciaFim),
    url_fonte: urlFonte,
  };
}

/**
 * Busca uma página da API de contratos do PNCP.
 * 204 No Content (quando não há contratos no período) vira página vazia.
 */
export async function buscarPaginaContratos({
  dataInicial, dataFinal, pagina = 1, tamanhoPagina = TAMANHO_PAGINA_PNCP, cnpjOrgao, requisitarFn = requisitar,
}) {
  const params = new URLSearchParams({
    dataInicial: formatarDataPncp(dataInicial),
    dataFinal: formatarDataPncp(dataFinal),
    pagina: String(pagina),
    tamanhoPagina: String(Math.min(Math.max(1, Number(tamanhoPagina) || TAMANHO_PAGINA_PNCP), TAMANHO_PAGINA_PNCP)),
  });
  if (cnpjOrgao) {
    const v = validarCnpj(cnpjOrgao);
    if (!v.valido) throw new Error(`cnpjOrgao inválido: "${cnpjOrgao}"`);
    params.set('cnpjOrgao', v.cnpj);
  }
  const url = `${PNCP_CONTRATOS_URL}?${params}`;
  const res = await limitar('pncp', INTERVALO_PNCP, () =>
    requisitarFn(url, { timeoutMs: TIMEOUT_PNCP(), headers: { Accept: 'application/json' } })
  );
  if (res.status === 204) return { data: [], totalPaginas: 0, totalRegistros: 0, paginaAtual: pagina };
  const corpo = await res.json();
  return {
    data: Array.isArray(corpo?.data) ? corpo.data : [],
    totalPaginas: Number(corpo?.totalPaginas) || 0,
    totalRegistros: Number(corpo?.totalRegistros) || 0,
    paginaAtual: pagina,
  };
}

/**
 * Consulta contratos publicados no PNCP num período, com filtros opcionais de UF do órgão
 * e de CNPJ/raiz do fornecedor.
 */
export async function consultarContratosPncp({
  dataInicial, dataFinal, cnpjOrgao, ufOrgao, cnpjFornecedor, maxPaginas = 10, requisitarFn,
}) {
  const ufFiltro = ufOrgao ? String(ufOrgao).trim().toUpperCase() : null;
  let filtroForn = null;
  if (cnpjFornecedor) {
    const limpo = String(cnpjFornecedor).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (limpo.length === 8) filtroForn = (c) => c.cnpj_basico === limpo;
    else {
      const v = validarCnpj(limpo);
      if (!v.valido) throw new Error(`cnpjFornecedor inválido: "${cnpjFornecedor}"`);
      filtroForn = (c) => c.cnpj_fornecedor === v.cnpj || c.cnpj_basico === v.cnpj.slice(0, 8);
    }
  }

  const contratos = [];
  let paginasLidas = 0;
  let totalPaginas = 1;
  let totalRegistros = 0;
  let lidosBrutos = 0;
  let descartadosPfOuInvalido = 0;

  const limite = Math.max(1, Number(maxPaginas) || 10);
  while (paginasLidas < totalPaginas && paginasLidas < limite) {
    const pag = await buscarPaginaContratos({
      dataInicial, dataFinal, pagina: paginasLidas + 1, cnpjOrgao, requisitarFn,
    });
    paginasLidas += 1;
    totalPaginas = pag.totalPaginas;
    totalRegistros = pag.totalRegistros;
    lidosBrutos += pag.data.length;
    for (const item of pag.data) {
      const norm = normalizarContratoPncp(item);
      if (!norm) { descartadosPfOuInvalido += 1; continue; }
      if (ufFiltro && norm.uf_orgao !== ufFiltro) continue;
      if (filtroForn && !filtroForn(norm)) continue;
      contratos.push(norm);
    }
    if (pag.totalPaginas === 0) break;
  }

  return {
    dataInicial,
    dataFinal,
    paginasLidas,
    totalPaginas,
    totalRegistros,
    truncadoPorMaxPaginas: totalPaginas > paginasLidas,
    lidosBrutos,
    descartadosPfOuInvalido,
    totalFiltrados: contratos.length,
    contratos,
  };
}
