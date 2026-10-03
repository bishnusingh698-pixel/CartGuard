import type { HeadersFunction } from "@remix-run/node";
import { Fragment, type ReactNode } from "react";

import { useI18n } from "../i18n/context";

export const headers: HeadersFunction = () => ({
  "Cache-Control": "public, max-age=3600",
});

const SUPPORT_EMAIL = "support@cartguard.io";

/**
 * Each GDPR bullet leads with an identifier the merchant recognises
 * (`customers/data_request: ...`). Splitting on the colon keeps the translator's
 * word order intact while rendering that identifier in a monospace tag.
 */
function PolicyTerm({ text }: { text: string }): ReactNode {
  const separator = text.search(/:\s/);
  if (separator === -1) return text;
  return (
    <Fragment>
      <code>{text.slice(0, separator)}</code>
      {text.slice(separator)}
    </Fragment>
  );
}

/** The contact sentence ends in `{email}`, so the anchor is spliced in rather
 * than stringified, letting translators order the sentence as they like. */
function ContactSentence({ body }: { body: string }): ReactNode {
  const parts = body.split(/(\{email\})/g).filter(Boolean);
  return parts.map((part, index) =>
    part === "{email}" ? (
      <a key={index} href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-600 hover:underline">
        {SUPPORT_EMAIL}
      </a>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-900 mb-2">{heading}</h2>
      {children}
    </div>
  );
}

export default function PrivacyPolicy() {
  const { t } = useI18n();

  return (
    <div className="min-h-screen bg-slate-50 py-12 px-4 sm:px-6 lg:px-8 text-slate-800">
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-sm border border-slate-200 p-8 sm:p-12">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 mb-4">{t("privacy.title")}</h1>
        <p className="text-sm text-slate-500 mb-8">{t("privacy.effectiveDate", { date: "October 2026" })}</p>

        <div className="space-y-6 text-sm leading-6">
          <Section heading={t("privacy.overview.heading")}>
            <p>{t("privacy.overview.body")}</p>
          </Section>

          <Section heading={t("privacy.store.heading")}>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>{t("privacy.store.session")}</li>
              <li>{t("privacy.store.rules")}</li>
              <li>{t("privacy.store.language")}</li>
            </ul>
          </Section>

          <Section heading={t("privacy.read.heading")}>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>{t("privacy.read.checkout")}</li>
              <li>{t("privacy.read.impact")}</li>
            </ul>
          </Section>

          <Section heading={t("privacy.gdpr.heading")}>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>
                <PolicyTerm text={t("privacy.gdpr.dataRequest")} />
              </li>
              <li>
                <PolicyTerm text={t("privacy.gdpr.redact")} />
              </li>
              <li>
                <PolicyTerm text={t("privacy.gdpr.shopRedact")} />
              </li>
            </ul>
          </Section>

          <Section heading={t("privacy.contact.heading")}>
            <p>
              <ContactSentence body={t("privacy.contact.body")} />
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}
