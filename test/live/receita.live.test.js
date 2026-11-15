// Testes AO VIVO da Receita (WebDAV público). Só rodam com LIVE=1 (npm run test:live). Nada é gravado no banco.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as receita from '../../src/conectores/receita.js';
import { listarMunicipios } from '../../src/conectores/ibge.js';

const LIVE = process.env.LIVE === '1';
const opts = { skip: !LIVE && 'defina LIVE=1 para rodar', timeout: 120_000 };

describe('Receita — Dados Abertos CNPJ (ao vivo)', () => {
  test('lista meses e arquivos do mês mais recente (sem Socios)', opts, async () => {
    const meses = await receita.listarMeses();
    assert.match(meses[0], /^\d{4}-\d{2}$/);
    const a = await receita.listarArquivosDoMes(meses[0]);
    assert.equal(a.estabelecimentos.length, 10);
    assert.equal(a.empresas.length, 10);
    assert.ok(a.municipios?.bytes > 0);
    assert.ok(a.estabelecimentos.every((x) => x.bytes > 0 && x.modificadoEm));
    console.log(`\n── mês ${meses[0]}: ${(a.estabelecimentos.reduce((s, x) => s + x.bytes, 0) / 1e9).toFixed(2)} GB de Estabelecimentos, ${(a.empresas.reduce((s, x) => s + x.bytes, 0) / 1e9).toFixed(2)} GB de Empresas`);
  });

  test('Municipios.zip real: os 79 municípios de MS casam com o IBGE', opts, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'receita-live-'));
    try {
      const [mes] = await receita.listarMeses();
      const { municipios } = await receita.listarArquivosDoMes(mes);
      const zip = await receita.baixarArquivo({ mes, arquivo: municipios, dir });
      const tom = new Map();
      await receita.lerZipCsv(zip, (c) => tom.set(c[0], c[1]));
      assert.ok(tom.size > 5000, `esperado > 5000 municípios, veio ${tom.size}`);
      const ibge = (await listarMunicipios('MS')).municipios;
      const mapa = receita.mapearMunicipios(tom, ibge);
      const casados = new Set([...mapa.values()].map((m) => m.codigo_ibge));
      const faltando = ibge.filter((m) => !casados.has(String(m.id))).map((m) => m.nome);
      assert.deepEqual(faltando, [], `municípios de MS sem código TOM: ${faltando.join(', ')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
