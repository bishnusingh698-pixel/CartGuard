/**
 * Form controls used to build CartGuard rules. One component language: every
 * list of values is a text field or picker plus removable chips, validated as
 * the merchant adds each entry.
 */

import { type ReactNode, useMemo, useState } from "react";
import {
  Autocomplete,
  BlockStack,
  Box,
  Button,
  Form,
  InlineError,
  InlineGrid,
  InlineStack,
  Select,
  Tag,
  Text,
  TextField,
} from "@shopify/polaris";

import { REGION_COUNTRIES, countryName, describeStateEntry, getCountryOptions, regionOptions, searchKey } from "../lib/regions";
import { type ParseResult, parseCountryEntry, parseRegionCode } from "../lib/rule-editor";
import { formatNumber } from "../lib/rule-summary";

const CHIP_PREVIEW = 30;

/* Chips */

type ChipListProps = {
  /** Plural name of the list, used in button labels ("blocked countries"). */
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  format?: (value: string) => string;
  emptyText: string;
};

export function ChipList({ label, values, onChange, format, emptyText }: ChipListProps) {
  const [expanded, setExpanded] = useState(false);
  if (values.length === 0) {
    return (
      <Text as="p" variant="bodySm" tone="subdued">
        {emptyText}
      </Text>
    );
  }
  const visible = expanded ? values : values.slice(0, CHIP_PREVIEW);
  return (
    <BlockStack gap="200">
      <InlineStack gap="200" wrap>
        {visible.map((value, index) => {
          const text = format ? format(value) : value;
          return (
            <Tag
              key={`${index}-${value}`}
              onRemove={() => onChange(values.filter((_, position) => position !== index))}
              accessibilityLabel={`Remove ${text}`}
            >
              {text}
            </Tag>
          );
        })}
      </InlineStack>
      {(values.length > CHIP_PREVIEW || values.length >= 5) && (
        <InlineStack gap="400">
          {values.length > CHIP_PREVIEW && (
            <Button variant="plain" onClick={() => setExpanded((current) => !current)}>
              {expanded ? "Show fewer" : `Show all ${formatNumber(values.length)}`}
            </Button>
          )}
          {values.length >= 5 && (
            <Button variant="plain" tone="critical" onClick={() => onChange([])} accessibilityLabel={`Remove all ${label}`}>
              Remove all
            </Button>
          )}
        </InlineStack>
      )}
    </BlockStack>
  );
}

/* Text list */

function addEntries(values: string[], parts: string[], parse: (raw: string) => ParseResult) {
  const next = [...values];
  const seen = new Set(values.map((value) => value.toLowerCase()));
  const rejected: string[] = [];
  let error: string | null = null;
  let duplicates = 0;
  for (const part of parts) {
    const result = parse(part);
    if ("error" in result) {
      rejected.push(part);
      error ??= result.error;
      continue;
    }
    const key = result.value.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    next.push(result.value);
  }
  return { next, rejected, error, duplicates };
}

type ListFieldProps = {
  label: string;
  /** Plural name used in chip button labels. Defaults to the label. */
  listName?: string;
  helpText?: ReactNode;
  placeholder?: string;
  values: string[];
  onChange: (values: string[]) => void;
  parse: (raw: string) => ParseResult;
  format?: (value: string) => string;
  emptyText?: string;
  /** Split typed or pasted text on commas, semicolons and line breaks. */
  allowMany?: boolean;
  /** Problems with entries that are already in the list. */
  error?: string;
  /** Shown to the left of the input, such as a country choice. */
  scope?: ReactNode;
  showChips?: boolean;
};

export function ListField({
  label,
  listName,
  helpText,
  placeholder,
  values,
  onChange,
  parse,
  format,
  emptyText = "Nothing added yet.",
  allowMany = true,
  error,
  scope,
  showChips = true,
}: ListFieldProps) {
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const add = () => {
    const parts = (allowMany ? input.split(/[\n,;]+/) : [input]).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const { next, rejected, error: firstError, duplicates } = addEntries(values, parts, parse);
    if (next.length !== values.length) onChange(next);
    setInput(rejected.join(", "));
    setInputError(firstError && rejected.length > 1 ? `${rejected.length} entries weren't added. ${firstError}` : firstError);
    setNotice(
      !firstError && duplicates > 0
        ? parts.length === 1
          ? "That's already on the list."
          : `Skipped ${formatNumber(duplicates)} already on the list.`
        : null,
    );
  };

  return (
    <BlockStack gap="200">
      <Form onSubmit={add}>
        <TextField
          label={label}
          helpText={notice ?? helpText}
          placeholder={placeholder}
          value={input}
          onChange={(value) => {
            setInput(value);
            setInputError(null);
            setNotice(null);
          }}
          autoComplete="off"
          error={inputError ?? error}
          connectedLeft={scope}
          connectedRight={
            <Button submit disabled={!input.trim()}>
              Add
            </Button>
          }
        />
      </Form>
      {showChips && (
        <ChipList label={listName ?? label} values={values} onChange={onChange} format={format} emptyText={emptyText} />
      )}
    </BlockStack>
  );
}

/* Countries */

type CountryPickerProps = {
  label: string;
  helpText?: ReactNode;
  values: string[];
  onChange: (values: string[]) => void;
  error?: string;
};

export function CountryPicker({ label, helpText, values, onChange, error }: CountryPickerProps) {
  const [query, setQuery] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const allOptions = useMemo(() => getCountryOptions(), []);
  const options = useMemo(() => {
    const key = searchKey(query);
    if (!key) return allOptions;
    return allOptions.filter((option) => searchKey(option.label).includes(key) || option.value.toLowerCase() === key);
  }, [allOptions, query]);

  return (
    <BlockStack gap="200">
      <Autocomplete
        allowMultiple
        options={options}
        selected={values}
        onSelect={(selected) => onChange(selected)}
        listTitle="Countries"
        emptyState={
          <Box padding="300">
            <Text as="p" tone="subdued">
              No countries match &quot;{query}&quot;.
            </Text>
          </Box>
        }
        textField={
          <Autocomplete.TextField
            label={label}
            helpText={helpText}
            value={query}
            onChange={setQuery}
            placeholder="Search for a country"
            autoComplete="off"
            error={error}
          />
        }
      />
      <ChipList label="blocked countries" values={values} onChange={onChange} format={countryName} emptyText="No countries blocked." />
      <InlineStack>
        <Button variant="plain" onClick={() => setPasteOpen((open) => !open)} ariaExpanded={pasteOpen}>
          {pasteOpen ? "Hide list entry" : "Add several countries at once"}
        </Button>
      </InlineStack>
      {pasteOpen && (
        <ListField
          label="Paste a list of countries"
          helpText="Separate names or 2-letter codes with commas, for example: Kazakhstan, CR, Russia."
          values={values}
          onChange={onChange}
          parse={parseCountryEntry}
          showChips={false}
        />
      )}
    </BlockStack>
  );
}

/* States and provinces */

const OTHER_COUNTRY = "other";

type RegionPickerProps = {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  error?: string;
};

export function RegionPicker({ label, values, onChange, error }: RegionPickerProps) {
  const [country, setCountry] = useState<string>(REGION_COUNTRIES[0]);
  const [region, setRegion] = useState("");
  const [otherCountry, setOtherCountry] = useState("");
  const [code, setCode] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const countryChoices = useMemo(
    () => [
      ...REGION_COUNTRIES.map((value) => ({ label: countryName(value), value })),
      { label: "Another country (enter a code)", value: OTHER_COUNTRY },
    ],
    [],
  );
  const otherCountries = useMemo(
    () => getCountryOptions().filter((option) => !(REGION_COUNTRIES as readonly string[]).includes(option.value)),
    [],
  );
  const isOther = country === OTHER_COUNTRY;

  const add = () => {
    let entry: string;
    if (!isOther) {
      if (!region) {
        setInputError("Choose a state or province first.");
        return;
      }
      entry = `${country}-${region}`;
    } else {
      if (!otherCountry) {
        setInputError("Choose a country first.");
        return;
      }
      const parsed = parseRegionCode(code);
      if ("error" in parsed) {
        setInputError(parsed.error);
        return;
      }
      entry = `${otherCountry}-${parsed.value}`;
    }
    if (values.some((value) => value.toUpperCase() === entry.toUpperCase())) {
      setInputError("That's already on the list.");
      return;
    }
    onChange([...values, entry]);
    setRegion("");
    setCode("");
    setInputError(null);
  };

  const shownError = inputError ?? error;

  return (
    <BlockStack gap="200">
      <BlockStack gap="100">
        <Text as="p">{label}</Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Choose from the list for the United States, Canada and Australia. For any other country, choose Another country and enter
          the region code Shopify shows on its orders.
        </Text>
      </BlockStack>
      <Form onSubmit={add}>
        <InlineGrid columns={{ xs: 1, sm: "1fr 1fr auto" }} gap="200" alignItems="end">
          <Select
            label="Country"
            options={countryChoices}
            value={country}
            onChange={(value) => {
              setCountry(value);
              setRegion("");
              setInputError(null);
            }}
          />
          {isOther ? (
            <InlineGrid columns={2} gap="200">
              <Select
                label="Which country"
                placeholder="Choose"
                options={otherCountries}
                value={otherCountry}
                onChange={(value) => {
                  setOtherCountry(value);
                  setInputError(null);
                }}
              />
              <TextField
                label="Region code"
                placeholder="13"
                value={code}
                onChange={(value) => {
                  setCode(value);
                  setInputError(null);
                }}
                autoComplete="off"
              />
            </InlineGrid>
          ) : (
            <Select
              id="cartguard-region"
              label="State or province"
              placeholder="Choose one"
              options={regionOptions(country)}
              value={region}
              onChange={(value) => {
                setRegion(value);
                setInputError(null);
              }}
            />
          )}
          <Button submit>Add</Button>
        </InlineGrid>
      </Form>
      {isOther && (
        <Text as="p" variant="bodySm" tone="subdued">
          Use the region code Shopify shows on the order&apos;s shipping address, such as 13 for Tokyo in Japan. Some countries, like the
          United Kingdom, have no region on Shopify addresses. For those, block a city or postal code below instead.
        </Text>
      )}
      {shownError && <InlineError message={shownError} fieldID="cartguard-region" />}
      <ChipList
        label="blocked states and provinces"
        values={values}
        onChange={onChange}
        format={describeStateEntry}
        emptyText="No states or provinces blocked."
      />
    </BlockStack>
  );
}
