/**
 * StreetEasy GraphQL queries.
 *
 * Adapted from evandcoleman/streeteasy-api (MIT) via Alec2435/streeteasy-mcp (MIT).
 * StreetEasy has introspection disabled; these shapes are what its own web app
 * sends, and they can change without notice. When a query starts failing with a
 * validation error, compare against the site's requests in a browser's network tab.
 */
import type { Available, NumberRange, SearchFilters, SearchRentalsInput, Sorting } from "./types";

/**
 * Fragments shared by the search query. Kept as a top-level constant so it
 * can also be referenced by callers building custom queries via `client.request()`.
 */
export const SEARCH_RENTALS_FRAGMENTS = `
fragment LeadMediaForSRP on LeadMedia {
  __typename
  photo { __typename key }
  floorPlan { __typename key }
}
fragment OpenHouseForSRP on OpenHouseDigest {
  __typename
  startTime
  endTime
  appointmentOnly
}
fragment RentalListingDigestForSearchResults on SearchRentalListing {
  __typename
  id
  areaName
  availableAt
  bedroomCount
  buildingType
  fullBathroomCount
  furnished
  geoPoint { __typename latitude longitude }
  halfBathroomCount
  hasTour3d
  hasVideos
  isNewDevelopment
  leadMedia { __typename ...LeadMediaForSRP }
  leaseTermMonths
  livingAreaSize
  mediaAssetCount
  monthsFree
  noFee
  netEffectivePrice
  offMarketAt
  photos { __typename key }
  price
  priceChangedAt
  priceDelta
  slug
  sourceGroupLabel
  sourceType
  status
  street
  unit
  upcomingOpenHouse { __typename ...OpenHouseForSRP }
  urlPath
}
`;

const ENUM_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Serialize a JavaScript value as a GraphQL literal.
 *
 * We have to render enum values as bare identifiers (e.g. `LISTED_AT`), because
 * the StreetEasy server rejects them when sent as JSON strings in query
 * variables (it expects raw GraphQL enum tokens). This mirrors how the
 * StreetEasy frontend calls the API.
 */
export function gqlValue(value: unknown, opts: { enum?: boolean } = {}): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot serialize non-finite number: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return `[${value.map((v) => gqlValue(v, opts)).join(", ")}]`;
  }
  if (typeof value === "string") {
    if (opts.enum) {
      if (!ENUM_RE.test(value)) {
        throw new Error(
          `Invalid GraphQL enum value: ${JSON.stringify(value)} — expected uppercase identifier`,
        );
      }
      return value;
    }
    // GraphQL string literal — same encoding as JSON string
    return JSON.stringify(value);
  }
  if (typeof value === "object") {
    // Generic object → not used directly; callers should use the typed helpers
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${gqlValue(v)}`);
    return `{ ${entries.join(", ")} }`;
  }
  throw new Error(`Unsupported type for GraphQL serialization: ${typeof value}`);
}

function gqlNumberRange(r: NumberRange | undefined): string | null {
  if (!r) return null;
  return `{ lowerBound: ${gqlValue(r.lowerBound)}, upperBound: ${gqlValue(r.upperBound)} }`;
}

function gqlAvailable(a: Available | undefined): string | null {
  if (!a) return null;
  return `{ startDate: ${gqlValue(a.startDate)}, endDate: ${gqlValue(a.endDate)} }`;
}

function gqlFilters(f: SearchFilters): string {
  const parts: string[] = [];
  if (f.areas !== undefined) parts.push(`areas: [${f.areas.join(", ")}]`);
  if (f.rentalStatus !== undefined) {
    parts.push(`rentalStatus: ${gqlValue(f.rentalStatus, { enum: true })}`);
  }
  if (f.price !== undefined) parts.push(`price: ${gqlNumberRange(f.price)}`);
  if (f.bedrooms !== undefined) parts.push(`bedrooms: ${gqlNumberRange(f.bedrooms)}`);
  if (f.bathrooms !== undefined) parts.push(`bathrooms: ${gqlNumberRange(f.bathrooms)}`);
  if (f.amenities !== undefined) {
    const list = f.amenities.map((a) => gqlValue(a, { enum: true })).join(", ");
    parts.push(`amenities: [${list}]`);
  }
  if (f.optionalAmenities !== undefined) {
    const list = f.optionalAmenities.map((a) => gqlValue(a, { enum: true })).join(", ");
    parts.push(`optionalAmenities: [${list}]`);
  }
  if (f.petsAllowed !== undefined) parts.push(`petsAllowed: ${gqlValue(f.petsAllowed)}`);
  if (f.available !== undefined) parts.push(`available: ${gqlAvailable(f.available)}`);
  return `{ ${parts.join(", ")} }`;
}

function gqlSorting(s: Sorting): string {
  return `{ attribute: ${gqlValue(s.attribute, { enum: true })}, direction: ${gqlValue(s.direction, { enum: true })} }`;
}

/**
 * Build the SearchRentalsFederated query with enum values inlined.
 *
 * Why this exists: the StreetEasy GraphQL server rejects enum values sent as
 * JSON strings in query variables (see e.g. `SortingAttributeInput`,
 * `RentalStatus`, `AdStrategy`). Rendering the entire input inline with bare
 * enum tokens is how the StreetEasy frontend calls the API, and the only
 * shape the server accepts today.
 */
export function buildSearchRentalsQuery(
  input: SearchRentalsInput & { adStrategy: string; userSearchToken: string },
): string {
  const sorting: Sorting = input.sorting ?? {
    attribute: "RECOMMENDED",
    direction: "DESCENDING",
  };

  const inputParts: string[] = [
    `sorting: ${gqlSorting(sorting)}`,
    `filters: ${gqlFilters(input.filters)}`,
    `adStrategy: ${gqlValue(input.adStrategy, { enum: true })}`,
    `userSearchToken: ${gqlValue(input.userSearchToken)}`,
  ];
  if (input.perPage !== undefined) inputParts.push(`perPage: ${gqlValue(input.perPage)}`);
  if (input.page !== undefined) inputParts.push(`page: ${gqlValue(input.page)}`);

  const inputLiteral = `{ ${inputParts.join(", ")} }`;

  return `
query SearchRentalsFederated {
  searchRentals(input: ${inputLiteral}) {
    __typename
    edges {
      __typename
      ... on OrganicRentalEdge {
        node { __typename ...RentalListingDigestForSearchResults }
        amenitiesMatch
        matchedAmenities
        missingAmenities
      }
      ... on FeaturedRentalEdge {
        node { __typename ...RentalListingDigestForSearchResults }
        amenitiesMatch
        matchedAmenities
        missingAmenities
      }
      ... on SponsoredRentalEdge {
        node { __typename ...RentalListingDigestForSearchResults }
        sponsoredSimilarityLabel
      }
    }
    totalCount
  }
}
${SEARCH_RENTALS_FRAGMENTS}
`;
}

export const RENTAL_LISTING_DETAILS_QUERY = `
  query RentalListingDetailsFederated($listingID: ID!) {
    rentalByListingId(id: $listingID) {
      __typename
      id
      offMarketAt
      availableAt
      buildingId
      status
      statusChanges {
        __typename
        status
        changedAt
      }
      createdAt
      updatedAt
      interestingChangeAt
      description
      media {
        __typename
        ...MediaInfo
      }
      propertyDetails {
        __typename
        ...PropertyInfo
      }
      mlsNumber
      backOffice {
        __typename
        brokerageListingId
      }
      pricing {
        __typename
        leaseTermMonths
        monthsFree
        noFee
        price
        priceDelta
        priceChanges {
          __typename
          changedAt
        }
      }
      recentListingsPriceStats {
        __typename
        rentalPriceStats {
          __typename
          medianPrice
        }
        salePriceStats {
          __typename
          medianPrice
        }
      }
      upcomingOpenHouses {
        __typename
        ...FederatedOpenHouseInfo
      }
      listingSource {
        __typename
        ...ListingSourceInfo
      }
      propertyHistory {
        __typename
        ...RentalPropertyHistory
      }
    }
    buildingByRentalListingId(id: $listingID) {
      __typename
      ...ListingBuildingInfo
    }
    getBuildingExpressByRentalListingId(id: $listingID) {
      __typename
      ...NearbySchools
    }
    getRelloRentalById(id: $listingID) {
      __typename
      ...RelloInfo
    }
    getRentalListingExpressById(id: $listingID) {
      __typename
      hasActiveBuildingShowcase
    }
  }
  fragment FederatedOpenHouseInfo on OpenHouse {
    __typename
    id
    startTime
    endTime
    appointmentOnly
  }
  fragment ListingBuildingInfo on Building {
    __typename
    id
    name
    type
    residentialUnitCount
    yearBuilt
    status
    additionalDetails {
      __typename
      leasingStartDate
      salesStartDate
    }
    address {
      __typename
      street
      city
      state
      zipCode
    }
    heroImage {
      __typename
      key
    }
    media {
      __typename
      photos {
        __typename
        key
      }
    }
    complex {
      __typename
      id
      name
    }
    area {
      __typename
      name
    }
    media {
      __typename
      photos {
        __typename
        key
      }
    }
    saleInventorySummary {
      __typename
      availableListingDigests {
        __typename
        id
      }
    }
    rentalInventorySummary {
      __typename
      availableListingDigests {
        __typename
        id
      }
    }
    isLandLease
    policies {
      __typename
      list
      petPolicy {
        __typename
        catsAllowed
        dogsAllowed
        maxDogWeight
        restrictedDogBreeds
      }
    }
    nearby {
      __typename
      transitStations {
        __typename
        name
        distance
        routes
        geo {
          __typename
          latitude
          longitude
        }
      }
    }
  }
  fragment ListingSourceInfo on ListingSource {
    __typename
    sourceType
  }
  fragment MediaInfo on Media {
    __typename
    photos {
      __typename
      key
    }
    floorPlans {
      __typename
      key
    }
    videos {
      __typename
      imageUrl
      id
      provider
    }
    tour3dUrl
    assetCount
  }
  fragment NearbySchools on BuildingExpress {
    __typename
    nearbySchools {
      __typename
      name
      district
      grades
      id
      idstr
      geoCenter {
        __typename
        latitude
        longitude
      }
    }
  }
  fragment PriceChangePercent on PriceChangeOfInterest {
    __typename
    pricePercentChange
  }
  fragment PropertyInfo on PropertyDetails {
    __typename
    address {
      __typename
      street
      houseNumber
      streetName
      city
      state
      zipCode
      unit
    }
    roomCount
    bedroomCount
    fullBathroomCount
    halfBathroomCount
    livingAreaSize
    amenities {
      __typename
      list
      doormanTypes
      parkingTypes
      sharedOutdoorSpaceTypes
      storageSpaceTypes
    }
    features {
      __typename
      list
      fireplaceTypes
      privateOutdoorSpaceTypes
      views
    }
  }
  fragment RelloInfo on RelloExpress {
    __typename
    rentalId
    ctaEnabled
    link
  }
  fragment RentalPropertyHistory on RentalListingChangesOfInterest {
    __typename
    listingId
    sourceGroupLabel
    photos {
      __typename
      key
    }
    offMarketAt
    rentalEventsOfInterest {
      __typename
      date
      price
      ...PriceChangePercent
      ... on RentalStatusChangeOfInterest {
        status
      }
    }
  }
`;
