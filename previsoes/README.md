# Previsões (automático, no GitHub)

Previsões de futebol que se atualizam sozinhas, sem servidor.

- `index.html`: o site (separadores Hoje / Anteriores, estilo escuro). Lê os dados de `data/`.
- `data/AAAA-MM-DD.json`: previsões de cada dia. São geradas e guardadas automaticamente.
- `scripts/gerar.js`: gera os ficheiros de `data/` com os dados da Sportmonks.
- `lib/engine.js`: o modelo (Poisson sobre golos recentes, em duas partes). Calcula cerca de 70 probabilidades por jogo: 1X2, dupla hipótese, empate anula aposta, total de golos (0,5 a 4,5), golos de cada equipa, ambas marcam, vitória sem sofrer, margem de vitória, número exato de golos, par/ímpar, resultados exatos mais prováveis, 1.ª parte, parte com mais golos e HT/FT. Todas saem da mesma distribuição, por isso são coerentes entre si.
- `lib/day.js`: pede à Sportmonks os jogos do dia e o histórico das equipas.
- `.github/workflows/previsoes.yml` (na raiz do repositório): corre o gerador de 30 em 30 minutos.
- `api/previsoes.js`: opcional, só se quiseres usar a Vercel em vez do GitHub.

## Fonte de dados (escolhe uma)

O gerador usa, por esta ordem, a primeira que tiver segredo: **TheStatsAPI** (`STATSAPI_KEY`), **football-data.org** (`FOOTBALLDATA_TOKEN`) ou **Sportmonks** (`SPORTMONKS_API_TOKEN`).

**TheStatsAPI:** chave enviada como `Authorization: Bearer`. Só vão para o site as ligas cujo nome contém um dos nomes de `STATS_COMPETITIONS` (por defeito: Premier League, Championship, Bundesliga, Serie A, Serie B, La Liga, Ligue 1, Eredivisie, Primeira Liga, Champions League, National League; `*` = todas). Máximo de `STATS_MAX_MATCHES` jogos por dia (40). Jogos com previsão já registada não gastam pedidos de histórico, e jogos terminados já guardados não repetem o pedido do intervalo. Isto mantém o consumo baixo face à quota mensal.

**football-data.org (recomendada):** plano grátis com 10 pedidos por minuto, sem limite diário. Faz 1 pedido por competição por execução (a época inteira), e inclui estas competições: Premier League, Championship, Bundesliga, Serie A, La Liga, Ligue 1, Eredivisie, Primeira Liga, Brasileirão Série A e Champions League. Não tem a National League inglesa nem a Serie B italiana.
1. Regista-te em https://www.football-data.org/client/register e copia o token que chega por email.
2. No GitHub, no mesmo sítio onde puseste a chave da Sportmonks (Settings > Secrets and variables > Actions, ou dentro do ambiente `SPORTMONKS_API_TOKEN`), cria o segredo `FOOTBALLDATA_TOKEN` com o token.
3. Corre o workflow (Actions > Atualizar previsões > Run workflow). No registo da execução aparece "Fonte de dados: football-data.org".
4. Se quiseres outras competições do teu plano, define a variável `FD_COMPETITIONS` (códigos separados por vírgula, por exemplo `PL,SA,PD`) no passo "Gerar previsões" do workflow. Competições que o plano não permite são ignoradas com um aviso.

Os dados de cada jogo passam a vir da fonte nova. Os dias já fechados que foram gerados com a Sportmonks ficam como estão.

## Como funciona

1. O workflow corre de 30 em 30 minutos com o segredo `SPORTMONKS_API_TOKEN`.
2. Para hoje e os 7 dias anteriores, calcula as previsões e grava os ficheiros em `previsoes/data/`.
3. **Uma previsão já registada nunca é recalculada.** Só se atualizam o resultado e os acertos. Por isso o separador "Anteriores" é um registo verdadeiro: as dicas marcadas "registada antes do jogo" foram guardadas antes do apito.
4. A página lê os ficheiros diretamente do repositório. Não precisa de servidor nem de chave.

## Configurar (uma vez)

1. No repositório, vai a **Settings > Secrets and variables > Actions > Repository secrets > New repository secret**.
   Nome: `SPORTMONKS_API_TOKEN`. Valor: a tua chave da Sportmonks.
   (Neste projeto o segredo está num *Environment* chamado `SPORTMONKS_API_TOKEN` e o workflow já declara `environment: SPORTMONKS_API_TOKEN`, por isso também funciona assim. Se o ambiente tiver revisores obrigatórios, cada execução fica à espera de aprovação.)
2. Vai a **Actions > Atualizar previsões > Run workflow** para correr a primeira vez. Depois corre sozinho.
3. Confirma que apareceram ficheiros em `previsoes/data/`.
4. Em **Settings > Actions > General > Workflow permissions**, confirma "Read and write permissions".

Para ver só o visual, abre a página com `?demo=1` no fim do endereço (dados fictícios).

## O que verificar no primeiro teste real

Escrevi a integração a partir da documentação da Sportmonks, mas só a testei com respostas simuladas.

- Que as ligas que queres (National League, Serie B) estão no teu plano. No plano grátis só entram 2 ligas.
- Que a API devolve `participants`, `scores` e `state`. Se algum nome for diferente, ajusta `goalsFrom` em `lib/engine.js`.
- Se o workflow falhar, abre o registo da execução em Actions: a mensagem de erro diz o que foi.

## Estatísticas dos jogos (xG) e "ambas marcam"

Com a TheStatsAPI, o modelo mistura o **xG da época** de cada equipa (golos esperados a favor e sofridos por jogo, 1 pedido por equipa, em cache 24 h em `data/xg-equipas.json`) com os golos recentes. O peso é `xgWeight` (0,5), reduzido quando há poucos jogos com xG; com menos de 4 jogos o xG é ignorado. O cartão mostra o xG usado.

O modelo exagerava "ambas marcam". A aprendizagem mede a diferença entre o previsto e o que aconteceu (teste z, ≥ 100 jogos) e aplica uma correção em logit (`bttsShift`) a toda a distribuição, por isso o construtor de aposta fica coerente.

Previsões de jogos que **ainda não começaram** são recalculadas quando o modelo muda (`REV` em `lib/engine.js`), mas ficam sempre congeladas a partir do apito.

## Escanteios e cartões

Com a TheStatsAPI, cada jogo por acontecer ganha mercados de **escanteios** (total, de cada equipa, quem tem mais) e de **cartões** (amarelos + vermelhos: total, de cada equipa, quem leva mais). O modelo usa os últimos jogos de cada equipa (precisa de pelo menos 3 com estatísticas) e uma distribuição binomial negativa, que varia mais do que a Poisson. Depois do jogo, os acertos são avaliados com os valores reais.

As estatísticas de cada jogo terminado custam 1 pedido e ficam em cache permanente em `data/stats-jogos.json`; por isso o gasto de pedidos é alto só nas primeiras execuções (`STATS_BUDGET`, 400 por execução) e depois baixo. O registo da execução mostra a quota mensal restante. Escanteios e cartões são tratados como independentes dos golos no construtor de aposta, o que é uma aproximação.

## Construtor de aposta

Em cada jogo por acontecer há o botão "Construtor de aposta". Escolhes seleções de vários mercados e o site calcula a probabilidade de acontecerem todas no mesmo jogo, com a mesma distribuição de golos do modelo (o site carrega `lib/engine.js` e recria-a a partir do xG guardado). Por isso respeita as ligações entre mercados, ao contrário de multiplicar probabilidades. Também sugere combinações por nível de risco (mais segura, equilibrada, mais arriscada), com quase todos os mercados (golos de cada equipa, vitória sem sofrer, margem, 1.ª parte…): só seleções que se reforçam entre si e sem redundâncias. A odd é "justa", não a da casa.

## Aprendizagem (fase 2)

`lib/learn.js` ajusta sozinho, a cada execução, os valores que antes eram fixos: vantagem de jogar em casa e fora, peso da forma recente, parte dos golos na 1.ª parte e média de golos (global e por liga). O resultado fica em `data/modelo.json` e o painel "Desempenho" mostra o estado.

Regras de segurança:
- só aprende com pelo menos 150 jogos terminados (`LEARN_MIN_GAMES` para mudar);
- cada valor é puxado para o valor por defeito quando há poucos dados e fica dentro de limites;
- validação: ajusta nos 70% de jogos mais antigos e testa nos 30% mais recentes. Os parâmetros só são adotados se previrem melhor do que os atuais, com ganho maior do que 2 erros-padrão (para não confundir sorte com melhoria);
- previsões já registadas nunca mudam: os parâmetros novos só valem para jogos novos. Cada previsão guarda `pv` (versão dos parâmetros) e `base` (forma bruta), que servem para o treino seguinte.

Não corrige tudo: só afina médias de golos. Se o modelo for otimista por causa de empates ou de golos que não são independentes, isso não se resolve aqui.

## Limites do modelo (para seres honesto com os utilizadores)

- É estatística simples: não sabe de lesões, suspensões, motivação, meteorologia nem treinadores.
- Os mercados da 1.ª parte e o HT/FT usam uma divisão fixa (45% dos golos na 1.ª parte), não a forma real de cada equipa. São os menos fiáveis.
- A "odd justa" é 1 / probabilidade do modelo. Só há valor se a casa pagar mais do que isso, e o modelo pode estar errado.
- Mostra sempre a taxa de acertos real, incluindo as falhas. Não prometas "100% certo".
