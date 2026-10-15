import fsSync from "fs";
import path from "path";

/**
 * Diretório de estado da fila de curadoria e dos marcadores de atividade.
 *
 * Estava em `process.cwd()/server/data`, que no container é filesystem EFÉMERO: cada
 * deploy recria a imagem e apagava o ficheiro com todas as decisões de aprovação e
 * rejeição. A 2026-08-05 confirmou-se que o ficheiro nem sequer existia em produção,
 * depois de 5 deploys no mesmo dia. Todo o resto do estado (SQLite, sessões, settings)
 * já vivia em /app/data, o volume persistente — esta era a única exceção.
 *
 * Resolução por ordem:
 *   1. CURATION_DATA_DIR, se definido (escape hatch para testes e ambientes especiais)
 *   2. /app/data, quando existe — é o volume montado dentro do container
 *   3. server/data local, para desenvolvimento fora do container (comportamento antigo)
 *
 * Vive num módulo sem dependências para que scripts, rotas e o worker a partilhem.
 */
export function resolveCurationDataDir() {
  const override = process.env.CURATION_DATA_DIR?.trim();
  if (override) return override;
  const volumeDir = "/app/data";
  try {
    if (fsSync.statSync(volumeDir).isDirectory()) return volumeDir;
  } catch {
    /* fora do container — segue para o fallback local */
  }
  return path.join(process.cwd(), "server", "data");
}
