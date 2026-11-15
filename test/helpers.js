// Utilitários de teste: fetch simulado por rota, cache em pasta temporária, fixtures.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

export const fixture = (nome) => JSON.parse(readFileSync(path.join(DIR, 'fixtures', nome), 'utf8'));

/** Isola o cache em uma pasta temporária e zera intervalos de throttle. Retorna função de limpeza. */
export function ambienteIsolado() {
  const dir = mkdtempSync(path.join(tmpdir(), 'mcp-dados-brasil-'));
  const anterior = { ...process.env };
  process.env.CACHE_DIR = dir;
  process.env.CNPJWS_INTERVALO_MS = '0';
  process.env.NOMINATIM_INTERVALO_MS = '0';
  return () => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in anterior)) delete process.env[k];
    Object.assign(process.env, anterior);
  };
}

/**
 * Substitui globalThis.fetch. `rotas` = [[regexOuTrecho, resposta]], onde resposta é
 * { status?, json?, html?, headers? } ou função (url) => resposta. Registra as URLs chamadas.
 */
export function simularFetch(rotas) {
  const original = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    chamadas.push(u);
    const rota = rotas.find(([padrao]) => (padrao instanceof RegExp ? padrao.test(u) : u.includes(padrao)));
    if (!rota) throw new TypeError(`fetch simulado: sem rota para ${u}`);
    const r = typeof rota[1] === 'function' ? rota[1](u) : rota[1];
    if (r instanceof Error) throw r;
    const corpo = r.html ?? JSON.stringify(r.json ?? {});
    const tipo = r.html != null ? 'text/html; charset=utf-8' : 'application/json';
    const res = new Response(corpo, { status: r.status ?? 200, headers: { 'content-type': tipo, ...(r.headers ?? {}) } });
    Object.defineProperty(res, 'url', { value: u });
    return res;
  };
  return { chamadas, restaurar: () => (globalThis.fetch = original) };
}
