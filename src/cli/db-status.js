#!/usr/bin/env node
// npm run db:status [-- --json] — conexão, versão, migrações aplicadas/pendentes e contagens.
import { criarConexao, bancoConfigurado, mascararSegredos } from '../db/conexao.js';
import { diagnosticar } from '../db/status.js';

const json = process.argv.includes('--json');

async function main() {
  if (!bancoConfigurado() && process.env.DB_MEMORIA !== '1') {
    const r = { configurado: false, mensagem: 'DATABASE_URL não configurada (copie .env.example para .env)' };
    console.log(json ? JSON.stringify(r, null, 2) : `✗ ${r.mensagem}`);
    return 1;
  }
  const conexao = await criarConexao();
  try {
    const s = await diagnosticar(conexao);
    if (json) {
      console.log(JSON.stringify(s, null, 2));
    } else if (!s.conectado) {
      console.log(`✗ falha ao conectar (${s.tipo}): ${s.erro}`);
    } else {
      console.log(`✓ conectado (${s.tipo}) · ${s.servidor} · ${s.latencia_ms} ms · usuário ${s.usuario}${s.ignora_rls ? ' (ignora RLS)' : ''}`);
      console.log(`  schema prospeccao: ${s.schema_prospeccao ? 'sim' : 'não'}`);
      console.log(`  migrações aplicadas: ${s.migracoes.aplicadas.map((m) => `${m.nome} (${m.aplicado_em})`).join(', ') || 'nenhuma'}`);
      console.log(`  migrações pendentes: ${s.migracoes.pendentes.join(', ') || 'nenhuma'}`);
      if (s.migracoes.ausentesNoDisco.length) console.log(`  ⚠ aplicadas mas ausentes no disco: ${s.migracoes.ausentesNoDisco.join(', ')}`);
      if (s.contagens) console.log(`  linhas: ${Object.entries(s.contagens).map(([t, n]) => `${t}=${n ?? '?'}`).join(' · ')}`);
    }
    return s.conectado ? 0 : 1;
  } finally {
    await conexao.fechar();
  }
}

main().then((c) => process.exit(c), (e) => {
  console.error(`✗ ${mascararSegredos(e.message)}`);
  process.exit(1);
});
