/**
 * A · Paso 6 (ADR-075) against the local stack, with the simulated model and a stand-in for
 * Meta's Graph API at 127.0.0.1:4610 (WHATSAPP_GRAPH_URL):
 *
 * - Meta's subscription check answers the challenge only with the verify token;
 * - a delivery that is not signed with the app secret is refused;
 * - a text to Demo Norte's number (registered for this run) is answered from that number with
 *   the portal's absolute links, counted with the channel «whatsapp» and kept in the
 *   conversation by a hash of the sender — never the number;
 * - the same message relayed again is not answered twice;
 * - a voice note is downloaded with the token, passed to text and answered with what it understood;
 * - a shared location gives «¿Qué hay cerca?», and no request carries the position;
 * - an image gets what the assistant understands; a number no municipality has, nothing.
 *
 * Run it with the stack up and the production server started with the WHATSAPP_* settings:
 *   SUPABASE_DB_URL=… pnpm --filter @rikuy/web test:e2e-whatsapp
 */
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = Number(process.env.RIKUY_PORT ?? 3000);
const WEBHOOK = `http://localhost:${PORT}/api/whatsapp`;
const NORTE_ORIGIN = `http://demo-norte.localhost:${PORT}`;
const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const NORTE_ID = "5eed1000-0000-4000-8000-000000000001";
const NUMBER_ID = "100000000000001";
const VISITOR = "59170000001";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET ?? "rikuy-ci-app-secret-not-real";
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? "rikuy-ci-verify-token-not-real";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN ?? "rikuy-ci-access-token-not-real";
const GRAPH_PORT = 4610;

const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });

interface GraphRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}
const graphRequests: GraphRequest[] = [];
let graph: Server;

function voiceNote(): Uint8Array {
  const bytes = new Uint8Array(4096);
  bytes.set(new TextEncoder().encode("OggS"), 0);
  return bytes;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function delivery(message: Record<string, unknown>, phoneNumberId = NUMBER_ID) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-e2e",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
              contacts: [{ wa_id: VISITOR, profile: { name: "Visitante" } }],
              messages: [{ from: VISITOR, timestamp: "1764300000", ...message }],
            },
          },
        ],
      },
    ],
  };
}

async function post(payload: unknown, secret = APP_SECRET): Promise<Response> {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return fetch(WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` },
    body,
  });
}

const sent = () =>
  graphRequests
    .filter((request) => request.method === "POST" && request.path.endsWith("/messages"))
    .map((request) => ({ path: request.path, ...JSON.parse(request.body) }));

async function nextSent(
  count: number,
): Promise<{ path: string; to: string; text: { body: string } }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const all = sent();
    if (all.length >= count) return all[count - 1];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no WhatsApp message ${count} was sent`);
}

const id = (name: string) => `wamid.e2e.${name}.${Date.now()}`;

beforeAll(async () => {
  graph = createServer(async (request, response) => {
    const path = request.url ?? "/";
    const body = await readBody(request);
    graphRequests.push({
      method: request.method ?? "GET",
      path,
      authorization: request.headers.authorization ?? null,
      body,
    });
    if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "POST" && path.endsWith("/messages")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ messages: [{ id: "wamid.out" }] }));
    } else if (path === "/media-e2e") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          url: `http://127.0.0.1:${GRAPH_PORT}/files/media-e2e`,
          mime_type: "audio/ogg; codecs=opus",
          file_size: 4096,
        }),
      );
    } else if (path === "/files/media-e2e") {
      response.writeHead(200, { "content-type": "audio/ogg" });
      response.end(Buffer.from(voiceNote()));
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => graph.listen(GRAPH_PORT, "127.0.0.1", resolve));

  await db`delete from public.whatsapp_messages where tenant_id = ${NORTE_ID}`;
  await db`delete from public.whatsapp_inbound where tenant_id = ${NORTE_ID}`;
  await db`
    insert into public.whatsapp_numbers (phone_number_id, tenant_id, display_phone)
    values (${NUMBER_ID}, ${NORTE_ID}, '+1 555 000 0000')
    on conflict (phone_number_id) do nothing
  `;
});

afterAll(async () => {
  await db`delete from public.whatsapp_numbers where phone_number_id = ${NUMBER_ID}`;
  await db`delete from public.whatsapp_messages where tenant_id = ${NORTE_ID}`;
  await db`delete from public.whatsapp_inbound where tenant_id = ${NORTE_ID}`;
  await db.end({ timeout: 5 });
  await new Promise<void>((resolve) => graph.close(() => resolve()));
});

describe("the municipality's assistant on WhatsApp (ADR-075)", () => {
  it("answers Meta's subscription check only with the verify token", async () => {
    const ok = await fetch(
      `${WEBHOOK}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`,
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1158201444");
    const wrong = await fetch(
      `${WEBHOOK}?hub.mode=subscribe&hub.verify_token=otro-token-equivocado-1234&hub.challenge=1`,
    );
    expect(wrong.status).toBe(403);
  });

  it("refuses a delivery that is not signed with the app secret", async () => {
    const payload = delivery({ id: id("unsigned"), type: "text", text: { body: "Hola" } });
    expect((await post(payload, "otro-secreto-de-otra-app")).status).toBe(401);
    const unsigned = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(unsigned.status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(sent()).toHaveLength(0);
  });

  it("answers a text from the municipality's number, once, without keeping the number", async () => {
    const messageId = id("text");
    const payload = delivery({
      id: messageId,
      type: "text",
      text: { body: "¿Qué lugares puedo visitar?" },
    });
    const response = await post(payload);
    expect(response.status).toBe(200);
    const answer = await nextSent(1);
    expect(answer.path).toBe(`/${NUMBER_ID}/messages`);
    expect(answer.to).toBe(VISITOR);
    expect(answer.text.body.length).toBeGreaterThan(10);
    expect(answer.text.body).toContain(`${NORTE_ORIGIN}/`);
    expect(graphRequests.at(-1)?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    // Relayed again (Meta retries): not answered twice.
    expect((await post(payload)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(sent()).toHaveLength(1);

    const [turns] = await db`
      select count(*)::int as count from public.assistant_turns
      where tenant_id = ${NORTE_ID} and channel = 'whatsapp'
    `;
    expect(turns?.count).toBeGreaterThan(0);
    const kept = await db`
      select contact_key, role, body from public.whatsapp_messages
      where tenant_id = ${NORTE_ID} order by id
    `;
    expect(kept.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(kept[0]?.body).toBe("¿Qué lugares puedo visitar?");
    expect(JSON.stringify(kept)).not.toContain("70000001");
  });

  it("passes a voice note to text and says what it understood", async () => {
    const before = sent().length;
    await post(
      delivery({ id: id("audio"), type: "audio", audio: { id: "media-e2e", voice: true } }),
    );
    const answer = await nextSent(before + 1);
    expect(answer.text.body.startsWith("Entendí: «¿Qué lugares puedo visitar?»")).toBe(true);
    const download = graphRequests.find((request) => request.path === "/files/media-e2e");
    expect(download?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("gives what is nearby a shared location, without sending the position on", async () => {
    const [place] = await db`
      select r.latitude, r.longitude from public.content_items i
      join public.content_revisions r on r.id = i.published_revision_id
      where i.tenant_id = ${NORTE_ID} and i.slug = 'mirador-del-valle'
    `;
    const before = sent().length;
    await post(
      delivery({
        id: id("location"),
        type: "location",
        location: { latitude: place?.latitude, longitude: place?.longitude },
      }),
    );
    const answer = await nextSent(before + 1);
    expect(answer.text.body).toContain("Mirador del Valle");
    expect(answer.text.body).toMatch(/^1\. \*/mu);
    const outgoing = sent()
      .slice(before)
      .map((message) => JSON.stringify(message))
      .join("");
    expect(outgoing).not.toContain(String(place?.latitude));
  });

  it("says what it understands for an image, and nothing to a number no municipality has", async () => {
    const before = sent().length;
    await post(delivery({ id: id("image"), type: "image", image: { id: "img-1" } }));
    const answer = await nextSent(before + 1);
    expect(answer.text.body).toContain("mensajes de texto, notas de voz y tu ubicación");

    await post(
      delivery({ id: id("unknown"), type: "text", text: { body: "Hola" } }, "999999999999"),
    );
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(sent()).toHaveLength(before + 1);
  });
});
