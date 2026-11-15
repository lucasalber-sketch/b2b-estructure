// Ingestão de contratos públicos do PNCP (api/consulta/v1/contratos) dia a dia, com checkpoint:
//   - Varre cada dia do intervalo [desde, ate] em páginas de 500.
//   - Filtra contratos PJ cuja raiz cnpj_basico (8 caracteres) pertença a alguma matriz cadastrada no banco.
//   - Liga contratos assinados tanto pela matriz quanto por qualquer filial à matriz em MS.
//   - Atualiza checkpoint a cada dia concluído em prospeccao.ingestao_execucoes.
import { buscarPaginaContratos, diasEntre, normalizarContratoPncp } from '../conectores/pncp.js';

/**
 * @param {object} o
 * @param {string} o.desde 'AAAA-MM-DD'
 * @param {string} o.ate   'AAAA-MM-DD'
 * @param {boolean} [o.simular=false]
 * @param {ReturnType<import('../db/repositorio.js').criarRepositorio>} o.repo
 * @param {typeof buscarPaginaContratos} [o.buscarPagina]
 * @param {Set<string>} [o.cnpjsBasicos]
 * @param {boolean} [o.retomar=true]
 * @param {(msg: string) => void} [o.aoLog]
 */
export async function ingerirPncp({
  desde,
  ate,
  simular = false,
  repo,
  buscarPagina = buscarPaginaContratos,
  cnpjsBasicos,
  retomar = true,
  aoLog = () => {},
}) {
  if (!repo && !cnpjsBasicos) throw new Error('informe repo ou cnpjsBasicos');
  if (!simular && !repo) throw new Error('repo é obrigatório quando simular=false');

  const inicio = Date.now();
  const todosDias = diasEntre(desde, ate);
  const raizes = cnpjsBasicos ?? (await repo.cnpjsBasicosCadastrados());

  let diasJaFeitos = new Set();
  let execucaoId = null;
  let contadores = {
    dias_total: todosDias.length,
    dias_processados: 0,
    paginas_lidas: 0,
    lidos_brutos: 0,
    contratos_pj: 0,
    descartados_pf_ou_invalido: 0,
    orgao_ms: 0,
    casados_empresa_ms: 0,
    gravados: 0,
    recusados_banco: 0,
    valor_total_casados: 0,
  };

  if (!simular) {
    if (retomar) {
      const ant = await repo.ultimaExecucao('pncp');
      if (
        ant &&
        ant.status !== 'concluida' &&
        ant.parametros?.desde === desde &&
        ant.parametros?.ate === ate &&
        Array.isArray(ant.checkpoint?.dias_concluidos)
      ) {
        execucaoId = ant.id;
        diasJaFeitos = new Set(ant.checkpoint.dias_concluidos);
        contadores = { ...contadores, ...(ant.contadores ?? {}) };
        await repo.atualizarExecucao(execucaoId, { status: 'em_andamento', erro: null });
        aoLog(`↻ Retomando execução ${execucaoId} (${diasJaFeitos.size}/${todosDias.length} dias já concluídos)`);
      }
    }
    if (!execucaoId) {
      execucaoId = await repo.iniciarExecucao({
        tipo: 'pncp',
        parametros: { desde, ate, empresas_base: raizes.size },
      });
    }
  }

  const amostra = [];
  const diasConcluidos = [...diasJaFeitos];

  try {
    for (const dia of todosDias) {
      if (diasJaFeitos.has(dia)) continue;

      let pagina = 1;
      let totalPaginas = 1;
      const casadosDia = [];

      while (pagina <= totalPaginas) {
        const res = await buscarPagina({ dataInicial: dia, dataFinal: dia, pagina });
        contadores.paginas_lidas += 1;
        totalPaginas = res.totalPaginas;
        contadores.lidos_brutos += res.data.length;

        for (const item of res.data) {
          const norm = normalizarContratoPncp(item);
          if (!norm) {
            contadores.descartados_pf_ou_invalido += 1;
            continue;
          }
          contadores.contratos_pj += 1;
          if (norm.uf_orgao === 'MS') contadores.orgao_ms += 1;

          if (raizes.has(norm.cnpj_basico)) {
            contadores.casados_empresa_ms += 1;
            contadores.valor_total_casados = Math.round((contadores.valor_total_casados + (norm.valor_global ?? 0)) * 100) / 100;
            casadosDia.push({
              cnpj_fornecedor: norm.cnpj_fornecedor,
              numero_controle_pncp: norm.numero_controle_pncp,
              orgao_cnpj: norm.orgao_cnpj,
              orgao_nome: norm.orgao_nome,
              objeto: norm.objeto,
              valor_global: norm.valor_global,
              data_assinatura: norm.data_assinatura,
              data_vigencia_fim: norm.data_vigencia_fim,
              url_fonte: norm.url_fonte,
            });
            if (amostra.length < 5) {
              amostra.push({
                numero_controle_pncp: norm.numero_controle_pncp,
                cnpj_fornecedor: norm.cnpj_fornecedor,
                razao_social_fornecedor: norm.razao_social_fornecedor,
                orgao_nome: norm.orgao_nome,
                uf_orgao: norm.uf_orgao,
                valor_global: norm.valor_global,
                data_assinatura: norm.data_assinatura,
              });
            }
          }
        }
        if (res.totalPaginas === 0) break;
        pagina += 1;
      }

      if (!simular && casadosDia.length > 0) {
        const r = await repo.registrarContratosPncp(casadosDia);
        contadores.gravados += r.gravados;
        contadores.recusados_banco += r.recusados.length;
      }

      contadores.dias_processados += 1;
      diasConcluidos.push(dia);
      aoLog(
        `✓ ${dia}: ${totalPaginas} pág. · casados MS no dia: ${casadosDia.length} (acumulado: ${contadores.casados_empresa_ms})`
      );

      if (!simular) {
        await repo.atualizarExecucao(execucaoId, {
          checkpoint: { ultimo_dia: dia, dias_concluidos: diasConcluidos },
          contadores,
        });
      }
    }

    if (!simular) {
      await repo.atualizarExecucao(execucaoId, {
        status: 'concluida',
        checkpoint: { ultimo_dia: ate, dias_concluidos: diasConcluidos },
        contadores,
      });
    }
  } catch (e) {
    if (execucaoId) {
      await repo.atualizarExecucao(execucaoId, { status: 'falhou', contadores, erro: e.message }).catch(() => {});
    }
    throw e;
  }

  return {
    desde,
    ate,
    simulado: simular,
    empresas_base: raizes.size,
    contadores,
    amostra,
    execucao_id: execucaoId,
    duracao_s: Math.round((Date.now() - inicio) / 1000),
  };
}
