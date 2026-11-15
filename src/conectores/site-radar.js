// Radar de site: baixa o HTML público da home (sem executar JS) e extrai sinais determinísticos:
// CNPJ, assinaturas de ERP e portais de RH/vagas (indício de empresa média/grande, +40 funcionários).
import { requisitar, HttpError } from '../lib/http.js';
import { validarCnpj, formatarCnpj } from './cnpj.js';

const TIMEOUT_MS = () => Number(process.env.SITE_RADAR_TIMEOUT_MS) || 5_000;
const MAX_BYTES = () => Number(process.env.SITE_RADAR_MAX_BYTES) || 2 * 1024 * 1024;

// ───────────────────────── Assinaturas ─────────────────────────
// Padrões propositalmente específicos para evitar falso positivo (ex.: "sap" dentro de "whatsapp").

export const ASSINATURAS_ERP = {
  totvs: /totvs/i,
  protheus: /protheus/i,
  sankhya: /sankhya/i,
  sap: /\bsap\.com\b|\bsap business one\b|\bsap\s?s\/4\s?hana\b|\bsapui5\b|\bsap ariba\b|\bsap\s+erp\b/i,
  senior: /senior\.com\.br|senior sistemas|\bsenior x\b/i,
  linx: /linx\.com\.br|\blinx sistemas\b|\blinx\s+(?:commerce|impulse)\b/i,
  omie: /omie\.com\.br|app\.omie|\bomie\b(?=[^a-z]|$)/i,
  bling: /bling\.com\.br|\berp bling\b/i,
  alterdata: /alterdata/i,
};

export const ASSINATURAS_RH = {
  gupy: /[a-z0-9-]+\.gupy\.io|\bgupy\.io\b/i,
  solides: /solides\.com\.br|solides\.jobs|vagas\.solides/i,
  vagas_com: /\bvagas\.com(?:\.br)?\b/i,
  inhire: /inhire\.(?:app|com\.br|com)\b/i,
  kenoby: /kenoby\.com/i,
};

const TRABALHE_CONOSCO = /trabalhe[\s_-]*conosco|trabalhe[\s_-]*com[\s_-]*a[\s_-]*gente|href=["'][^"']*\/carreiras?\b/i;

// ───────────────────────── Utilidades ─────────────────────────

function trechoEvidencia(texto, indice, tamanho) {
  const ini = Math.max(0, indice - 50);
  const fim = Math.min(texto.length, indice + tamanho + 50);
  return texto.slice(ini, fim).replace(/\s+/g, ' ').trim();
}

function procurar(html, assinaturas) {
  const achados = [];
  for (const [nome, regex] of Object.entries(assinaturas)) {
    const m = regex.exec(html);
    if (m) achados.push({ nome, evidencia: trechoEvidencia(html, m.index, m[0].length) });
  }
  return achados;
}

/** Extrai CNPJs válidos: formato com máscara (numérico ou alfanumérico) ou 14 dígitos logo após "CNPJ". */
export function extrairCnpjs(html) {
  const candidatos = new Set();
  const comMascara = /(?<![A-Z0-9])[A-Z0-9]{2}\.[A-Z0-9]{3}\.[A-Z0-9]{3}\/[A-Z0-9]{4}-\d{2}(?!\d)/gi;
  for (const m of html.matchAll(comMascara)) candidatos.add(m[0].toUpperCase());
  const aposRotulo = /cnpj[^A-Za-z0-9]{0,20}(\d{14})(?!\d)/gi;
  for (const m of html.matchAll(aposRotulo)) candidatos.add(m[1]);
  const validos = new Map();
  for (const c of candidatos) {
    const v = validarCnpj(c);
    if (v.valido) validos.set(v.cnpj, formatarCnpj(v.cnpj));
  }
  return [...validos].map(([cnpj, formatado]) => ({ cnpj, formatado }));
}

/** Analisa um HTML já baixado (função pura, testável offline). */
export function analisarHtml(html) {
  const titulo = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, ' ').trim() || null;
  const erps = procurar(html, ASSINATURAS_ERP);
  const rh = procurar(html, ASSINATURAS_RH);
  const tc = TRABALHE_CONOSCO.exec(html);
  return {
    titulo,
    cnpjs: extrairCnpjs(html),
    erps,
    rh,
    trabalheConosco: tc ? { evidencia: trechoEvidencia(html, tc.index, tc[0].length) } : null,
    indicioMedioGrande: rh.length > 0,
  };
}

// ───────────────────────── Download ─────────────────────────

const HOST_PRIVADO = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/i;

export function normalizarDominio(entrada) {
  const bruto = String(entrada ?? '').trim();
  if (!bruto) throw new Error('Informe um domínio, ex.: empresa.com.br');
  const temEsquema = /^https?:\/\//i.test(bruto);
  let url;
  try {
    url = new URL(temEsquema ? bruto : `https://${bruto}`);
  } catch {
    throw new Error(`Domínio inválido: "${entrada}"`);
  }
  if (HOST_PRIVADO.test(url.hostname) || !url.hostname.includes('.')) {
    throw new Error(`Domínio não permitido (endereço local/privado): "${url.hostname}"`);
  }
  const candidatos = temEsquema ? [url.toString()] : [`https://${url.host}${url.pathname}`, `http://${url.host}${url.pathname}`];
  return { host: url.hostname, candidatos };
}

async function lerTextoLimitado(res, limite) {
  const leitor = res.body?.getReader();
  if (!leitor) return { texto: '', bytes: 0, truncado: false };
  const partes = [];
  let bytes = 0;
  let truncado = false;
  while (true) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
    bytes += value.byteLength;
    if (bytes >= limite) {
      truncado = true;
      await leitor.cancel().catch(() => {});
      break;
    }
  }
  return { texto: new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(partes)), bytes, truncado };
}

/** Baixa a home do domínio (timeout 5s, sem JS) e devolve os sinais encontrados. */
export async function inspecionarSite(dominio) {
  const { host, candidatos } = normalizarDominio(dominio);
  const avisos = [];
  for (const url of candidatos) {
    try {
      const res = await requisitar(url, {
        timeoutMs: TIMEOUT_MS(),
        tentativas: 1,
        redirect: 'follow',
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'pt-BR,pt;q=0.9' },
      });
      const tipo = res.headers.get('content-type') || '';
      if (tipo && !/html|xml|text\/plain/i.test(tipo)) {
        avisos.push({ url, mensagem: `conteúdo não-HTML (${tipo})` });
        continue;
      }
      const { texto, bytes, truncado } = await lerTextoLimitado(res, MAX_BYTES());
      return {
        dominio: host,
        acessivel: true,
        urlFinal: res.url || url,
        status: res.status,
        bytes,
        truncado,
        ...analisarHtml(texto),
        avisos,
      };
    } catch (e) {
      avisos.push({ url, status: e instanceof HttpError ? e.status : 0, mensagem: e.message });
    }
  }
  return { dominio: host, acessivel: false, cnpjs: [], erps: [], rh: [], trabalheConosco: null, indicioMedioGrande: false, avisos };
}
