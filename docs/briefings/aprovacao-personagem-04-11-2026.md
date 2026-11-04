# Aprovação por personagem — 04/11/2026

Passa a APPROVED os produtos PENDING cujo título tem um personagem da lista fechada. Não publica. Não mexe na margem.

## Ficheiros

| Ficheiro | Papel |
|---|---|
| `scripts/catalog/character-import-2026-10-09.json` | Fonte. A lista de 09/10 é a lista de hoje (revisão do arquiteto, 04/11). Não muda |
| `lib/importer/catalog/characterApproval.js` | Aliases do briefing, nomes de risco, origem, seleção, resumo, escrita e reversão (puro) |
| `scripts/catalog/character-approve.js` | Dry-run e `--execute` |
| `scripts/catalog/character-approve-revert.js` | Reversão pela origem |
| `scripts/tests/character-approve.test.js` | Teste (entra em `test:franchise`) |

## Correr

Dry-run na Fly, só leitura. Actions → fly-ops → `approve-dry`, a partir de `main`.

Saídas em `reports/character-approve/` na máquina (`reports/` está no `.gitignore`):

- `candidates-character-import-2026-11-04.csv`, os candidatos;
- `candidates-character-import-2026-11-04-orfaos.csv`, os órfãos fora do execute;
- `candidates-character-import-2026-11-04.summary.md`, o resumo.

O log das Actions é público. Leva só contagens, nomes, SKUs e títulos. Os custos ficam nos CSV.

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
- Ordem dos motivos de exclusão é universo errado → órfão → estado → custo → âmbito.
- Só PENDING. REJECTED, fora da fila, APPROVED, PUBLISHED e SYNC_ERROR contados à parte.
- Custo bruto = `distributorPrice` (precio_distribuidores), exige > 5,00 €.
- Stock não filtra.
- Âmbito = fabricante COLLECTOR/CORE (decisão 15/09) ou Loungefly. Loungefly deteta-se por vendor, `resolvedFormat` ou prefixo de `originalTitle` (fallback `title`).
- Um SKU conta uma vez nos totais. A contagem por personagem conta o SKU em cada nome que bate. Franquia e P1/P2 vêm do nome de maior prioridade.

## Decisões do arquiteto (04/11)

1. **Origem.** Aceite. `metadata.origem` fica `"humano"`. A corrida grava `metadata.importOrigin = "character-import-2026-11-04"` e o estado anterior em `metadata.importPrevious`. O revert lê os dois.
2. **PENDING apagados no admin.** Entram como qualquer candidato, no dry-run e no execute. A marca `deletedInAdmin` fica. O relatório conta-os numa linha própria.
3. **Loungefly.** Aceite. O `CatalogProduct` não tem coluna de marca.
4. **Órfãos.** Nada grava `resolvedFranchise` pela via do personagem. O B7 só aplica a passagem A (`characterResolver.server.js`), e o `franchiseResolver` não tem camada de personagem. Os órfãos dos 9 nomes saem do execute e ficam no CSV de órfãos, com a franquia do personagem e se passariam os outros filtros. O execute recusa qualquer candidato sem `resolvedFranchise`.
5. **Aliases do B7.** Aceite. O dry-run lista cada alias do B7 que não está na lista nem no briefing, com correspondências no universo, candidatos e candidatos que só entram por esse alias.
