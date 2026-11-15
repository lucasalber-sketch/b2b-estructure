// Cliente HTTP mínimo e determinístico: timeout, 1 retry em falha de rede/5xx, User-Agent genérico.

export const USER_AGENT =
  process.env.USER_AGENT || 'mcp-dados-brasil/0.1 (consulta local de dados publicos)';

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', causa = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.causa = causa;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function timeoutPadrao() {
  return Number(process.env.HTTP_TIMEOUT_MS) || 10_000;
}

/**
 * Faz uma requisição e devolve a Response (já validada como 2xx).
 * Retry 1x apenas em erro de rede, timeout ou 5xx. 4xx (inclusive 404/429) sobe direto.
 */
export async function requisitar(url, { timeoutMs = timeoutPadrao(), headers = {}, tentativas = 2, ...resto } = {}) {
  let ultimoErro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const res = await fetch(url, {
        ...resto,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9, */*;q=0.5', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res;
      const erro = new HttpError(`HTTP ${res.status} em ${url}`, { status: res.status, url });
      if (res.status < 500) throw erro; // 4xx: não adianta repetir
      ultimoErro = erro;
    } catch (e) {
      if (e instanceof HttpError && e.status && e.status < 500) throw e;
      ultimoErro =
        e instanceof HttpError
          ? e
          : new HttpError(
              e?.name === 'TimeoutError' ? `Timeout (${timeoutMs}ms) em ${url}` : `Falha de rede em ${url}: ${e?.message}`,
              { url, causa: e }
            );
    }
    if (i < tentativas - 1) await esperar(400 * (i + 1));
  }
  throw ultimoErro;
}

export async function buscarJson(url, opcoes) {
  const res = await requisitar(url, opcoes);
  try {
    return await res.json();
  } catch (e) {
    throw new HttpError(`Resposta não é JSON válido em ${url}`, { status: res.status, url, causa: e });
  }
}
