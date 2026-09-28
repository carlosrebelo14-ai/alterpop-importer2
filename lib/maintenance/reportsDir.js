/**
 * Pasta dos relatórios gerados por scripts para leitura humana (auditorias, exports,
 * HTML de revisão) — decisão 28/09/2026. Fica no .gitignore: nunca é commitada e nunca
 * deixa o working tree sujo (a guarda 2 de scripts/deploy.sh recusa deploy com
 * ficheiros por seguir).
 *
 * Resolvida a partir deste ficheiro, não de process.cwd(): o script escreve no mesmo
 * sítio qualquer que seja a pasta de onde corre. No Fly fica em /app/reports (efémero,
 * como results/ — descarregar com `flyctl ssh sftp get` antes do deploy seguinte).
 *
 * Fica de fora, de propósito: results/errors.json (convenção de erros do AGENTS.md),
 * saídas de jobs em results/, e o estado de runtime em data/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPORTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "reports");

/** Caminho de um relatório em reports/, criando a pasta (e subpastas) se faltar. */
export function reportPath(...segments) {
  const file = path.join(REPORTS_DIR, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}
