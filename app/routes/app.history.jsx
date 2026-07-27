import { redirect } from "react-router";
import { authenticateAdmin } from "../utils/authenticate.server";

/** Rota legada — auditoria no separador «Logs de Erro» do Dashboard. */
export const loader = async ({ request }) => {
  await authenticateAdmin(request);
  return redirect("/app");
};

export default function LegacyHistoryRedirect() {
  return null;
}
