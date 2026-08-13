import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  //
  // Fix (code review 2026-08-13): isto usava `db.session.deleteMany` (tabela Prisma
  // Session), mas a app corre com SESSION_STORAGE=file por omissão — a sessão real
  // vive em data/sessions/offline_<shop>.json e nunca era apagada ao desinstalar,
  // deixando um token OAuth "morto" em disco. `sessionStorage` é a instância
  // resolvida (file ou prisma, conforme configurado) — usar sempre esta, nunca o
  // modelo Prisma diretamente.
  if (session) {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions.length) {
      await sessionStorage.deleteSessions(sessions.map((s) => s.id));
    }
  }

  return new Response();
};
