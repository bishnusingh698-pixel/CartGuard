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

import { useI18n } from "../i18n/context";
import { REGION_COUNTRIES, countryName, describeStateEntry, getCountryOptions, regionOptions, searchKey } from "../lib/regions";
import { type ParseResult, parseCountryEntry, parseRegionCode } from "../lib/rule-editor";

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
  const { t, number } = useI18n();
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
              accessibilityLabel={t("list.chip.remove", { value: text })}
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
              {expanded ? t("list.showFewer") : t("list.showAll", { count: number(values.length) })}
            </Button>
          )}
          {values.length >= 5 && (
            <Button variant="plain" tone="critical" onClick={() => onChange([])} accessibilityLabel={t("list.removeAll", { label })}>
              {t("common.removeAll")}
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
  emptyText,
  allowMany = true,
  error,
  scope,
  showChips = true,
}: ListFieldProps) {
  const { t, number } = useI18n();
  const emptyLabel = emptyText ?? t("list.nothingAdded");
  const [input, setInput] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const add = () => {
    const parts = (allowMany ? input.split(/[\n,;]+/) : [input]).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return;
    const { next, rejected, error: firstError, duplicates } = addEntries(values, parts, parse);
    if (next.length !== values.length) onChange(next);
    setInput(rejected.join(", "));
    setInputError(
      firstError && rejected.length > 1 ? t("list.rejected", { count: number(rejected.length), reason: firstError }) : firstError,
    );
    setNotice(
      !firstError && duplicates > 0
        ? parts.length === 1
          ? t("list.duplicateOne")
          : t("list.duplicateMany", { count: number(duplicates) })
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
        <ChipList label={listName ?? label} values={values} onChange={onChange} format={format} emptyText={emptyLabel} />
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
  const { t } = useI18n();
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
        listTitle={t("fields.countries.listTitle")}
        emptyState={
          <Box padding="300">
            <Text as="p" tone="subdued">
              {t("fields.countries.noMatch", { query })}
            </Text>
          </Box>
        }
        textField={
          <Autocomplete.TextField
            label={label}
            helpText={helpText}
            value={query}
            onChange={setQuery}
            placeholder={t("fields.countries.searchPlaceholder")}
            autoComplete="off"
            error={error}
          />
        }
      />
      <ChipList
        label={t("fields.countries.listName")}
        values={values}
        onChange={onChange}
        format={countryName}
        emptyText={t("fields.countries.empty")}
      />
      <InlineStack>
        <Button variant="plain" onClick={() => setPasteOpen((open) => !open)} ariaExpanded={pasteOpen}>
          {pasteOpen ? t("fields.countries.pasteToggleHide") : t("fields.countries.pasteToggle")}
        </Button>
      </InlineStack>
      {pasteOpen && (
        <ListField
          label={t("fields.countries.pasteLabel")}
          helpText={t("fields.countries.pasteHelp")}
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
  const { t } = useI18n();
  const [country, setCountry] = useState<string>(REGION_COUNTRIES[0]);
  const [region, setRegion] = useState("");
  const [otherCountry, setOtherCountry] = useState("");
  const [code, setCode] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const countryChoices = useMemo(
    () => [
      ...REGION_COUNTRIES.map((value) => ({ label: countryName(value), value })),
      { label: t("fields.states.otherCountry"), value: OTHER_COUNTRY },
    ],
    [t],
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
        setInputError(t("fields.states.needState"));
        return;
      }
      entry = `${country}-${region}`;
    } else {
      if (!otherCountry) {
        setInputError(t("fields.states.needCountry"));
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
      setInputError(t("fields.states.duplicate"));
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
          {t("fields.states.help")}
        </Text>
      </BlockStack>
      <Form onSubmit={add}>
        <InlineGrid columns={{ xs: 1, sm: "1fr 1fr auto" }} gap="200" alignItems="end">
          <Select
            label={t("fields.states.country")}
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
                label={t("fields.states.whichCountry")}
                placeholder={t("fields.states.choose")}
                options={otherCountries}
                value={otherCountry}
                onChange={(value) => {
                  setOtherCountry(value);
                  setInputError(null);
                }}
              />
              <TextField
                label={t("fields.states.regionCode")}
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
              label={t("fields.states.stateOrProvince")}
              placeholder={t("fields.states.chooseOne")}
              options={regionOptions(country)}
              value={region}
              onChange={(value) => {
                setRegion(value);
                setInputError(null);
              }}
            />
          )}
          <Button submit>{t("common.add")}</Button>
        </InlineGrid>
      </Form>
      {isOther && (
        <Text as="p" variant="bodySm" tone="subdued">
          {t("fields.states.otherHelp")}
        </Text>
      )}
      {shownError && <InlineError message={shownError} fieldID="cartguard-region" />}
      <ChipList
        label={t("fields.states.listName")}
        values={values}
        onChange={onChange}
        format={describeStateEntry}
        emptyText={t("fields.states.empty")}
      />
    </BlockStack>
  );
}
