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
import { Banner, BlockStack, Modal, Select, Text } from "@shopify/polaris";

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
};

/**
 * The always-available selector in Settings. Saves immediately on change, so
 * there is no separate Save button to forget to press.
 */
export function LanguageSetting({ value, chosen, detected }: Props) {
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

  // `pending` is cleared once the request settles, so a save that failed must
  // not leave the control showing a value that was never stored. Clearing is
  // derived from the fetcher rather than stored separately, which avoids a
  // double-render and keeps the two states from drifting apart.
  const failed = fetcher.state === "idle" && fetcher.data !== undefined && !fetcher.data.ok;

  return (
    <BlockStack gap="300">
      <Select
        label={t("language.fieldLabel")}
        labelHidden
        options={LANGUAGE_OPTIONS.map((option) => ({
          value: option.value,
          label: option.label,
        }))}
        value={failed ? value : shown}
        onChange={save}
        disabled={saving}
        helpText={
          <span id="language-status">
            {failed
              ? t("language.saveFailed")
              : !chosen && detected
                ? t("language.detected")
                : chosen
                  ? t("language.saved")
                  : t("language.description")}
          </span>
        }
      />
    </BlockStack>
  );
}

/**
 * The first-launch picker. Rendered as a modal over the app rather than as a
 * separate page so the merchant can see what they are about to set up, and so
 * skipping leaves them in the app instead of on a dead end.
 *
 * `savable` is false in the local demo preview, where there is no authenticated
 * shop to store a preference against. The picker still opens so the copy is
 * visible, but it says so and offers no control that would post to `/language`:
 * in demo mode that action redirects to OAuth, which previously left the
 * merchant staring at a modal whose every button bounced them out of the app.
 */
export function LanguageOnboarding({
  detectedLanguage,
  savable = true,
}: {
  detectedLanguage: Language;
  savable?: boolean;
}) {
  const { t } = useI18n();
  const fetcher = useFetcher<SaveResponse>();
  const [selection, setSelection] = useState<Language>(detectedLanguage);
  const saving = fetcher.state !== "idle";
  const failed = fetcher.state === "idle" && fetcher.data !== undefined && !fetcher.data.ok;
  // Modal content is mounted once `open` is true, so closing on a completed
  // submit is a render-time state change rather than an effect.
  const [done, setDone] = useState(false);

  const finish = (next: Language | null) => {
    if (!savable) {
      setDone(true);
      return;
    }
    setDone(true);
    fetcher.submit(next ? { language: next } : {}, { method: "post", action: "/language" });
  };

  // A failed save must reopen the dialog, or the merchant loses the error and
  // the picker is simply gone until the next page load.
  const open = savable ? !done || (failed && !saving) : !done;

  return (
    <Modal
      open={open}
      onClose={() => finish(null)}
      title={t("language.stepTitle")}
      primaryAction={{
        content: t("language.continue"),
        loading: saving,
        disabled: !savable,
        onAction: () => finish(selection),
      }}
      secondaryActions={[{ content: t("language.skip"), onAction: () => finish(null) }]}
    >
      <BlockStack gap="400">
        <Text as="p" tone="subdued">
          {t("language.onboardingDescription")}
        </Text>

        {!savable && (
          <Banner tone="info">
            <Text as="p">{t("language.demoNotice")}</Text>
          </Banner>
        )}

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
          disabled={!savable}
        />

        <Text as="p" variant="bodySm" tone="subdued">
          {t("language.description")}
        </Text>
      </BlockStack>
    </Modal>
  );
}
