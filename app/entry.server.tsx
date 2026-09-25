import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { RemixServer } from "@remix-run/react";
import { createReadableStreamFromReadable, type EntryContext } from "@remix-run/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const waitForAll = isbot(request.headers.get("user-agent") ?? "");

  return new Promise<Response>((resolve, reject) => {
    let shellRendered = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;

    const sendResponse = () => {
      shellRendered = true;
      const body = new PassThrough();
      const stream = createReadableStreamFromReadable(body);
      responseHeaders.set("Content-Type", "text/html");
      resolve(new Response(stream, { headers: responseHeaders, status: responseStatusCode }));
      pipe(body);
    };

    const { pipe, abort } = renderToPipeableStream(
      <RemixServer context={remixContext} url={request.url} />,
      {
        onShellReady() {
          if (!waitForAll) sendResponse();
        },
        onAllReady() {
          clearTimeout(abortTimer);
          if (waitForAll) sendResponse();
        },
        onShellError(error: unknown) {
          clearTimeout(abortTimer);
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          if (shellRendered) console.error(error);
        },
      },
    );

    // Abort slow streams, and clear the timer once rendering finishes so it
    // doesn't keep firing after the response is complete.
    abortTimer = setTimeout(abort, streamTimeout + 1000);
  });
}
