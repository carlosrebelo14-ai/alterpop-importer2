import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // GET sem shop → mostrar formulário (evita formData() em pedidos sem corpo)
  if (request.method === "GET" && !url.searchParams.get("shop")) {
    return { errors: loginErrorMessage({}) };
  }

  try {
    const errors = loginErrorMessage(await login(request));
    return { errors };
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[auth.login] loader:", error);
    return {
      errors: {
        shop: "Falha no login OAuth. Corre npm run shopify:reset-session e abre a app de novo.",
      },
    };
  }
};

export const action = async ({ request }) => {
  try {
    const errors = loginErrorMessage(await login(request));
    return { errors };
  } catch (error) {
    if (error instanceof Response) throw error;
    console.error("[auth.login] action:", error);
    return {
      errors: {
        shop: "Falha no login OAuth. Corre npm run shopify:reset-session e abre a app de novo.",
      },
    };
  }
};

export default function Auth() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <AppProvider embedded={false}>
      <s-page>
        <Form method="post">
          <s-section heading="Log in">
            <s-text-field
              name="shop"
              label="Shop domain"
              details="example.myshopify.com"
              value={shop}
              onChange={(e) => setShop(e.currentTarget.value)}
              autocomplete="on"
              error={errors.shop}
            ></s-text-field>
            <s-button type="submit">Log in</s-button>
          </s-section>
        </Form>
      </s-page>
    </AppProvider>
  );
}
