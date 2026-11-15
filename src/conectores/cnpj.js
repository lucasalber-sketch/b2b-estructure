// Conector CNPJ: validação (numérico + alfanumérico) e consulta BrasilAPI → fallback Publica CNPJ.ws.
import { buscarJson, HttpError } from '../lib/http.js';
import { lerCache, gravarCache, DIA_MS } from '../lib/cache.js';
import { limitar } from '../lib/throttle.js';

export const BRASILAPI_CNPJ = 'https://brasilapi.com.br/api/cnpj/v1/';
export const CNPJWS = 'https://publica.cnpj.ws/cnpj/';

const TTL = () => (Number(process.env.CACHE_TTL_CNPJ_DIAS) || 7) * DIA_MS;
// Publica CNPJ.ws permite 3 consultas/minuto → 1 a cada 20s.
const INTERVALO_CNPJWS = () => Number(process.env.CNPJWS_INTERVALO_MS ?? 20_000);

// ───────────────────────── Validação ─────────────────────────

/** Remove máscara e coloca em maiúsculas. Aceita "12.ABC.345/01DE-35" ou "00000000000191". */
export function limparCnpj(entrada) {
  return String(entrada ?? '').toUpperCase().replace(/[\s./-]/g, '');
}

const valorChar = (c) => c.charCodeAt(0) - 48; // '0'..'9' → 0..9, 'A'..'Z' → 17..42 (regra Receita/2026)

function digitoVerificador(base, pesos) {
  const soma = [...base].reduce((acc, c, i) => acc + valorChar(c) * pesos[i], 0);
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

const PESOS_DV1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const PESOS_DV2 = [6, 5, 4, 3, 2, ...PESOS_DV1.slice(4)];

/**
 * Valida CNPJ numérico (atual) e alfanumérico (IN RFB 2.229/2024, a partir de jul/2026):
 * 12 posições [A-Z0-9] + 2 dígitos verificadores numéricos, módulo 11 sobre (ASCII − 48).
 */
export function validarCnpj(entrada) {
  const cnpj = limparCnpj(entrada);
  if (!/^[A-Z0-9]{12}\d{2}$/.test(cnpj)) {
    return { valido: false, cnpj, motivo: 'formato inválido (esperado 12 caracteres alfanuméricos + 2 dígitos)' };
  }
  if (/^(.)\1{13}$/.test(cnpj)) return { valido: false, cnpj, motivo: 'sequência repetida' };
  const dv1 = digitoVerificador(cnpj.slice(0, 12), PESOS_DV1);
  const dv2 = digitoVerificador(cnpj.slice(0, 12) + dv1, PESOS_DV2);
  if (cnpj.slice(12) !== `${dv1}${dv2}`) return { valido: false, cnpj, motivo: 'dígitos verificadores não conferem' };
  return { valido: true, cnpj, alfanumerico: /[A-Z]/.test(cnpj) };
}

export function formatarCnpj(cnpj) {
  const c = limparCnpj(cnpj);
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}

// ─────────────────────── Regra LGPD do telefone ───────────────────────

const NATUREZA_EMPRESARIO_INDIVIDUAL = 2135;

/**
 * Telefone/e-mail só são expostos quando:
 *  - porte ∈ {DEMAIS, EPP}, e
 *  - natureza jurídica é de entidade empresarial PJ (códigos 2xxx: Ltda, S.A., SLU, economia mista…),
 *    exceto 213-5 Empresário (Individual), e
 *  - a empresa NÃO é optante do MEI.
 * Caso contrário o contato pode ser de pessoa física → ocultado.
 */
export function podeExporContato({ porte, naturezaCodigo, mei }) {
  if (mei === true) return { permitido: false, motivo: 'oculto_mei' };
  const cod = Number(naturezaCodigo);
  if (!cod || cod < 2000 || cod > 2999) return { permitido: false, motivo: 'oculto_natureza_nao_empresarial' };
  if (cod === NATUREZA_EMPRESARIO_INDIVIDUAL) return { permitido: false, motivo: 'oculto_empresario_individual' };
  if (porte !== 'DEMAIS' && porte !== 'EPP') return { permitido: false, motivo: 'oculto_porte' };
  return { permitido: true, motivo: null };
}

function aplicarRegraContato(r, telefoneBruto, emailBruto) {
  const regra = podeExporContato({ porte: r.porte, naturezaCodigo: r.naturezaJuridica.codigo, mei: r.mei });
  r.telefone = regra.permitido ? formatarTelefone(telefoneBruto) : null;
  r.email = regra.permitido ? (emailBruto ? String(emailBruto).toLowerCase() : null) : null;
  r.contatoMotivo = regra.permitido ? (r.telefone ? null : 'nao_informado') : regra.motivo;
  return r;
}

// ───────────────────────── Normalização ─────────────────────────

const PORTE_POR_CODIGO = { 0: 'NAO_INFORMADO', 1: 'ME', 3: 'EPP', 5: 'DEMAIS' };

function formatarTelefone(bruto) {
  const d = String(bruto ?? '').replace(/\D/g, '');
  if (d.length < 10) return d || null;
  const ddd = d.slice(0, 2);
  const num = d.slice(2);
  return `(${ddd}) ${num.slice(0, num.length - 4)}-${num.slice(-4)}`;
}

/** Junta tipo + logradouro sem duplicar (ex.: "QUADRA" + "SAUN QUADRA 5" fica só "SAUN QUADRA 5" se já contiver o tipo). */
function montarLogradouro(tipo, logradouro) {
  if (!logradouro) return tipo || null;
  const palavras = String(logradouro).toUpperCase().split(/\s+/);
  if (!tipo || palavras.includes(String(tipo).toUpperCase())) return logradouro;
  return `${tipo} ${logradouro}`;
}

const cnae = (codigo, descricao) => ({ codigo: String(codigo ?? '').replace(/\D/g, '').padStart(7, '0'), descricao: descricao ?? null });

export function normalizarBrasilApi(d) {
  const r = {
    cnpj: d.cnpj,
    cnpjFormatado: formatarCnpj(d.cnpj),
    razaoSocial: d.razao_social ?? null,
    nomeFantasia: d.nome_fantasia || null,
    matrizFilial: d.descricao_identificador_matriz_filial || (d.identificador_matriz_filial === 1 ? 'MATRIZ' : 'FILIAL'),
    situacao: d.descricao_situacao_cadastral ?? null,
    dataAbertura: d.data_inicio_atividade ?? null,
    porte: PORTE_POR_CODIGO[d.codigo_porte] ?? 'NAO_INFORMADO',
    porteDescricao: d.porte ?? null,
    naturezaJuridica: { codigo: d.codigo_natureza_juridica ? String(d.codigo_natureza_juridica) : null, descricao: d.natureza_juridica ?? null },
    mei: d.opcao_pelo_mei === true,
    capitalSocial: d.capital_social != null ? Number(d.capital_social) : null,
    cnaePrincipal: cnae(d.cnae_fiscal, d.cnae_fiscal_descricao),
    cnaesSecundarios: (d.cnaes_secundarios ?? []).filter((c) => c.codigo).map((c) => cnae(c.codigo, c.descricao)),
    endereco: {
      logradouro: montarLogradouro(d.descricao_tipo_de_logradouro, d.logradouro),
      numero: d.numero || null,
      complemento: d.complemento || null,
      bairro: d.bairro || null,
      cep: d.cep || null,
      municipio: d.municipio || null,
      uf: d.uf || null,
      codigoIbge: d.codigo_municipio_ibge ? String(d.codigo_municipio_ibge) : null,
    },
    inscricoesEstaduais: null, // BrasilAPI não fornece; preenchido via CNPJ.ws quando possível
    fonte: 'brasilapi',
  };
  return aplicarRegraContato(r, d.ddd_telefone_1, d.email);
}

const PORTE_CNPJWS = { '01': 'ME', '03': 'EPP', '05': 'DEMAIS' };

export function extrairInscricoesEstaduais(d) {
  return (d.estabelecimento?.inscricoes_estaduais ?? []).map((ie) => ({
    inscricao: ie.inscricao_estadual,
    uf: ie.estado?.sigla ?? null,
    ativa: ie.ativo ?? null,
  }));
}

export function normalizarCnpjWs(d) {
  const e = d.estabelecimento ?? {};
  const r = {
    cnpj: e.cnpj,
    cnpjFormatado: formatarCnpj(e.cnpj),
    razaoSocial: d.razao_social ?? null,
    nomeFantasia: e.nome_fantasia || null,
    matrizFilial: e.tipo ? String(e.tipo).toUpperCase() : null,
    situacao: e.situacao_cadastral ? String(e.situacao_cadastral).toUpperCase() : null,
    dataAbertura: e.data_inicio_atividade ?? null,
    porte: PORTE_CNPJWS[d.porte?.id] ?? 'NAO_INFORMADO',
    porteDescricao: d.porte?.descricao ?? null,
    naturezaJuridica: { codigo: d.natureza_juridica?.id ?? null, descricao: d.natureza_juridica?.descricao ?? null },
    mei: d.simples?.mei === 'Sim',
    capitalSocial: d.capital_social != null ? Number(d.capital_social) : null,
    cnaePrincipal: cnae(e.atividade_principal?.id, e.atividade_principal?.descricao),
    cnaesSecundarios: (e.atividades_secundarias ?? []).map((c) => cnae(c.id, c.descricao)),
    endereco: {
      logradouro: montarLogradouro(e.tipo_logradouro, e.logradouro),
      numero: e.numero || null,
      complemento: e.complemento ? e.complemento.replace(/\s+/g, ' ').trim() : null,
      bairro: e.bairro || null,
      cep: e.cep || null,
      municipio: e.cidade?.nome ?? null,
      uf: e.estado?.sigla ?? null,
      codigoIbge: e.cidade?.ibge_id ? String(e.cidade.ibge_id) : null,
    },
    inscricoesEstaduais: extrairInscricoesEstaduais(d),
    fonte: 'cnpjws',
  };
  return aplicarRegraContato(r, `${e.ddd1 ?? ''}${e.telefone1 ?? ''}`, e.email);
}

// ───────────────────────── Consulta ─────────────────────────

const consultarBrasilApi = (cnpj) => buscarJson(BRASILAPI_CNPJ + cnpj);
const consultarCnpjWs = (cnpj) => limitar('cnpjws', INTERVALO_CNPJWS, () => buscarJson(CNPJWS + cnpj, { tentativas: 1 }));

const descreverErro = (fonte, e) => ({ fonte, status: e instanceof HttpError ? e.status : 0, mensagem: e.message });

/**
 * Consulta um CNPJ em tempo real (com cache local de 7 dias).
 * @param {string} entrada CNPJ com ou sem máscara
 * @param {{ incluirIE?: boolean, ignorarCache?: boolean }} opcoes
 *   incluirIE: se a BrasilAPI responder, faz uma 2ª chamada ao CNPJ.ws só para trazer a Inscrição Estadual.
 */
export async function consultarCnpj(entrada, { incluirIE = true, ignorarCache = false } = {}) {
  const v = validarCnpj(entrada);
  if (!v.valido) throw new Error(`CNPJ inválido (${v.cnpj || entrada}): ${v.motivo}`);
  const cnpj = v.cnpj;

  if (!ignorarCache) {
    const emCache = await lerCache('cnpj', cnpj, TTL());
    if (emCache && !(incluirIE && emCache.inscricoesEstaduais === null)) return { ...emCache, doCache: true };
  }

  const avisos = [];
  let resultado = null;
  let dadosCnpjWs = null;

  try {
    resultado = normalizarBrasilApi(await consultarBrasilApi(cnpj));
  } catch (e) {
    avisos.push(descreverErro('brasilapi', e));
    try {
      dadosCnpjWs = await consultarCnpjWs(cnpj);
      resultado = normalizarCnpjWs(dadosCnpjWs);
    } catch (e2) {
      avisos.push(descreverErro('cnpjws', e2));
    }
  }

  if (!resultado) {
    const naoEncontrado = avisos.every((a) => a.status === 404 || a.status === 400);
    if (naoEncontrado) return { encontrado: false, cnpj, cnpjFormatado: formatarCnpj(cnpj), avisos, doCache: false };
    throw new Error(`Falha ao consultar CNPJ ${formatarCnpj(cnpj)}: ${avisos.map((a) => `${a.fonte}: ${a.mensagem}`).join(' | ')}`);
  }

  if (incluirIE && resultado.inscricoesEstaduais === null) {
    try {
      resultado.inscricoesEstaduais = extrairInscricoesEstaduais(await consultarCnpjWs(cnpj));
      resultado.fonte = 'brasilapi+cnpjws';
    } catch (e) {
      avisos.push({ ...descreverErro('cnpjws', e), contexto: 'inscricao_estadual' });
    }
  }

  const final = { encontrado: true, ...resultado, consultadoEm: new Date().toISOString(), avisos };
  await gravarCache('cnpj', cnpj, final);
  return { ...final, doCache: false };
}
