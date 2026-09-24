/**
 * StreetEasy's amenity filter tokens (from evandcoleman/streeteasy-api).
 * `required` amenities narrow the search; `nice_to_have` ones only rank and
 * report matched/missing.
 */

export const AMENITIES = {
  WASHER_DRYER: { group: "unit", label: "Washer/dryer in unit" },
  DISHWASHER: { group: "unit", label: "Dishwasher" },
  PRIVATE_OUTDOOR_SPACE: { group: "unit", label: "Private outdoor space" },
  CENTRAL_AC: { group: "unit", label: "Central air" },
  FURNISHED: { group: "unit", label: "Furnished" },
  FIREPLACE: { group: "unit", label: "Fireplace" },
  LOFT: { group: "unit", label: "Loft" },
  CITY_VIEW: { group: "view", label: "City view" },
  GARDEN_VIEW: { group: "view", label: "Garden view" },
  PARK_VIEW: { group: "view", label: "Park view" },
  SKYLINE_VIEW: { group: "view", label: "Skyline view" },
  WATER_VIEW: { group: "view", label: "Water view" },
  DOORMAN: { group: "building", label: "Doorman" },
  LAUNDRY: { group: "building", label: "Laundry in building" },
  ELEVATOR: { group: "building", label: "Elevator" },
  GYM: { group: "building", label: "Gym" },
  PARKING: { group: "building", label: "Parking" },
  SHARED_OUTDOOR_SPACE: { group: "building", label: "Shared outdoor space" },
  POOL: { group: "building", label: "Pool" },
  PIED_A_TERRE_ALLOWED: { group: "building", label: "Pied-à-terre allowed" },
  CHILDRENS_PLAYROOM: { group: "building", label: "Children's playroom" },
  SMOKE_FREE: { group: "building", label: "Smoke-free" },
  STORAGE_SPACE: { group: "building", label: "Storage space" },
  GUARANTORS_ACCEPTED: { group: "building", label: "Guarantors accepted" },
} as const;

export type AmenityToken = keyof typeof AMENITIES;
export const AMENITY_TOKENS = Object.keys(AMENITIES) as AmenityToken[];

/** Accepts tokens or loose names ("washer dryer", "w/d", "doorman"). */
export function resolveAmenity(input: string): AmenityToken | null {
  const key = input
    .trim()
    .toUpperCase()
    .replace(/[\s\-/]+/g, "_")
    .replace(/[^A-Z_]/g, "");
  if (key in AMENITIES) return key as AmenityToken;
  const aliases: Record<string, AmenityToken> = {
    W_D: "WASHER_DRYER",
    WD: "WASHER_DRYER",
    IN_UNIT_LAUNDRY: "WASHER_DRYER",
    WASHER: "WASHER_DRYER",
    DRYER: "WASHER_DRYER",
    AC: "CENTRAL_AC",
    AIR_CONDITIONING: "CENTRAL_AC",
    OUTDOOR_SPACE: "PRIVATE_OUTDOOR_SPACE",
    BALCONY: "PRIVATE_OUTDOOR_SPACE",
    TERRACE: "PRIVATE_OUTDOOR_SPACE",
    ROOF_DECK: "SHARED_OUTDOOR_SPACE",
    ROOFTOP: "SHARED_OUTDOOR_SPACE",
    LAUNDRY_IN_BUILDING: "LAUNDRY",
    CONCIERGE: "DOORMAN",
    FITNESS: "GYM",
    GARAGE: "PARKING",
  };
  return aliases[key] ?? null;
}
