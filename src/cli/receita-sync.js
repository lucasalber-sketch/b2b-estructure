#!/usr/bin/env node
// npm run receita:sync -- [--mes AAAA-MM] [--dry-run] [--arquivos 0,1] [--org UUID] [--json]
// Baixa (com retomada) e ingere os Dados Abertos do CNPJ da Receita filtrando MS / ativa / matriz / EPP+DEMAIS.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listarMeses } from '../conectores/receita.js';
import { ingerirReceita } from '../servicos/receita-ingestao.js';
import { criarConexao, mascararSegredos } from '../db/conexao.js';
import { criarRepositorio } from '../db/repositorio.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const valor = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const simular = args.includes('--dry-run');
const json = args.includes('--json');
const n = (v) => (v ?? 0).toLocaleString('pt-BR');

async function main() {
  const mes = valor('--mes') ?? (await listarMeses())[0];
  if (!/^\d{4}-\d{2}$/.test(mes ?? '')) throw new Error(`mês inválido: ${mes}`);
  const indices = valor('--arquivos')?.split(',').map(Number);
  const dir = path.resolve(RAIZ, process.env.RECEITA_DIR || 'data/receita', mes);
  console.error(`→ Receita ${mes} · ${simular ? 'SIMULAÇÃO (nada será gravado no banco)' : 'GRAVAÇÃO no banco'} · pasta ${path.relative(RAIZ, dir)}`);

  let conexao = null;
  let repo;
  if (!simular) {
    const org = valor('--org') ?? process.env.ORGANIZACAO_ID;
    if (!org) throw new Error('defina ORGANIZACAO_ID no .env ou passe --org');
    conexao = await criarConexao();
    repo = criarRepositorio(conexao, { organizationId: org });
  }
  try {
    const r = await ingerirReceita({ mes, dir, simular, repo, indices, aoLog: (m) => console.error(`  ${m}`) });
    if (json) { console.log(JSON.stringify(r, null, 2)); return 0; }
    const e = r.estabelecimentos;
    const j = r.juncao;
    console.log(`\n══ Receita ${r.mes} · ${r.uf} · ${r.simulado ? 'simulação' : 'gravação'} · ${r.duracao_s}s ══`);
    console.log(`Estabelecimentos lidos (Brasil): ${n(e.linhas)}  (malformados: ${n(e.malformadas)})`);
    console.log(`  em ${r.uf}: ${n(e.uf)} → ativos: ${n(e.uf_ativas)} → matrizes ativas: ${n(e.uf_ativas_matriz)}`);
    console.log(`Empresas lidas (Brasil): ${n(r.empresas.linhas)} → casadas com as matrizes de ${r.uf}: ${n(r.empresas.casadas)}`);
    console.log(`Municípios ${r.uf} mapeados TOM→IBGE: ${r.municipios_mapeados}`);
    console.log(`\nDescartes na junção:`);
    for (const [k, v] of Object.entries(j.descartes).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${n(v)}`);
    if (Object.keys(j.nao_mapeados).length) console.log(`  municípios não mapeados: ${JSON.stringify(j.nao_mapeados)}`);
    console.log(`  inválidas (Zod): ${n(j.invalidas)} ${Object.keys(j.invalidas_motivos).length ? JSON.stringify(j.invalidas_motivos) : ''}`);
    console.log(`\n✓ APTAS para o banco: ${n(j.aptas)}   por porte: ${JSON.stringify(j.por_porte)}`);
    console.log(`  com telefone: ${n(j.com_telefone)} · com e-mail: ${n(j.com_email)} · avisos: ${JSON.stringify(j.avisos)}`);
    console.log(`  top municípios: ${j.por_municipio.map(([m, q]) => `${m} ${n(q)}`).join(' · ')}`);
    console.log(`  top CNAE: ${j.por_cnae.map(([c, q]) => `${c} ${n(q)}`).join(' · ')}`);
    console.log(`  amostra: ${JSON.stringify(r.amostra, null, 1)}`);
    if (!r.simulado) console.log(`\n⇪ gravadas: ${n(j.gravadas)} · recusadas pelo banco: ${n(j.recusadas_banco)} · execução ${r.execucao_id}`);
    return 0;
  } finally {
    await conexao?.fechar();
  }
}

main().then((c) => process.exit(c), (e) => {
  console.error(`✗ ${mascararSegredos(e.message)}`);
  process.exit(1);
});
