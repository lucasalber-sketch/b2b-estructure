// Utilitários dos testes de banco: PGlite em memória já migrado, CNPJs sintéticos válidos e acesso como papel do app.
import { criarConexao } from '../../src/db/conexao.js';
import { aplicarMigracoes } from '../../src/db/migracoes.js';

export const ORG_A = '00000000-0000-4000-8000-00000000000a';
export const ORG_B = '00000000-0000-4000-8000-00000000000b';

export async function bancoMigrado() {
  const db = await criarConexao({ memoria: true });
  await aplicarMigracoes(db);
  return db;
}

/** Completa 12 caracteres com os 2 DVs (mesma regra da Receita). */
export function gerarCnpj(base12) {
  const v = (c) => c.charCodeAt(0) - 48;
  const dv = (s, pesos) => {
    const r = [...s].reduce((a, c, i) => a + v(c) * pesos[i], 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const d1 = dv(base12, p1);
  const d2 = dv(base12 + d1, [6, ...p1]);
  return `${base12}${d1}${d2}`;
}

/** Executa SQL cru como `prospeccao_app` no contexto de uma organização (ignora o repositório/Zod). */
export function comoApp(db, org, fn) {
  return db.transacao(async (tx) => {
    if (org) await tx.query(`SELECT set_config('app.organization_id', $1, true)`, [org]);
    await tx.exec('SET LOCAL ROLE prospeccao_app');
    return fn(tx);
  });
}

/** Empresa mínima válida (EPP, Ltda) para os testes. */
export const empresaBase = (cnpj, extra = {}) => ({
  cnpj,
  cnpj_origem: 'brasilapi',
  fonte_descoberta: 'mcp_consulta',
  razao_social: 'INDUSTRIA TESTE LTDA',
  porte: 'EPP',
  natureza_juridica_codigo: '2062',
  uf: 'MS',
  codigo_ibge: '5002704',
  municipio: 'CAMPO GRANDE',
  ...extra,
});

/** INSERT cru com as colunas mínimas. */
export const inserirCru = (tx, org, cnpj, extra = {}) => {
  const e = { organization_id: org, ...empresaBase(cnpj), ...extra };
  const cols = Object.keys(e);
  return tx.query(
    `INSERT INTO prospeccao.empresas (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    Object.values(e)
  );
};
