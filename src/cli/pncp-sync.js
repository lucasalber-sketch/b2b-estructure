#!/usr/bin/env node
// npm run pncp:sync -- [--desde AAAA-MM-DD] [--ate AAAA-MM-DD] [--dias 7] [--dry-run] [--org UUID] [--json]
// Varre os contratos publicados no PNCP e grava aqueles cujo fornecedor (matriz ou filial) pertence à base de MS.
import { ingerirPncp } from '../servicos/pncp-ingestao.js';
import { criarConexao, mascararSegredos } from '../db/conexao.js';
import { criarRepositorio } from '../db/repositorio.js';

const args = process.argv.slice(2);
const valor = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const simular = args.includes('--dry-run');
const json = args.includes('--json');
const n = (v) => (v ?? 0).toLocaleString('pt-BR');
const moeda = (v) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function intervaloPadrao() {
  const hoje = new Date();
  const ate = valor('--ate') ?? hoje.toISOString().slice(0, 10);
  let desde = valor('--desde');
  if (!desde) {
    const dias = Math.max(1, Number(valor('--dias') ?? 7));
    const d = new Date(`${ate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (dias - 1));
    desde = d.toISOString().slice(0, 10);
  }
  return { desde, ate };
}

async function main() {
  const { desde, ate } = intervaloPadrao();
  const org = valor('--org') ?? process.env.ORGANIZACAO_ID;
  if (!org) throw new Error('defina ORGANIZACAO_ID no .env ou passe --org');

  console.error(
    `→ PNCP [${desde} .. ${ate}] · ${simular ? 'SIMULAÇÃO (nada será gravado)' : 'GRAVAÇÃO no banco'}`
  );

  const conexao = await criarConexao();
  const repo = criarRepositorio(conexao, { organizationId: org });
  try {
    const r = await ingerirPncp({
      desde,
      ate,
      simular,
      repo,
      aoLog: (m) => console.error(`  ${m}`),
    });
    if (json) {
      console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    const c = r.contadores;
    console.log(`\n══ PNCP ${r.desde} .. ${r.ate} · ${r.simulado ? 'simulação' : 'gravação'} · ${r.duracao_s}s ══`);
    console.log(`Empresas-base em MS (cnpj_basico): ${n(r.empresas_base)}`);
    console.log(`Dias processados: ${n(c.dias_processados)}/${n(c.dias_total)} · páginas lidas: ${n(c.paginas_lidas)}`);
    console.log(`Contratos lidos (Brasil): ${n(c.lidos_brutos)} → PJ válidos: ${n(c.contratos_pj)} (descartados PF/inv.: ${n(c.descartados_pf_ou_invalido)})`);
    console.log(`  órgãos de MS: ${n(c.orgao_ms)} · fornecedores da base MS: ${n(c.casados_empresa_ms)} (${moeda(c.valor_total_casados)})`);
    if (r.amostra.length) console.log(`  amostra: ${JSON.stringify(r.amostra, null, 1)}`);
    if (!r.simulado) {
      console.log(`\n⇪ gravados: ${n(c.gravados)} · recusados pelo banco: ${n(c.recusados_banco)} · execução ${r.execucao_id}`);
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
