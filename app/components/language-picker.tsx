/**
 * Language selection, shown once after install and then available in Settings.
 *
 * Both surfaces post to the same `/language` action and then revalidate, so the
 * new language is rendered by the server rather than swapped in on the client.
 * That is what keeps it consistent with `<html lang>` and with Polaris' own
 * strings, which only change on a server render.
 */

import { useState } from "react";
import { useFetcher } from "@remix-run/react";
import { Banner, BlockStack, Button, Card, InlineStack, Select, Text } from "@shopify/polaris";

import { useI18n } from "../i18n/context";
import { LANGUAGE_OPTIONS, type Language } from "../i18n/locales";

type SaveResponse = { ok: boolean; language?: Language | null; error?: string };

type Props = {
  /** The language saved for this shop, or null when following the admin. */
  value: Language;
  /** True when the merchant has made an explicit choice. */
  chosen: boolean;
  /** True when the current language was detected rather than chosen. */
  detected: boolean;
  /** The admin locale offered as a shortcut, when it maps to a language we have. */
  adminLanguage?: Language | null;
};

/**
 * The always-available selector in Settings. Saves immediately on change, so
 * there is no separate Save button to forget to press.
 */
export function LanguageSetting({ value, chosen, detected, adminLanguage }: Props) {
  const { t } = useI18n();
  const fetcher = useFetcher<SaveResponse>();
  const [pending, setPending] = useState<Language | null>(null);

  // Show the value being saved rather than the settled one, so a slow request
  // does not make the control snap back to the previous language.
  const shown = pending ?? value;
  const saving = fetcher.state !== "idle";

  const save = (next: string) => {
    setPending(next as Language);
    fetcher.submit({ language: next }, { method: "post", action: "/language" });
  };

  return (
    <BlockStack gap="300">
      <Select
        label={t("language.fieldLabel")}
        labelHidden
        options={LANGUAGE_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
        value={shown}
        onChange={save}
        disabled={saving}
        helpText={
          <span id="language-status">
            {fetcher.state === "idle" && fetcher.data && !fetcher.data.ok
              ? t("language.saveFailed")
              : !chosen && detected
                ? t("language.detected")
                : chosen
                  ? t("language.saved")
                  : t("language.description")}
          </span>
        }
      />
      {adminLanguage && adminLanguage !== value && (
        <InlineStack>
          <Button
            loading={saving}
            onClick={() => save(adminLanguage)}
            accessibilityLabel={t("language.useAdminLocale")}
          >
            {t("language.useAdminLocale")}
          </Button>
        </InlineStack>
      )}
    </BlockStack>
  );
}

/**
 * The first-launch picker. Rendered as a modal over the app rather than as a
 * separate page so the merchant can see what they are about to set up, and so
 * skipping leaves them in the app instead of on a dead end.
 */
export function LanguageOnboarding({ detectedLanguage }: { detectedLanguage: Language }) {
  const { t } = useI18n();
  const fetcher = useFetcher<SaveResponse>();
  const [selection, setSelection] = useState<Language>(detectedLanguage);
  const saving = fetcher.state !== "idle";
  const failed = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok;

  const finish = (next: Language | null) => {
    fetcher.submit(next ? { language: next } : {}, { method: "post", action: "/language" });
  };

  return (
    <div className="cg-modal-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("language.stepTitle")}
        className="cg-modal"
      >
        <Card>
          <BlockStack gap="400">
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                {t("language.stepTitle")}
              </Text>
              <Text as="p" tone="subdued">
                {t("language.onboardingDescription")}
              </Text>
            </BlockStack>

            {failed && (
              <Banner tone="critical">
                <Text as="p">{t("language.saveFailed")}</Text>
              </Banner>
            )}

            <Select
              label={t("language.fieldLabel")}
              labelHidden
              options={LANGUAGE_OPTIONS.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              value={selection}
              onChange={(next) => setSelection(next as Language)}
            />

            <InlineStack align="end" gap="200">
              <Button onClick={() => finish(null)} disabled={saving}>
                {t("language.skip")}
              </Button>
              <Button variant="primary" loading={saving} onClick={() => finish(selection)}>
                {t("language.continue")}
              </Button>
            </InlineStack>

            <Text as="p" variant="bodySm" tone="subdued">
              {t("language.description")}
            </Text>
          </BlockStack>
        </Card>
      </div>
    </div>
  );
}
