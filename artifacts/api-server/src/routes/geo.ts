import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, lt, or } from "@workspace/db";
import { Router, type IRouter, type Response as ExpressResponse } from "express";
import {
  CreateGeoSessionBody,
  CreateGeoSessionResponse,
  GetGeoSessionParams,
  GetGeoSessionResponse,
  ReverseGeocodeQueryParams,
  ReverseGeocodeResponse,
  StopGeoSessionHeader,
  StopGeoSessionParams,
  StopGeoSessionResponse,
  UpdateGeoSessionLocationBody,
  UpdateGeoSessionLocationHeader,
  UpdateGeoSessionLocationParams,
  UpdateGeoSessionLocationResponse,
} from "@workspace/api-zod";
import { db, geoSessions } from "@workspace/db";
import type { GeoLocationRecord } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();
const geocodeCache = new Map<string, { address: unknown; expiresAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STOPPED_SESSION_RETENTION_MS = 30 * 60 * 1000;
let lastNominatimRequest = 0;
let nominatimQueue: Promise<unknown> = Promise.resolve();

function publicSession(row: typeof geoSessions.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    isActive: row.isActive,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    location: row.location,
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function ownerMatches(candidate: string, storedHash: string): boolean {
  return timingSafeEqual(digest(candidate), Buffer.from(storedHash, "hex"));
}

function isUsAddress(location: GeoLocationRecord): boolean {
  const countryCode = location.address?.countryCode?.toLowerCase();
  return countryCode == null || countryCode === "us";
}

function toGeoLocationRecord(
  location: ReturnType<typeof CreateGeoSessionBody.parse>["location"],
): GeoLocationRecord {
  return {
    ...location,
    timestamp:
      location.timestamp instanceof Date
        ? location.timestamp.toISOString()
        : String(location.timestamp),
  };
}

function notFound(res: ExpressResponse, message: string): void {
  res.status(404).json({ error: message });
}

function enqueueNominatim(url: string): Promise<globalThis.Response> {
  const request = nominatimQueue.then(async () => {
    const waitMs = Math.max(0, 1100 - (Date.now() - lastNominatimRequest));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastNominatimRequest = Date.now();
    return fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "GeoAnime/1.0 (U.S. reverse geocoding)",
      },
      signal: AbortSignal.timeout(12_000),
    });
  });
  nominatimQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}

function field(
  address: Record<string, string>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = address[key]?.trim();
    if (value) return value;
  }
  return null;
}

function normalizeAddress(
  source: { address?: Record<string, string>; display_name?: string },
) {
  const raw = source.address ?? {};
  const countryCode = field(raw, "country_code")?.toLowerCase() ?? null;
  return {
    houseNumber: field(raw, "house_number"),
    street: field(raw, "road", "residential", "pedestrian", "footway"),
    avenue: field(raw, "avenue"),
    neighborhood: field(
      raw,
      "neighbourhood",
      "suburb",
      "quarter",
      "city_district",
    ),
    city: field(raw, "city", "town", "village", "municipality", "hamlet"),
    state: field(raw, "state", "province"),
    country: field(raw, "country"),
    countryCode,
    postalCode: field(raw, "postcode"),
    formatted: source.display_name?.trim() || null,
  };
}

router.get("/geo/reverse-geocode", async (req, res): Promise<void> => {
  const query = ReverseGeocodeQueryParams.safeParse({
    lat: req.query.lat,
    lon: req.query.lon,
  });
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }

  const cacheKey = `${query.data.lat.toFixed(4)},${query.data.lon.toFixed(4)}`;
  const cached = geocodeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.json(ReverseGeocodeResponse.parse(cached.address));
    return;
  }

  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(query.data.lat));
    url.searchParams.set("lon", String(query.data.lon));
    url.searchParams.set("zoom", "18");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "en-US");

    const response = await enqueueNominatim(url.toString());
    if (!response.ok) {
      req.log.warn({ status: response.status }, "U.S. address lookup failed");
      res.status(502).json({ error: "Address lookup is temporarily unavailable." });
      return;
    }

    const result = (await response.json()) as {
      address?: Record<string, string>;
      display_name?: string;
    };
    const address = normalizeAddress(result);
    if (address.countryCode !== "us") {
      res.status(422).json({
        error: "GeoAnime currently supports locations within the United States.",
      });
      return;
    }

    if (geocodeCache.size >= 5000) {
      const oldest = geocodeCache.keys().next().value;
      if (oldest) geocodeCache.delete(oldest);
    }
    geocodeCache.set(cacheKey, {
      address,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.json(ReverseGeocodeResponse.parse(address));
  } catch (error) {
    req.log.warn({ err: error }, "U.S. address lookup failed");
    res.status(503).json({ error: "Address lookup is temporarily unavailable." });
  }
});

router.post("/geo/sessions", async (req, res): Promise<void> => {
  const parsed = CreateGeoSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const input = parsed.data;
  const location = toGeoLocationRecord(input.location);
  if (!isUsAddress(location)) {
    res.status(422).json({
      error: "GeoAnime currently supports locations within the United States.",
    });
    return;
  }

  const id = randomBytes(9).toString("base64url");
  const ownerToken = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt =
    input.expiresMinutes === 0
      ? null
      : new Date(now.getTime() + input.expiresMinutes * 60_000);

  const [row] = await db
    .insert(geoSessions)
    .values({
      id,
      kind: input.kind,
      ownerTokenHash: digest(ownerToken).toString("hex"),
      isActive: true,
      expiresAt,
      location,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  res
    .status(201)
    .json(
      CreateGeoSessionResponse.parse({
        session: publicSession(row),
        ownerToken,
      }),
    );
});

router.get("/geo/sessions/:id", async (req, res): Promise<void> => {
  const params = GetGeoSessionParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .select()
    .from(geoSessions)
    .where(eq(geoSessions.id, params.data.id))
    .limit(1);
  if (!row) {
    notFound(res, "This location share does not exist or has expired.");
    return;
  }

  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    await db.delete(geoSessions).where(eq(geoSessions.id, row.id));
    notFound(res, "This location share has expired.");
    return;
  }

  res.json(GetGeoSessionResponse.parse(publicSession(row)));
});

router.patch("/geo/sessions/:id/location", async (req, res): Promise<void> => {
  const params = UpdateGeoSessionLocationParams.safeParse(req.params);
  const header = UpdateGeoSessionLocationHeader.safeParse({
    "X-Session-Owner": req.get("X-Session-Owner"),
  });
  const body = UpdateGeoSessionLocationBody.safeParse(req.body);
  if (!params.success || !header.success || !body.success) {
    const error =
      (params.success ? undefined : params.error.message) ??
      (header.success ? undefined : header.error.message) ??
      (body.success ? undefined : body.error.message);
    res.status(400).json({ error: error ?? "Invalid location update." });
    return;
  }

  const [existing] = await db
    .select()
    .from(geoSessions)
    .where(eq(geoSessions.id, params.data.id))
    .limit(1);
  if (
    !existing ||
    !existing.isActive ||
    (existing.expiresAt && existing.expiresAt.getTime() <= Date.now())
  ) {
    notFound(res, "This live location share is no longer active.");
    return;
  }
  if (!ownerMatches(header.data["X-Session-Owner"], existing.ownerTokenHash)) {
    res.status(403).json({ error: "The share owner key is invalid." });
    return;
  }
  if (existing.kind !== "live") {
    res.status(409).json({ error: "Only a live share can receive updates." });
    return;
  }
  const location = toGeoLocationRecord(body.data.location);
  if (!isUsAddress(location)) {
    res.status(422).json({
      error: "GeoAnime currently supports locations within the United States.",
    });
    return;
  }

  const [row] = await db
    .update(geoSessions)
    .set({
      location,
      updatedAt: new Date(),
    })
    .where(and(eq(geoSessions.id, existing.id), eq(geoSessions.isActive, true)))
    .returning();

  if (!row) {
    notFound(res, "This live location share is no longer active.");
    return;
  }

  res.json(UpdateGeoSessionLocationResponse.parse(publicSession(row)));
});

router.post("/geo/sessions/:id/stop", async (req, res): Promise<void> => {
  const params = StopGeoSessionParams.safeParse(req.params);
  const header = StopGeoSessionHeader.safeParse({
    "X-Session-Owner": req.get("X-Session-Owner"),
  });
  if (!params.success || !header.success) {
    const error =
      (params.success ? undefined : params.error.message) ??
      (header.success ? undefined : header.error.message);
    res.status(400).json({ error: error ?? "Invalid share credentials." });
    return;
  }

  const [existing] = await db
    .select()
    .from(geoSessions)
    .where(eq(geoSessions.id, params.data.id))
    .limit(1);
  if (!existing) {
    notFound(res, "This location share does not exist or has expired.");
    return;
  }
  if (!ownerMatches(header.data["X-Session-Owner"], existing.ownerTokenHash)) {
    res.status(403).json({ error: "The share owner key is invalid." });
    return;
  }

  let stoppedAt = existing.updatedAt;
  if (existing.isActive) {
    stoppedAt = new Date();
    await db
      .update(geoSessions)
      .set({ isActive: false, location: null, updatedAt: stoppedAt })
      .where(and(eq(geoSessions.id, existing.id), eq(geoSessions.isActive, true)));
  }

  res.json(
    StopGeoSessionResponse.parse({
      id: existing.id,
      isActive: false,
      stoppedAt: stoppedAt.toISOString(),
    }),
  );
});

const cleanupTimer = setInterval(() => {
  const now = new Date();
  const stoppedBefore = new Date(now.getTime() - STOPPED_SESSION_RETENTION_MS);
  void db
    .delete(geoSessions)
    .where(
      or(
        lt(geoSessions.expiresAt, now),
        and(eq(geoSessions.isActive, false), lt(geoSessions.updatedAt, stoppedBefore)),
      ),
    )
    .catch((err: unknown) => {
      logger.warn({ err }, "Unable to prune expired GeoAnime shares");
    });
}, 5 * 60 * 1000);
cleanupTimer.unref();

export default router;
