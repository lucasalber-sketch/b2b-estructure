// Conector dos Dados Abertos do CNPJ (Receita Federal) — compartilhamento Nextcloud público via WebDAV.
// Leitura 100% em streaming (ZIP → inflate → Latin-1 → linhas), sem carregar arquivos de GB na memória.
// LGPD: os arquivos Socios*.zip (QSA) nunca são listados para download nem lidos.
import { createReadStream, createWriteStream, existsSync, statSync, renameSync, mkdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import { USER_AGENT } from '../lib/http.js';
import { montarLogradouro, podeExporContato } from './cnpj.js';
import { paraE164 } from '../db/esquemas.js';

const log = (...a) => console.error('[receita]', ...a);

export const WEBDAV_URL = () =>
  (process.env.RECEITA_WEBDAV_URL || 'https://arquivos.receitafederal.gov.br/public.php/webdav').replace(/\/$/, '');
const TOKEN = () => process.env.RECEITA_TOKEN || 'gn672Ad4CF8N6TK'; // token público do compartilhamento
export const PASTA_CNPJ = 'Dados/Cadastros/CNPJ';
const autorizacao = () => `Basic ${Buffer.from(`${TOKEN()}:`).toString('base64')}`;

// ───────────────────────── WebDAV ─────────────────────────

/** PROPFIND Depth:1 → [{ nome, pasta, bytes, modificadoEm }] (sem a própria pasta). */
export async function listarPasta(caminho) {
  const url = `${WEBDAV_URL()}/${caminho.replace(/^\/|\/$/g, '')}/`;
  const res = await fetch(url, {
    method: 'PROPFIND',
    headers: { Authorization: autorizacao(), Depth: '1', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(Number(process.env.HTTP_TIMEOUT_MS) || 30_000),
  });
  if (res.status !== 207) throw new Error(`WebDAV PROPFIND ${caminho}: HTTP ${res.status}`);
  return interpretarPropfind(await res.text(), caminho);
}

export function interpretarPropfind(xml, caminho) {
  const base = `/${caminho.replace(/^\/|\/$/g, '')}/`;
  const itens = [];
  for (const bloco of xml.split(/<d:response>/i).slice(1)) {
    const href = decodeURIComponent(/<d:href>([^<]+)<\/d:href>/i.exec(bloco)?.[1] ?? '');
    const relativo = href.slice(href.indexOf(base) + base.length).replace(/\/$/, '');
    if (!relativo || href.indexOf(base) < 0) continue; // a própria pasta
    const bytes = /<d:getcontentlength>(\d+)</i.exec(bloco)?.[1];
    const mod = /<d:getlastmodified>([^<]+)</i.exec(bloco)?.[1];
    itens.push({
      nome: relativo,
      pasta: /<d:collection\s*\/>/i.test(bloco),
      bytes: bytes != null ? Number(bytes) : null,
      modificadoEm: mod ? new Date(mod).toISOString() : null,
    });
  }
  return itens;
}

/** Meses publicados (AAAA-MM), do mais recente para o mais antigo. */
export async function listarMeses() {
  const itens = await listarPasta(PASTA_CNPJ);
  return itens.filter((i) => i.pasta && /^\d{4}-\d{2}$/.test(i.nome)).map((i) => i.nome).sort().reverse();
}

/** Arquivos de um mês relevantes para a ingestão (nunca Socios*). */
export async function listarArquivosDoMes(mes) {
  const itens = await listarPasta(`${PASTA_CNPJ}/${mes}`);
  const zips = itens.filter((i) => !i.pasta && /\.zip$/i.test(i.nome) && !/^socios/i.test(i.nome));
  const ordenar = (re) =>
    zips.filter((i) => re.test(i.nome)).sort((a, b) => Number(/(\d+)\.zip$/i.exec(a.nome)[1]) - Number(/(\d+)\.zip$/i.exec(b.nome)[1]));
  return {
    mes,
    estabelecimentos: ordenar(/^Estabelecimentos\d+\.zip$/i),
    empresas: ordenar(/^Empresas\d+\.zip$/i),
    municipios: zips.find((i) => /^Municipios\.zip$/i.test(i.nome)) ?? null,
  };
}

/**
 * Baixa um arquivo do mês para `dir`, com retomada (HTTP Range) a partir do `.parcial`.
 * Só renomeia para o nome final quando o tamanho confere com o publicado.
 */
export async function baixarArquivo({ mes, arquivo, dir, tentativas = 5, aoProgredir }) {
  mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, arquivo.nome);
  if (existsSync(destino) && (arquivo.bytes == null || statSync(destino).size === arquivo.bytes)) return destino;
  const parcial = `${destino}.parcial`;
  const url = `${WEBDAV_URL()}/${PASTA_CNPJ}/${mes}/${encodeURIComponent(arquivo.nome)}`;

  for (let t = 1; t <= tentativas; t++) {
    const inicio = existsSync(parcial) ? statSync(parcial).size : 0;
    if (arquivo.bytes != null && inicio === arquivo.bytes) break;
    try {
      const res = await fetch(url, {
        headers: { Authorization: autorizacao(), 'User-Agent': USER_AGENT, ...(inicio ? { Range: `bytes=${inicio}-` } : {}) },
        signal: AbortSignal.timeout(Number(process.env.RECEITA_TIMEOUT_MS) || 6 * 60 * 60_000),
      });
      if (inicio && res.status !== 206) throw new Error(`servidor ignorou Range (HTTP ${res.status})`);
      if (!inicio && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      let recebidos = inicio;
      const corpo = Readable.fromWeb(res.body);
      corpo.on('data', (c) => { recebidos += c.length; aoProgredir?.(recebidos, arquivo.bytes); });
      await pipeline(corpo, createWriteStream(parcial, { flags: inicio ? 'a' : 'w' }));
      break;
    } catch (e) {
      if (t === tentativas) throw new Error(`falha ao baixar ${arquivo.nome} após ${t} tentativas: ${e.message}`);
      log(`${arquivo.nome}: ${e.message} — retomando (tentativa ${t + 1}/${tentativas})`);
      await new Promise((r) => setTimeout(r, 2000 * t));
    }
  }
  const tamanho = statSync(parcial).size;
  if (arquivo.bytes != null && tamanho !== arquivo.bytes) {
    throw new Error(`${arquivo.nome}: tamanho ${tamanho} ≠ publicado ${arquivo.bytes}`);
  }
  renameSync(parcial, destino);
  return destino;
}

// ───────────────────────── Leitura ZIP/CSV em streaming ─────────────────────────

/** Linha da Receita ("a";"b";…) → campos. Retorna null se não estiver no formato esperado. */
export function separarCampos(linha) {
  const l = linha.endsWith('\r') ? linha.slice(0, -1) : linha;
  if (l.length < 2 || l[0] !== '"' || l[l.length - 1] !== '"') return null;
  return l.slice(1, -1).split('";"');
}

/**
 * Lê o(s) CSV(s) dentro de um ZIP chamando `aoLer(campos)` por linha. Retorna { linhas, malformadas, internos }.
 * @param {string | Uint8Array} origem caminho do .zip (ou bytes, nos testes)
 */
export async function lerZipCsv(origem, aoLer) {
  const dec = new TextDecoder('latin1');
  let resto = '';
  let linhas = 0;
  let malformadas = 0;
  const internos = [];
  const processar = (texto, final) => {
    const partes = (resto + texto).split('\n');
    resto = final ? '' : partes.pop();
    for (const p of partes) {
      if (!p) continue;
      const campos = separarCampos(p);
      if (!campos) { malformadas++; continue; }
      linhas++;
      aoLer(campos);
    }
  };
  let erro = null;
  const uz = new Unzip((arq) => {
    internos.push(arq.name);
    arq.ondata = (e, dados, final) => {
      if (e) { erro = e; return; }
      processar(dec.decode(dados, { stream: !final }), final);
    };
    arq.start();
  });
  uz.register(UnzipInflate);

  if (typeof origem === 'string') {
    for await (const pedaco of createReadStream(origem, { highWaterMark: 1 << 20 })) {
      uz.push(pedaco);
      if (erro) throw erro;
    }
  } else {
    uz.push(origem);
  }
  uz.push(new Uint8Array(0), true);
  if (erro) throw erro;
  return { linhas, malformadas, internos };
}

// ───────────────────────── Layout (validado contra o arquivo real de 2026-10) ─────────────────────────

export const ESTAB = {
  cnpj_basico: 0, cnpj_ordem: 1, cnpj_dv: 2, matriz_filial: 3, nome_fantasia: 4, situacao: 5,
  data_inicio: 10, cnae_principal: 11, cnae_secundaria: 12, tipo_logradouro: 13, logradouro: 14, numero: 15,
  complemento: 16, bairro: 17, cep: 18, uf: 19, municipio: 20, ddd1: 21, tel1: 22, ddd2: 23, tel2: 24, email: 27,
  TOTAL: 30,
};
export const EMPR = { cnpj_basico: 0, razao_social: 1, natureza: 2, capital: 4, porte: 5, TOTAL: 7 };

/** Confere se a linha tem a cara do layout esperado (aborta a ingestão se o layout mudar). */
export function layoutConfere(campos, tipo) {
  if (tipo === 'estab') {
    return campos.length === ESTAB.TOTAL && /^[A-Z0-9]{8}$/.test(campos[0]) && /^[A-Z0-9]{4}$/.test(campos[1])
      && /^\d{2}$/.test(campos[2]) && /^[12]$/.test(campos[3]) && /^\d{2}$/.test(campos[5]) && /^([A-Z]{2}|)$/.test(campos[19]);
  }
  return campos.length === EMPR.TOTAL && /^[A-Z0-9]{8}$/.test(campos[0]) && /^\d{4}$/.test(campos[2]) && /^\d{2}$/.test(campos[5]);
}

export const SITUACAO_ATIVA = '02';
export const MATRIZ = '1';
export const PORTE_RECEITA = { '00': 'NAO_INFORMADO', '01': 'ME', '03': 'EPP', '05': 'DEMAIS' };

// ───────────────────────── Municípios (TOM/SIAFI → IBGE) ─────────────────────────

export const normalizarNome = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/**
 * Casa os nomes da tabela de municípios da Receita (código TOM) com a lista IBGE da UF.
 * Os nomes da Receita não trazem UF; por isso o casamento só é usado para linhas cuja UF já é a da lista.
 * @returns {Map<string, { codigo_ibge: string, nome: string }>} TOM → IBGE (apenas nomes que existem na UF)
 */
export function mapearMunicipios(tomParaNome, municipiosIbge) {
  const ibgePorNome = new Map(municipiosIbge.map((m) => [normalizarNome(m.nome), { codigo_ibge: String(m.id), nome: m.nome }]));
  const mapa = new Map();
  for (const [tom, nome] of tomParaNome) {
    const ibge = ibgePorNome.get(normalizarNome(nome));
    if (ibge) mapa.set(tom, ibge);
  }
  return mapa;
}

// ───────────────────────── Conversão para a linha de `empresas` ─────────────────────────

/** Provedores de e-mail gratuitos: o e-mail é gravado, mas o domínio não é tratado como site da empresa. */
export const PROVEDORES_GRATUITOS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.com.br', 'outlook.com', 'outlook.com.br', 'live.com',
  'msn.com', 'yahoo.com', 'yahoo.com.br', 'ymail.com', 'bol.com.br', 'uol.com.br', 'terra.com.br', 'ig.com.br',
  'icloud.com', 'me.com', 'globo.com', 'globomail.com', 'r7.com', 'zipmail.com.br', 'protonmail.com', 'proton.me',
  'aol.com', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'superig.com.br', 'oi.com.br', 'pop.com.br',
]);

const contemCpf = (t) => /\d{11}/.test(t) || /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(t);
const vazio = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const data8 = (v) => (/^\d{8}$/.test(v ?? '') && v !== '00000000' ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null);
const capital = (v) => {
  const n = Number(String(v ?? '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Estabelecimento (campos) → objeto compacto para o arquivo intermediário (só o que será usado). */
export function compactarEstab(c) {
  return {
    b: c[ESTAB.cnpj_basico], o: c[ESTAB.cnpj_ordem], d: c[ESTAB.cnpj_dv], f: c[ESTAB.nome_fantasia],
    i: c[ESTAB.data_inicio], cp: c[ESTAB.cnae_principal], cs: c[ESTAB.cnae_secundaria],
    tl: c[ESTAB.tipo_logradouro], lg: c[ESTAB.logradouro], n: c[ESTAB.numero], cm: c[ESTAB.complemento],
    br: c[ESTAB.bairro], cep: c[ESTAB.cep], uf: c[ESTAB.uf], m: c[ESTAB.municipio],
    t1: `${c[ESTAB.ddd1]}${c[ESTAB.tel1]}`, t2: `${c[ESTAB.ddd2]}${c[ESTAB.tel2]}`, e: c[ESTAB.email],
  };
}

export function compactarEmpresa(c) {
  return { b: c[EMPR.cnpj_basico], r: c[EMPR.razao_social], nj: c[EMPR.natureza], k: c[EMPR.capital], p: c[EMPR.porte] };
}

/**
 * Junta estabelecimento + empresa numa entrada de `empresas` (formato EmpresaEntrada).
 * @returns {{ aceita: true, empresa: object, avisos: string[] } | { aceita: false, motivo: string }}
 */
export function montarEmpresa(est, emp, municipios, { consultadoEm } = {}) {
  if (!emp) return { aceita: false, motivo: 'sem_empresa' };
  const porte = PORTE_RECEITA[emp.p] ?? 'NAO_INFORMADO';
  if (porte !== 'EPP' && porte !== 'DEMAIS') return { aceita: false, motivo: `porte_${porte}` };
  if (emp.nj === '2135') return { aceita: false, motivo: 'empresario_individual' };
  if (!/^2\d{3}$/.test(emp.nj)) return { aceita: false, motivo: 'natureza_nao_empresarial' };
  const razao = vazio(emp.r);
  if (!razao) return { aceita: false, motivo: 'sem_razao_social' };
  if (contemCpf(razao)) return { aceita: false, motivo: 'razao_social_com_cpf' };
  const mun = municipios.get(est.m);
  if (!mun) return { aceita: false, motivo: 'municipio_nao_mapeado' };

  const avisos = [];
  const regra = podeExporContato({ porte, naturezaCodigo: emp.nj, mei: false });
  let telefone = null;
  let email = null;
  if (regra.permitido) {
    telefone = paraE164(est.t1) ?? paraE164(est.t2);
    const e = vazio(est.e)?.toLowerCase() ?? null;
    if (e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      // Gravado exatamente como cadastrado na Receita (decisão do usuário), inclusive provedor gratuito.
      // O aviso só alimenta o relatório e o enriquecedor (domínio gratuito não é site da empresa).
      email = e;
      if (PROVEDORES_GRATUITOS.has(e.split('@')[1])) avisos.push('email_provedor_gratuito');
    } else if (e) {
      avisos.push('email_invalido');
    }
  }
  let fantasia = vazio(est.f);
  if (fantasia && contemCpf(fantasia)) { fantasia = null; avisos.push('fantasia_com_cpf_descartada'); }
  const cnae = (v) => (/^\d{7}$/.test(v) ? v : null);

  return {
    aceita: true,
    avisos,
    empresa: {
      cnpj: `${est.b}${est.o}${est.d}`,
      cnpj_origem: 'rfb_lote',
      fonte_descoberta: 'rfb_lote',
      razao_social: razao,
      nome_fantasia: fantasia,
      matriz_filial: 'MATRIZ',
      situacao: 'ATIVA',
      data_abertura: data8(est.i),
      porte,
      natureza_juridica_codigo: emp.nj,
      mei: false,
      capital_social: capital(emp.k),
      cnae_principal: cnae(est.cp),
      cnaes_secundarios: String(est.cs ?? '').split(',').map((x) => x.trim()).filter((x) => /^\d{7}$/.test(x)),
      logradouro: vazio(montarLogradouro(vazio(est.tl), vazio(est.lg))),
      numero: vazio(est.n),
      complemento: vazio(est.cm)?.replace(/\s+/g, ' ') ?? null,
      bairro: vazio(est.br),
      cep: /^\d{8}$/.test(est.cep ?? '') ? est.cep : null,
      municipio: mun.nome,
      uf: est.uf,
      codigo_ibge: mun.codigo_ibge,
      telefone_e164: telefone,
      telefone_origem: telefone ? 'rfb_lote' : 'NAO_VERIFICADO',
      email,
      email_origem: email ? 'rfb_lote' : 'NAO_VERIFICADO',
      consultado_em: consultadoEm ?? null,
    },
  };
}
