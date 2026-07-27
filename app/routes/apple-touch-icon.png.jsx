/**
 * Evita erro SSR "No route matches URL /apple-touch-icon.png".
 * Alguns browsers/webviews pedem este ficheiro automaticamente.
 */
export const loader = async () =>
  new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "public, max-age=86400",
    },
  });

