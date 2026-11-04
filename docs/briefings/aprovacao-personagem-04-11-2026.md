# Aprovação por personagem — 04/11/2026

Passa a APPROVED os produtos PENDING cujo título tem um personagem da lista fechada. Não publica. Não mexe na margem.

## Ficheiros

| Ficheiro | Papel |
|---|---|
| `scripts/catalog/character-approve-2026-11-04.json` | Lista fechada, 27 âmbitos (26 universos + linha The Mandalorian), P1 e P2, aliases do briefing, 9 nomes A+B, 27 nomes de risco |
| `lib/importer/catalog/characterApproval.js` | Seleção, resumo, escrita e reversão (puro) |
| `scripts/catalog/character-approve.js` | Dry-run e `--execute` |
| `scripts/catalog/character-approve-revert.js` | Reversão pela origem |
| `scripts/tests/character-approve.test.js` | Teste (entra em `test:franchise`) |

## Correr

Dry-run na Fly, só leitura: Actions → fly-ops → `approve-dry`. Ou à mão.

```bash
node scripts/catalog/character-approve.js
```

CSV e resumo ficam em `reports/character-approve/` na máquina. O log só leva contagens, nomes e títulos. Os custos ficam no CSV.

Execute, só com OK do arquiteto. N é o total do dry-run. Se a seleção mudou entretanto, para sem escrever.

```bash
node scripts/catalog/character-approve.js --execute --confirm-count N
```

Reversão. Dry-run em fly-ops `revert-dry`, execute à mão.

```bash
node scripts/catalog/character-approve-revert.js --execute --confirm-count N
```

## Regras implementadas

- Título `cleanTitle`, fallback `title`. Palavra inteira, sem maiúsculas nem acentos, após NFC. Hífen e pontuação valem espaço.
- Universo pela `resolvedFranchise`. "×" e "x" são iguais. The Mandalorian exige só Star Wars. Star Wars deixa de excluir a Line.
- Órfãos (`resolvedFranchise` vazio) só para os 9 nomes da passagem B.
- Ordem dos motivos de exclusão: universo errado → estado → custo → âmbito.
- Só PENDING. REJECTED, fora da fila, APPROVED, PUBLISHED e SYNC_ERROR contados à parte.
- Custo bruto = `distributorPrice` (precio_distribuidores), exige > 5,00 €.
- Stock não filtra.
- Âmbito = fabricante COLLECTOR/CORE (decisão 15/09) ou Loungefly. Loungefly deteta-se por vendor, `resolvedFormat` ou prefixo de `originalTitle` (fallback `title`).
- Um SKU conta uma vez nos totais. A contagem por personagem conta o SKU em cada nome que bate. Franquia e P1/P2 vêm do nome de maior prioridade.

## Decisões a confirmar pelo arquiteto

1. **Marca de origem.** `metadata.origem` fica `"humano"`, porque é o valor que congela a decisão contra o worker e as regras de painel. A origem desta corrida vai em `metadata.importOrigin = "character-import-2026-11-04"`, com o estado anterior em `metadata.importPrevious`. O revert lê estes dois campos.
2. **PENDING apagado no admin** (`deletedInAdmin`) fica de fora e é contado. Regra de 09/10, só a aprovação do Carlos o tira de PENDING.
3. **Marca (brand).** O `CatalogProduct` não tem coluna de marca. A deteção Loungefly usa vendor, formato e título.
4. **Órfãos da passagem B entram no execute.** Publicam sem `alterpop.franchise`. A contagem vem à parte no dry-run.
5. **Aliases do vocabulário B7** juntam-se aos do briefing quando o nome é igual (ex.: Spider-Man ganha "Peter Parker"). Mesma regra de 09/10.
