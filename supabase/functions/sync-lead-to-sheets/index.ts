// Edge Function disparada pelo Database Webhook do Supabase (INSERT em public.leads).
// Autentica na API do Google Sheets com uma Service Account e adiciona uma linha
// com os dados do lead recém-criado.
//
// Secrets esperados (Deno.env / `supabase secrets set`):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY  (conteúdo do campo "private_key" do JSON da service account)
//   GOOGLE_SHEETS_SPREADSHEET_ID
//   GOOGLE_SHEETS_RANGE                 (ex: "Leads!A:I")
//   WEBHOOK_SECRET                      (string aleatória; deve bater com o header
//                                         X-Webhook-Secret configurado no Database Webhook)

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromString(input: string): string {
  return base64url(new TextEncoder().encode(input));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
  const pemBody = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const binary = atob(pemBody);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return crypto.subtle.importKey(
    "pkcs8",
    bytes.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getAccessToken(clientEmail: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600
  };

  const unsigned = `${base64urlFromString(JSON.stringify(header))}.${base64urlFromString(JSON.stringify(claims))}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = `${unsigned}.${base64url(signature)}`;

  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`Falha ao obter access token do Google: ${tokenResponse.status} ${text}`);
  }

  const tokenJson = await tokenResponse.json();
  return tokenJson.access_token as string;
}

async function appendToSheet(
  accessToken: string,
  spreadsheetId: string,
  range: string,
  row: unknown[]
): Promise<void> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ values: [row] })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Falha ao adicionar linha na planilha: ${response.status} ${text}`);
  }
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const expectedSecret = Deno.env.get("WEBHOOK_SECRET");
  const receivedSecret = request.headers.get("x-webhook-secret");
  if (expectedSecret && receivedSecret !== expectedSecret) {
    return new Response(JSON.stringify({ error: "Invalid webhook secret" }), { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const record = body?.record;
  if (!record) {
    return new Response(JSON.stringify({ error: "Missing record in payload" }), { status: 400 });
  }

  const clientEmail = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY");
  const spreadsheetId = Deno.env.get("GOOGLE_SHEETS_SPREADSHEET_ID");
  const range = Deno.env.get("GOOGLE_SHEETS_RANGE") ?? "Leads!A:I";

  if (!clientEmail || !privateKey || !spreadsheetId) {
    return new Response(JSON.stringify({ error: "Missing Google Sheets configuration" }), { status: 500 });
  }

  const row = [
    record.nome ?? "",
    record.telefone ?? "",
    record.email ?? "",
    record.utm_source ?? "",
    record.utm_campaign ?? "",
    record.utm_medium ?? "",
    record.utm_content ?? "",
    record.utm_term ?? "",
    record.created_at ?? new Date().toISOString()
  ];

  try {
    const accessToken = await getAccessToken(clientEmail, privateKey);
    await appendToSheet(accessToken, spreadsheetId, range, row);
  } catch (err) {
    console.error("sync-lead-to-sheets error:", err);
    // Retorna erro para que o Database Webhook do Supabase tente novamente.
    return new Response(JSON.stringify({ error: String(err) }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});
