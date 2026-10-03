/**
 * Country and region reference data for the block rules editor (browser) and
 * rule validation (server). Pure: no I/O. Country names come from the
 * runtime's Intl data, so they match what merchants see elsewhere.
 */

import { resolveCountryCode, splitCountryScope } from "../../extensions/cartguard-validator/src/rules";

const COUNTRY_CODES_RAW =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO " +
  "FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE " +
  "JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO " +
  "MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW " +
  "PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM " +
  "TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW";

export const COUNTRY_CODES: readonly string[] = COUNTRY_CODES_RAW.split(" ");
const COUNTRY_SET = new Set(COUNTRY_CODES);

export type Option = { label: string; value: string };

let regionNames: Intl.DisplayNames | null | undefined;

function displayNames(): Intl.DisplayNames | null {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  return regionNames;
}

export function isCountryCode(value: string): boolean {
  return COUNTRY_SET.has(value.trim().toUpperCase());
}

/** "CR" -> "Costa Rica". Values that aren't country codes are returned as-is. */
export function countryName(code: string): string {
  const upper = code.trim().toUpperCase();
  if (!COUNTRY_SET.has(upper)) return code.trim();
  if (upper === "XK") return "Kosovo";
  try {
    return displayNames()?.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

let countryOptions: Option[] | null = null;

/** Every country, sorted by name. */
export function getCountryOptions(): Option[] {
  if (!countryOptions) {
    countryOptions = COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code) })).sort((a, b) =>
      a.label.localeCompare(b.label, "en"),
    );
  }
  return countryOptions;
}

/** Lowercase, accent-free, punctuation-free form used for searching. */
export function searchKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

let codesByName: Map<string, string> | null = null;

/** Resolves "CR", "cr", "Costa Rica", "USA" or "UK" to a country code. Null when unknown. */
export function findCountry(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (isCountryCode(raw)) return raw.toUpperCase();
  if (!codesByName) {
    codesByName = new Map(getCountryOptions().map((option) => [searchKey(option.label), option.value]));
  }
  const byName = codesByName.get(searchKey(raw));
  if (byName) return byName;
  const alias = resolveCountryCode(raw);
  return alias && COUNTRY_SET.has(alias) ? alias : null;
}

/* States and provinces */

const REGION_DATA: Record<string, string> = {
  US:
    "AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|" +
    "DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|" +
    "KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|" +
    "MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|" +
    "NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|" +
    "SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|" +
    "WV:West Virginia|WI:Wisconsin|WY:Wyoming|AS:American Samoa|GU:Guam|MP:Northern Mariana Islands|" +
    "PR:Puerto Rico|VI:U.S. Virgin Islands|UM:U.S. Minor Outlying Islands|AA:Armed Forces Americas|" +
    "AE:Armed Forces Europe|AP:Armed Forces Pacific",
  CA:
    "AB:Alberta|BC:British Columbia|MB:Manitoba|NB:New Brunswick|NL:Newfoundland and Labrador|NS:Nova Scotia|" +
    "NT:Northwest Territories|NU:Nunavut|ON:Ontario|PE:Prince Edward Island|QC:Quebec|SK:Saskatchewan|YT:Yukon",
  AU:
    "ACT:Australian Capital Territory|NSW:New South Wales|NT:Northern Territory|QLD:Queensland|SA:South Australia|" +
    "TAS:Tasmania|VIC:Victoria|WA:Western Australia",
};

/** Countries with a built-in state/province list. Others take a region code. */
export const REGION_COUNTRIES = ["US", "CA", "AU"] as const;

const REGIONS: Record<string, Option[]> = Object.fromEntries(
  Object.entries(REGION_DATA).map(([country, list]) => [
    country,
    list.split("|").map((pair) => {
      const [value, label] = pair.split(":");
      return { value, label };
    }),
  ]),
);

export function regionOptions(country: string): Option[] {
  return REGIONS[country.toUpperCase()] ?? [];
}

export function regionName(country: string, code: string): string | null {
  return REGIONS[country.toUpperCase()]?.find((region) => region.value === code.toUpperCase())?.label ?? null;
}

const STATE_ENTRY = /^\s*([a-z]{2})\s*[-:]\s*([a-z0-9]+(?: [a-z0-9]+)?)\s*$/i;
const MAX_REGION_CODE_LENGTH = 6;

/**
 * Shopify region codes are short letters/numbers, sometimes with one space
 * ("13", "MH", "TAMPS", "Q ROO"). For countries with a built-in list the
 * code must be on it.
 */
export function isValidRegionCode(country: string, code: string): boolean {
  const upper = code.trim().toUpperCase().replace(/\s+/g, " ");
  if (!upper || upper.length > MAX_REGION_CODE_LENGTH || !/^[A-Z0-9]+(?: [A-Z0-9]+)?$/.test(upper)) return false;
  const known = REGIONS[country.trim().toUpperCase()];
  return known ? known.some((region) => region.value === upper) : true;
}

/** "US-CA", "JP-13", "MX-TAMPS" or a bare code such as "WA" (any country). */
export function isValidStateEntry(entry: string): boolean {
  const scoped = STATE_ENTRY.exec(entry);
  if (scoped) return isCountryCode(scoped[1]) && isValidRegionCode(scoped[1], scoped[2]);
  return /^\s*[a-z0-9]{1,3}\s*$/i.test(entry);
}

/** "US-CA" -> "California, United States"; "WA" -> "WA (any country)". */
export function describeStateEntry(entry: string): string {
  const scoped = STATE_ENTRY.exec(entry);
  if (!scoped) return `${entry.trim().toUpperCase()} (any country)`;
  const country = scoped[1].toUpperCase();
  const code = scoped[2].toUpperCase();
  return `${regionName(country, code) ?? code}, ${countryName(country)}`;
}

/** "US:Austin" -> "Austin, United States"; "Austin" stays "Austin". */
export function describeScopedEntry(entry: string): string {
  const { country, value } = splitCountryScope(entry, false);
  return country && isCountryCode(country) ? `${value.trim()}, ${countryName(country)}` : entry.trim();
}
