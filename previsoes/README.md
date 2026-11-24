# Previsões (automático)

Site de previsões de futebol que se atualiza sozinho.

- `index.html`: o site (separadores Hoje / Anteriores, estilo escuro).
- `api/previsoes.js`: função serverless da Vercel. Vai buscar jogos e resultados recentes à Sportmonks e calcula as previsões.
- `lib/engine.js`: o modelo (Poisson sobre golos recentes). Mercados: 1X2, mais/menos de 2,5, ambas marcam e dupla hipótese.
- `test/engine.test.js`: testes do modelo (`npm test`).

## Pôr online (Vercel)

1. Cria uma conta em https://my.sportmonks.com e copia o teu API token (o plano grátis dá 2 ligas).
2. Cria um projeto novo na Vercel com esta pasta.
3. Em Settings > Environment Variables, adiciona `SPORTMONKS_API_TOKEN` com o teu token.
4. Faz deploy. O token fica só no servidor, nunca vai para o telemóvel dos utilizadores.

Para ver o visual sem API, abre `index.html?demo=1` (dados fictícios).

## O que verificar no primeiro teste real

Escrevi a integração a partir da documentação da Sportmonks, mas não a consegui testar com a chave real, só com respostas simuladas. Confirma:

- Que as ligas que queres (National League, Serie B) estão no teu plano. No plano grátis só entram 2 ligas.
- Que `/fixtures/date/{data}` e `/fixtures/between/{inicio}/{fim}/{equipa}` devolvem os campos `participants`, `scores` e `state`. Se algum nome for diferente, o ajuste faz-se em `lib/engine.js` (função `goalsFrom`) e em `api/previsoes.js`.
- O consumo de pedidos: cada jogo gasta 2 pedidos extra (histórico das duas equipas). Há cache de 5 minutos.

## Limites do modelo (para seres honesto com os utilizadores)

- É estatística simples: não sabe de lesões, suspensões, motivação, meteorologia nem mudanças de treinador.
- Não prevê HT/FT: exige o resultado ao intervalo e é um mercado muito instável.
- A "odd justa" é 1 / probabilidade do modelo. Só há valor se a casa pagar mais do que isso, e o modelo pode estar errado.
- O separador Anteriores recalcula cada previsão só com jogos anteriores à partida. Mostra como o modelo teria ido, mas não são dicas publicadas antes do jogo. Se quiseres um registo verdadeiro, grava as previsões de Hoje numa base de dados (por exemplo Firebase) antes dos jogos começarem.
- Não prometas "100% certo" nem "VVIP garantido". Mostra a taxa de acertos real, incluindo as falhas.
