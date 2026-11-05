/**
 * "Try a checkout": runs the rules in the form, including unsaved changes,
 * against an address and email the merchant types. Uses the same rule engine
 * as the checkout Function, in the browser, so nothing is sent anywhere.
 */

import { useEffect, useMemo, useState } from "react";
import { Banner, BlockStack, Button, Checkbox, InlineGrid, InlineStack, List, Select, Text, TextField } from "@shopify/polaris";

import { useI18n } from "../i18n/context";
import type { Option } from "../lib/regions";
import { evaluateCart, type RuleConfig, type Violation } from "../../extensions/cartguard-validator/src/rules";

export type TesterInput = {
  countryCode: string;
  provinceCode: string;
  city: string;
  zip: string;
  address1: string;
  address2: string;
  email: string;
  signedIn: boolean;
};

export const EMPTY_TESTER_INPUT: TesterInput = {
  countryCode: "",
  provinceCode: "",
  city: "",
  zip: "",
  address1: "",
  address2: "",
  email: "",
  signedIn: false,
};

/** True once the merchant has typed anything worth checking. */
export function hasTesterInput(input: TesterInput): boolean {
  return [input.countryCode, input.provinceCode, input.city, input.zip, input.address1, input.address2, input.email].some(
    (value) => value.trim() !== "",
  );
}

/**
 * The violations a checkout with this address and email would get. No cart
 * lines are sent, so quantity and order total limits never fire here.
 */
export function testCheckout(input: TesterInput, config: RuleConfig): Violation[] {
  const hasAddress = [input.countryCode, input.provinceCode, input.city, input.zip, input.address1, input.address2].some(
    (value) => value.trim() !== "",
  );
  const email = input.email.trim() || null;
  return evaluateCart(
    {
      email,
      customerEmail: input.signedIn ? email : null,
      lines: [],
      addresses: hasAddress
        ? [
            {
              groupIndex: 0,
              address: {
                countryCode: input.countryCode || null,
                provinceCode: input.provinceCode.trim() || null,
                city: input.city,
                zip: input.zip,
                address1: input.address1,
                address2: input.address2,
              },
            },
          ]
        : [],
    },
    config,
  );
}

export function CheckoutTester({ config, countryOptions }: { config: RuleConfig; countryOptions: Option[] }) {
  const { t } = useI18n();
  const [input, setInput] = useState<TesterInput>(EMPTY_TESTER_INPUT);
  const set = (patch: Partial<TesterInput>) => setInput((current) => ({ ...current, ...patch }));
  const violations = useMemo(() => (hasTesterInput(input) ? testCheckout(input, config) : null), [input, config]);
  // Country names come from Intl, and Node and the browser can spell a few
  // differently ("Falkland Islands"), which breaks hydration. The list is
  // only filled in once the page is running in the browser.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const options = useMemo(
    () => [{ label: t("tester.chooseCountry"), value: "" }, ...(hydrated ? countryOptions.filter((option) => option.value) : [])],
    [countryOptions, hydrated, t],
  );

  return (
    <BlockStack gap="400">
      <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
        <TextField label={t("tester.address1")} value={input.address1} onChange={(address1) => set({ address1 })} autoComplete="off" />
        <TextField label={t("tester.address2")} value={input.address2} onChange={(address2) => set({ address2 })} autoComplete="off" />
      </InlineGrid>
      <InlineGrid columns={{ xs: 1, md: 3 }} gap="300">
        <TextField label={t("tester.city")} value={input.city} onChange={(city) => set({ city })} autoComplete="off" />
        <TextField
          label={t("tester.province")}
          helpText={t("tester.provinceHelp")}
          value={input.provinceCode}
          onChange={(provinceCode) => set({ provinceCode })}
          autoComplete="off"
        />
        <TextField label={t("tester.zip")} value={input.zip} onChange={(zip) => set({ zip })} autoComplete="off" />
      </InlineGrid>
      <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
        <Select label={t("tester.country")} options={options} value={input.countryCode} onChange={(countryCode) => set({ countryCode })} />
        <TextField label={t("tester.email")} type="email" value={input.email} onChange={(email) => set({ email })} autoComplete="off" />
      </InlineGrid>
      <Checkbox
        label={t("tester.signedIn")}
        helpText={t("tester.signedInHelp")}
        checked={input.signedIn}
        onChange={(signedIn) => set({ signedIn })}
      />

      <div aria-live="polite">
        {violations === null ? (
          <Text as="p" tone="subdued">
            {t("tester.empty")}
          </Text>
        ) : violations.length === 0 ? (
          <Banner tone="success" title={t("tester.passes.title")}>
            <Text as="p">{t("tester.passes.body")}</Text>
          </Banner>
        ) : (
          <Banner tone="critical" title={t("tester.blocked.title")}>
            <List>
              {violations.map((violation, index) => (
                <List.Item key={`${index}-${violation.target}`}>
                  <BlockStack gap="050">
                    <Text as="span">{t("tester.blocked.customerSees", { message: violation.message })}</Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {t("tester.blocked.why", { detail: violation.detail })}
                    </Text>
                  </BlockStack>
                </List.Item>
              ))}
            </List>
          </Banner>
        )}
      </div>

      <InlineStack align="space-between" blockAlign="center" gap="300">
        <Text as="p" variant="bodySm" tone="subdued">
          {t("tester.note")}
        </Text>
        {hasTesterInput(input) && (
          <Button variant="plain" onClick={() => setInput(EMPTY_TESTER_INPUT)}>
            {t("tester.clear")}
          </Button>
        )}
      </InlineStack>
    </BlockStack>
  );
}
