# Staging de scripts no Fly sem deploy

Procedimento para correr no Fly (`alterpop-importer-app`) um script novo ou uma
versão alterada de `lib/` **sem deploy e sem tocar nos ficheiros da app em execução**.
Usado pela primeira vez no briefing de 27/09/2026 (N5, N2).

Quem corre: o Carlos. O classificador do agente bloqueia escritas por shell remoto
(`sftp put`, `mkdir`/`cp` via `flyctl ssh console`). O developer prepara os comandos
e os tamanhos esperados; o Carlos corre e cola a saída.

## Quando usar

- Dry-run ou script só leitura que precisa da sessão OAuth offline e do SQLite de
  produção, antes de o código estar em `main`.
- `--execute` só depois do dry-run revisto e com OK explícito do Carlos no momento.

Para código que já está em `main`, o caminho é o deploy — e o único deploy é
`bash scripts/deploy.sh` (guardas de branch, working tree, `origin/main` e testes).
Nunca `flyctl deploy` à mão.

## Estrutura

```
/app/tmp-2709/            ← pasta de staging (nome livre; usar o do briefing)
├── lib/                  ← cópia de /app/lib, com os ficheiros alterados por cima
├── app -> /app/app       ← symlink: lib/session importa ../../app/db.server.js
└── scripts/catalog/      ← só os scripts a correr
```

Os imports relativos (`../../lib/...`) resolvem dentro da pasta de staging.
`node_modules` resolve para cima, até `/app/node_modules`. A app em execução
continua a usar `/app/lib`, que não se toca.

`app` é o único import de `lib/` que sai de `lib/`. Se isso mudar, o script falha
logo no arranque com `ERR_MODULE_NOT_FOUND`, antes de qualquer chamada à loja.
Nesse caso, acrescentar o symlink em falta.

## Passos

### 1. Criar a pasta

Apaga a anterior, copia `lib`, cria o symlink e apaga as cópias dos ficheiros que
vão ser substituídos. **O `sftp put` do flyctl não sobrescreve**: um ficheiro que
já existe fica como estava, com a mensagem `file exists on VM`.

```bash
flyctl ssh console -a alterpop-importer-app -C "sh -c 'rm -rf /app/tmp-2709 && mkdir -p /app/tmp-2709/scripts/catalog && cp -r /app/lib /app/tmp-2709/lib && ln -s /app/app /app/tmp-2709/app && rm /app/tmp-2709/lib/<caminho/ficheiro-alterado>.js && echo staged'"
```

Não correr `ln -s` uma segunda vez sobre um symlink que já existe: com um
destino que é diretório, o `ln` tenta criar o link *dentro* de `/app/app`.

### 2. Enviar os ficheiros

Correr a partir da raiz do repo local (os caminhos de origem são relativos).

```bash
printf 'put lib/<caminho>.js /app/tmp-2709/lib/<caminho>.js\nput scripts/catalog/<script>.js /app/tmp-2709/scripts/catalog/<script>.js\n' | flyctl ssh sftp shell -a alterpop-importer-app
```

Confirmar que cada linha diz `N bytes written` e que `N` bate com o `wc -c` local.
Uma linha `file exists on VM` quer dizer que esse ficheiro **não** foi enviado:
apagá-lo e repetir o envio.

### 3. Correr

```bash
flyctl ssh console -a alterpop-importer-app -C "sh -c 'cd /app && node tmp-2709/scripts/catalog/<script>.js'"
```

Dry-run por omissão. `--execute` só com OK do Carlos depois de ler o dry-run.

### 4. Limpar

```bash
flyctl ssh console -a alterpop-importer-app -C "rm -rf /app/tmp-2709"
```

Um deploy (`bash scripts/deploy.sh`) também limpa (a imagem nova não traz a pasta). Não deixar staging
esquecido entre briefings: a cópia de `lib/` fica desatualizada no deploy seguinte.

## Erros conhecidos

| Sintoma | Causa | Ação |
|---|---|---|
| `file exists on VM` no `put` | sftp não sobrescreve | `rm` do ficheiro no VM, repetir o `put` |
| `ERR_MODULE_NOT_FOUND .../tmp-2709/app/db.server.js` | Falta o symlink `app` | `ln -s /app/app /app/tmp-2709/app` (uma vez) |
| `Falha ao configurar PRAGMAs SQLite … Response from the Engine was empty` depois do `DONE` | Corrida entre a configuração assíncrona de PRAGMA do `prismaSafe` e o `$disconnect()` em scripts curtos | Inofensivo para a leitura. Correção em PR separado (dívida registada) |
| Aviso `flyctl agent … older than the current flyctl` | Versão do agente local | Inofensivo; o agente reinicia sozinho |
