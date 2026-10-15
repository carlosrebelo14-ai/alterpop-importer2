/* eslint-env node */
/**
 * Apoio dos testes estáticos. Devolve o código sem comentários de linha e de bloco.
 *
 * Preserva as strings (um `//` dentro de "https://..." não é comentário) e as quebras de linha,
 * para que os números de linha e as posições continuem a bater certo com o ficheiro original.
 * Não trata literais de expressão regular. Os ficheiros que o usam não têm barras com aspas.
 *
 * @param {string} texto
 * @returns {string}
 */
export function semComentarios(texto) {
  let saida = "";
  let i = 0;
  let estado = "codigo"; // codigo | linha | bloco | aspas | apostrofo | modelo

  while (i < texto.length) {
    const c = texto[i];
    const p = texto[i + 1];

    if (estado === "codigo") {
      if (c === "/" && p === "/") {
        estado = "linha";
        saida += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && p === "*") {
        estado = "bloco";
        saida += "  ";
        i += 2;
        continue;
      }
      if (c === '"') estado = "aspas";
      else if (c === "'") estado = "apostrofo";
      else if (c === "`") estado = "modelo";
      saida += c;
      i += 1;
      continue;
    }

    if (estado === "linha") {
      if (c === "\n") {
        estado = "codigo";
        saida += c;
      } else {
        saida += " ";
      }
      i += 1;
      continue;
    }

    if (estado === "bloco") {
      if (c === "*" && p === "/") {
        estado = "codigo";
        saida += "  ";
        i += 2;
        continue;
      }
      saida += c === "\n" ? c : " ";
      i += 1;
      continue;
    }

    // Dentro de uma string: copia tal como está, incluindo o carácter escapado.
    saida += c;
    if (c === "\\") {
      saida += p ?? "";
      i += 2;
      continue;
    }
    if ((estado === "aspas" && c === '"') || (estado === "apostrofo" && c === "'") || (estado === "modelo" && c === "`")) {
      estado = "codigo";
    }
    i += 1;
  }

  return saida;
}

/**
 * Posição do carácter de fecho que corresponde ao `abertura` em `abre`. Usa-se sobre código já sem
 * comentários. Strings com parênteses ou chavetas desequilibradas não são tratadas.
 * @param {string} texto
 * @param {number} abre posição do carácter de abertura
 * @param {string} abertura
 * @param {string} fechamento
 * @returns {number}
 */
export function fecho(texto, abre, abertura, fechamento) {
  let profundidade = 0;
  for (let i = abre; i < texto.length; i += 1) {
    if (texto[i] === abertura) profundidade += 1;
    else if (texto[i] === fechamento) {
      profundidade -= 1;
      if (profundidade === 0) return i;
    }
  }
  throw new Error(`${abertura} sem ${fechamento} correspondente`);
}
