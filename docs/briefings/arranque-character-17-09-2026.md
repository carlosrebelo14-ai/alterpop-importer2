# ARRANQUE — B7 CHARACTER

Texto de abertura para um chat novo de developer. App `alterpop-importer2`. Emitido 17/09/2026 pelo arquiteto da app.

---

## 1. Contexto

| Item | Valor |
|---|---|
| App | `alterpop-importer2`, sincroniza a loja Shopify com o feed do OcioStock |
| Loja | `jyr17t-wr.myshopify.com`, plano Basic, só em inglês |
| Produção | Fly, app `alterpop-importer-app`, SQLite em `/app/data/dev.sqlite` |
| Sessão Shopify | `FileSessionStorage`. Scripts carregam a sessão com `loadOfflineSessionForShop`. A tabela Prisma `Session` está vazia e não serve |
| Comandos em produção | O Carlos corre `flyctl deploy` e `flyctl ssh console` no terminal dele. O developer prepara o comando e espera pelo resultado |
| Schema | Alterações com `npm run db:push` manual via `fly ssh console`. Nunca no arranque do contentor |
| Documentos do projeto | `claude/briefing-backend-17-09-2026.md` (com as adendas), `claude/resposta-app-briefing-16-09-2026.md`, `claude/briefing-frontend-16-09-2026.md` |

## 2. Regras de trabalho

- Um passo de cada vez. Nos pontos marcados PARAR, reportar e esperar.
- Scripts com escrita correm em dry-run por omissão. A escrita exige `--execute`.
- Qualquer script de lote reporta linhas processadas e total, e sai com erro se não baterem.
- Escrita na loja só com `metafieldsSet` e mutações de metaobject. Nunca `productUpdate`.
- A aprovação do Carlos no painel é a decisão final. Nada falha em silêncio.
- Um campo de override do Carlos manda sobre o feed em tudo o que vem depois.
- Sem AI no fluxo de catálogo.
- Só uma sessão de developer no repo de cada vez. Confirmar com `git log` que não há commits alheios antes de começar.
- Cada defeito encontrado vira uma verificação com teste, e nunca uma correção manual solta.

## 3. Estado de partida

### Definições na loja, verificadas a 17/09

| Peça | GID |
|---|---|
| Metaobject `character` | `gid://shopify/MetaobjectDefinition/47579070794` |
| `alterpop.character` (produto) | `gid://shopify/MetafieldDefinition/1532722643274` |
| `alterpop.characters` (coleção) | `gid://shopify/MetafieldDefinition/1532722676042` |

`metaobjectsCount` = 0. Os scopes de metaobjects estão aprovados e ativos.

### Contrato

| Campo do metaobject | Tipo | Obrigatório | Validação |
|---|---|---|---|
| `title` | `single_line_text_field` | Sim | — |
| `image` | `file_reference` | Não | `file_type_options` = Image |
| `universe` | `list.collection_reference` | Sim | — |
| `products` | `list.product_reference` | Sim | `list.max` = 128 |

```
displayNameKey              title
access.storefront           PUBLIC_READ
capabilities.publishable    enabled
capabilities.onlineStore    enabled, urlHandle "characters", redirects ativos
metafields produto/coleção  list.metaobject_reference, metaobject_definition_id = 47579070794
```

### Loja live a 17/09

| Métrica | Valor |
|---|---|
| Produtos ACTIVE | 65 |
| One Piece | 44, dos quais 43 com Luffy |
| Star Wars | 15, dos quais 13 com Luke Skywalker |
| Auditoria live | 0 avisos. Os dois Luke com título igual estão em `acceptedWarnings` |

## 4. Vocabulário

O vocabulário está fechado e vive no repo, nos PRs #71, #73 e #75.

| Estado | Regra |
|---|---|
| Passagem A e B | 10 nomes aprovados (Joker, Harley Quinn, Catwoman, Captain America, Hulk, Venom, Thor, Wolverine, Supergirl, Goofy) |
| Passagem A apenas | Todos os outros nomes do vocabulário |
| Fora | Menos de 3 produtos dentro do universo, nome ambíguo, ou duplicado da sala (Harry, Batman, Superman, Sonic, Mario, Naruto, Wednesday, Stitch, Zelda). Spider-Man fica |

- A tabela de veredictos do ficheiro do censo está desatualizada. Não reconstruir a partir dela.
- Character significa sujeito nomeado que o coleccionador procura (pessoa, criatura, mecha ou objeto).
- Os handles usam a forma canónica curta (`luffy`, nunca `monkey-d-luffy`).
- Um nome só conta dentro do universo esperado. "Robin" só conta em produtos Batman.

## 5. `characterResolver.server.js`

| Item | Spec |
|---|---|
| Tipo | Função pura |
| Entrada | `titleOverride ?? originalTitle`, e `resolvedFranchise` |
| Passagem A | Nome ou alias com fronteira de palavra, sem maiúsculas, em NFC, só se `resolvedFranchise` for o universo do nome |
| Passagem B | Fora deste trabalho. Nenhum dos 10 nomes é de One Piece ou Star Wars |
| Vários nomes | Lista de handles. "Luke Skywalker & Grogu" dá `[luke-skywalker, grogu]` |
| Campo Prisma | `resolvedCharacters`, lista de handles, nullable |
| Payload | `buildPublishPayload` passa a incluir os Characters |

### Testes obrigatórios

| Caso | Esperado |
|---|---|
| "Star Wars Luke Skywalker & Grogu" | `[luke-skywalker, grogu]` |
| "One Piece Monkey.D.Luffy Grandline Series" | `[luffy]` |
| "One Piece Dioramatic The Anime D Luffy Monkey" | `[luffy]` |
| Título com "Robin" fora de Batman | Sem `robin` |
| `originalTitle` com Luke e `titleOverride` sem Luke | Sem `luke-skywalker` |
| Nome da lista dos epónimos | Nunca aparece |

## 6. `characterPages.server.js`

### Limiar

Um Character tem metaobject `ACTIVE` quando tem 3 ou mais produtos ACTIVE publicados no Online Store. O catálogo Prisma não conta.

### Ciclo de vida

| Evento | Ação |
|---|---|
| Chega a 3 | Cria ou reativa o metaobject em `ACTIVE`. Escreve `title`, `universe` e `products`. Escreve `alterpop.character` nos produtos. Atualiza `alterpop.characters` das coleções do universo |
| Produto novo num Character ativo | Acrescenta a `products` e escreve a referência no produto |
| Desce abaixo de 3 | Metaobject em `DRAFT`, nunca apagado. `products` mantém a última lista. Referências removidas dos produtos. Sai de `alterpop.characters` |
| Volta a 3 | Reativa o mesmo metaobject com o mesmo handle |
| Mais de 128 produtos | Erro visível. Nunca truncar |

### Regras de escrita

| Regra | Spec |
|---|---|
| `alterpop.character` no produto | Aponta só para Characters `ACTIVE` |
| `alterpop.characters` na coleção | Characters `ACTIVE` do universo, do maior para o menor número de produtos |
| `universe` | GIDs das coleções Universe, a partir do handle em `franchiseUniverses.js` |
| `image` | Não escrever. É conteúdo do Carlos |

### V12

Para cada Character `ACTIVE`, o conjunto em `products` é igual ao conjunto de produtos cujo `alterpop.character` o contém. Qualquer diferença deixa o V12 a vermelho.

## 7. Piloto

### Esperado sobre os 65 live

| Handle | Produtos | Resultado |
|---|---|---|
| `luffy` | 43 | Metaobject `ACTIVE` |
| `luke-skywalker` | 13 | Metaobject `ACTIVE` |
| Todos os outros | Menos de 3 | Sem metaobject |

- Os dois packs "Luke Skywalker & Grogu" apontam só para `luke-skywalker`.
- `din-djarin` pode aparecer com 1 produto pelo alias "The Mandalorian". Fica abaixo do limiar. Reportar na mesma.
- Qualquer outro nome com 3 ou mais produtos obriga a parar e reportar a lista de títulos.
- Luffy ocupa 98% da sala One Piece e Luke ocupa 87% da sala Star Wars. Aceite para o piloto.

## 8. Ordem

1. Ler os documentos da secção 1. Localizar o ficheiro do vocabulário. Confirmar que `luffy` e `luke-skywalker` existem, e em que estado. **PARAR e reportar.**
2. `characterResolver.server.js` com os testes da secção 5.
3. `resolvedCharacters` no schema e `db:push`. Backfill Prisma em dry-run. Reportar a distribuição no catálogo e nos 65 live. **PARAR.**
4. Backfill `--execute`.
5. `characterPages.server.js` e script `character-pages-sync.js` em dry-run sobre a loja. Reportar as ações previstas. **PARAR à espera do OK do Carlos.**
6. `--execute`. Reportar handle, GID, status, `system.url` real, número de produtos e referências escritas.
7. V12 no portão de saúde.
8. Aviso ao frontend de que os dados existem. Verificação do tema na secção 9.
9. `character-pages-sync` no ciclo do `trigger-sync`, com travão igual ao do reconciliador (até 10 Characters alterados por ciclo, acima disso não escreve e fica vermelho).
10. **PARAR.** Os restantes universos passam a ser tratados pelo ciclo à medida que o Carlos publica.

## 9. Verificação com o tema

| Degrau | Prova |
|---|---|
| 1 | As três definições existem e `metaobjectsCount` = 2 |
| 2 | Os dois metaobjects estão `ACTIVE` e `/pages/characters/<handle>` responde 200 |
| 3 | `/collections/one-piece` e `/collections/star-wars` mostram Shop by Character, com um círculo cada, a 375 e 1280 px |
| 4 | A PDP de um produto Luffy mostra o nome acima do título. O Chopper não mostra nada |

Notas para o tema:

- A contagem "N pieces" usa `metaobject.products.value.count` (em listas de referências o `.size` não serve).
- O `system.url` real confirma o caminho.

## 10. Pendentes fora deste chat

| Item | Onde |
|---|---|
| Avisos no painel e P6 (títulos repetidos contra a loja e o lote) | Briefing de 17/09, ADENDA 9 |
| V13 com o primeiro ciclo real | Briefing de 17/09, ADENDA 9 |
| Colisão Din Djarin / Line The Mandalorian | Aberto. Volta quando Star Wars tiver produtos Mandalorian live |
| Imagens dos Characters | Conteúdo do Carlos |

Estes pendentes não correm em paralelo com este chat. Uma sessão de cada vez.

---

# ADENDA 1 — 17/09/2026, vocabulário em falta no repo

O developer não encontrou no ficheiro do vocabulário os 15 nomes do piloto de 14/09 (Star Wars, Dragon Ball, Batman). O PR #73 juntou os 31 universos restantes. Os 15 nomes do piloto foram medidos no PR #71 e nunca chegaram ao ficheiro.

## Decisão

Opção 2. O developer acrescenta os 15 nomes ao `characterVocabulary.js` antes de tocar no resolver.

| Universo | Nome | Handle | Estado |
|---|---|---|---|
| Star Wars | Darth Vader | `darth-vader` | Passagem A |
| Star Wars | Luke Skywalker | `luke-skywalker` | Passagem A |
| Star Wars | Ahsoka Tano | `ahsoka-tano` | Passagem A |
| Star Wars | Grogu | `grogu` | Passagem A |
| Star Wars | Din Djarin | `din-djarin` | Passagem A, sem o alias "The Mandalorian" |
| Dragon Ball | Goku | `goku` | Passagem A |
| Dragon Ball | Vegeta | `vegeta` | Passagem A |
| Dragon Ball | Gohan | `gohan` | Passagem A |
| Dragon Ball | Frieza | `frieza` | Passagem A |
| Dragon Ball | Piccolo | `piccolo` | Passagem A |
| Batman | Batman | — | Fora, duplica a sala (PR #75, 93,7%) |
| Batman | Joker | `joker` | Passagem A e B |
| Batman | Harley Quinn | `harley-quinn` | Passagem A e B |
| Batman | Catwoman | `catwoman` | Passagem A e B |
| Batman | Robin | `robin` | Passagem A. Só conta em produtos Batman |

## Regras de entrada

- O nome do universo tem de ser exatamente o de `FRANCHISE_UNIVERSES`. Um nome que não bata faz o teste falhar.
- Os aliases vêm do script de medição do PR #71, copiados tal como estão. A exceção é "The Mandalorian" no Din Djarin.
- A passagem B dos três nomes Batman fica registada no vocabulário e não corre neste trabalho.
- Um teste confirma que os 10 nomes com passagem B existem no vocabulário.

## Din Djarin — colisão resolvida

O alias "The Mandalorian" é também o nome da Line e da série, e apanha merch da linha inteira (153 produtos medidos no PR #71). Sai do vocabulário. Ficam "Din Djarin" e "Mando".

As figuras cuja caixa só diz "The Mandalorian" deixam de entrar. Mede-se de novo quando houver produtos Mandalorian live.

## Ordem

1. Acrescentar os 15 nomes com os testes. Reportar a contagem final do vocabulário e os aliases copiados do PR #71. **PARAR.**
2. Seguir a ordem da secção 8 a partir do passo 2.

## Correção — Batman entra

Decisão do Carlos de 17/09: Batman entra como Character, contra a régua dos epónimos.

| Item | Spec |
|---|---|
| Handle | `batman` |
| Estado | Passagem A, só em produtos do universo Batman |
| Exceção | Lista `EPONYM_OVERRIDES` no vocabulário, com `batman` e a data da decisão. A régua continua a valer para os outros 8 nomes |
| Teste | `batman` entra no vocabulário. Harry, Superman, Sonic, Mario, Naruto, Wednesday, Stitch e Zelda continuam fora |
| Efeito conhecido | No catálogo, a página do Batman cobre 93,7% da sala Batman |

---

# ADENDA 2 — 17/09/2026, vocabulário fechado

## Aceite

| Item | Estado |
|---|---|
| Universos no vocabulário | 34 (31 + Star Wars, Dragon Ball, Batman) |
| Nomes novos | 15 |
| Aliases do PR #71 | Ahsoka Tano → Ahsoka. Grogu → Baby Yoda, The Child. Frieza → Freezer. Din Djarin → Mando |
| `EPONYM_OVERRIDES` | Batman, 2026-09-17 |
| `PASSAGEM_B_NAMES` | 10 nomes |
| Testes | 7 verdes |

## Notas

- Os documentos do projeto vivem no claude.ai e não no repo. Este arranque é a fonte. Uma cópia passa a viver em `docs/briefings/arranque-character-17-09-2026.md` no repo.
- Os 5 universos dormentes ficam fora do vocabulário, por desenho.

## Ordem

1. Commit do vocabulário e dos testes, com a cópia do arranque em `docs/briefings/`.
2. Passo 2 da secção 8, `characterResolver.server.js` com os testes da secção 5.
3. Passo 3, até ao PARAR.
