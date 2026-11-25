# Previsões (automático, no GitHub)

Previsões de futebol que se atualizam sozinhas, sem servidor.

- `index.html`: o site (separadores Hoje / Anteriores, estilo escuro). Lê os dados de `data/`.
- `data/AAAA-MM-DD.json`: previsões de cada dia. São geradas e guardadas automaticamente.
- `scripts/gerar.js`: gera os ficheiros de `data/` com os dados da Sportmonks.
- `lib/engine.js`: o modelo (Poisson sobre golos recentes, em duas partes). Calcula cerca de 70 probabilidades por jogo: 1X2, dupla hipótese, empate anula aposta, total de golos (0,5 a 4,5), golos de cada equipa, ambas marcam, vitória sem sofrer, margem de vitória, número exato de golos, par/ímpar, resultados exatos mais prováveis, 1.ª parte, parte com mais golos e HT/FT. Todas saem da mesma distribuição, por isso são coerentes entre si.
- `lib/day.js`: pede à Sportmonks os jogos do dia e o histórico das equipas.
- `.github/workflows/previsoes.yml` (na raiz do repositório): corre o gerador de 30 em 30 minutos.
- `api/previsoes.js`: opcional, só se quiseres usar a Vercel em vez do GitHub.

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

## Limites do modelo (para seres honesto com os utilizadores)

- É estatística simples: não sabe de lesões, suspensões, motivação, meteorologia nem treinadores.
- Os mercados da 1.ª parte e o HT/FT usam uma divisão fixa (45% dos golos na 1.ª parte), não a forma real de cada equipa. São os menos fiáveis.
- A "odd justa" é 1 / probabilidade do modelo. Só há valor se a casa pagar mais do que isso, e o modelo pode estar errado.
- Mostra sempre a taxa de acertos real, incluindo as falhas. Não prometas "100% certo".
