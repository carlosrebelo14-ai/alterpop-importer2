import { redirect } from "react-router";
import { authenticateAdmin } from "../utils/authenticate.server";

/** Rota legada — jobs visíveis no Dashboard (banners + polling). */
export const loader = async ({ request }) => {
  await authenticateAdmin(request);
  return redirect("/app");
};

export default function LegacyJobsRedirect() {
  return null;
}
