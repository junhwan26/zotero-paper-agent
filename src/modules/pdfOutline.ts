type PdfLoaderKind = "esm" | "legacy" | "reader";

interface PdfJsLib {
  GlobalWorkerOptions?: {
    workerSrc?: string;
  };
  getDocument(options: {
    data?: Uint8Array;
    url?: string;
    useWorkerFetch?: boolean;
    disableWorker?: boolean;
  }): PdfLoadingTask;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>;
  destroy?: () => void | Promise<void>;
}

interface PdfOutlineItem {
  title?: string;
  dest?: string | unknown[] | null;
  url?: string;
  items?: PdfOutlineItem[];
}

interface PdfDocumentProxy {
  numPages: number;
  getOutline(): Promise<PdfOutlineItem[] | null | undefined>;
  getDestination(dest: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  cleanup?: () => void | Promise<void>;
  destroy?: () => void | Promise<void>;
}

interface PdfPageProxy {
  getTextContent(options?: Record<string, unknown>): Promise<{
    items: Array<{
      str?: string;
      unicode?: string;
      text?: string;
      [key: string]: unknown;
    }>;
  }>;
}

interface LoadedPdfJs {
  lib: PdfJsLib;
  loader: PdfLoaderKind;
}

interface DestStats {
  string: number;
  array: number;
  null: number;
  resolvedPage: number;
  failedResolve: number;
}

interface FlattenedOutlineNode {
  title: string;
  depth: number;
  pageNumber?: number;
  url?: string;
  path: string;
}

interface PdfRunMeta {
  loader: string;
  workerSrc: string;
  disableWorker: boolean;
}

export interface PdfOutlineNode {
  title: string;
  pageNumber?: number;
  url?: string;
  children: PdfOutlineNode[];
  depth: number;
}

export interface PdfSectionContext {
  title: string;
  depth: number;
  pageNumber?: number;
  startPageNumber?: number;
  endPageNumber?: number;
  url?: string;
  path: string;
  contextText: string;
  previewText: string;
  truncated: boolean;
}

export interface ExtractSectionContextOptions {
  maxPagesPerSection?: number;
  maxCharsPerSection?: number;
  previewChars?: number;
}

const PDF_JS_ESM_URL = "resource://zotero/reader/pdf/build/pdf.mjs";
const PDF_JS_WORKER_URL = "resource://zotero/reader/pdf/build/pdf.worker.mjs";
const PDF_JS_LEGACY_URL = "resource://pdf.js/build/pdf.js";
const PDF_JS_LEGACY_ALT_URL = "resource://zotero/reader/pdf/build/pdf.js";
const DEFAULT_MAX_PAGES_PER_SECTION = 8;
const DEFAULT_MAX_CHARS_PER_SECTION = 12000;
const DEFAULT_PREVIEW_CHARS = 280;

let cachedLoader: LoadedPdfJs | null = null;

export async function extractOutlineFromAttachment(attachmentItemID: number) {
  const readerPdf = await getOpenReaderPdfDocument(attachmentItemID);
  if (readerPdf) {
    try {
      logOutlineDebug({
        stage: "reader-open",
        itemID: attachmentItemID,
        source: "Zotero.Reader active pdfDocument",
      });
      return await parseOutlineFromPdfDocument(readerPdf, {
        loader: "reader",
        workerSrc: "(reader-owned)",
        disableWorker: false,
      });
    } catch (error) {
      logOutlineDebug({
        stage: "reader-open",
        itemID: attachmentItemID,
        source: "Zotero.Reader active pdfDocument",
        error: stringifyError(error),
      });
      // fallback to bytes + standalone PDF.js loader
    }
  }

  const buffer = await readAttachmentPdfArrayBuffer(attachmentItemID);
  return extractOutline(buffer);
}

export async function extractSectionContextsFromAttachment(
  attachmentItemID: number,
  opts?: ExtractSectionContextOptions,
) {
  const options = normalizeSectionContextOptions(opts);
  let contexts: PdfSectionContext[] | null = null;
  let pdfError: unknown = null;

  const readerPdf = await getOpenReaderPdfDocument(attachmentItemID);
  if (readerPdf) {
    try {
      logOutlineDebug({
        stage: "section-context",
        itemID: attachmentItemID,
        source: "Zotero.Reader active pdfDocument",
      });
      const readerContexts = await extractSectionContextsFromPdfDocument(
        readerPdf,
        {
          loader: "reader",
          workerSrc: "(reader-owned)",
          disableWorker: false,
        },
        opts,
      );
      contexts = readerContexts;
      if (!shouldFallbackToBytePath(readerContexts)) {
        return readerContexts;
      }
      logOutlineDebug({
        stage: "section-context",
        itemID: attachmentItemID,
        source: "Zotero.Reader active pdfDocument",
        reason: "all contexts empty despite page ranges; fallback to byte path",
      });
    } catch (error) {
      logOutlineDebug({
        stage: "section-context",
        itemID: attachmentItemID,
        source: "Zotero.Reader active pdfDocument",
        error: stringifyError(error),
      });
      pdfError = error;
    }
  }

  if (!contexts || shouldFallbackToBytePath(contexts)) {
    try {
      const filePath = await getAttachmentFilePathOrThrow(attachmentItemID);
      const buffer = await readAttachmentPdfArrayBuffer(attachmentItemID);
      const bytePathContexts = await extractSectionContextsInternal(
        buffer,
        opts,
        filePath,
      );
      contexts = bytePathContexts;
      if (!shouldFallbackToBytePath(bytePathContexts)) {
        return bytePathContexts;
      }
    } catch (error) {
      pdfError = error;
      logOutlineDebug({
        stage: "section-context",
        itemID: attachmentItemID,
        source: "bytes+pdfjs",
        error: stringifyError(error),
      });
    }
  }

  let baseContexts = contexts;
  if (!baseContexts) {
    const nodes = await extractOutlineFromAttachment(attachmentItemID);
    if (!nodes.length) {
      return [] as PdfSectionContext[];
    }
    baseContexts = buildEmptySectionContextsFromNodes(nodes);
  }
  const attachmentText = await readAttachmentTextSafe(attachmentItemID);
  const enriched = enrichContextsWithAttachmentText(
    baseContexts,
    attachmentText,
    options,
  );
  const withContext = enriched.filter((entry) =>
    Boolean(entry.contextText),
  ).length;

  logOutlineDebug({
    stage: "section-context-attachment-text",
    itemID: attachmentItemID,
    hasAttachmentText: Boolean(attachmentText),
    contextCount: enriched.length,
    withContext,
    recovered: withContext > 0,
    priorPdfError: pdfError ? stringifyError(pdfError) : undefined,
  });

  return enriched;
}

export async function readAttachmentPdfArrayBuffer(attachmentItemID: number) {
  const item = getAttachmentItemOrThrow(attachmentItemID);

  const filePath = await getAttachmentFilePathOrThrow(attachmentItemID);

  try {
    const ioUtils = (globalThis as any).IOUtils;
    if (ioUtils && typeof ioUtils.read === "function") {
      const bytes = (await ioUtils.read(filePath)) as Uint8Array;
      const arrayBuffer = bytesToArrayBuffer(bytes);
      logOutlineDebug({
        stage: "read-bytes",
        source: "IOUtils.read",
        itemID: attachmentItemID,
        key: item.key,
        filePath,
        byteLength: arrayBuffer.byteLength,
      });
      return arrayBuffer;
    }
  } catch (error) {
    logOutlineDebug({
      stage: "read-bytes",
      source: "IOUtils.read",
      itemID: attachmentItemID,
      key: item.key,
      filePath,
      error: stringifyError(error),
    });
  }

  try {
    const binary = await Zotero.File.getBinaryContentsAsync(filePath);
    const bytes = binaryStringToUint8Array(binary);
    const arrayBuffer = bytesToArrayBuffer(bytes);
    logOutlineDebug({
      stage: "read-bytes",
      source: "Zotero.File.getBinaryContentsAsync",
      itemID: attachmentItemID,
      key: item.key,
      filePath,
      byteLength: arrayBuffer.byteLength,
    });
    return arrayBuffer;
  } catch (error) {
    logOutlineDebug({
      stage: "read-bytes",
      source: "Zotero.File.getBinaryContentsAsync",
      itemID: attachmentItemID,
      key: item.key,
      filePath,
      error: stringifyError(error),
    });
    throw new Error(
      `Failed to read attachment bytes (itemID=${attachmentItemID}, key=${item.key || "unknown"}, filePath=${filePath}).`,
    );
  }
}

function getAttachmentItemOrThrow(attachmentItemID: number) {
  const item = (Zotero.Items.get(attachmentItemID) ||
    null) as Zotero.Item | null;
  if (!item) {
    throw new Error(`Attachment item not found (itemID=${attachmentItemID}).`);
  }
  if (!item.isAttachment()) {
    throw new Error(
      `Item is not an attachment (itemID=${attachmentItemID}, key=${item.key || "unknown"}).`,
    );
  }
  return item;
}

async function getAttachmentFilePathOrThrow(attachmentItemID: number) {
  const item = getAttachmentItemOrThrow(attachmentItemID);
  const filePathRaw = await item.getFilePathAsync();
  if (typeof filePathRaw !== "string" || !filePathRaw.trim()) {
    throw new Error(
      `Attachment file path is unavailable (itemID=${attachmentItemID}, key=${item.key || "unknown"}).`,
    );
  }
  return filePathRaw;
}

export async function extractOutline(
  arrayBuffer: ArrayBuffer,
): Promise<PdfOutlineNode[]> {
  const { lib, loader } = await loadPdfJs();
  const stats: DestStats = {
    string: 0,
    array: 0,
    null: 0,
    resolvedPage: 0,
    failedResolve: 0,
  };
  let workerSrc = "(unset)";

  try {
    if (lib.GlobalWorkerOptions) {
      lib.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_URL;
      workerSrc = String(lib.GlobalWorkerOptions.workerSrc || "(unset)");
    }
  } catch (error) {
    logOutlineDebug({
      stage: "worker",
      loader,
      workerSrc,
      error: stringifyError(error),
    });
  }

  let loadingTask: PdfLoadingTask | null = null;
  let pdf: PdfDocumentProxy | null = null;
  let usedDisableWorker = false;

  try {
    try {
      loadingTask = lib.getDocument({
        data: new Uint8Array(arrayBuffer),
        useWorkerFetch: false,
      });
      pdf = await loadingTask.promise;
    } catch (workerError) {
      logOutlineDebug({
        stage: "worker",
        loader,
        workerSrc,
        disableWorker: false,
        error: stringifyError(workerError),
      });
      await safeDestroyLoadingTask(loadingTask);
      loadingTask = lib.getDocument({
        data: new Uint8Array(arrayBuffer),
        useWorkerFetch: false,
        disableWorker: true,
      });
      pdf = await loadingTask.promise;
      usedDisableWorker = true;
    }

    return await parseOutlineFromPdfDocument(pdf, {
      loader,
      workerSrc,
      disableWorker: usedDisableWorker,
      stats,
    });
  } catch (error) {
    logOutlineDebug({
      stage: "extract-outline",
      loader,
      workerSrc,
      disableWorker: usedDisableWorker,
      error: stringifyError(error),
      destStats: stats,
    });
    throw new Error(
      `Failed to extract PDF bookmark outline. ${stringifyError(error)}`,
    );
  } finally {
    await safeCleanupPdf(pdf);
    await safeDestroyLoadingTask(loadingTask);
  }
}

export async function extractSectionContexts(
  arrayBuffer: ArrayBuffer,
  opts?: ExtractSectionContextOptions,
) {
  return extractSectionContextsInternal(arrayBuffer, opts);
}

async function extractSectionContextsInternal(
  arrayBuffer: ArrayBuffer,
  opts?: ExtractSectionContextOptions,
  filePath?: string,
) {
  const { lib, loader } = await loadPdfJs();
  let workerSrc = "(unset)";

  try {
    if (lib.GlobalWorkerOptions) {
      lib.GlobalWorkerOptions.workerSrc = PDF_JS_WORKER_URL;
      workerSrc = String(lib.GlobalWorkerOptions.workerSrc || "(unset)");
    }
  } catch (error) {
    logOutlineDebug({
      stage: "worker",
      loader,
      workerSrc,
      error: stringifyError(error),
    });
  }

  let loadingTask: PdfLoadingTask | null = null;
  let pdf: PdfDocumentProxy | null = null;
  let usedDisableWorker = false;
  let loadSource: "data" | "url" = "data";

  try {
    try {
      const opened =
        loader === "reader" && filePath
          ? await openPdfDocumentTaskFromUrl(lib, filePath, false)
          : await openPdfDocumentTaskFromDataOrUrl(
              lib,
              arrayBuffer,
              false,
              filePath,
              loadingTask,
            );
      loadingTask = opened.task;
      pdf = opened.pdf;
      loadSource = opened.source;
    } catch (workerError) {
      logOutlineDebug({
        stage: "worker",
        loader,
        workerSrc,
        disableWorker: false,
        error: stringifyError(workerError),
      });
      await safeDestroyLoadingTask(loadingTask);
      const opened =
        loader === "reader" && filePath
          ? await openPdfDocumentTaskFromUrl(lib, filePath, true)
          : await openPdfDocumentTaskFromDataOrUrl(
              lib,
              arrayBuffer,
              true,
              filePath,
              loadingTask,
            );
      loadingTask = opened.task;
      pdf = opened.pdf;
      loadSource = opened.source;
      usedDisableWorker = true;
    }

    const contexts = await extractSectionContextsFromPdfDocument(
      pdf,
      {
        loader,
        workerSrc,
        disableWorker: usedDisableWorker,
      },
      opts,
    );
    logOutlineDebug({
      stage: "section-context",
      loader,
      workerSrc,
      disableWorker: usedDisableWorker,
      loadSource,
      filePath: loadSource === "url" ? filePath : undefined,
    });
    return contexts;
  } catch (error) {
    logOutlineDebug({
      stage: "section-context",
      loader,
      workerSrc,
      disableWorker: usedDisableWorker,
      loadSource,
      error: stringifyError(error),
    });
    throw new Error(
      `Failed to extract PDF section contexts. ${stringifyError(error)}`,
    );
  } finally {
    await safeCleanupPdf(pdf);
    await safeDestroyLoadingTask(loadingTask);
  }
}

async function openPdfDocumentTaskFromDataOrUrl(
  lib: PdfJsLib,
  arrayBuffer: ArrayBuffer,
  disableWorker: boolean,
  filePath: string | undefined,
  previousTask: PdfLoadingTask | null,
): Promise<{
  task: PdfLoadingTask;
  pdf: PdfDocumentProxy;
  source: "data" | "url";
}> {
  const baseOptions = {
    useWorkerFetch: false,
    ...(disableWorker ? { disableWorker: true } : {}),
  };
  let task: PdfLoadingTask | null = null;
  try {
    task = lib.getDocument({
      data: new Uint8Array(arrayBuffer),
      ...baseOptions,
    });
    const pdf = await task.promise;
    return {
      task,
      pdf,
      source: "data",
    };
  } catch (error) {
    const missingUrl = isMissingUrlParameterError(error);
    if (!missingUrl || !filePath) {
      await safeDestroyLoadingTask(task);
      throw error;
    }
    await safeDestroyLoadingTask(task);
    await safeDestroyLoadingTask(previousTask);
    return await openPdfDocumentTaskFromUrl(lib, filePath, disableWorker);
  }
}

async function openPdfDocumentTaskFromUrl(
  lib: PdfJsLib,
  filePath: string,
  disableWorker: boolean,
) {
  const urlCandidates = buildPdfUrlCandidates(filePath);
  const baseOptions = {
    useWorkerFetch: false,
    ...(disableWorker ? { disableWorker: true } : {}),
  };
  let lastError: unknown = null;

  for (const url of urlCandidates) {
    const forms: Array<{
      id: "object+options" | "object" | "string";
      open: () => PdfLoadingTask;
    }> = [
      {
        id: "object+options",
        open: () =>
          lib.getDocument({
            url,
            ...baseOptions,
          }),
      },
      {
        id: "object",
        open: () =>
          lib.getDocument({
            url,
          }),
      },
      {
        id: "string",
        open: () => lib.getDocument(url as any),
      },
    ];

    for (const form of forms) {
      let task: PdfLoadingTask | null = null;
      try {
        task = form.open();
        const pdf = await task.promise;
        logOutlineDebug({
          stage: "worker",
          reason: "url-open-success",
          url,
          form: form.id,
          disableWorker,
        });
        return {
          task,
          pdf,
          source: "url" as const,
        };
      } catch (error) {
        lastError = error;
        await safeDestroyLoadingTask(task);
        logOutlineDebug({
          stage: "worker",
          reason: "url-open-failed",
          url,
          form: form.id,
          disableWorker,
          error: stringifyError(error),
        });
      }
    }
  }

  throw lastError || new Error("Failed to open PDF with URL candidates.");
}

function buildPdfUrlCandidates(filePath: string) {
  const candidates: string[] = [];
  const raw = String(filePath || "").trim();
  if (raw) {
    candidates.push(raw);
  }

  const normalized = raw.replace(/\\/g, "/");
  if (normalized) {
    const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
    const fileUrl = encodeURI(`file://${prefixed}`);
    if (!candidates.includes(fileUrl)) {
      candidates.push(fileUrl);
    }
  }

  return candidates;
}

function isMissingUrlParameterError(error: unknown) {
  const text = stringifyError(error).toLowerCase();
  return (
    text.includes("getdocument") &&
    (text.includes("no `url` parameter provided") ||
      text.includes("no 'url' parameter provided") ||
      text.includes("no url parameter provided"))
  );
}

async function parseOutlineFromPdfDocument(
  pdf: PdfDocumentProxy,
  meta: {
    loader: string;
    workerSrc: string;
    disableWorker: boolean;
    stats?: DestStats;
  },
) {
  const stats = meta.stats || {
    string: 0,
    array: 0,
    null: 0,
    resolvedPage: 0,
    failedResolve: 0,
  };
  const outline = await pdf.getOutline();
  const outlineNull = !outline;
  const outlineRootLength = Array.isArray(outline) ? outline.length : 0;

  logOutlineDebug({
    stage: "getOutline",
    loader: meta.loader,
    workerSrc: meta.workerSrc,
    disableWorker: meta.disableWorker,
    outlineNull,
    outlineRootLength,
  });

  // PDF bookmark(Outline)이 없는 경우는 정상이며 빈 배열을 반환한다.
  if (!outline || !outline.length) {
    logOutlineDebug({
      stage: "result",
      loader: meta.loader,
      workerSrc: meta.workerSrc,
      disableWorker: meta.disableWorker,
      outlineNull,
      outlineRootLength,
      destStats: stats,
    });
    return [] as PdfOutlineNode[];
  }

  let visitedCount = 0;
  const parseItems = async (
    items: PdfOutlineItem[],
    depth: number,
  ): Promise<PdfOutlineNode[]> => {
    const nodes: PdfOutlineNode[] = [];

    for (const item of items) {
      visitedCount += 1;
      if (visitedCount % 100 === 0) {
        await Promise.resolve();
      }

      let pageNumber: number | undefined;
      const dest = item?.dest ?? null;
      let destArray: unknown[] | null = null;

      if (typeof dest === "string") {
        stats.string += 1;
        try {
          destArray = await pdf.getDestination(dest);
        } catch (error) {
          stats.failedResolve += 1;
          logOutlineDebug({
            stage: "dest-resolve",
            loader: meta.loader,
            reason: "getDestination(string) failed",
            error: stringifyError(error),
          });
        }
      } else if (Array.isArray(dest)) {
        stats.array += 1;
        destArray = dest;
      } else {
        stats.null += 1;
      }

      if (destArray && destArray.length) {
        try {
          const pageRef = destArray[0];
          const pageIndex = await pdf.getPageIndex(pageRef);
          if (Number.isFinite(pageIndex) && pageIndex >= 0) {
            pageNumber = pageIndex + 1;
            stats.resolvedPage += 1;
          }
        } catch (error) {
          stats.failedResolve += 1;
          logOutlineDebug({
            stage: "dest-resolve",
            loader: meta.loader,
            reason: "getPageIndex failed",
            error: stringifyError(error),
          });
        }
      }

      const title = normalizeOutlineTitle(item?.title);
      const url =
        typeof item?.url === "string" && item.url.trim()
          ? item.url.trim()
          : undefined;
      const children = await parseItems(
        Array.isArray(item?.items) ? item.items : [],
        depth + 1,
      );

      nodes.push({
        title,
        pageNumber,
        url,
        children,
        depth,
      });
    }

    return nodes;
  };

  const nodes = await parseItems(outline, 0);
  logOutlineDebug({
    stage: "result",
    loader: meta.loader,
    workerSrc: meta.workerSrc,
    disableWorker: meta.disableWorker,
    outlineNull: false,
    outlineRootLength,
    destStats: stats,
  });
  return nodes;
}

async function extractSectionContextsFromPdfDocument(
  pdf: PdfDocumentProxy,
  meta: PdfRunMeta,
  opts?: ExtractSectionContextOptions,
) {
  const nodes = await parseOutlineFromPdfDocument(pdf, {
    loader: meta.loader,
    workerSrc: meta.workerSrc,
    disableWorker: meta.disableWorker,
  });
  if (!nodes.length) {
    return [] as PdfSectionContext[];
  }

  const options = normalizeSectionContextOptions(opts);
  const flattened = flattenOutlineWithPath(nodes);
  const docPageCount = resolveDocumentPageCount(pdf, flattened);
  const pageTextCache = new Map<number, string>();
  const contexts: PdfSectionContext[] = [];
  let withRange = 0;
  let withContext = 0;
  let charsTotal = 0;
  let truncatedCount = 0;

  for (let i = 0; i < flattened.length; i += 1) {
    const current = flattened[i];
    const range = resolveSectionPageRange(flattened, i, docPageCount);
    if (range.startPageNumber) {
      withRange += 1;
    }

    const built = range.startPageNumber
      ? await buildContextTextForRange(
          pdf,
          range.startPageNumber,
          range.endPageNumber || range.startPageNumber,
          pageTextCache,
          options,
        )
      : {
          contextText: "",
          previewText: "",
          truncated: false,
        };

    if (built.contextText) {
      withContext += 1;
      charsTotal += built.contextText.length;
    }
    if (built.truncated) {
      truncatedCount += 1;
    }

    contexts.push({
      title: current.title,
      depth: current.depth,
      pageNumber: current.pageNumber,
      startPageNumber: range.startPageNumber,
      endPageNumber: range.endPageNumber,
      url: current.url,
      path: current.path,
      contextText: built.contextText,
      previewText: built.previewText,
      truncated: built.truncated,
    });

    if (i % 50 === 0) {
      await Promise.resolve();
    }
  }

  logOutlineDebug({
    stage: "section-context",
    loader: meta.loader,
    workerSrc: meta.workerSrc,
    disableWorker: meta.disableWorker,
    sectionCount: contexts.length,
    docPageCount,
    withRange,
    withContext,
    charsTotal,
    truncatedCount,
    options,
  });

  return contexts;
}

function normalizeSectionContextOptions(
  opts: ExtractSectionContextOptions | undefined,
) {
  const maxPagesPerSection = clampPositiveInteger(
    opts?.maxPagesPerSection,
    DEFAULT_MAX_PAGES_PER_SECTION,
  );
  const maxCharsPerSection = clampPositiveInteger(
    opts?.maxCharsPerSection,
    DEFAULT_MAX_CHARS_PER_SECTION,
  );
  const previewChars = clampPositiveInteger(
    opts?.previewChars,
    DEFAULT_PREVIEW_CHARS,
  );

  return {
    maxPagesPerSection,
    maxCharsPerSection,
    previewChars,
  };
}

function clampPositiveInteger(value: unknown, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const rounded = Math.floor(num);
  return rounded > 0 ? rounded : fallback;
}

function flattenOutlineWithPath(nodes: PdfOutlineNode[]) {
  const flattened: FlattenedOutlineNode[] = [];

  const walk = (items: PdfOutlineNode[], parentPath: string) => {
    items.forEach((item, index) => {
      const path = parentPath ? `${parentPath}.${index + 1}` : `${index + 1}`;
      flattened.push({
        title: item.title,
        depth: item.depth,
        pageNumber: item.pageNumber,
        url: item.url,
        path,
      });
      if (item.children.length) {
        walk(item.children, path);
      }
    });
  };

  walk(nodes, "");
  return flattened;
}

function resolveDocumentPageCount(
  pdf: PdfDocumentProxy,
  flattened: FlattenedOutlineNode[],
) {
  const pdfPageCount = Number((pdf as any)?.numPages);
  if (Number.isFinite(pdfPageCount) && pdfPageCount > 0) {
    return Math.floor(pdfPageCount);
  }
  const maxBookmarkPage = flattened.reduce((max, node) => {
    if (typeof node.pageNumber !== "number" || node.pageNumber <= 0) {
      return max;
    }
    return Math.max(max, Math.floor(node.pageNumber));
  }, 0);
  if (maxBookmarkPage > 0) {
    return maxBookmarkPage;
  }
  return 1;
}

function resolveSectionPageRange(
  flattened: FlattenedOutlineNode[],
  currentIndex: number,
  numPages: number,
) {
  const current = flattened[currentIndex];
  if (typeof current.pageNumber !== "number" || current.pageNumber <= 0) {
    return {
      startPageNumber: undefined,
      endPageNumber: undefined,
    } as const;
  }

  const safeNumPages =
    Number.isFinite(numPages) && numPages > 0
      ? Math.floor(numPages)
      : Math.floor(current.pageNumber);
  const startPageNumber = Math.max(1, Math.floor(current.pageNumber));
  let endPageNumber = Math.max(startPageNumber, safeNumPages);

  for (let i = currentIndex + 1; i < flattened.length; i += 1) {
    const next = flattened[i];
    if (
      next.depth <= current.depth &&
      typeof next.pageNumber === "number" &&
      next.pageNumber > 0
    ) {
      endPageNumber = Math.floor(next.pageNumber) - 1;
      break;
    }
  }

  if (endPageNumber < startPageNumber) {
    endPageNumber = startPageNumber;
  }
  return {
    startPageNumber,
    endPageNumber,
  };
}

async function buildContextTextForRange(
  pdf: PdfDocumentProxy,
  startPageNumber: number,
  endPageNumber: number,
  cache: Map<number, string>,
  options: {
    maxPagesPerSection: number;
    maxCharsPerSection: number;
    previewChars: number;
  },
) {
  const safeStart = Math.max(1, Math.floor(startPageNumber));
  const safeEnd = Math.max(safeStart, Math.floor(endPageNumber));
  const maxEndByPages = safeStart + Math.max(1, options.maxPagesPerSection) - 1;
  const effectiveEnd = Math.min(safeEnd, maxEndByPages);
  const parts: string[] = [];
  let chars = 0;
  let truncated = effectiveEnd < safeEnd;

  for (let page = safeStart; page <= effectiveEnd; page += 1) {
    const text = await getPageText(pdf, page, cache);
    if (text) {
      const remaining = options.maxCharsPerSection - chars;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (text.length > remaining) {
        parts.push(text.slice(0, remaining).trim());
        chars = options.maxCharsPerSection;
        truncated = true;
        break;
      }
      parts.push(text);
      chars += text.length;
    }
    if ((page - safeStart + 1) % 3 === 0) {
      await Promise.resolve();
    }
  }

  const contextText = parts.join("\n\n").trim();
  const previewText = clipText(contextText, options.previewChars);
  return {
    contextText,
    previewText,
    truncated,
  };
}

async function getPageText(
  pdf: PdfDocumentProxy,
  pageNumber: number,
  cache: Map<number, string>,
) {
  if (cache.has(pageNumber)) {
    return cache.get(pageNumber)!;
  }

  try {
    const page = await pdf.getPage(pageNumber);
    let textContent: {
      items: Array<{
        str?: string;
        unicode?: string;
        text?: string;
        [key: string]: unknown;
      }>;
    } | null = null;
    try {
      textContent = await page.getTextContent({
        includeMarkedContent: true,
      });
    } catch {
      textContent = await page.getTextContent();
    }
    const items = Array.isArray(textContent?.items) ? textContent.items : [];
    let text = normalizePageText(
      items
        .map((item) => {
          if (typeof item?.str === "string") {
            return item.str;
          }
          if (typeof item?.unicode === "string") {
            return item.unicode;
          }
          if (typeof item?.text === "string") {
            return item.text;
          }
          return "";
        })
        .filter(Boolean)
        .join(" "),
    );
    if (!text) {
      const fallbackContent = await page.getTextContent();
      const fallbackItems = Array.isArray(fallbackContent?.items)
        ? fallbackContent.items
        : [];
      text = normalizePageText(
        fallbackItems
          .map((item) => {
            if (typeof item?.str === "string") {
              return item.str;
            }
            if (typeof item?.unicode === "string") {
              return item.unicode;
            }
            if (typeof item?.text === "string") {
              return item.text;
            }
            return "";
          })
          .filter(Boolean)
          .join(" "),
      );
    }
    cache.set(pageNumber, text);
    return text;
  } catch (error) {
    logOutlineDebug({
      stage: "section-context",
      reason: "getPageText failed",
      pageNumber,
      error: stringifyError(error),
    });
    cache.set(pageNumber, "");
    return "";
  }
}

function normalizePageText(text: string) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function clipText(text: string, maxChars: number) {
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trim()}...`;
}

function shouldFallbackToBytePath(contexts: PdfSectionContext[]) {
  if (!contexts.length) {
    return false;
  }
  const withRange = contexts.filter(
    (entry) => typeof entry.startPageNumber === "number",
  );
  if (!withRange.length) {
    return false;
  }
  const withText = withRange.filter((entry) =>
    Boolean(entry.contextText.trim()),
  );
  return withText.length === 0;
}

function buildEmptySectionContextsFromNodes(nodes: PdfOutlineNode[]) {
  const flattened = flattenOutlineWithPath(nodes);
  const pageCount = Math.max(
    1,
    flattened.reduce((max, node) => {
      if (typeof node.pageNumber !== "number" || node.pageNumber <= 0) {
        return max;
      }
      return Math.max(max, Math.floor(node.pageNumber));
    }, 0),
  );

  return flattened.map((entry, index) => {
    const range = resolveSectionPageRange(flattened, index, pageCount);
    return {
      title: entry.title,
      depth: entry.depth,
      pageNumber: entry.pageNumber,
      startPageNumber: range.startPageNumber,
      endPageNumber: range.endPageNumber,
      url: entry.url,
      path: entry.path,
      contextText: "",
      previewText: "",
      truncated: false,
    } as PdfSectionContext;
  });
}

async function readAttachmentTextSafe(attachmentItemID: number) {
  try {
    const item = getAttachmentItemOrThrow(attachmentItemID);
    const text = await item.attachmentText;
    return String(text || "");
  } catch (error) {
    logOutlineDebug({
      stage: "section-context-attachment-text",
      reason: "read-attachment-text-failed",
      itemID: attachmentItemID,
      error: stringifyError(error),
    });
    return "";
  }
}

function enrichContextsWithAttachmentText(
  contexts: PdfSectionContext[],
  attachmentText: string,
  options: {
    maxPagesPerSection: number;
    maxCharsPerSection: number;
    previewChars: number;
  },
) {
  if (!attachmentText.trim()) {
    return contexts;
  }

  const starts = findSectionStartsByTitle(contexts, attachmentText);
  return contexts.map((entry, index) => {
    if (entry.contextText.trim()) {
      return entry;
    }
    const start = starts[index];
    if (start < 0) {
      return entry;
    }
    const end = findSectionEndIndex(
      contexts,
      starts,
      index,
      attachmentText.length,
    );
    const rawSlice = attachmentText.slice(start, end).trim();
    if (!rawSlice) {
      return entry;
    }
    const normalized = normalizeAttachmentContextText(rawSlice);
    if (!normalized) {
      return entry;
    }

    const maxChars = Math.max(1, options.maxCharsPerSection);
    const truncated = normalized.length > maxChars;
    const contextText = truncated
      ? normalized.slice(0, maxChars).trim()
      : normalized;

    return {
      ...entry,
      contextText,
      previewText: clipText(contextText, options.previewChars),
      truncated,
    };
  });
}

function findSectionStartsByTitle(contexts: PdfSectionContext[], text: string) {
  const starts = new Array<number>(contexts.length).fill(-1);
  const loweredText = text.toLowerCase();
  let cursor = 0;

  for (let i = 0; i < contexts.length; i += 1) {
    const title = normalizeOutlineTitle(contexts[i].title);
    const index = findHeadingLikeIndex(loweredText, title, cursor);
    starts[i] = index;
    if (index >= 0) {
      cursor = Math.min(
        loweredText.length,
        index + Math.max(1, Math.min(title.length, 120)),
      );
    }
  }

  return starts;
}

function findHeadingLikeIndex(
  loweredText: string,
  title: string,
  cursor: number,
) {
  const candidates = buildHeadingCandidates(title);
  let best = -1;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const idx = loweredText.indexOf(candidate, cursor);
    if (idx >= 0 && (best < 0 || idx < best)) {
      best = idx;
    }
  }
  if (best >= 0) {
    return best;
  }
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const idx = loweredText.indexOf(candidate);
    if (idx >= 0 && (best < 0 || idx < best)) {
      best = idx;
    }
  }
  return best;
}

function buildHeadingCandidates(title: string) {
  const source = String(title || "").trim();
  if (!source || source === "(untitled)") {
    return [] as string[];
  }
  const normalized = source.replace(/\s+/g, " ").trim().toLowerCase();
  const noPunct = normalized
    .replace(/[.,:;!?()[\]{}"'`~\-_/\\|+*=<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const noStopWords = noPunct
    .replace(/\b(section|chapter)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(
    new Set(
      [normalized, noPunct, noStopWords].filter((entry) => entry.length >= 3),
    ),
  );
}

function findSectionEndIndex(
  contexts: PdfSectionContext[],
  starts: number[],
  currentIndex: number,
  fallbackEnd: number,
) {
  const currentDepth = contexts[currentIndex].depth;
  for (let i = currentIndex + 1; i < contexts.length; i += 1) {
    if (contexts[i].depth <= currentDepth && starts[i] >= 0) {
      return starts[i];
    }
  }
  for (let i = currentIndex + 1; i < contexts.length; i += 1) {
    if (starts[i] >= 0) {
      return starts[i];
    }
  }
  return fallbackEnd;
}

function normalizeAttachmentContextText(text: string) {
  return String(text || "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadPdfJs(): Promise<LoadedPdfJs> {
  if (cachedLoader) {
    return cachedLoader;
  }

  const attempts: Array<{ path: string; error: string }> = [];

  try {
    const chromeUtils = (globalThis as any).ChromeUtils;
    if (chromeUtils && typeof chromeUtils.importESModule === "function") {
      const module = chromeUtils.importESModule(PDF_JS_ESM_URL);
      const lib = normalizePdfJsLib(module);
      if (isPdfJsLib(lib)) {
        cachedLoader = { lib, loader: "esm" };
        logOutlineDebug({
          stage: "loader",
          loader: "esm",
          mode: "ChromeUtils.importESModule",
          path: PDF_JS_ESM_URL,
        });
        return cachedLoader;
      }
      attempts.push({
        path: `${PDF_JS_ESM_URL} (ChromeUtils.importESModule)`,
        error: "Module loaded but no getDocument() found.",
      });
    } else {
      attempts.push({
        path: `${PDF_JS_ESM_URL} (ChromeUtils.importESModule)`,
        error: "ChromeUtils.importESModule unavailable",
      });
    }
  } catch (error) {
    attempts.push({
      path: `${PDF_JS_ESM_URL} (ChromeUtils.importESModule)`,
      error: stringifyError(error),
    });
  }

  try {
    const runtimeImport = new Function("u", "return import(u)") as (
      url: string,
    ) => Promise<any>;
    const module = await runtimeImport(PDF_JS_ESM_URL);
    const lib = normalizePdfJsLib(module);
    if (isPdfJsLib(lib)) {
      cachedLoader = { lib, loader: "esm" };
      logOutlineDebug({
        stage: "loader",
        loader: "esm",
        path: PDF_JS_ESM_URL,
      });
      return cachedLoader;
    }
    attempts.push({
      path: PDF_JS_ESM_URL,
      error: "Module loaded but no getDocument() found.",
    });
  } catch (error) {
    attempts.push({
      path: PDF_JS_ESM_URL,
      error: stringifyError(error),
    });
  }

  try {
    const scope: Record<string, any> = {};
    Services.scriptloader.loadSubScript(PDF_JS_LEGACY_URL, scope);
    const lib = normalizePdfJsLib(scope.pdfjsLib || scope.PDFJS || scope);
    if (isPdfJsLib(lib)) {
      cachedLoader = { lib, loader: "legacy" };
      logOutlineDebug({
        stage: "loader",
        loader: "legacy",
        path: PDF_JS_LEGACY_URL,
      });
      return cachedLoader;
    }
    attempts.push({
      path: PDF_JS_LEGACY_URL,
      error: "Script loaded but no pdfjsLib.getDocument() found.",
    });
  } catch (error) {
    attempts.push({
      path: PDF_JS_LEGACY_URL,
      error: stringifyError(error),
    });
  }

  try {
    const scope: Record<string, any> = {};
    Services.scriptloader.loadSubScript(PDF_JS_LEGACY_ALT_URL, scope);
    const lib = normalizePdfJsLib(scope.pdfjsLib || scope.PDFJS || scope);
    if (isPdfJsLib(lib)) {
      cachedLoader = { lib, loader: "legacy" };
      logOutlineDebug({
        stage: "loader",
        loader: "legacy",
        path: PDF_JS_LEGACY_ALT_URL,
      });
      return cachedLoader;
    }
    attempts.push({
      path: PDF_JS_LEGACY_ALT_URL,
      error: "Script loaded but no pdfjsLib.getDocument() found.",
    });
  } catch (error) {
    attempts.push({
      path: PDF_JS_LEGACY_ALT_URL,
      error: stringifyError(error),
    });
  }

  try {
    const lib = getReaderResidentPdfJsLib();
    if (lib) {
      cachedLoader = { lib, loader: "reader" };
      logOutlineDebug({
        stage: "loader",
        loader: "reader",
        path: "Zotero.Reader._readers[*]._internalReader._primaryView._iframeWindow.pdfjsLib",
      });
      return cachedLoader;
    }
    attempts.push({
      path: "Zotero.Reader resident pdfjsLib",
      error: "No reader-resident pdfjsLib found.",
    });
  } catch (error) {
    attempts.push({
      path: "Zotero.Reader resident pdfjsLib",
      error: stringifyError(error),
    });
  }

  // Last-resort fallback could bundle pdfjs-dist in this plugin, but default policy
  // is to reuse Zotero's bundled PDF.js first.
  const details = attempts
    .map((attempt) => `${attempt.path} -> ${attempt.error}`)
    .join(" | ");
  throw new Error(`Failed to load PDF.js. Attempts: ${details}`);
}

function normalizePdfJsLib(candidate: any): any {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  if (candidate.default && typeof candidate.default === "object") {
    if (typeof candidate.default.getDocument === "function") {
      return candidate.default;
    }
  }
  return candidate;
}

function isPdfJsLib(candidate: any): candidate is PdfJsLib {
  return Boolean(candidate && typeof candidate.getDocument === "function");
}

function getReaderResidentPdfJsLib() {
  const readerManager = (Zotero as any).Reader;
  const readers = Array.isArray(readerManager?._readers)
    ? readerManager._readers
    : [];

  for (const reader of readers) {
    const primaryView = reader?._internalReader?._primaryView;
    const iframeWindow =
      primaryView?._iframeWindow ||
      reader?._iframeWindow ||
      primaryView?._iframe?.contentWindow;
    const candidate =
      iframeWindow?.wrappedJSObject?.pdfjsLib || iframeWindow?.pdfjsLib;
    const lib = normalizePdfJsLib(candidate);
    if (isPdfJsLib(lib)) {
      return lib;
    }
  }

  return null;
}

function normalizeOutlineTitle(title: unknown) {
  const value = String(title || "").trim();
  return value || "(untitled)";
}

async function getOpenReaderPdfDocument(attachmentItemID: number) {
  const readerManager = (Zotero as any).Reader;
  const readers = Array.isArray(readerManager?._readers)
    ? readerManager._readers
    : [];

  for (const reader of readers) {
    if (Number(reader?.itemID || 0) !== attachmentItemID) {
      continue;
    }

    try {
      if (typeof reader?._waitForReader === "function") {
        await reader._waitForReader();
      }
    } catch {
      // ignore and continue probing objects below
    }

    const primaryView = reader?._internalReader?._primaryView;
    const iframeWindow =
      primaryView?._iframeWindow ||
      reader?._iframeWindow ||
      primaryView?._iframe?.contentWindow;
    const wrappedWindow = iframeWindow?.wrappedJSObject || iframeWindow;
    const app = wrappedWindow?.PDFViewerApplication;
    const pdfDocument = app?.pdfDocument as PdfDocumentProxy | undefined;
    if (pdfDocument && typeof pdfDocument.getOutline === "function") {
      return pdfDocument;
    }
  }

  return null;
}

function binaryStringToUint8Array(binary: string) {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array) {
  const copied = new Uint8Array(bytes.byteLength);
  copied.set(bytes);
  return copied.buffer;
}

async function safeCleanupPdf(pdf: PdfDocumentProxy | null) {
  if (!pdf) {
    return;
  }
  try {
    if (typeof pdf.cleanup === "function") {
      await pdf.cleanup();
    }
  } catch (error) {
    logOutlineDebug({
      stage: "cleanup",
      target: "pdf.cleanup",
      error: stringifyError(error),
    });
  }
  try {
    if (typeof pdf.destroy === "function") {
      await pdf.destroy();
    }
  } catch (error) {
    logOutlineDebug({
      stage: "cleanup",
      target: "pdf.destroy",
      error: stringifyError(error),
    });
  }
}

async function safeDestroyLoadingTask(task: PdfLoadingTask | null) {
  if (!task || typeof task.destroy !== "function") {
    return;
  }
  try {
    await task.destroy();
  } catch (error) {
    logOutlineDebug({
      stage: "cleanup",
      target: "loadingTask.destroy",
      error: stringifyError(error),
    });
  }
}

function logOutlineDebug(payload: Record<string, unknown>) {
  ztoolkit.log("[pdf-outline]", payload);
}

function stringifyError(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const value: any = error;
    if (typeof value.message === "string" && value.message.trim()) {
      const name = typeof value.name === "string" ? `${value.name}: ` : "";
      return `${name}${value.message}`;
    }
    try {
      if (typeof value.toString === "function") {
        const text = String(value.toString());
        if (text && text !== "[object Object]") {
          return text;
        }
      }
    } catch {
      // ignore
    }
  }
  try {
    const json = JSON.stringify(error);
    return json && json !== "{}" ? json : "Unknown error object";
  } catch {
    return "Unknown error";
  }
}
