/**
 * Overview "Get started" guide: the three steps from install to a protected
 * checkout, each with one button to the page that does it. Done states come
 * from the store's real status, except "tested", which only this browser
 * knows about (the order check doesn't store anything on the server).
 */

import { useEffect, useState } from "react";
import { Badge, BlockStack, Box, Button, Card, InlineGrid, InlineStack, ProgressBar, Text } from "@shopify/polaris";

import { useI18n } from "../i18n/context";
import type { MessageKey } from "../i18n/catalog";

/** Set by the order check page after a successful run. */
export const ORDERS_CHECKED_KEY = "cartguard.ordersChecked";
const GUIDE_HIDDEN_KEY = "cartguard.setupGuideHidden";

export function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeFlag(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Private windows and blocked storage: the guide just shows the step again.
  }
}

type Step = { id: string; title: MessageKey; body: MessageKey; action: MessageKey; url: string; done: boolean };

export function SetupGuide({ hasRules, protectionOn }: { hasRules: boolean; protectionOn: boolean }) {
  const { t, number } = useI18n();
  // Read after hydration so the server and first client render agree.
  const [tested, setTested] = useState(false);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    setTested(readFlag(ORDERS_CHECKED_KEY));
    setHidden(readFlag(GUIDE_HIDDEN_KEY));
  }, []);

  const steps: Step[] = [
    { id: "rules", title: "setup.step1.title", body: "setup.step1.body", action: "setup.step1.action", url: "/app/rules", done: hasRules },
    { id: "protect", title: "setup.step2.title", body: "setup.step2.body", action: "setup.step2.action", url: "/app/rules", done: protectionOn },
    { id: "test", title: "setup.step3.title", body: "setup.step3.body", action: "setup.step3.action", url: "/app/orders", done: tested },
  ];
  const done = steps.filter((step) => step.done).length;
  const current = steps.find((step) => !step.done)?.id;

  if (hidden && done === steps.length) return null;

  if (done === steps.length) {
    return (
      <Card>
        <InlineGrid columns={{ xs: 1, sm: "1fr auto" }} gap="300" alignItems="center">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h2" variant="headingMd">
                {t("setup.complete.title")}
              </Text>
              <Badge tone="success">{t("setup.done")}</Badge>
            </InlineStack>
            <Text as="p" tone="subdued">
              {t("setup.complete.body")}
            </Text>
          </BlockStack>
          <InlineStack>
            <Button
              variant="plain"
              onClick={() => {
                writeFlag(GUIDE_HIDDEN_KEY);
                setHidden(true);
              }}
            >
              {t("setup.hide")}
            </Button>
          </InlineStack>
        </InlineGrid>
      </Card>
    );
  }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="200">
          <InlineStack align="space-between" blockAlign="center" gap="200">
            <Text as="h2" variant="headingMd">
              {t("setup.title")}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {t("setup.progress", { done: number(done), total: number(steps.length) })}
            </Text>
          </InlineStack>
          <ProgressBar progress={(done / steps.length) * 100} size="small" tone="primary" />
        </BlockStack>
        <BlockStack gap="200" as="ol">
          {steps.map((step, index) => {
            const isCurrent = step.id === current;
            return (
              <Box
                as="li"
                key={step.id}
                padding="300"
                borderRadius="200"
                background={isCurrent ? "bg-surface-secondary" : undefined}
              >
                <InlineGrid columns="28px 1fr" gap="300">
                  <Text as="span" variant="headingMd" tone={step.done ? "success" : isCurrent ? undefined : "subdued"}>
                    {step.done ? "✓" : number(index + 1)}
                  </Text>
                  <BlockStack gap="200">
                    <BlockStack gap="050">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h3" variant="headingSm" tone={step.done ? "subdued" : undefined}>
                          {t(step.title)}
                        </Text>
                        {step.done && <Badge tone="success">{t("setup.done")}</Badge>}
                      </InlineStack>
                      {!step.done && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t(step.body)}
                        </Text>
                      )}
                    </BlockStack>
                    {!step.done && (
                      <InlineStack>
                        <Button variant={isCurrent ? "primary" : undefined} url={step.url}>
                          {t(step.action)}
                        </Button>
                      </InlineStack>
                    )}
                  </BlockStack>
                </InlineGrid>
              </Box>
            );
          })}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}
