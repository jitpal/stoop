/**
 * Raw StreetEasy shapes → the compact records agents see.
 *
 * Kept small on purpose: a page of results goes into an agent's context, so
 * search results carry what's needed to choose and get_listing carries the rest.
 */

import { areaByName } from "../geo/areas";
import type { RentalEdge, RentalListingDetailsResponse, SearchRentalListing } from "./types";

const SE_BASE = "https://streeteasy.com";
const PHOTO_CDN = "https://photos.zillowstatic.com/fp";

export function photoUrl(key: string): string {
  return `${PHOTO_CDN}/${key}-se_large_800_400.jpg`;
}

export function listingUrl(urlPath: string | undefined | null, id: string): string {
  if (urlPath) return `${SE_BASE}/${urlPath.replace(/^\/+/, "")}`;
  return `${SE_BASE}/rental/${id}`;
}

export interface ListingSummary {
  id: string;
  url: string;
  address: string;
  street: string;
  unit: string | null;
  neighborhood: string;
  borough: string | null;
  price: number;
  net_effective_price?: number;
  months_free?: number;
  no_fee: boolean;
  beds: number;
  baths: number;
  sqft: number | null;
  available_on: string | null;
  furnished: boolean;
  building_type: string;
  new_development: boolean;
  lat: number | null;
  lng: number | null;
  photo: string | null;
  photo_count: number;
  has_video: boolean;
  has_3d_tour: boolean;
  open_house?: { start: string; end: string; by_appointment: boolean };
  price_change?: { delta: number; on: string | null };
  listed_by: string | null;
  sponsored?: true;
  amenities_matched?: string[];
  amenities_missing?: string[];
  /** Added by location searches. */
  distance_m?: number;
  walk_min?: number;
  /** Added when building flags are requested. */
  building?: unknown;
}

export function normalizeEdge(edge: RentalEdge): ListingSummary {
  const n: SearchRentalListing = edge.node;
  const out: ListingSummary = {
    id: n.id,
    url: listingUrl(n.urlPath, n.id),
    address: [n.street, n.unit].filter(Boolean).join(" ").trim(),
    street: n.street,
    unit: n.unit || null,
    neighborhood: n.areaName,
    borough: areaByName(n.areaName)?.borough ?? null,
    price: n.price,
    no_fee: n.noFee,
    beds: n.bedroomCount,
    baths: n.fullBathroomCount + (n.halfBathroomCount ? n.halfBathroomCount * 0.5 : 0),
    sqft: n.livingAreaSize || null,
    available_on: n.availableAt ? n.availableAt.slice(0, 10) : null,
    furnished: n.furnished,
    building_type: n.buildingType,
    new_development: n.isNewDevelopment,
    lat: n.geoPoint?.latitude ?? null,
    lng: n.geoPoint?.longitude ?? null,
    photo: n.leadMedia?.photo?.key ? photoUrl(n.leadMedia.photo.key) : null,
    photo_count: n.photos?.length ?? 0,
    has_video: n.hasVideos,
    has_3d_tour: n.hasTour3d,
    listed_by: n.sourceGroupLabel || null,
  };
  if (n.netEffectivePrice && n.netEffectivePrice !== n.price)
    out.net_effective_price = n.netEffectivePrice;
  if (n.monthsFree) out.months_free = n.monthsFree;
  if (n.upcomingOpenHouse) {
    out.open_house = {
      start: n.upcomingOpenHouse.startTime,
      end: n.upcomingOpenHouse.endTime,
      by_appointment: n.upcomingOpenHouse.appointmentOnly,
    };
  }
  if (n.priceDelta)
    out.price_change = { delta: n.priceDelta, on: n.priceChangedAt?.slice(0, 10) ?? null };
  if (edge.__typename === "SponsoredRentalEdge") out.sponsored = true;
  if ("amenitiesMatch" in edge) {
    if (edge.matchedAmenities?.length) out.amenities_matched = edge.matchedAmenities;
    if (edge.missingAmenities?.length) out.amenities_missing = edge.missingAmenities;
  }
  return out;
}

export function normalizeDetails(raw: RentalListingDetailsResponse) {
  const l = raw.rentalByListingId;
  const b = raw.buildingByRentalListingId;
  const p = l.propertyDetails;
  const addr = p?.address ?? b?.address;
  const pet = b?.policies?.petPolicy;
  const history = (l.propertyHistory ?? [])
    .flatMap((h) => h.rentalEventsOfInterest ?? [])
    .map((e) => ({
      date: e.date?.slice(0, 10),
      event: e.status || (e.pricePercentChange ? "PRICE_CHANGE" : "EVENT"),
      price: e.price,
      ...(e.pricePercentChange ? { change_pct: e.pricePercentChange } : {}),
    }))
    .sort((a, b2) => String(b2.date).localeCompare(String(a.date)))
    .slice(0, 15);

  return {
    id: l.id,
    status: l.status,
    street: addr?.street ?? null,
    unit: addr?.unit ?? null,
    zip: addr?.zipCode ?? null,
    neighborhood: b?.area?.name ?? null,
    price: l.pricing?.price ?? null,
    no_fee: l.pricing?.noFee ?? null,
    months_free: l.pricing?.monthsFree ?? null,
    lease_term_months: l.pricing?.leaseTermMonths ?? null,
    neighborhood_median_rent: l.recentListingsPriceStats?.rentalPriceStats?.medianPrice ?? null,
    available_on: l.availableAt?.slice(0, 10) ?? null,
    listed_on: l.createdAt?.slice(0, 10) ?? null,
    days_on_market: l.createdAt
      ? Math.max(0, Math.floor((Date.now() - Date.parse(l.createdAt)) / 86400000))
      : null,
    beds: p?.bedroomCount ?? null,
    baths: p ? p.fullBathroomCount + (p.halfBathroomCount ? p.halfBathroomCount * 0.5 : 0) : null,
    rooms: p?.roomCount ?? null,
    sqft: p?.livingAreaSize || null,
    description: l.description ?? null,
    unit_features: p?.features?.list ?? [],
    views: p?.features?.views ?? [],
    outdoor_space: p?.features?.privateOutdoorSpaceTypes ?? [],
    building_amenities: p?.amenities?.list ?? [],
    doorman: p?.amenities?.doormanTypes ?? [],
    laundry_and_storage: p?.amenities?.storageSpaceTypes ?? [],
    shared_outdoor_space: p?.amenities?.sharedOutdoorSpaceTypes ?? [],
    parking: p?.amenities?.parkingTypes ?? [],
    pets: pet
      ? {
          cats: pet.catsAllowed,
          dogs: pet.dogsAllowed,
          max_dog_weight_lb: pet.maxDogWeight,
          restricted_breeds: pet.restrictedDogBreeds?.length ? pet.restrictedDogBreeds : undefined,
        }
      : null,
    building: b
      ? {
          name: b.name || null,
          type: b.type,
          year_built: b.yearBuilt || null,
          units: b.residentialUnitCount || null,
          other_rentals_available: b.rentalInventorySummary?.availableListingDigests?.length ?? 0,
          policies: b.policies?.list ?? [],
        }
      : null,
    price_history: history,
    open_houses: (l.upcomingOpenHouses ?? []).map((o) => ({
      start: o.startTime,
      end: o.endTime,
      by_appointment: o.appointmentOnly,
    })),
    photos: (l.media?.photos ?? []).slice(0, 20).map((ph) => photoUrl(ph.key)),
    photo_count: l.media?.photos?.length ?? 0,
    floor_plans: (l.media?.floorPlans ?? []).map((f) => photoUrl(f.key)),
    videos: (l.media?.videos ?? []).map((v) =>
      v.provider?.toUpperCase() === "YOUTUBE"
        ? `https://www.youtube.com/watch?v=${v.id}`
        : v.provider?.toUpperCase() === "VIMEO"
          ? `https://vimeo.com/${v.id}`
          : v.imageUrl,
    ),
    tour_3d: l.media?.tour3dUrl ?? null,
    streeteasy_nearby_transit: (b?.nearby?.transitStations ?? []).slice(0, 5).map((t) => ({
      name: t.name,
      routes: t.routes,
      lat: t.geo?.latitude,
      lng: t.geo?.longitude,
    })),
  };
}
