import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";

export type GeoAddressRecord = {
  houseNumber: string | null;
  street: string | null;
  avenue: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  countryCode: string | null;
  postalCode: string | null;
  formatted: string | null;
};

export type GeoLocationRecord = {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
  timestamp: string;
  address: GeoAddressRecord | null;
};

export const geoSessions = pgTable(
  "geo_sessions",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["location", "live"] }).notNull(),
    ownerTokenHash: text("owner_token_hash").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    location: jsonb("location").$type<GeoLocationRecord | null>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("geo_sessions_expiry_idx").on(table.expiresAt)],
);
