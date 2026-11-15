// Limitador simples por chave: garante um intervalo mínimo entre chamadas à mesma API.
// A primeira chamada é imediata; as seguintes esperam o intervalo restante (fila serializada).

const filas = new Map();

/**
 * @param {string} chave  identificador da API (ex.: 'cnpjws')
 * @param {number|(() => number)} intervaloMs  intervalo mínimo; função permite ler env em tempo de execução
 * @param {() => Promise<T>} tarefa
 */
export function limitar(chave, intervaloMs, tarefa) {
  const estado = filas.get(chave) ?? { cauda: Promise.resolve(), ultima: 0 };
  filas.set(chave, estado);

  const execucao = estado.cauda.then(async () => {
    const intervalo = typeof intervaloMs === 'function' ? intervaloMs() : intervaloMs;
    const falta = estado.ultima + intervalo - Date.now();
    if (falta > 0) await new Promise((r) => setTimeout(r, falta));
    estado.ultima = Date.now();
    return tarefa();
  });
  estado.cauda = execucao.catch(() => {}); // erro de uma tarefa não trava a fila
  return execucao;
}
