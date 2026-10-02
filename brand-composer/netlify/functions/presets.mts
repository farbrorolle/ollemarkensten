/**
 * Saved composer settings ("presets"), stored in Netlify Blobs so they're shared by every
 * browser, computer and deploy of the site.
 *
 *   GET    /api/presets?project=broadcom             -> { defaultId, presets: [{ id, name, savedAt }] }
 *   GET    /api/presets?project=broadcom&id=<id>     -> { id, name, savedAt, settings }
 *   GET    /api/presets?project=broadcom&id=default  -> the default preset (404 when none)
 *   POST   /api/presets?project=broadcom             body { name, settings, makeDefault? } -> meta
 *   PUT    /api/presets?project=broadcom&default=<id|none>  -> sets / clears the default
 *   DELETE /api/presets?project=broadcom&id=<id>
 */
import { getStore } from "@netlify/blobs";

interface Meta {
  id: string;
  name: string;
  savedAt: string;
}
interface Index {
  defaultId: string | null;
  presets: Meta[];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const project = (url.searchParams.get("project") ?? "broadcom").replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "broadcom";
  const store = getStore({ name: "composer-presets", consistency: "strong" });
  const indexKey = `${project}/index`;
  const presetKey = (id: string): string => `${project}/preset/${id}`;
  const readIndex = async (): Promise<Index> =>
    ((await store.get(indexKey, { type: "json" })) as Index | null) ?? { defaultId: null, presets: [] };

  try {
    if (req.method === "GET") {
      const idParam = url.searchParams.get("id");
      const index = await readIndex();
      if (!idParam) return json(index);
      const id = idParam === "default" ? index.defaultId : idParam;
      if (!id) return json({ error: "No default" }, 404);
      const preset = await store.get(presetKey(id), { type: "json" });
      return preset ? json(preset) : json({ error: "Not found" }, 404);
    }

    if (req.method === "POST") {
      const body = (await req.json()) as { name?: string; settings?: unknown; makeDefault?: boolean };
      const name = String(body.name ?? "").trim().slice(0, 80);
      if (!name || !body.settings || typeof body.settings !== "object") return json({ error: "Name and settings needed" }, 400);
      const meta: Meta = { id: crypto.randomUUID().slice(0, 8), name, savedAt: new Date().toISOString() };
      await store.setJSON(presetKey(meta.id), { ...meta, settings: body.settings });
      const index = await readIndex();
      index.presets.push(meta);
      if (body.makeDefault) index.defaultId = meta.id;
      await store.setJSON(indexKey, index);
      return json({ ...meta, isDefault: index.defaultId === meta.id });
    }

    if (req.method === "PUT") {
      const target = url.searchParams.get("default");
      const index = await readIndex();
      if (target === "none") index.defaultId = null;
      else if (target && index.presets.some((p) => p.id === target)) index.defaultId = target;
      else return json({ error: "Unknown preset" }, 400);
      await store.setJSON(indexKey, index);
      return json(index);
    }

    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "id needed" }, 400);
      const index = await readIndex();
      index.presets = index.presets.filter((p) => p.id !== id);
      if (index.defaultId === id) index.defaultId = null;
      await store.setJSON(indexKey, index);
      await store.delete(presetKey(id));
      return json(index);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
};

export const config = { path: "/api/presets" };
