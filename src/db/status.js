// Diagnóstico do banco, compartilhado por `npm run db:status` e pela ferramenta MCP `db_status`.
// Nunca devolve URL, usuário de conexão completo ou senha.
import { statusMigracoes } from './migracoes.js';
import { mascararSegredos } from './conexao.js';

export const TABELAS = ['empresas', 'empresa_contratos_pncp', 'empresa_sinais_erp', 'funil_historico', 'nao_contatar', 'ingestao_execucoes'];

export async function diagnosticar(conexao) {
  const inicio = performance.now();
  try {
    const { rows } = await conexao.query(
      `SELECT current_setting('server_version') AS versao, current_user AS usuario,
              (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user) AS ignora_rls,
              to_regnamespace('prospeccao') IS NOT NULL AS schema_existe`
    );
    const latencia_ms = Math.round(performance.now() - inicio);
    const info = rows[0];
    const migracoes = await statusMigracoes(conexao);

    let contagens = null;
    if (info.schema_existe && migracoes.aplicadas.length) {
      contagens = {};
      for (const t of TABELAS) {
        const r = await conexao.query(`SELECT count(*)::int AS n FROM prospeccao.${t}`).catch(() => null);
        contagens[t] = r ? r.rows[0].n : null;
      }
    }
    return {
      configurado: true,
      tipo: conexao.tipo,
      conectado: true,
      latencia_ms,
      servidor: `PostgreSQL ${info.versao}`,
      usuario: info.usuario,
      ignora_rls: info.ignora_rls,
      schema_prospeccao: info.schema_existe,
      migracoes,
      em_dia: migracoes.pendentes.length === 0,
      // Contagens vistas pelo usuário de conexão (dono). Se ignora_rls=false, o FORCE RLS pode zerá-las.
      contagens,
    };
  } catch (e) {
    return { configurado: true, tipo: conexao.tipo, conectado: false, erro: mascararSegredos(e.message) };
  }
}
