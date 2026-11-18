# B2B Estructure · Inteligência Comercial & RevOps (Mato Grosso do Sul)

Plataforma de inteligência comercial, prospecção ativa e qualificação *RevOps* desenhada especificamente para o mercado corporativo de **Mato Grosso do Sul (MS)**, com foco na identificação de demanda para sistemas de gestão empresarial (**ERP Enterprise**).

O sistema processa dados públicos governamentais, aplica regras determinísticas de higienização de dados e entrega para o time comercial uma base qualificada de empresas com mapeamento geográfico, histórico de contratos públicos, detecção de sistemas em uso e roteiros consultivos de abordagem.

---

## 1. Visão Geral e Proposta de Valor

### O Problema do Mercado
Bases tradicionais de prospecção vendem milhões de contatos não filtrados. No Mato Grosso do Sul, quase um milhão de registros brutos na Receita Federal contêm majoritariamente Microempreendedores Individuais (MEI), associações de bairro, empresas inaptas e telefones cadastrais pertencentes a escritórios de contabilidade. Isso gera desperdício de tempo e desgaste operacional para equipes de vendas complexas.

### A Solução
O **b2b-estructure** aplica uma esteira de descarte e enriquecimento auditável:
1. **Redução de Escopo:** De **73,8 milhões** de linhas nacionais e **994 mil** registros em MS para **35.476 matrizes ativas** de porte **EPP** e **DEMAIS** (médio e grande porte).
2. **Capital Social Auditado:** As empresas mapeadas somam **R$ 153,1 bilhões** em capital social distribuído pelos 79 municípios do estado.
3. **Detecção de Telefones de Escritórios Contábeis:** Agrupamento estatístico em tempo real que mapeia números de telefone compartilhados por 10 ou mais empresas, alertando o vendedor antes da ligação.
4. **Radar de Software & PNCP:** Identificação de assinaturas técnicas de ERP (TOTVS, SAP, Senior, Sankhya) e portais de RH (Gupy, Sólides) no código-fonte das empresas, cruzados com contratos públicos ativos no Portal Nacional de Contratações Públicas.

---

## 2. Métricas Consolidadas da Base (Mato Grosso do Sul)

| Métrica | Quantidade | Observação |
| :--- | :---: | :--- |
| **Matrizes Ativas Qualificadas** | **35.476** | 100% sediadas em MS, ativas na Receita Federal. |
| **Porte DEMAIS (Médio e Grande)** | **13.198** | Foco primário para ERPs de classe mundial. |
| **Porte EPP (Empresa de Pequeno Porte)** | **22.278** | Foco secundário e expansão comercial. |
| **Capital Social Somado** | **R$ 153,1 bilhões** | Alta concentração em bioenergia, celulose e agro. |
| **Polos Municipais Mapeados** | **79 municípios** | Campo Grande, Dourados, Três Lagoas e polos do interior. |
| **Contratos Públicos Vinculados (PNCP)**| **R$ 17,08 milhões** | Contratos de fornecimento direto a órgãos públicos. |
| **Telefones de Contabilidade Rastreados** | **190 telefones** | Afetam 5.217 empresas (alerta preventivo para SDR). |
| **Conformidade LGPD** | **100% PJ** | Zero dados de pessoas físicas, CPFs ou sócios. |

---

## 3. Arquitetura do Sistema e Engenharia de Dados

A arquitetura do projeto prioriza previsibilidade matemática e integridade relacional.

### Divisão de Responsabilidades (95% Determinístico vs. 5% IA)
* **95% Determinístico (Sem Inteligência Artificial / Sem Alucinação):**
  * Extração e descompressão via *streaming* da Receita Federal.
  * Validação matemática de dígitos verificadores de CNPJ.
  * Normalização e deduplicação de telefones, e-mails e endereços.
  * Geocodificação em dois níveis (BrasilAPI e OpenStreetMap Nominatim).
  * Casamento de contratos públicos pelo CNPJ básico (8 dígitos).
  * Varredura regex estrita em HTML de domínios corporativos para localização de assinaturas literais.
  * Algoritmo aditivo de *Score B2B* (0 a 100 pontos).
* **5% Assistido por IA:**
  * Formulação dinâmica de teses consultivas e redação personalizada da mensagem de abordagem para WhatsApp, contextualizando município e segmento econômico.

### Diagramas Arquiteturais
O repositório inclui diagramas vetoriais completos na raiz:
* `arquitetura-sistema.svg`: Fluxo completo de dados das fontes públicas até o acionamento comercial.
* `esquema-banco-dados.svg`: Modelo Entidade-Relacionamento do Supabase com tabelas, chaves e políticas de segurança RLS.

---

## 4. Estrutura do Repositório

```text
├── api/                      # Adaptador Serverless para deploy na Vercel
│   └── index.js
├── certs/                    # Certificado SSL CA público para conexão com Supabase
│   └── prod-ca-2021.crt
├── db/
│   └── migracoes/            # Migrações SQL numeradas e rastreadas (001, 002)
├── docs/                     # Documentação de metodologia e escopo
├── scripts/                  # Scripts utilitários e testes ao vivo opcionais
├── src/
│   ├── cli/                  # Ferramentas de linha de comando (sync, migrar, enriquecer)
│   ├── conectores/           # Clientes HTTP (Receita, PNCP, BrasilAPI, Nominatim, Radar)
│   ├── db/                   # Repositório relacional, pool de conexões e RLS
│   ├── mcp/                  # Servidor Model Context Protocol (stdio) com ferramentas
│   ├── servicos/             # Motor RevOps, qualificador setorial e esteiras de dados
│   └── web/                  # Servidor HTTP nativo e SPA (HTML, CSS e JS limpos)
│       └── public/           # Interface web com mapas Leaflet e dashboard executivo
├── test/                     # Suíte de 108 testes automatizados em PGlite WASM
├── arquitetura-sistema.svg   # Diagrama vetorial da arquitetura geral
├── esquema-banco-dados.svg   # Diagrama vetorial do schema relacional do banco
├── vercel.json               # Configuração de rotas e rewrites da Vercel
├── .env.example              # Modelo documentado de variáveis de ambiente
└── package.json              # Dependências e scripts de execução
```

---

## 5. Guia de Instalação e Execução

### Pré-requisitos
* **Node.js** >= 22.9.0
* **npm** >= 10.0.0

### Passo 1: Clonar o Repositório e Instalar Dependências
```bash
git clone https://github.com/lucasalber-sketch/b2b-estructure.git
cd b2b-estructure
npm install
```

### Passo 2: Executar a Suíte de Testes (Autônoma, sem Banco Externo)
O projeto conta com testes unitários e de integração baseados em **PGlite** (PostgreSQL compilado em WebAssembly). Não é necessário configurar credenciais ou banco de dados externo para testar:
```bash
npm test
```
> **Resultado esperado:** 108 testes executados (105 aprovados e 3 testes de rede ao vivo pulados por padrão).

### Passo 3: Configurar Variáveis de Ambiente
Copie o modelo de exemplo e ajuste as chaves necessárias:
```bash
cp .env.example .env
```
Preencha a variável `ORGANIZACAO_ID` (UUID aleatório para o tenant) e a `DATABASE_URL` do Supabase.

### Passo 4: Inicializar o Painel Web Localmente
```bash
npm run dev
```
Acesse a aplicação no navegador em: `http://localhost:3030`.

---

## 6. O Pipeline de Dados e os Arquivos Brutos da Receita Federal

### Por que os arquivos ZIP não estão no Git?
Os arquivos brutos mensais disponibilizados pela Receita Federal somam aproximadamente **8 a 10 gigabytes** compactados (e mais de 70 GB descompactados). O GitHub limita arquivos individuais a 100 MB e desencoraja repositórios com volumes superiores a 2 GB. Por isso, a pasta `data/` está no `.gitignore`.

### Como a validação funciona para o avaliador?
1. **Base Pré-carregada no Supabase:** Se o avaliador utilizar a conexão do projeto, o banco já contém as **35.476 empresas de Mato Grosso do Sul**, os contratos do PNCP e os sinais de software gravados e indexados.
2. **Reprocessamento Opcional:** Caso deseje baixar e reprocessar os dados brutos a partir da fonte governamental:
   ```bash
   # Execução simulada (dry-run) que processa os arquivos oficiais sem gravar no banco
   npm run receita:sync -- --dry-run
   ```
   O conector possui suporte a retomada por cabeçalho `Range: bytes`, decodificação de Latin-1 para UTF-8 em tempo real e descompressão via *streams*, operando com pico de memória inferior a 150 MB.

---

## 7. Comandos de Linha de Comando (CLI)

O projeto expõe comandos diretos via `npm run`:

| Comando | Descrição |
| :--- | :--- |
| `npm test` | Executa a suíte de testes com banco em memória. |
| `npm run dev` | Inicia o servidor web e a API REST na porta 3030. |
| `npm run db:status` | Diagnostica a conexão, migrações aplicadas e contagens do banco. |
| `npm run db:migrar` | Aplica migrações pendentes com controle de soma de verificação (SHA-256). |
| `npm run pncp:sync -- --dias 90` | Sincroniza contratos públicos de MS do último trimestre via API do PNCP. |
| `npm run enriquecer -- --porte DEMAIS --limite 100` | Geocodifica e inspeciona domínios das 100 maiores empresas. |

---

## 8. Governança, Segurança e Conformidade LGPD

* **Legítimo Interesse e Dados Manifestamente Públicos:** Em estrita conformidade com a Lei Geral de Proteção de Dados (Lei nº 13.709/2018), a plataforma trata exclusivamente dados cadastrais de pessoas jurídicas.
* **Isolamento Multi-Tenant via RLS:** Todas as tabelas do schema `prospeccao` operam com *Row Level Security* forçado. Cada consulta assume a sessão `SET LOCAL ROLE prospeccao_app` e define `app.organization_id`. Uma organização não possui visibilidade sobre os dados de outra.
* **Mecanismo Permanente de Opt-out:** A tabela `prospeccao.nao_contatar` possui um gatilho nativo no banco que impede remoção ou edição. Quando uma empresa solicita a exclusão, seus contatos são anonimizados e novas rotinas de ingestão a ignoram sumariamente.

---

## 9. Deploy na Vercel

O projeto está configurado para deploy imediato na Vercel:
1. Conecte o repositório na dashboard da Vercel.
2. Nas configurações do projeto, adicione as variáveis de ambiente:
   * `DATABASE_URL`: String de conexão do Supabase (pooler porta 5432).
   * `DATABASE_SSL_CA`: Caminho `certs/prod-ca-2021.crt`.
   * `ORGANIZACAO_ID`: UUID da organização administradora.
3. O arquivo `vercel.json` e o adaptador `api/index.js` gerenciam o roteamento das páginas estáticas e das rotas da API REST (`/api/resumo`, `/api/empresas`, `/api/exportar`).

---

## 10. Licença e Direitos

Projeto de inteligência comercial privada. Dados públicos processados em conformidade com o Decreto Federal nº 8.777/2016 (Política de Dados Abertos do Poder Executivo Federal).
