// Executor idempotente de migrações SQL puras (db/migracoes/NNN_nome.sql).
// Regras: ordem alfabética; cada arquivo numa transação com advisory lock; arquivo já aplicado
// não pode mudar (sha256) — corrija criando uma nova migração.
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR_MIGRACOES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migracoes');
const TRAVA = 715_002; // chave do pg_advisory_xact_lock deste projeto

const CONTROLE = `
  CREATE SCHEMA IF NOT EXISTS prospeccao;
  CREATE TABLE IF NOT EXISTS prospeccao._migracoes (
    nome        text PRIMARY KEY,
    sha256      text NOT NULL,
    aplicado_em timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE prospeccao._migracoes ENABLE ROW LEVEL SECURITY;`;

/** CRLF → LF antes do hash, para o checkout no Windows não "alterar" a migração. */
const hash = (sql) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

export function lerArquivos(dir = DIR_MIGRACOES) {
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f))
    .sort()
    .map((nome) => {
      const sql = readFileSync(path.join(dir, nome), 'utf8');
      return { nome, sql, sha256: hash(sql) };
    });
}

async function aplicadas(db) {
  const { rows: existe } = await db.query(`SELECT to_regclass('prospeccao._migracoes') IS NOT NULL AS ok`);
  if (!existe[0].ok) return [];
  const { rows } = await db.query('SELECT nome, sha256, aplicado_em FROM prospeccao._migracoes ORDER BY nome');
  return rows.map((r) => ({ ...r, aplicado_em: new Date(r.aplicado_em).toISOString() }));
}

function conferir(arquivos, feitas) {
  const porNome = new Map(arquivos.map((a) => [a.nome, a]));
  for (const f of feitas) {
    const a = porNome.get(f.nome);
    if (a && a.sha256 !== f.sha256) {
      throw new Error(`migração ${f.nome} foi alterada depois de aplicada (sha256 diverge) — crie uma nova migração em vez de editar`);
    }
  }
}

/** { aplicadas: [{nome, aplicado_em}], pendentes: [nome], ausentesNoDisco: [nome] } */
export async function statusMigracoes(db, { dir = DIR_MIGRACOES } = {}) {
  const arquivos = lerArquivos(dir);
  const feitas = await aplicadas(db);
  conferir(arquivos, feitas);
  const nomesFeitos = new Set(feitas.map((f) => f.nome));
  const noDisco = new Set(arquivos.map((a) => a.nome));
  return {
    aplicadas: feitas.map(({ nome, aplicado_em }) => ({ nome, aplicado_em })),
    pendentes: arquivos.filter((a) => !nomesFeitos.has(a.nome)).map((a) => a.nome),
    ausentesNoDisco: feitas.filter((f) => !noDisco.has(f.nome)).map((f) => f.nome),
  };
}

/** Aplica as pendentes. Retorna { aplicadas: [nome] } (vazio se já estava em dia). */
export async function aplicarMigracoes(db, { dir = DIR_MIGRACOES, simular = false } = {}) {
  const arquivos = lerArquivos(dir);
  conferir(arquivos, await aplicadas(db));
  if (simular) return { aplicadas: [], simuladas: (await statusMigracoes(db, { dir })).pendentes };

  await db.exec(CONTROLE);
  const resultado = [];
  for (const arq of arquivos) {
    const feita = await db.transacao(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [TRAVA]);
      // Revalida dentro da trava: outro processo pode ter aplicado enquanto esperávamos.
      const { rows } = await tx.query('SELECT sha256 FROM prospeccao._migracoes WHERE nome = $1', [arq.nome]);
      if (rows.length) return false;
      await tx.exec(arq.sql);
      await tx.query('INSERT INTO prospeccao._migracoes (nome, sha256) VALUES ($1, $2)', [arq.nome, arq.sha256]);
      return true;
    });
    if (feita) resultado.push(arq.nome);
  }
  return { aplicadas: resultado };
}
