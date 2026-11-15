#!/usr/bin/env node
// npm run enriquecer -- [--tipo geo|site|ambos] [--ibge 5002704] [--cnae 0115600] [--porte DEMAIS] [--limite 100] [--dry-run] [--org UUID] [--json]
// Enriquecimento incremental: geocodificação por CEP/endereço e radar de site (CNPJ + ERP + RH).
import { enriquecerEmpresas } from '../servicos/enriquecedor.js';
import { criarConexao, mascararSegredos } from '../db/conexao.js';
import { criarRepositorio } from '../db/repositorio.js';

const args = process.argv.slice(2);
const valor = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const simular = args.includes('--dry-run');
const json = args.includes('--json');
const n = (v) => (v ?? 0).toLocaleString('pt-BR');

async function main() {
  const tipo = valor('--tipo') ?? 'ambos';
  if (!['geo', 'site', 'ambos'].includes(tipo)) throw new Error(`--tipo inválido: ${tipo} (esperado geo, site ou ambos)`);
  const codigo_ibge = valor('--ibge');
  const cnae = valor('--cnae');
  const porte = valor('--porte');
  const limite = Number(valor('--limite') ?? 100);
  const org = valor('--org') ?? process.env.ORGANIZACAO_ID;
  if (!org) throw new Error('defina ORGANIZACAO_ID no .env ou passe --org');

  console.error(
    `→ Enriquecimento (${tipo}) · limite=${limite} · ${simular ? 'SIMULAÇÃO (nada será gravado)' : 'GRAVAÇÃO no banco'}`
  );

  const conexao = await criarConexao();
  const repo = criarRepositorio(conexao, { organizationId: org });
  try {
    const r = await enriquecerEmpresas({
      repo,
      tipo,
      codigo_ibge,
      cnae,
      porte,
      limite,
      simular,
      aoLog: (m) => console.error(`  ${m}`),
    });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    const c = r.contadores;
    console.log(`\n══ Enriquecimento (${r.tipo}) · ${r.simulado ? 'simulação' : 'gravação'} · ${r.duracao_s}s ══`);
    console.log(`Empresas selecionadas: ${n(c.selecionadas)}`);
    if (r.tipo === 'geo' || r.tipo === 'ambos') {
      console.log(
        `Geo: tentadas=${n(c.geo.tentadas)} · com coordenada=${n(c.geo.com_coordenada)} · sem=${n(c.geo.sem_coordenada)} · por precisão=${JSON.stringify(c.geo.por_precisao)}`
      );
    }
    if (r.tipo === 'site' || r.tipo === 'ambos') {
      console.log(
        `Site: tentadas=${n(c.site.tentadas)} · HTTP=${n(c.site.requisicoes_http)} (reuso cache=${n(c.site.reuso_cache_dominio)}) · status=${JSON.stringify(c.site.por_status)}`
      );
      console.log(`  sinais confirmados: ERP=${n(c.site.sinais_erp)} · RH=${n(c.site.sinais_rh)}`);
    }
    if (r.amostra_sinais.length) {
      console.log(`  amostra sinais: ${JSON.stringify(r.amostra_sinais, null, 1)}`);
    }
    if (!r.simulado) {
      console.log(`\n⇪ movidas para 'enriquecido': ${n(c.qualificadas_funil)} · execução ${r.execucao_id ?? 'n/a'}`);
    }
    return 0;
  } finally {
    await conexao.fechar();
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(`✗ ${mascararSegredos(e.message)}`);
    process.exit(1);
  }
);
