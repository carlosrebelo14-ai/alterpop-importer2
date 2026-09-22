import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request }) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current;

  if (session) {
    session.scope = current.toString();
    try {
      await sessionStorage.storeSession(session);
    } catch (err) {
      // Auditoria 2026-09-22 — FileSessionStorage.storeSession() (fileSessionStorage.js)
      // não apanha erros de fs.writeFile (só os métodos de leitura/apagar o fazem — de
      // propósito: o fluxo OAuth precisa de saber se storeSession realmente falhou).
      // Aqui, ao contrário do OAuth, um erro de I/O pontual não deve derrubar o
      // webhook: sem isto, a exceção propagava, a rota devolvia 500 e a Shopify
      // reenviava o mesmo webhook indefinidamente, falhando sempre da mesma forma.
      console.error(
        `[webhook] scopes_update: falha ao gravar sessão para ${shop} (scope não atualizado localmente):`,
        err?.message || err
      );
    }
  }

  return new Response();
};
