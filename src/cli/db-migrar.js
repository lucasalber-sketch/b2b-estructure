#!/usr/bin/env node
// npm run db:migrar [-- --dry-run] — aplica as migrações pendentes de db/migracoes/.
import { criarConexao, mascararSegredos } from '../db/conexao.js';
import { aplicarMigracoes } from '../db/migracoes.js';

const simular = process.argv.includes('--dry-run');

async function main() {
  const conexao = await criarConexao();
  try {
    console.log(`→ banco: ${conexao.tipo}${simular ? ' (simulação, nada será gravado)' : ''}`);
    const r = await aplicarMigracoes(conexao, { simular });
    if (simular) {
      console.log(r.simuladas.length ? `  seriam aplicadas: ${r.simuladas.join(', ')}` : '  nada pendente');
    } else {
      console.log(r.aplicadas.length ? `✓ aplicadas: ${r.aplicadas.join(', ')}` : '✓ já estava em dia — nada a aplicar');
    }
    return 0;
  } finally {
    await conexao.fechar();
  }
}

main().then((c) => process.exit(c), (e) => {
  console.error(`✗ migração falhou (nada desta migração foi gravado): ${mascararSegredos(e.message)}`);
  process.exit(1);
});
