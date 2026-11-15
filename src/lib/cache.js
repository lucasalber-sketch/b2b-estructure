// Cache JSON em disco: data/cache/<namespace>/<chave>.json com TTL.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ_PROJETO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DIA_MS = 24 * 60 * 60 * 1000;

function diretorioBase() {
  const env = process.env.CACHE_DIR;
  if (!env) return path.join(RAIZ_PROJETO, 'data', 'cache');
  return path.isAbsolute(env) ? env : path.join(RAIZ_PROJETO, env);
}

function caminho(namespace, chave) {
  const seguro = String(chave).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').slice(0, 120);
  return path.join(diretorioBase(), namespace, `${seguro}.json`);
}

/** Lê do cache. ttlMs = Infinity para nunca expirar. Retorna null se ausente/expirado/corrompido. */
export async function lerCache(namespace, chave, ttlMs = Infinity) {
  if (process.env.CACHE_DESATIVADO === '1') return null;
  try {
    const bruto = JSON.parse(await readFile(caminho(namespace, chave), 'utf8'));
    if (Date.now() - bruto.salvoEm > ttlMs) return null;
    return bruto.dados;
  } catch {
    return null;
  }
}

export async function gravarCache(namespace, chave, dados) {
  if (process.env.CACHE_DESATIVADO === '1') return;
  const destino = caminho(namespace, chave);
  await mkdir(path.dirname(destino), { recursive: true });
  const tmp = `${destino}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ salvoEm: Date.now(), dados }, null, 2), 'utf8');
  await rename(tmp, destino); // escrita atômica
}

/** Busca no cache; se não houver, executa `produzir()` e grava. Retorna { dados, doCache }. */
export async function comCache(namespace, chave, ttlMs, produzir) {
  const emCache = await lerCache(namespace, chave, ttlMs);
  if (emCache !== null) return { dados: emCache, doCache: true };
  const dados = await produzir();
  await gravarCache(namespace, chave, dados);
  return { dados, doCache: false };
}
