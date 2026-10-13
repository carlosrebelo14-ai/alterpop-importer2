# V18 — manifesto da limpeza de tags (dry-run de 13/10/2026)

Resultado do dry-run de `scripts/catalog/tags-cleanup.js`, calculado a partir da leitura da loja (só leitura). Nada foi escrito.

- Âmbito: produtos ACTIVE (57 produtos), tags fora de `ALLOWED_PRODUCT_TAGS = ["alterpop"]`.
- Total: 179 remoções de tag.

| Tag | Produtos |
|---|---|
| new-arrival | 57 |
| Action Figures | 40 |
| Figures & Statues | 40 |
| Funko | 40 |
| Lifestyle & Replicas | 1 |
| Loungefly | 1 |

## Reversão

A execução usa só `tagsRemove`. Para repor um produto, `tagsAdd` com o `id` e as tags da linha correspondente (`gid://shopify/Product/<id>`). Este ficheiro é o registo do estado anterior.

## Lista

| SKU | Handle | Product ID | Tags removidas |
|---|---|---|---|
| 8435450233067 | the-lord-of-the-rings-gandalf-legolas-set-2-pokis-figures | 16092920316234 | new-arrival |
| 8435450255779 | the-lord-of-the-rings-gandalf-en-moria-18cm | 16092920480074 | new-arrival |
| 889698135504 | the-lord-of-the-rings-gandalf | 16092920971594 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698837842 | the-lord-of-the-rings-gandalf-with-doors-of-durin | 16092921102666 | Action Figures, Figures & Statues, Funko, new-arrival |
| 830395023007 | pop-star-wars-darth-vader | 16096171393354 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698338844 | star-wars-holiday-darth-vader | 16096171622730 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698643368 | star-wars-holiday-darth-vader-1 | 16096171884874 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698675345 | star-wars-darth-vader | 16096172015946 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698707435 | star-wars-40th-darth-vader-vs-luke-skywalker | 16096172212554 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698707503 | star-wars-40th-darth-vader | 16096172409162 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698799188 | super-star-wars-darth-vader | 16096172540234 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698807678 | star-wars-darth-vader-on-throne | 16096172736842 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698808767 | comic-covers-star-wars-darth-vader | 16096172900682 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698835947 | pop-pack-2-figures-star-wars-darth-vader-luke-skywalker | 16096173031754 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698864541 | sfx-star-wars-darth-vader | 16096173195594 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698931281 | star-wars-darth-vader-unarmored | 16096173359434 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698934008 | star-wars-darth-vader-lightsaber | 16096173556042 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698338844 C6 | star-wars-holiday-darth-vader-5-1-chase | 16096173752650 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698561082 | star-wars-bounty-hunter-darth-vader-exclusive | 16096174113098 | Action Figures, Figures & Statues, Funko, new-arrival |
| 5010994187637 | star-wars-obi-wan-kenobi-darth-vader-electronic-helmet | 16096174473546 | new-arrival |
| 5010996137067 | star-wars-revenge-of-the-jedi-darth-vader-figure-15cm | 16096174801226 | new-arrival |
| 671803364165 | loungefly-star-wars-dark-side-darth-vader-backpack-26cm | 16096175096138 | Lifestyle & Replicas, Loungefly, new-arrival |
| 5060525894862 | star-wars-darth-vader-a-new-hope-figure-clamping-bracket-cable-guy-20cm | 16096175227210 | new-arrival |
| 8435747802136 | star-wars-darth-vader-manual-umbrella | 16096175456586 | new-arrival |
| 8445484398762 | star-wars-darth-vader-casual-backpack | 16096175653194 | new-arrival |
| 889698467636 | star-wars-darth-vader-in-meditation-chamber | 16096175817034 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698807692 | star-wars-darth-vader-with-tie-advanced-starfighter | 16096175980874 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698675369 | star-wars-luke-skywalker | 16096179781962 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698707497 | star-wars-40th-luke-skywalker | 16096179945802 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698837965 | star-wars-luke-skywalker-red-5 | 16096180076874 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698837972 | star-wars-luke-skywalker-1 | 16096180273482 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698908740 | star-wars-luke-skywalker-legends | 16096180470090 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698712835 | star-wars-luke-skywalker-exclusive | 16096180633930 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698837989 | star-wars-luke-skywalker-with-remote | 16096180765002 | Action Figures, Figures & Statues, Funko, new-arrival |
| 5010996154996 | star-wars-the-book-of-boba-fett-luke-skywalker-grogu-figure-15cm | 16096180928842 | new-arrival |
| 889698686525 | star-wars-the-book-of-boba-fett-2-luke-skywalker-grogu | 16096181158218 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698744041 | star-wars-luke-skywalker-in-t-47-airspeeder-exclusive | 16096181322058 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698338851 | star-wars-holiday-santa-yoda | 16096183812426 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698903752 | nooks-star-wars-yoda-in-his-hut | 16096184009034 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698487405 | star-wars-mandalorian-yoda-the-child | 16096184172874 | Action Figures, Figures & Statues, Funko, new-arrival |
| 5055964757588 | star-wars-yoda-the-child-icons-lamp-12cm | 16096184369482 | new-arrival |
| 5400868008784 | star-wars-the-mandalorian-the-child-baby-yoda-plush-toy-25cm | 16096184566090 | new-arrival |
| 5055964757328 | star-wars-the-mandalorian-yoda-the-child-3d-light | 16096184762698 | new-arrival |
| 889698497572 | star-wars-mandalorian-yoda-the-child-25cm | 16096185221450 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698499316 | star-wars-mandalorian-with-yoda-child-25cm | 16096185680202 | Action Figures, Figures & Statues, Funko, new-arrival |
| 5010996197276 | star-wars-forze-fx-yoda-lightsaber-replica | 16096185942346 | new-arrival |
| 5010996299291 | star-wars-obi-wan-kenobi-clone-trooper-figure-9-5cm | 16096363938122 | new-arrival |
| 889698675871 | star-wars-obi-wan-kenobi-2-purge-trooper | 16096364167498 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698675888 | star-wars-obi-wan-kenobi-2-grand-inquisitor | 16096364331338 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698760188 | star-wars-obi-wan-kenobi | 16096364560714 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698649018 | star-wars-obi-wan-kenobi-darth-vader-exclusive | 16096364757322 | Action Figures, Figures & Statues, Funko, new-arrival |
| 5010996109262 | star-wars-obi-wan-kenobi-bounty-collection-lola-figures-6cm | 16096364953930 | new-arrival |
| 5010996176950 | star-wars-obi-wan-kenobi-qui-gon-jinn-figure-15cm | 16096365150538 | new-arrival |
| 5010996184238 | star-wars-obi-wan-kenobi-grand-inquisitor-figure-9cm | 16096365314378 | new-arrival |
| 889698675864 | star-wars-obi-wan-kenobi-2-ned-b | 16096365478218 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698317962 | star-wars-clone-wars-obi-wan-kenobi | 16096366788938 | Action Figures, Figures & Statues, Funko, new-arrival |
| 889698739405 | star-wars-jabba-skiff-han-solo-exclusive | 16096370426186 | Action Figures, Figures & Statues, Funko, new-arrival |
