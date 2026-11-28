import { describe, expect, it } from "vitest";

import { createSessionClient } from "./session-client";
import { createWhatsAppCloud, WhatsAppCloudError } from "./whatsapp-cloud";
import {
  createPlatformWhatsAppRepository,
  createWhatsAppNumberRepository,
} from "./whatsapp-numbers";

const BASE = "http://127.0.0.1:54321";
const TENANT = "5eed1000-0000-4000-8000-000000000002";
const TOKEN = `EAAG${"t".repeat(40)}`;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const pgError = (code: string, status: number, hint: string | null = null) =>
  json({ code, message: "x", details: null, hint }, status);

function client(route: (url: URL, body: unknown) => Response) {
  const calls: { path: string; body: unknown }[] = [];
  const session = createSessionClient({
    url: BASE,
    publishableKey: "sb_publishable_test",
    secureCookies: false,
    cookies: { getAll: () => [], setAll: () => undefined },
    fetch: async (input, init = {}) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: url.pathname, body });
      return route(url, body);
    },
  });
  return { session, calls };
}

const number = {
  phoneNumberId: "1234567890",
  displayPhone: "+591 67680091",
  createdAt: "2026-11-28",
};

describe("the WhatsApp numbers of a municipality (ADR-075)", () => {
  it("lets the operator list, add and remove them", async () => {
    const { session, calls } = client(() => json([number]));
    const repository = createPlatformWhatsAppRepository(session);
    expect(await repository.list(TENANT)).toEqual([number]);
    expect(await repository.add(TENANT, "1234567890", "+591 67680091")).toEqual({
      status: "updated",
      numbers: [number],
    });
    expect(await repository.remove(TENANT, "1234567890")).toEqual({
      status: "updated",
      numbers: [number],
    });
    expect(calls.map((call) => call.path.split("/").pop())).toEqual([
      "platform_whatsapp_numbers",
      "platform_add_whatsapp_number",
      "platform_remove_whatsapp_number",
    ]);
    expect(calls[1]?.body).toEqual({
      p_tenant_id: TENANT,
      p_phone_number_id: "1234567890",
      p_display_phone: "+591 67680091",
    });
  });

  it("says what the database refused", async () => {
    const cases: [Response, string][] = [
      [pgError("42501", 403), "forbidden"],
      [pgError("PT404", 404, "tenant"), "not_found"],
      [pgError("PT409", 409, "taken"), "taken"],
      [pgError("PT409", 409, "too_many"), "too_many"],
      [pgError("23514", 400, "phone_number_id"), "invalid"],
      [pgError("23514", 400, "display_phone"), "display"],
    ];
    for (const [response, status] of cases) {
      const { session } = client(() => response.clone());
      expect(await createPlatformWhatsAppRepository(session).add(TENANT, "1", null)).toEqual({
        status,
      });
    }
  });

  it("is not the operator: no list; before the migration: none", async () => {
    expect(
      await createPlatformWhatsAppRepository(client(() => pgError("42501", 403)).session).list(
        TENANT,
      ),
    ).toBeNull();
    const missing = () => pgError("PGRST202", 404);
    expect(await createPlatformWhatsAppRepository(client(missing).session).list(TENANT)).toEqual(
      [],
    );
    expect(await createWhatsAppNumberRepository(client(missing).session).numbers(TENANT)).toEqual(
      [],
    );
  });

  it("lets a member read them", async () => {
    const { session } = client(() => json([number]));
    expect(await createWhatsAppNumberRepository(session).numbers(TENANT)).toEqual([number]);
  });
});

describe("Meta's WhatsApp Cloud API (ADR-075)", () => {
  function graph(route: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const cloud = createWhatsAppCloud({
      accessToken: TOKEN,
      graphUrl: "http://127.0.0.1:4610/",
      fetch: async (input, init = {}) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, init });
        return route(url, init);
      },
    });
    return { cloud, calls };
  }

  it("sends a text from the municipality's number, the token only in the header", async () => {
    const { cloud, calls } = graph(() => json({ messages: [{ id: "wamid.1" }] }));
    await cloud.sendText("1234567890", "59167680091", "Hola");
    expect(calls[0]?.url).toBe("http://127.0.0.1:4610/1234567890/messages");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "59167680091",
      type: "text",
      text: { preview_url: false, body: "Hola" },
    });
  });

  it("fails without the token or Meta's body in the error", async () => {
    const { cloud } = graph(() => json({ error: { message: `echo ${TOKEN}` } }, 401));
    const error = await cloud.sendText("1234567890", "59167680091", "Hola").catch((e) => e);
    expect(error).toBeInstanceOf(WhatsAppCloudError);
    expect(String(error.message)).not.toContain(TOKEN);
    expect(String(error.message)).not.toContain("echo");
  });

  it("refuses ids that are not digits before calling Meta", async () => {
    const { cloud, calls } = graph(() => json({}));
    await expect(cloud.sendText("../x", "59167680091", "Hola")).rejects.toThrow();
    await expect(cloud.downloadMedia("a/b")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("downloads a voice note with the token, and nothing larger than a dictation", async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const { cloud, calls } = graph((url) =>
      !url.includes("/files/")
        ? json({ url: "http://127.0.0.1:4610/files/media123", mime_type: "audio/ogg; codecs=opus" })
        : new Response(audio),
    );
    expect(await cloud.downloadMedia("media123")).toEqual({
      bytes: audio,
      mimeType: "audio/ogg; codecs=opus",
    });
    expect(new Headers(calls[1]?.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);

    const big = graph((url) =>
      !url.includes("/files/")
        ? json({ url: "http://127.0.0.1:4610/files/9", file_size: 3 * 1024 * 1024 })
        : new Response(audio),
    );
    expect(await big.cloud.downloadMedia("media9")).toBeNull();
    expect(big.calls).toHaveLength(1);

    const streamed = graph((url) =>
      !url.includes("/files/")
        ? json({ url: "http://127.0.0.1:4610/files/8" })
        : new Response(new Uint8Array(3 * 1024 * 1024)),
    );
    expect(await streamed.cloud.downloadMedia("media8")).toBeNull();
  });
});
