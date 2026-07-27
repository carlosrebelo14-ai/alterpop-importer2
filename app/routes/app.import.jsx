import { redirect } from "react-router";
import { authenticateAdmin } from "../utils/authenticate.server";

/** Rota legada — redireciona para o Dashboard (curadoria + sync em tempo real). */
export const loader = async ({ request }) => {
  await authenticateAdmin(request);
  return redirect("/app");
};

export default function LegacyImportRedirect() {
  return null;
}
