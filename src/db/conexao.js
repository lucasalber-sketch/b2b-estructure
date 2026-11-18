// Conexão com o banco: Postgres/Supabase (pg + SSL) quando há DATABASE_URL; PGlite em memória para testes.
// Interface única: { tipo, query(sql, params) → { rows }, exec(sql), transacao(fn), fechar() }.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const log = (...a) => console.error('[db]', ...a);

/** Remove a senha de qualquer texto que contenha a URL de conexão. */
export function mascararSegredos(texto, url = process.env.DATABASE_URL) {
  let t = String(texto ?? '');
  if (url) {
    try {
      const senha = decodeURIComponent(new URL(url).password);
      if (senha) t = t.split(senha).join('***');
    } catch { /* URL inválida: nada a mascarar */ }
  }
  return t.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1***@');
}

export const bancoConfigurado = () => Boolean(process.env.DATABASE_URL);
const memoriaPermitida = () => process.env.NODE_ENV === 'test' || process.env.DB_MEMORIA === '1';

/**
 * @param {{ url?: string, memoria?: boolean }} opcoes
 *   memoria=true força PGlite em memória (testes). Sem URL e sem memória permitida → erro claro.
 */
export async function criarConexao({ url = process.env.DATABASE_URL, memoria } = {}) {
  if (memoria || (!url && memoriaPermitida())) return conexaoPglite();
  if (!url) throw new Error('DATABASE_URL não configurada (defina no .env; veja .env.example)');
  return conexaoPostgres(url);
}

// ───────────────────────── Postgres (Supabase) ─────────────────────────

function configurarSsl() {
  const caminhoCa = process.env.DATABASE_SSL_CA;
  // Caminho relativo é resolvido a partir da raiz do projeto (o servidor MCP pode ser iniciado de outra pasta).
  if (caminhoCa) {
    try {
      return { ca: readFileSync(path.resolve(RAIZ, caminhoCa), 'utf8'), rejectUnauthorized: true };
    } catch (e) {
      log('aviso: falha ao ler certificado CA (' + caminhoCa + '): ' + e.message + ' — usando TLS');
      return { rejectUnauthorized: false };
    }
  }
  log('aviso: DATABASE_SSL_CA não definido — conexão cifrada (TLS) mas sem verificação do certificado do servidor');
  return { rejectUnauthorized: false };
}

async function conexaoPostgres(url) {
  const { default: pg } = await import('pg');
  pg.types.setTypeParser(1082, (v) => v); // date → 'AAAA-MM-DD' (sem deslocamento de fuso)

  // sslmode na URL faria o pg ignorar a configuração abaixo → removido; SSL é sempre ligado aqui.
  const u = new URL(url);
  for (const p of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) u.searchParams.delete(p);

  const pool = new pg.Pool({
    connectionString: u.toString(),
    ssl: configurarSsl(),
    max: Number(process.env.DATABASE_POOL_MAX) || (process.env.VERCEL ? 1 : 5),
    connectionTimeoutMillis: Number(process.env.DATABASE_TIMEOUT_MS) || 10_000,
    idleTimeoutMillis: 30_000,
    application_name: 'b2b-estructure',
  });
  pool.on('error', (e) => log('erro no pool:', mascararSegredos(e.message, url)));

  const comMascara = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      e.message = mascararSegredos(e.message, url);
      throw e;
    }
  };
  const adaptar = (c) => ({
    query: (sql, params = []) => comMascara(() => c.query(sql, params)),
    exec: (sql) => comMascara(() => c.query(sql)),
  });

  return {
    tipo: 'postgres',
    ...adaptar(pool),
    async transacao(fn) {
      const cliente = await comMascara(() => pool.connect());
      try {
        await cliente.query('BEGIN');
        const r = await fn(adaptar(cliente));
        await cliente.query('COMMIT');
        return r;
      } catch (e) {
        await cliente.query('ROLLBACK').catch(() => {});
        e.message = mascararSegredos(e.message, url);
        throw e;
      } finally {
        cliente.release();
      }
    },
    fechar: () => pool.end(),
  };
}

// ───────────────────────── PGlite (memória) ─────────────────────────

async function conexaoPglite() {
  let PGlite;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    throw new Error('PGlite indisponível (é devDependency): rode `npm install` ou configure DATABASE_URL');
  }
  const db = new PGlite({ parsers: { 1082: (v) => v } });
  await db.waitReady;
  const adaptar = (c) => ({ query: (sql, params = []) => c.query(sql, params), exec: (sql) => c.exec(sql) });
  return {
    tipo: 'pglite',
    ...adaptar(db),
    transacao: (fn) => db.transaction((tx) => fn(adaptar(tx))),
    fechar: () => db.close(),
  };
}
