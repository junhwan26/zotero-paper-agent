import { config } from "../../package.json";
import {
  type PdfSectionContext,
  extractSectionContextsFromAttachment,
} from "./pdfOutline";
import { getLocaleID } from "../utils/locale";

type ChatRole = "user" | "assistant";

interface ChatSectionLink {
  title: string;
  path?: string;
  pageNumber?: number;
  attachmentItemID?: number;
}

interface ChatMessage {
  role: ChatRole;
  content: string;
  createdAt: string;
  sectionLinks?: ChatSectionLink[];
}

interface TextChunk {
  id: string;
  text: string;
  start: number;
  end: number;
}

interface PaperIndex {
  hash: string;
  title: string;
  source: string;
  chunks: TextChunk[];
  updatedAt: string;
}

interface ConversationMemory {
  summary: string;
  updatedAt: string;
  turnCount: number;
}

interface PaperEmbeddings {
  endpoint: string;
  model: string;
  chunkHashes: Record<string, string>;
  vectors: Record<string, number[]>;
  updatedAt: string;
}

interface PaperStore {
  version: 2;
  papers: Record<string, PaperIndex>;
  conversations: Record<string, ChatMessage[]>;
  memories: Record<string, ConversationMemory>;
  embeddings: Record<string, PaperEmbeddings>;
}

interface ResolvedPaper {
  paperID: string;
  title: string;
  paperItem: Zotero.Item;
  attachmentItem: Zotero.Item | null;
}

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  localMode: boolean;
}

interface EmbeddingConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  localMode: boolean;
}

interface RetrievalResult {
  chunks: TextChunk[];
  retrievalMode: "keyword" | "hybrid";
}

interface SummaryPlanSection {
  id: string;
  title: string;
  objective: string;
  retrievalQueries: string[];
  anchorChunkIndex?: number;
  headingLevel?: number;
}

interface SummaryPlan {
  sections: SummaryPlanSection[];
  reasoning: string;
}

interface SectionDraft {
  section: SummaryPlanSection;
  evidence: TextChunk[];
  retrievalMode: "keyword" | "hybrid";
  draft: string;
}

interface SummaryProgress {
  percent: number;
  stage: string;
}

interface PromptConfig {
  summarySinglePassSystem: string;
  summarySinglePassUser: string;
  summarySectionSystem: string;
  summarySectionUser: string;
  qaSystem: string;
  qaUser: string;
  memorySystem: string;
  memoryUser: string;
}

type SummaryProgressHandler = (progress: SummaryProgress) => void;

const STORE_FILE_NAME = "paper-chat-store-v1.json";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_ENDPOINT = "https://api.openai.com/v1/embeddings";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_CHAT_MODEL = "qwen2.5:7b-instruct";
const DEFAULT_LOCAL_EMBEDDING_MODEL = "nomic-embed-text";
const CHUNK_SIZE = 1600;
const CHUNK_OVERLAP = 260;
const MAX_CONTEXT_CHARS = 12000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_STORED_MESSAGES = 60;
const MEMORY_REFRESH_MIN_NEW_MESSAGES = 6;
const MEMORY_SOURCE_WINDOW = 18;
const EMBEDDING_BATCH_SIZE = 12;
const SECTION_ID = "paper-chat";
const STANDALONE_HIDDEN_ATTR = "data-paper-chat-hidden";
const PROMPT_CONFIG_URL = `${rootURI}content/paperChatPrompts.json`;
const PROMPT_CONFIG_CACHE_TTL_MS = 2000;

const renderTokens = new WeakMap<Element, string>();
const indexCache = new Map<string, PaperIndex>();
const topPlacementTimers = new WeakMap<Document, number>();

let storeCache: PaperStore | null = null;
let storeWriteQueue: Promise<void> = Promise.resolve();
let promptConfigCache: PromptConfig | null = null;
let promptConfigLoadedAt = 0;
let promptConfigLoadFailed = false;

const DEFAULT_PROMPT_CONFIG: PromptConfig = {
  summarySinglePassSystem: [
    "당신은 논문 요약 도우미다.",
    "설명은 한국어로 하되, 고유명사/원문 용어는 필요한 경우 원문을 유지한다.",
    "주어진 컨텍스트 밖 사실을 추측하지 않는다.",
  ].join(" "),
  summarySinglePassUser: [
    "논문 제목: {{title}}",
    "",
    "다음 논문을 한국어로 요약해.",
    "가능하면 소목차(예: 2.1, 3.2.1) 제목을 그대로 유지해 섹션별로 작성해.",
    "각 섹션은 핵심 주장, 방법, 결과, 한계를 상세히 정리해.",
    "컨텍스트에 없는 내용은 추측하지 말고 '근거 부족'을 명시해.",
    "",
    "논문 컨텍스트:",
    "{{context}}",
  ].join("\n"),
  summarySectionSystem: [
    "당신은 논문 요약 에이전트의 섹션 작성기다.",
    "컨텍스트 범위 내 사실만 사용하고 한국어로 작성한다.",
  ].join(" "),
  summarySectionUser: [
    "논문 제목: {{title}}",
    "섹션 제목: {{section_title}}",
    "섹션 목표: {{section_objective}}",
    "",
    "요구사항:",
    "- 섹션 제목은 다시 쓰지 말고 본문만 작성",
    "- 8~12줄로 상세하게 작성",
    "- 핵심 주장/방법/실험근거/정량결과/한계 순서로 정리",
    "- 근거가 부족하면 그 부분에 '근거 부족' 명시",
    "- 컨텍스트 바깥 정보 추측 금지",
    "",
    "컨텍스트:",
    "{{context}}",
  ].join("\n"),
  qaSystem: [
    "당신은 논문 Q&A 보조 도우미다.",
    "답변은 기본 한국어로 작성한다.",
    "원문 컨텍스트와 대화 기록에 있는 정보만 사용한다.",
    "추측하지 말고, 정보가 부족하면 필요한 정보를 명시한다.",
    "각 핵심 주장 문장 끝에 [C숫자] 인용을 붙인다.",
  ].join(" "),
  qaUser: [
    "논문 제목: {{title}}",
    "",
    "{{memory_block}}",
    "",
    "컨텍스트:",
    "{{context}}",
    "",
    "질문: {{question}}",
  ].join("\n"),
  memorySystem: [
    "당신은 대화 메모리를 압축하는 도우미다.",
    "사실 기반으로 짧게 요약하고, 미해결 질문과 사용자 의도를 분리해 정리한다.",
    "추측은 금지한다.",
  ].join(" "),
  memoryUser: [
    "논문 제목: {{title}}",
    "",
    "아래 대화 기록을 이후 턴에서 사용할 장기 메모리로 8줄 이내 요약해.",
    "- 사용자 핵심 관심사",
    "- 이미 합의된 사실",
    "- 아직 답하지 못한 질문",
    "- 답변 스타일 선호(언어/형식)",
    "",
    "{{transcript}}",
  ].join("\n"),
};

export function registerPaperChatSection() {
  unregisterPaperChatSection();

  Zotero.ItemPaneManager.registerSection({
    paneID: SECTION_ID,
    pluginID: addon.data.config.addonID,
    header: {
      l10nID: getLocaleID("item-section-example2-head-text"),
      l10nArgs: '{"status": "Ready"}',
      icon: "chrome://zotero/skin/16/universal/book.svg",
    },
    sidenav: {
      l10nID: getLocaleID("item-section-example2-sidenav-tooltip"),
      icon: "chrome://zotero/skin/20/universal/save.svg",
    },
    onItemChange: ({ tabType, setEnabled, doc }) => {
      const enabled = tabType === "reader" && isPaperChatEnabled();
      setEnabled(enabled);
      schedulePaperChatSectionAtTop(doc);
      applyStandaloneSidebarMode(doc, enabled && isReaderStandaloneMode());
      return true;
    },
    onDestroy: ({ doc }) => {
      applyStandaloneSidebarMode(doc, false);
    },
    onRender: (props) => {
      void renderPaperChatSection(props as any);
    },
  });
}

export function unregisterPaperChatSection() {
  try {
    Zotero.ItemPaneManager.unregisterSection(SECTION_ID);
  } catch {
    // ignore if section was not registered yet
  }
}

async function renderPaperChatSection(props: {
  body: Element;
  item?: Zotero.Item;
  setL10nArgs: (args: string) => void;
  setSectionSummary: (summary: string) => void;
}) {
  const { body, item, setL10nArgs, setSectionSummary } = props;
  const doc = body.ownerDocument;
  if (!doc) {
    return;
  }

  if (!item) {
    body.textContent = "";
    return;
  }

  if (!isPaperChatEnabled()) {
    body.textContent = "";
    const hint = createElement(doc, "div", "paper-chat-hint");
    hint.textContent =
      "Paper chat is disabled. Enable it in plugin preferences.";
    body.append(hint);
    setL10nArgs('{\"status\": \"Off\"}');
    setSectionSummary("disabled");
    return;
  }

  const token = `${Date.now()}-${Math.random()}`;
  renderTokens.set(body, token);

  body.textContent = "";

  const root = createElement(doc, "div", "paper-chat-root");
  const toolbar = createElement(doc, "div", "paper-chat-toolbar");
  const statusText = createElement(doc, "span", "paper-chat-status");
  statusText.textContent = getLLMConfig().localMode ? "Ready (Local)" : "Ready";

  const summarizeButton = createElement(doc, "button", "paper-chat-action");
  summarizeButton.type = "button";
  summarizeButton.textContent = "Summarize";

  const clearButton = createElement(doc, "button", "paper-chat-action");
  clearButton.type = "button";
  clearButton.textContent = "Clear Chat";

  toolbar.append(statusText, summarizeButton, clearButton);

  const progress = createElement(doc, "div", "paper-chat-progress");
  const progressBar = createElement(doc, "div", "paper-chat-progress-bar");
  const progressFill = createElement(doc, "div", "paper-chat-progress-fill");
  const progressLabel = createElement(doc, "span", "paper-chat-progress-label");
  progress.hidden = true;
  progressFill.style.width = "0%";
  progressBar.append(progressFill);
  progress.append(progressBar, progressLabel);

  const messages = createElement(doc, "div", "paper-chat-messages");

  const composer = createElement(doc, "div", "paper-chat-composer");
  const input = createElement(doc, "textarea", "paper-chat-input");
  input.placeholder = "Ask about this paper...";
  input.rows = 3;

  const sendButton = createElement(doc, "button", "paper-chat-send");
  sendButton.type = "button";
  sendButton.textContent = "Send";

  composer.append(input, sendButton);
  root.append(toolbar, progress, messages, composer);
  body.append(root);
  schedulePaperChatSectionAtTop(doc);

  const isCurrentRender = () => {
    return body.isConnected && renderTokens.get(body) === token;
  };

  const setBusy = (busy: boolean, label?: string) => {
    summarizeButton.disabled = busy;
    clearButton.disabled = busy;
    sendButton.disabled = busy;
    input.disabled = busy;
    if (label) {
      statusText.textContent = label;
    }
  };

  const setSummaryProgress = (state?: SummaryProgress) => {
    if (!state) {
      progress.hidden = true;
      progressFill.style.width = "0%";
      progressLabel.textContent = "";
      return;
    }

    const percent = Math.max(0, Math.min(100, Math.round(state.percent)));
    progress.hidden = false;
    progressFill.style.width = `${percent}%`;
    progressLabel.textContent = `${percent}% · ${state.stage}`;
  };

  const renderConversation = async () => {
    const resolved = await resolvePaper(item);
    if (!isCurrentRender()) {
      return resolved;
    }

    const conversation = await getConversation(resolved.paperID);
    messages.textContent = "";
    const attachmentItemID = Number((resolved.attachmentItem as any)?.id || 0);

    if (!conversation.length) {
      const hint = createElement(doc, "div", "paper-chat-hint");
      hint.textContent = "No messages yet. Click Summarize or ask a question.";
      messages.append(hint);
    } else {
      for (const message of conversation) {
        const bubble = createElement(
          doc,
          "div",
          `paper-chat-bubble paper-chat-bubble-${message.role}`,
        );
        renderChatBubbleContent(doc, bubble, message, attachmentItemID);
        messages.append(bubble);
      }
      messages.scrollTop = messages.scrollHeight;
    }

    setSectionSummary(`${Math.ceil(conversation.length / 2)} turns`);
    return resolved;
  };

  let resolvedPaper: ResolvedPaper;
  try {
    resolvedPaper = await renderConversation();
  } catch (error) {
    messages.textContent = "";
    const bubble = createElement(
      doc,
      "div",
      "paper-chat-bubble paper-chat-bubble-assistant",
    );
    bubble.textContent = stringifyError(error);
    messages.append(bubble);
    statusText.textContent = stringifyError(error);
    setL10nArgs('{\"status\": \"Error\"}');
    setSectionSummary("error");
    return;
  }
  if (!isCurrentRender()) {
    return;
  }

  setL10nArgs(`{"status": "${resolvedPaper.attachmentItem ? "PDF" : "Meta"}"}`);
  if (isReaderStandaloneMode()) {
    applyStandaloneSidebarMode(doc, true);
  }

  summarizeButton.addEventListener("click", async () => {
    if (!isCurrentRender()) {
      return;
    }

    setBusy(true, "Summarizing...");
    setSummaryProgress({
      percent: 1,
      stage: "요약 시작",
    });
    try {
      const result = await summarizePaper(item, (state) => {
        if (!isCurrentRender()) {
          return;
        }
        setSummaryProgress(state);
        statusText.textContent = `Summarizing... ${Math.round(state.percent)}%`;
      });
      statusText.textContent = `Summary complete (${result.usedChunks} chunks)`;
      setSummaryProgress({
        percent: 100,
        stage: "요약 완료",
      });
      resolvedPaper = await renderConversation();
      setL10nArgs(
        `{"status": "${resolvedPaper.attachmentItem ? "PDF" : "Meta"}"}`,
      );
    } catch (error) {
      statusText.textContent = stringifyError(error);
      setSummaryProgress();
    } finally {
      if (isCurrentRender()) {
        setBusy(false);
      }
    }
  });

  clearButton.addEventListener("click", async () => {
    if (!isCurrentRender()) {
      return;
    }

    setBusy(true, "Clearing...");
    setSummaryProgress();
    try {
      await clearConversation(resolvedPaper.paperID);
      await renderConversation();
      statusText.textContent = "Conversation cleared";
    } catch (error) {
      statusText.textContent = stringifyError(error);
    } finally {
      if (isCurrentRender()) {
        setBusy(false);
      }
    }
  });

  const sendMessage = async () => {
    if (!isCurrentRender()) {
      return;
    }

    const question = input.value.trim();
    if (!question) {
      return;
    }

    input.value = "";
    setBusy(true, "Generating answer...");
    setSummaryProgress();
    try {
      const result = await askPaperQuestion(item, question);
      statusText.textContent = `Answer complete (${result.usedChunks} chunks, ${result.retrievalMode})`;
      resolvedPaper = await renderConversation();
      setL10nArgs(
        `{"status": "${resolvedPaper.attachmentItem ? "PDF" : "Meta"}"}`,
      );
    } catch (error) {
      statusText.textContent = stringifyError(error);
    } finally {
      if (isCurrentRender()) {
        setBusy(false);
      }
    }
  };

  sendButton.addEventListener("click", () => {
    void sendMessage();
  });

  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });
}

async function getPromptConfig() {
  if (
    promptConfigCache &&
    Date.now() - promptConfigLoadedAt < PROMPT_CONFIG_CACHE_TTL_MS
  ) {
    return promptConfigCache;
  }

  try {
    const rawText = await loadPromptConfigText();
    const parsed = JSON.parse(rawText);
    promptConfigCache = normalizePromptConfig(parsed);
    promptConfigLoadedAt = Date.now();
    promptConfigLoadFailed = false;
    return promptConfigCache;
  } catch (error) {
    if (!promptConfigLoadFailed) {
      ztoolkit.log(
        "Failed to load paper agent prompt config; using defaults",
        error,
      );
      promptConfigLoadFailed = true;
    }
    promptConfigLoadedAt = Date.now();
    if (!promptConfigCache) {
      promptConfigCache = { ...DEFAULT_PROMPT_CONFIG };
    }
    return promptConfigCache;
  }
}

async function loadPromptConfigText() {
  try {
    const response = await fetch(PROMPT_CONFIG_URL);
    if (response.ok) {
      return await response.text();
    }
    throw new Error(`HTTP ${response.status}`);
  } catch {
    const zoteroFile = (Zotero as any).File;
    if (
      zoteroFile &&
      typeof zoteroFile.getContentsFromURLAsync === "function"
    ) {
      const value = await zoteroFile.getContentsFromURLAsync(PROMPT_CONFIG_URL);
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    throw new Error(`Prompt config unavailable at ${PROMPT_CONFIG_URL}`);
  }
}

function normalizePromptConfig(raw: any): PromptConfig {
  return {
    summarySinglePassSystem: toPromptText(
      raw?.summarySinglePassSystem,
      DEFAULT_PROMPT_CONFIG.summarySinglePassSystem,
    ),
    summarySinglePassUser: toPromptText(
      raw?.summarySinglePassUser,
      DEFAULT_PROMPT_CONFIG.summarySinglePassUser,
    ),
    summarySectionSystem: toPromptText(
      raw?.summarySectionSystem,
      DEFAULT_PROMPT_CONFIG.summarySectionSystem,
    ),
    summarySectionUser: toPromptText(
      raw?.summarySectionUser,
      DEFAULT_PROMPT_CONFIG.summarySectionUser,
    ),
    qaSystem: toPromptText(raw?.qaSystem, DEFAULT_PROMPT_CONFIG.qaSystem),
    qaUser: toPromptText(raw?.qaUser, DEFAULT_PROMPT_CONFIG.qaUser),
    memorySystem: toPromptText(
      raw?.memorySystem,
      DEFAULT_PROMPT_CONFIG.memorySystem,
    ),
    memoryUser: toPromptText(raw?.memoryUser, DEFAULT_PROMPT_CONFIG.memoryUser),
  };
}

function toPromptText(value: unknown, fallback: string) {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : fallback;
  }

  if (Array.isArray(value)) {
    const lines = value
      .map((line) => String(line ?? ""))
      .filter((line) => typeof line === "string");
    const joined = lines.join("\n").trim();
    return joined ? joined : fallback;
  }

  return fallback;
}

function renderPromptTemplate(
  template: string,
  values: Record<string, string | number | undefined>,
) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    if (value === undefined) {
      return "";
    }
    return String(value);
  });
}

async function summarizePaper(
  item: Zotero.Item,
  onProgress?: SummaryProgressHandler,
) {
  reportSummaryProgress(onProgress, 3, "논문 로딩");
  const resolved = await resolvePaper(item);
  reportSummaryProgress(onProgress, 8, "텍스트 인덱스 준비");
  const index = await ensurePaperIndex(resolved);
  let answer = "";
  let usedChunks = 0;
  let sectionLinks: ChatSectionLink[] | undefined;

  try {
    if (resolved.attachmentItem) {
      try {
        const tocResult = await runBookmarkContextSummaryPipeline(
          resolved,
          index,
          onProgress,
        );
        answer = tocResult.answer;
        usedChunks = tocResult.usedChunks;
        sectionLinks = tocResult.sectionLinks;
      } catch (tocError) {
        ztoolkit.log(
          "Bookmark-context summary pipeline failed; fallback to single-pass",
          tocError,
        );
      }
    }

    if (!answer.trim()) {
      reportSummaryProgress(onProgress, 45, "폴백 요약 실행");
      const fallback = await summarizePaperSinglePass(index, onProgress);
      answer = fallback.answer;
      usedChunks = fallback.usedChunks;
    }
  } catch (error) {
    ztoolkit.log("Summary pipeline failed; fallback to single-pass", error);
    reportSummaryProgress(onProgress, 45, "폴백 요약 실행");
    const fallback = await summarizePaperSinglePass(index, onProgress);
    answer = fallback.answer;
    usedChunks = fallback.usedChunks;
  }
  reportSummaryProgress(onProgress, 100, "요약 완료");

  const assistantMessage: ChatMessage = {
    role: "assistant",
    content: answer,
    createdAt: new Date().toISOString(),
    ...(sectionLinks?.length ? { sectionLinks } : {}),
  };

  await appendConversation(resolved.paperID, [
    {
      role: "user",
      content: "이 논문을 요약해줘.",
      createdAt: new Date().toISOString(),
    },
    assistantMessage,
  ]);
  void refreshConversationMemoryIfNeeded(resolved.paperID, index.title);

  return {
    answer,
    usedChunks,
  };
}

async function runBookmarkContextSummaryPipeline(
  resolved: ResolvedPaper,
  index: PaperIndex,
  onProgress?: SummaryProgressHandler,
) {
  const attachmentID = Number((resolved.attachmentItem as any)?.id || 0);
  if (!attachmentID) {
    throw new Error("PDF attachment is required for bookmark-context summary.");
  }

  reportSummaryProgress(onProgress, 12, "PDF 목차 컨텍스트 추출");
  const contexts = await extractSectionContextsFromAttachment(attachmentID);
  const prepared = prepareBookmarkContextSummaryPlan(contexts);
  if (!prepared.plan.sections.length) {
    throw new Error("No bookmark sections available for summary.");
  }

  const sectionDrafts: SectionDraft[] = [];
  const totalSteps = Math.max(1, prepared.plan.sections.length + 1);
  const phaseStart = 24;
  const phaseSpan = 72;
  let step = 0;

  for (const section of prepared.plan.sections) {
    step += 1;
    reportSummaryProgress(
      onProgress,
      phaseStart + (phaseSpan * step) / totalSteps,
      `소목차 요약: ${section.title}`,
    );

    const context = prepared.contextBySectionID.get(section.id);
    if (!context) {
      continue;
    }
    const contextText = context.contextText?.trim() || "";
    if (!contextText) {
      continue;
    }

    const chunk = buildContextChunkFromPdfSection(context);
    try {
      const draft = await draftSummarySection(index, section, [chunk]);
      sectionDrafts.push({
        section,
        evidence: [chunk],
        retrievalMode: "keyword",
        draft,
      });
    } catch (error) {
      ztoolkit.log("Bookmark section summary failed", {
        sectionID: section.id,
        title: section.title,
        error,
      });
    }
  }

  step += 1;
  reportSummaryProgress(
    onProgress,
    phaseStart + (phaseSpan * step) / totalSteps,
    "최종 요약 편집",
  );

  const answerDraft = await composeSectionedSummary(
    index,
    prepared.plan,
    sectionDrafts,
  );
  const usedEvidenceMap = new Map<string, TextChunk>();
  for (const sectionDraft of sectionDrafts) {
    for (const chunk of sectionDraft.evidence) {
      usedEvidenceMap.set(chunk.id, chunk);
    }
  }
  const sectionLinks = prepared.plan.sections
    .map((section): ChatSectionLink | null => {
      const context = prepared.contextBySectionID.get(section.id);
      if (!context) {
        return null;
      }
      const pageNumber = context.startPageNumber ?? context.pageNumber;
      return {
        title: section.title,
        path: context.path,
        pageNumber,
        attachmentItemID:
          Number((resolved.attachmentItem as any)?.id || 0) || undefined,
      };
    })
    .filter((entry): entry is ChatSectionLink => Boolean(entry));

  return {
    answer: answerDraft.trim(),
    usedChunks: usedEvidenceMap.size,
    sectionLinks,
  };
}

function prepareBookmarkContextSummaryPlan(contexts: PdfSectionContext[]) {
  const selected = contexts.filter((entry) =>
    Boolean(String(entry.title || "").trim()),
  );
  const sections: SummaryPlanSection[] = [];
  const contextBySectionID = new Map<string, PdfSectionContext>();

  selected.forEach((entry, index) => {
    const sectionID = `toc-${entry.path || index + 1}`;
    const rangeText =
      typeof entry.startPageNumber === "number"
        ? entry.endPageNumber && entry.endPageNumber >= entry.startPageNumber
          ? `p.${entry.startPageNumber}-${entry.endPageNumber}`
          : `p.${entry.startPageNumber}`
        : undefined;
    const objective = rangeText
      ? `${entry.title} 소목차의 핵심 주장, 방법, 결과, 한계를 정리 (범위 ${rangeText})`
      : `${entry.title} 소목차의 핵심 주장, 방법, 결과, 한계를 정리`;

    sections.push({
      id: sectionID,
      title: entry.title,
      objective,
      retrievalQueries: [entry.title],
      headingLevel: entry.depth + 1,
    });
    contextBySectionID.set(sectionID, entry);
  });

  return {
    plan: {
      reasoning: "pdf-bookmark-context",
      sections,
    } as SummaryPlan,
    contextBySectionID,
  };
}

function buildContextChunkFromPdfSection(
  section: PdfSectionContext,
): TextChunk {
  const raw = String(section.contextText || "").trim();
  const text =
    raw.length > MAX_CONTEXT_CHARS
      ? `${raw.slice(0, MAX_CONTEXT_CHARS).trim()}...`
      : raw;
  return {
    id: `toc:${section.path || section.title}`,
    text,
    start: 0,
    end: text.length,
  };
}

async function summarizePaperSinglePass(
  index: PaperIndex,
  onProgress?: SummaryProgressHandler,
) {
  reportSummaryProgress(onProgress, 55, "단일 패스 컨텍스트 구성");
  const prompts = await getPromptConfig();
  const contextChunks = selectSummaryChunks(index);
  const contextText = buildContextBlock(contextChunks, {
    includeLabels: false,
  });

  const prompt = renderPromptTemplate(prompts.summarySinglePassUser, {
    title: index.title,
    context: contextText,
  });

  reportSummaryProgress(onProgress, 75, "단일 패스 요약 생성");
  const answerDraft = await requestLLM([
    {
      role: "system",
      content: renderPromptTemplate(prompts.summarySinglePassSystem, {
        title: index.title,
      }),
    },
    { role: "user", content: prompt },
  ]);

  return {
    answer: answerDraft.trim(),
    usedChunks: contextChunks.length,
  };
}

async function draftSummarySection(
  index: PaperIndex,
  section: SummaryPlanSection,
  evidence: TextChunk[],
) {
  const prompts = await getPromptConfig();
  const contextText = buildContextBlock(evidence, {
    includeLabels: false,
  });
  const sectionPrompt = renderPromptTemplate(prompts.summarySectionUser, {
    title: index.title,
    section_title: section.title,
    section_objective: section.objective,
    context: contextText,
  });

  const sectionDraft = await requestLLM([
    {
      role: "system",
      content: renderPromptTemplate(prompts.summarySectionSystem, {
        title: index.title,
        section_title: section.title,
      }),
    },
    { role: "user", content: sectionPrompt },
  ]);

  return sectionDraft.trim();
}

async function composeSectionedSummary(
  index: PaperIndex,
  plan: SummaryPlan,
  sectionDrafts: SectionDraft[],
) {
  const draftByID = new Map(
    sectionDrafts.map((draft) => [draft.section.id, draft]),
  );
  const ordered = plan.sections
    .map((section) => {
      const match = draftByID.get(section.id);
      if (!match || !match.draft.trim()) {
        return `### ${section.title}\n근거 부족`;
      }
      return `### ${section.title}\n${match.draft.trim()}`;
    })
    .join("\n\n");

  const uncertain = plan.sections
    .filter((section) => {
      const text = draftByID.get(section.id)?.draft || "";
      return /근거 부족|정보 부족|불명확/.test(text);
    })
    .map((section) => `- ${section.title}`);

  return [
    `TL;DR: ${index.title}의 소목차별 핵심 내용을 상세 정리했습니다.`,
    "",
    "## 소목차별 상세 요약",
    ordered || "소목차를 찾지 못했습니다.",
    "",
    "## 확인이 필요한 항목",
    uncertain.length ? uncertain.join("\n") : "- 없음",
  ].join("\n");
}

async function askPaperQuestion(item: Zotero.Item, question: string) {
  const prompts = await getPromptConfig();
  const resolved = await resolvePaper(item);
  const index = await ensurePaperIndex(resolved);
  const conversation = await getConversation(resolved.paperID);
  const memory = await getConversationMemory(resolved.paperID);

  const retrieval = await retrieveRelevantChunks(
    resolved.paperID,
    index,
    question,
    6,
  );
  const contextText = buildContextBlock(retrieval.chunks);

  const history = conversation.slice(-MAX_HISTORY_MESSAGES).map(
    (message): LLMMessage => ({
      role: message.role,
      content: message.content,
    }),
  );

  const memoryBlock = memory?.summary
    ? ["대화 장기 메모리(참고용):", memory.summary].join("\n")
    : "대화 장기 메모리(참고용):\n(없음)";

  const messages: LLMMessage[] = [
    {
      role: "system",
      content: renderPromptTemplate(prompts.qaSystem, {
        title: index.title,
      }),
    },
    ...history,
    {
      role: "user",
      content: renderPromptTemplate(prompts.qaUser, {
        title: index.title,
        memory_block: memoryBlock,
        context: contextText,
        question,
      }),
    },
  ];

  const answerDraft = await requestLLM(messages);
  const answer = enforceEvidence(answerDraft, retrieval.chunks);

  await appendConversation(resolved.paperID, [
    {
      role: "user",
      content: question,
      createdAt: new Date().toISOString(),
    },
    {
      role: "assistant",
      content: answer,
      createdAt: new Date().toISOString(),
    },
  ]);
  void refreshConversationMemoryIfNeeded(resolved.paperID, index.title);

  return {
    answer,
    usedChunks: retrieval.chunks.length,
    retrievalMode: retrieval.retrievalMode,
  };
}

async function ensurePaperIndex(resolved: ResolvedPaper): Promise<PaperIndex> {
  if (indexCache.has(resolved.paperID)) {
    const cached = indexCache.get(resolved.paperID)!;
    if (cached.source === "pdf-cache") {
      return cached;
    }
  }

  const store = await loadStore();
  const existing = store.papers[resolved.paperID];

  const paperText = await loadPaperText(resolved);
  const normalizedText = normalizeText(paperText.text);
  if (existing) {
    const nextHash = hashText(normalizedText);
    if (
      existing.hash === nextHash &&
      existing.source === paperText.source &&
      existing.title === resolved.title
    ) {
      indexCache.set(resolved.paperID, existing);
      return existing;
    }
  }

  const index = buildPaperIndex(resolved, paperText.source, normalizedText);

  store.papers[resolved.paperID] = index;
  indexCache.set(resolved.paperID, index);
  await persistStore(store);
  return index;
}

function buildPaperIndex(
  resolved: ResolvedPaper,
  source: string,
  normalizedText: string,
): PaperIndex {
  const chunks = chunkText(normalizedText);
  if (!chunks.length) {
    throw new Error(
      "No readable paper content found. Index the PDF in Zotero first.",
    );
  }

  return {
    hash: hashText(normalizedText),
    title: resolved.title,
    source,
    chunks,
    updatedAt: new Date().toISOString(),
  };
}

function selectSummaryChunks(index: PaperIndex) {
  const chunks: TextChunk[] = [];
  let charCount = 0;

  for (const chunk of index.chunks) {
    chunks.push(chunk);
    charCount += chunk.text.length;
    if (charCount >= MAX_CONTEXT_CHARS) {
      break;
    }
  }

  return chunks;
}

function renderChatBubbleContent(
  doc: Document,
  bubble: HTMLElement,
  message: ChatMessage,
  fallbackAttachmentItemID: number,
) {
  const content = String(message.content || "");
  if (
    message.role !== "assistant" ||
    !Array.isArray(message.sectionLinks) ||
    !message.sectionLinks.length
  ) {
    bubble.textContent = content;
    return;
  }

  const linkLookup = buildSectionLinkLookup(message.sectionLinks);
  if (!linkLookup.size) {
    bubble.textContent = content;
    return;
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  lines.forEach((line, index) => {
    const heading = parseMarkdownHeading(line);
    if (heading) {
      const link = consumeSectionLink(linkLookup, heading.title);
      const pageNumber =
        typeof link?.pageNumber === "number" ? Math.floor(link.pageNumber) : 0;
      const attachmentItemID = Number(
        link?.attachmentItemID || fallbackAttachmentItemID || 0,
      );
      if (pageNumber > 0 && attachmentItemID > 0) {
        const anchor = createElement(doc, "a", "paper-chat-heading-link");
        anchor.href = "#";
        anchor.textContent = line;
        anchor.title = `Open section in PDF (p.${pageNumber})`;
        anchor.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void navigateToPdfSection(attachmentItemID, pageNumber).catch(
            (error) => {
              ztoolkit.log("Failed to navigate from heading link", {
                attachmentItemID,
                pageNumber,
                title: heading.title,
                error: stringifyError(error),
              });
            },
          );
        });
        bubble.append(anchor);
      } else {
        bubble.append(doc.createTextNode(line));
      }
    } else {
      bubble.append(doc.createTextNode(line));
    }

    if (index < lines.length - 1) {
      bubble.append(doc.createTextNode("\n"));
    }
  });
}

function parseMarkdownHeading(line: string) {
  const match = String(line || "").match(/^\s{0,3}#{2,6}\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }
  return {
    title: match[1],
  };
}

function buildSectionLinkLookup(sectionLinks: ChatSectionLink[]) {
  const lookup = new Map<string, ChatSectionLink[]>();
  for (const sectionLink of sectionLinks) {
    const key = normalizeHeadingKey(sectionLink.title);
    if (!key) {
      continue;
    }
    const queue = lookup.get(key);
    if (queue) {
      queue.push(sectionLink);
    } else {
      lookup.set(key, [sectionLink]);
    }
  }
  return lookup;
}

function consumeSectionLink(
  lookup: Map<string, ChatSectionLink[]>,
  headingTitle: string,
) {
  const key = normalizeHeadingKey(headingTitle);
  if (!key) {
    return null;
  }

  const exact = lookup.get(key);
  if (exact && exact.length) {
    return exact.shift()!;
  }

  for (const [candidateKey, queue] of lookup.entries()) {
    if (!queue.length) {
      continue;
    }
    if (candidateKey.includes(key) || key.includes(candidateKey)) {
      return queue.shift()!;
    }
  }

  return null;
}

function normalizeHeadingKey(value: string) {
  return String(value || "")
    .trim()
    .replace(/^#+\s*/, "")
    .replace(/^\d+(?:\.\d+)*[\)\.]?\s+/, "")
    .replace(/^[ivxlcdm]+[\)\.]?\s+/i, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.:;,\-]+$/g, "")
    .toLowerCase();
}

async function navigateToPdfSection(
  attachmentItemID: number,
  pageNumber: number,
) {
  const pageIndex = Math.max(0, Math.floor(pageNumber) - 1);
  const reader = findReaderForAttachment(attachmentItemID);

  if (reader) {
    try {
      if (typeof (reader as any)._waitForReader === "function") {
        await (reader as any)._waitForReader();
      }
    } catch {
      // ignore wait errors and try navigate directly
    }
    if (typeof (reader as any).navigate === "function") {
      await (reader as any).navigate({ pageIndex });
      return;
    }
  }

  const readerManager = (Zotero as any).Reader;
  if (readerManager && typeof readerManager.open === "function") {
    await readerManager.open(
      attachmentItemID,
      { pageIndex },
      { allowDuplicate: false },
    );
    return;
  }

  throw new Error("Reader API unavailable for section navigation.");
}

function findReaderForAttachment(attachmentItemID: number) {
  const readerManager = (Zotero as any).Reader;
  const readers = Array.isArray(readerManager?._readers)
    ? readerManager._readers
    : [];
  for (const reader of readers) {
    if (Number(reader?.itemID || 0) === attachmentItemID) {
      return reader;
    }
  }
  return null;
}

async function retrieveRelevantChunks(
  paperID: string,
  index: PaperIndex,
  query: string,
  topK: number,
): Promise<RetrievalResult> {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (!queryTokens.length) {
    return {
      chunks: selectSummaryChunks(index).slice(0, topK),
      retrievalMode: "keyword",
    };
  }

  const lexicalScores = new Map<string, number>();
  for (const chunk of index.chunks) {
    const score = scoreChunk(chunk.text, queryTokens);
    if (score > 0) {
      lexicalScores.set(chunk.id, score);
    }
  }

  const keywordChunks = limitChunksByContext(
    index.chunks
      .filter((chunk) => (lexicalScores.get(chunk.id) || 0) > 0)
      .sort(
        (a, b) =>
          (lexicalScores.get(b.id) || 0) - (lexicalScores.get(a.id) || 0),
      )
      .slice(0, topK),
  );

  if (!isHybridSearchEnabled()) {
    return {
      chunks: keywordChunks.length
        ? keywordChunks
        : selectSummaryChunks(index).slice(0, topK),
      retrievalMode: "keyword",
    };
  }

  try {
    const queryVector = await requestEmbedding(query);
    const chunkVectors = await getOrCreateChunkEmbeddings(paperID, index);

    if (!queryVector.length || !chunkVectors.size) {
      return {
        chunks: keywordChunks.length
          ? keywordChunks
          : selectSummaryChunks(index).slice(0, topK),
        retrievalMode: "keyword",
      };
    }

    const denseScores = new Map<string, number>();
    for (const chunk of index.chunks) {
      const vector = chunkVectors.get(chunk.id);
      if (!vector || !vector.length) {
        continue;
      }
      const score = cosineSimilarity(queryVector, vector);
      if (Number.isFinite(score)) {
        denseScores.set(chunk.id, score);
      }
    }

    const lexicalNorm = normalizeScores(lexicalScores);
    const denseNorm = normalizeScores(denseScores);
    const denseWeight = queryTokens.length < 4 ? 0.62 : 0.55;
    const lexicalWeight = 1 - denseWeight;

    const ranked = index.chunks
      .map((chunk) => {
        const lexical = lexicalNorm.get(chunk.id) || 0;
        const dense = denseNorm.get(chunk.id) || 0;
        return {
          chunk,
          score: lexicalWeight * lexical + denseWeight * dense,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((entry) => entry.chunk);

    if (!ranked.length) {
      return {
        chunks: keywordChunks.length
          ? keywordChunks
          : selectSummaryChunks(index).slice(0, topK),
        retrievalMode: "keyword",
      };
    }

    return {
      chunks: limitChunksByContext(ranked),
      retrievalMode: "hybrid",
    };
  } catch (error) {
    ztoolkit.log(
      "Hybrid retrieval failed; fallback to keyword retrieval",
      error,
    );
    return {
      chunks: keywordChunks.length
        ? keywordChunks
        : selectSummaryChunks(index).slice(0, topK),
      retrievalMode: "keyword",
    };
  }
}

function limitChunksByContext(
  chunks: TextChunk[],
  maxChars = MAX_CONTEXT_CHARS,
) {
  let charCount = 0;
  const limited: TextChunk[] = [];
  for (const chunk of chunks) {
    limited.push(chunk);
    charCount += chunk.text.length;
    if (charCount >= maxChars) {
      break;
    }
  }
  return limited;
}

function normalizeScores(scores: Map<string, number>) {
  if (!scores.size) {
    return new Map<string, number>();
  }

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const score of scores.values()) {
    if (score < min) {
      min = score;
    }
    if (score > max) {
      max = score;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return new Map<string, number>();
  }

  if (Math.abs(max - min) < 1e-9) {
    const normalized = new Map<string, number>();
    for (const [key] of scores) {
      normalized.set(key, 1);
    }
    return normalized;
  }

  const normalized = new Map<string, number>();
  for (const [key, score] of scores) {
    normalized.set(key, (score - min) / (max - min));
  }
  return normalized;
}

function scoreChunk(text: string, queryTokens: string[]) {
  const tokens = tokenize(text);
  if (!tokens.length) {
    return 0;
  }

  const tokenFreq = new Map<string, number>();
  for (const token of tokens) {
    tokenFreq.set(token, (tokenFreq.get(token) || 0) + 1);
  }

  let score = 0;
  for (const token of queryTokens) {
    const tf = tokenFreq.get(token) || 0;
    if (tf > 0) {
      score += 1 + Math.log(tf);
    }
  }

  return score / Math.sqrt(tokens.length);
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F\u4E00-\u9FFF\uAC00-\uD7AF\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function buildContextBlock(
  chunks: TextChunk[],
  options?: {
    includeLabels?: boolean;
  },
) {
  const includeLabels = options?.includeLabels ?? true;
  return chunks
    .map((chunk, index) =>
      includeLabels ? `[C${index + 1}] ${chunk.text}` : chunk.text,
    )
    .join("\n\n");
}

async function resolvePaper(item: Zotero.Item): Promise<ResolvedPaper> {
  let paperItem = item;

  const parentID = getParentID(item);
  if (!isRegularItem(item) && parentID) {
    const parent = await Zotero.Items.getAsync(parentID);
    if (parent) {
      paperItem = parent;
    }
  }

  let attachmentItem: Zotero.Item | null = null;

  if (isPdfAttachment(item)) {
    attachmentItem = item;
  }

  if (!attachmentItem && isRegularItem(paperItem)) {
    const attachmentIDs = ((paperItem as any).getAttachments?.() || []) as
      | number[]
      | string[];
    for (const attachmentID of attachmentIDs) {
      const attachment = await Zotero.Items.getAsync(Number(attachmentID));
      if (attachment && isPdfAttachment(attachment)) {
        attachmentItem = attachment;
        break;
      }
    }
  }

  const title =
    readFieldText(paperItem, "title") ||
    readFieldText(item, "title") ||
    "Untitled";

  return {
    paperID: String((paperItem as any).id || (item as any).id),
    title,
    paperItem,
    attachmentItem,
  };
}

async function loadPaperText(resolved: ResolvedPaper) {
  const sourceParts: string[] = [];

  if (resolved.attachmentItem) {
    const pdfText = await readPDFCacheText(resolved.attachmentItem);
    if (pdfText) {
      sourceParts.push("pdf-cache");
      return {
        text: pdfText,
        source: sourceParts.join("+"),
      };
    }
  }

  const abstractText = stripHTML(
    readFieldText(resolved.paperItem, "abstractNote"),
  );
  if (abstractText) {
    sourceParts.push("abstract");
    return {
      text: abstractText,
      source: sourceParts.join("+"),
    };
  }

  const title = readFieldText(resolved.paperItem, "title");
  if (title) {
    sourceParts.push("title");
    return {
      text: title,
      source: sourceParts.join("+"),
    };
  }

  return {
    text: "",
    source: "none",
  };
}

async function readPDFCacheText(attachment: Zotero.Item) {
  const filePath = await getAttachmentFilePath(attachment);
  if (!filePath) {
    return "";
  }

  const folderPath = dirname(filePath);
  if (!folderPath) {
    return "";
  }

  const cachePath = joinPath(folderPath, ".zotero-ft-cache");
  return normalizeText(await readTextFile(cachePath));
}

async function getAttachmentFilePath(attachment: Zotero.Item) {
  const anyAttachment = attachment as any;

  try {
    if (typeof anyAttachment.getFilePathAsync === "function") {
      const value = await anyAttachment.getFilePathAsync();
      if (typeof value === "string") {
        return value;
      }
    }
  } catch (error) {
    ztoolkit.log("getFilePathAsync failed", error);
  }

  try {
    if (typeof anyAttachment.getFilePath === "function") {
      const value = anyAttachment.getFilePath();
      if (typeof value === "string") {
        return value;
      }
    }
  } catch (error) {
    ztoolkit.log("getFilePath failed", error);
  }

  try {
    const attachmentsAPI = (Zotero as any).Attachments;
    if (
      attachmentsAPI &&
      typeof attachmentsAPI.getFilePathAsync === "function"
    ) {
      const value = await attachmentsAPI.getFilePathAsync(
        (attachment as any).id,
      );
      if (typeof value === "string") {
        return value;
      }
    }
  } catch (error) {
    ztoolkit.log("Attachments.getFilePathAsync failed", error);
  }

  return "";
}

function isRegularItem(item: Zotero.Item) {
  const anyItem = item as any;
  if (typeof anyItem.isRegularItem === "function") {
    return Boolean(anyItem.isRegularItem());
  }
  return false;
}

function isPdfAttachment(item: Zotero.Item) {
  const anyItem = item as any;

  if (typeof anyItem.isPDFAttachment === "function") {
    try {
      if (anyItem.isPDFAttachment()) {
        return true;
      }
    } catch (error) {
      ztoolkit.log("isPDFAttachment failed", error);
    }
  }

  if (typeof anyItem.isAttachment === "function" && !anyItem.isAttachment()) {
    return false;
  }

  if (typeof anyItem.attachmentContentType === "string") {
    return anyItem.attachmentContentType === "application/pdf";
  }

  const contentType = readFieldText(item, "contentType");
  return contentType === "application/pdf";
}

function getParentID(item: Zotero.Item) {
  const anyItem = item as any;
  const parentID = anyItem.parentItemID || anyItem.parentID;
  if (typeof parentID === "number") {
    return parentID;
  }
  if (typeof parentID === "string" && parentID.trim()) {
    return Number(parentID);
  }
  return 0;
}

function readFieldText(item: Zotero.Item, field: string) {
  try {
    const value = (item as any).getField?.(field);
    return typeof value === "string" ? value : "";
  } catch (error) {
    ztoolkit.log("getField failed", field, error);
    return "";
  }
}

function stripHTML(input: string) {
  return normalizeText(input.replace(/<[^>]+>/g, " "));
}

function normalizeText(input: string) {
  return input
    .replace(/\r/g, "\n")
    .replace(/[\t\f\v]+/g, " ")
    .replace(/\u0000/g, "")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkText(text: string) {
  if (!text) {
    return [];
  }

  const chunks: TextChunk[] = [];
  let index = 0;
  let start = 0;
  const overlap = Math.min(CHUNK_OVERLAP, Math.max(0, CHUNK_SIZE - 1));

  while (start < text.length) {
    const end = Math.min(text.length, start + CHUNK_SIZE);
    const chunkText = text.slice(start, end).trim();
    if (chunkText) {
      chunks.push({
        id: `chunk-${index + 1}`,
        text: chunkText,
        start,
        end,
      });
      index += 1;
    }

    if (end >= text.length) {
      break;
    }

    start = Math.max(start + 1, end - overlap);
  }

  return chunks;
}

async function requestLLM(messages: LLMMessage[]) {
  const llmConfig = getLLMConfig();

  if (!llmConfig.endpoint) {
    throw new Error("Set LLM endpoint in plugin preferences first.");
  }

  if (!llmConfig.model) {
    throw new Error("Set LLM model in plugin preferences first.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (llmConfig.apiKey) {
    headers.Authorization = `Bearer ${llmConfig.apiKey}`;
  }

  const payload = {
    model: llmConfig.model,
    messages,
    temperature: 0.2,
  };

  try {
    const responsePayload = await postJSON(
      llmConfig.endpoint,
      headers,
      payload,
    );
    const content = extractChatContent(responsePayload);

    if (!content) {
      throw new Error("LLM returned an empty response.");
    }

    return content;
  } catch (error: any) {
    const errorMessage = [
      "LLM request failed.",
      stringifyError(error),
      error?.responseText ? String(error.responseText) : "",
    ]
      .filter(Boolean)
      .join(" ");

    throw new Error(errorMessage);
  }
}

async function requestEmbedding(text: string) {
  const vectors = await requestEmbeddings([text]);
  return vectors[0] || [];
}

async function requestEmbeddings(texts: string[]) {
  if (!texts.length) {
    return [] as number[][];
  }

  const embeddingConfig = getEmbeddingConfig();
  if (!embeddingConfig.endpoint || !embeddingConfig.model) {
    throw new Error(
      "Set embedding endpoint/model in plugin preferences before hybrid search.",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (embeddingConfig.apiKey) {
    headers.Authorization = `Bearer ${embeddingConfig.apiKey}`;
  }

  const payload = {
    model: embeddingConfig.model,
    input: texts,
  };

  const responsePayload = await postJSON(
    embeddingConfig.endpoint,
    headers,
    payload,
  );
  const vectors = extractEmbeddingVectors(responsePayload);
  if (vectors.length !== texts.length) {
    throw new Error(
      `Embedding response size mismatch: requested ${texts.length}, got ${vectors.length}.`,
    );
  }
  return vectors;
}

async function postJSON(
  endpoint: string,
  headers: Record<string, string>,
  payload: unknown,
) {
  if (
    (Zotero as any).HTTP &&
    typeof (Zotero as any).HTTP.request === "function"
  ) {
    const response = await (Zotero.HTTP as any).request("POST", endpoint, {
      headers,
      body: JSON.stringify(payload),
    });
    return parseResponsePayload(response);
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let parsed: any = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${typeof parsed?.error?.message === "string" ? parsed.error.message : text}`,
    );
  }
  return parsed;
}

function getLLMConfig(): LLMConfig {
  const prefPrefix = config.prefsPrefix;
  const apiKey = String(
    Zotero.Prefs.get(`${prefPrefix}.llmApiKey`, true) || "",
  ).trim();
  const endpoint = normalizeChatEndpoint(
    String(
      Zotero.Prefs.get(`${prefPrefix}.llmBaseUrl`, true) || DEFAULT_ENDPOINT,
    ).trim(),
  );
  const model = String(
    Zotero.Prefs.get(`${prefPrefix}.llmModel`, true) || DEFAULT_MODEL,
  ).trim();
  const localMode = Boolean(Zotero.Prefs.get(`${prefPrefix}.localMode`, true));
  const localBaseUrl = String(
    Zotero.Prefs.get(`${prefPrefix}.localBaseUrl`, true) ||
      DEFAULT_LOCAL_BASE_URL,
  ).trim();
  const localEndpoint = normalizeChatEndpoint(localBaseUrl);
  const localModel = String(
    Zotero.Prefs.get(`${prefPrefix}.localChatModel`, true) ||
      DEFAULT_LOCAL_CHAT_MODEL,
  ).trim();

  if (localMode && localEndpoint) {
    return {
      endpoint: localEndpoint,
      apiKey: "",
      model: localModel || model,
      localMode: true,
    };
  }

  return {
    endpoint,
    apiKey,
    model,
    localMode: false,
  };
}

function getEmbeddingConfig(): EmbeddingConfig {
  const prefPrefix = config.prefsPrefix;
  const apiKey = String(
    Zotero.Prefs.get(`${prefPrefix}.llmApiKey`, true) || "",
  ).trim();
  const endpoint = normalizeEmbeddingEndpoint(
    String(
      Zotero.Prefs.get(`${prefPrefix}.embeddingBaseUrl`, true) ||
        DEFAULT_EMBEDDING_ENDPOINT,
    ).trim(),
  );
  const model = String(
    Zotero.Prefs.get(`${prefPrefix}.embeddingModel`, true) ||
      DEFAULT_EMBEDDING_MODEL,
  ).trim();
  const localMode = Boolean(Zotero.Prefs.get(`${prefPrefix}.localMode`, true));
  const localBaseUrl = String(
    Zotero.Prefs.get(`${prefPrefix}.localBaseUrl`, true) ||
      DEFAULT_LOCAL_BASE_URL,
  ).trim();
  const localEndpoint = normalizeEmbeddingEndpoint(localBaseUrl);
  const localModel = String(
    Zotero.Prefs.get(`${prefPrefix}.localEmbeddingModel`, true) ||
      DEFAULT_LOCAL_EMBEDDING_MODEL,
  ).trim();

  if (localMode && localEndpoint) {
    return {
      endpoint: localEndpoint,
      apiKey: "",
      model: localModel || model,
      localMode: true,
    };
  }

  return {
    endpoint,
    apiKey,
    model,
    localMode: false,
  };
}

function isPaperChatEnabled() {
  return Boolean(Zotero.Prefs.get(`${config.prefsPrefix}.enable`, true));
}

function isReaderStandaloneMode() {
  return Boolean(
    Zotero.Prefs.get(`${config.prefsPrefix}.readerStandalone`, true),
  );
}

function isHybridSearchEnabled() {
  return Boolean(
    Zotero.Prefs.get(`${config.prefsPrefix}.enableHybridSearch`, true),
  );
}

function isEvidenceRequired() {
  return Boolean(
    Zotero.Prefs.get(`${config.prefsPrefix}.requireEvidence`, true),
  );
}

function schedulePaperChatSectionAtTop(doc: Document | null | undefined) {
  if (!doc) {
    return;
  }

  placePaperChatSectionAtTop(doc);

  const view = doc.defaultView;
  if (!view) {
    return;
  }

  const pending = topPlacementTimers.get(doc);
  if (typeof pending === "number") {
    view.clearTimeout(pending);
  }

  const timer = view.setTimeout(() => {
    placePaperChatSectionAtTop(doc);
    topPlacementTimers.delete(doc);
  }, 90);
  topPlacementTimers.set(doc, timer);
}

function placePaperChatSectionAtTop(doc: Document | null | undefined) {
  if (!doc) {
    return;
  }

  const button = doc.querySelector(
    `item-pane-sidenav .btn[data-pane="${SECTION_ID}"], item-pane-sidenav [data-pane="${SECTION_ID}"]`,
  ) as HTMLElement | null;
  const infoButton = doc.querySelector(
    `item-pane-sidenav .btn[data-pane="info"], item-pane-sidenav [data-pane="info"]`,
  ) as HTMLElement | null;
  if (button) {
    const buttonWrapper =
      (button.closest(".pin-wrapper") as HTMLElement | null) || button;
    const infoWrapper =
      (infoButton?.closest(".pin-wrapper") as HTMLElement | null) || infoButton;
    const targetParent =
      infoWrapper?.parentElement || buttonWrapper.parentElement;
    if (targetParent) {
      if (infoWrapper && infoWrapper.parentElement === targetParent) {
        if (buttonWrapper !== infoWrapper) {
          targetParent.insertBefore(buttonWrapper, infoWrapper);
        }
      } else if (targetParent.firstElementChild !== buttonWrapper) {
        targetParent.insertBefore(
          buttonWrapper,
          targetParent.firstElementChild,
        );
      }
    }
  }

  const panel = doc.querySelector(
    `item-pane-section[data-pane="${SECTION_ID}"], item-details-section[data-pane="${SECTION_ID}"], [data-pane="${SECTION_ID}"].item-pane-section, [data-pane="${SECTION_ID}"].item-details-section`,
  ) as HTMLElement | null;
  const infoPanel = doc.querySelector(
    `item-pane-section[data-pane="info"], item-details-section[data-pane="info"], [data-pane="info"].item-pane-section, [data-pane="info"].item-details-section`,
  ) as HTMLElement | null;
  if (panel) {
    const panelParent = infoPanel?.parentElement || panel.parentElement;
    if (panelParent) {
      if (infoPanel && infoPanel.parentElement === panelParent) {
        if (panel !== infoPanel) {
          panelParent.insertBefore(panel, infoPanel);
        }
      } else if (panelParent.firstElementChild !== panel) {
        panelParent.insertBefore(panel, panelParent.firstElementChild);
      }
    }
  }
}

function applyStandaloneSidebarMode(
  doc: Document | null | undefined,
  enabled: boolean,
) {
  if (!doc) {
    return;
  }

  schedulePaperChatSectionAtTop(doc);

  // Recover from older standalone logic that hid wrappers.
  const wrappers = Array.from(
    doc.querySelectorAll("item-pane-sidenav .pin-wrapper"),
  ) as HTMLElement[];
  for (const wrapper of wrappers) {
    if (wrapper.style.display === "none") {
      wrapper.style.display = "";
    }
    if (wrapper.getAttribute(STANDALONE_HIDDEN_ATTR) === "true") {
      wrapper.removeAttribute(STANDALONE_HIDDEN_ATTR);
    }
  }

  if (!enabled) {
    return;
  }
}

function normalizeChatEndpoint(endpoint: string) {
  const trimmed = endpoint.trim().replace(/\/$/, "");
  if (!trimmed) {
    return "";
  }

  if (/\/chat\/completions\/?$/i.test(trimmed)) {
    return trimmed;
  }

  if (/\/embeddings\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/embeddings\/?$/i, "/chat/completions");
  }

  if (/\/v1\/?$/i.test(trimmed)) {
    return `${trimmed}/chat/completions`;
  }

  if (/^https?:\/\/[^/]+$/i.test(trimmed)) {
    return `${trimmed}/v1/chat/completions`;
  }

  return trimmed;
}

function normalizeEmbeddingEndpoint(endpoint: string) {
  const trimmed = endpoint.trim().replace(/\/$/, "");
  if (!trimmed) {
    return "";
  }

  if (/\/embeddings\/?$/i.test(trimmed)) {
    return trimmed;
  }

  if (/\/chat\/completions\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/chat\/completions\/?$/i, "/embeddings");
  }

  if (/\/v1\/?$/i.test(trimmed)) {
    return `${trimmed}/embeddings`;
  }

  if (/^https?:\/\/[^/]+$/i.test(trimmed)) {
    return `${trimmed}/v1/embeddings`;
  }

  return trimmed;
}

function parseResponsePayload(response: any) {
  if (response?.response && typeof response.response === "object") {
    return response.response;
  }

  if (typeof response?.responseText === "string") {
    return JSON.parse(response.responseText);
  }

  if (typeof response === "string") {
    return JSON.parse(response);
  }

  throw new Error("Unable to parse LLM response payload.");
}

function extractChatContent(payload: any) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("\n")
      .trim();
  }

  return "";
}

function extractEmbeddingVectors(payload: any) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const ordered = rows
    .filter((row: any) => Array.isArray(row?.embedding))
    .sort((a: any, b: any) => {
      const ai = typeof a?.index === "number" ? a.index : 0;
      const bi = typeof b?.index === "number" ? b.index : 0;
      return ai - bi;
    });

  return ordered.map((row: any) =>
    (row.embedding as any[]).map((value) =>
      typeof value === "number" ? value : Number(value || 0),
    ),
  );
}

function reportSummaryProgress(
  handler: SummaryProgressHandler | undefined,
  percent: number,
  stage: string,
) {
  if (!handler) {
    return;
  }
  handler({
    percent: Math.max(0, Math.min(100, percent)),
    stage,
  });
}

async function getConversation(paperID: string) {
  const store = await loadStore();
  return store.conversations[paperID] || [];
}

async function clearConversation(paperID: string) {
  const store = await loadStore();
  delete store.conversations[paperID];
  delete store.memories[paperID];
  await persistStore(store);
}

async function appendConversation(paperID: string, messages: ChatMessage[]) {
  const store = await loadStore();
  const existing = store.conversations[paperID] || [];
  store.conversations[paperID] = [...existing, ...messages].slice(
    -MAX_STORED_MESSAGES,
  );
  await persistStore(store);
}

async function getConversationMemory(paperID: string) {
  const store = await loadStore();
  return store.memories[paperID] || null;
}

async function refreshConversationMemoryIfNeeded(
  paperID: string,
  title: string,
) {
  const prompts = await getPromptConfig();
  const store = await loadStore();
  const conversation = store.conversations[paperID] || [];
  if (conversation.length < 4) {
    return;
  }

  const memory = store.memories[paperID];
  const turnCount = memory?.turnCount || 0;
  const newMessageCount = conversation.length - turnCount;
  if (memory && newMessageCount < MEMORY_REFRESH_MIN_NEW_MESSAGES) {
    return;
  }

  const transcript = conversation
    .slice(-MEMORY_SOURCE_WINDOW)
    .map((message) => {
      const role = message.role === "user" ? "User" : "Assistant";
      return `${role}: ${message.content}`;
    })
    .join("\n");

  try {
    const summary = await requestLLM([
      {
        role: "system",
        content: renderPromptTemplate(prompts.memorySystem, {
          title,
        }),
      },
      {
        role: "user",
        content: renderPromptTemplate(prompts.memoryUser, {
          title,
          transcript,
        }),
      },
    ]);

    if (!summary.trim()) {
      return;
    }

    store.memories[paperID] = {
      summary: summary.trim(),
      updatedAt: new Date().toISOString(),
      turnCount: conversation.length,
    };
    await persistStore(store);
  } catch (error) {
    ztoolkit.log("Conversation memory refresh skipped", error);
  }
}

async function getOrCreateChunkEmbeddings(paperID: string, index: PaperIndex) {
  const store = await loadStore();
  const embeddingConfig = getEmbeddingConfig();
  const entry = store.embeddings[paperID];
  const reset =
    !entry ||
    entry.endpoint !== embeddingConfig.endpoint ||
    entry.model !== embeddingConfig.model;

  const working: PaperEmbeddings = reset
    ? {
        endpoint: embeddingConfig.endpoint,
        model: embeddingConfig.model,
        chunkHashes: {},
        vectors: {},
        updatedAt: new Date().toISOString(),
      }
    : {
        endpoint: entry.endpoint,
        model: entry.model,
        chunkHashes: { ...entry.chunkHashes },
        vectors: { ...entry.vectors },
        updatedAt: entry.updatedAt,
      };

  const validChunkIDs = new Set(index.chunks.map((chunk) => chunk.id));
  let dirty = reset;
  for (const key of Object.keys(working.vectors)) {
    if (!validChunkIDs.has(key)) {
      delete working.vectors[key];
      delete working.chunkHashes[key];
      dirty = true;
    }
  }

  const missing: Array<{ chunk: TextChunk; hash: string }> = [];
  for (const chunk of index.chunks) {
    const chunkHash = hashText(chunk.text);
    const vector = working.vectors[chunk.id];
    if (
      working.chunkHashes[chunk.id] !== chunkHash ||
      !Array.isArray(vector) ||
      !vector.length
    ) {
      missing.push({ chunk, hash: chunkHash });
    }
  }

  if (missing.length) {
    for (let i = 0; i < missing.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = missing.slice(i, i + EMBEDDING_BATCH_SIZE);
      const vectors = await requestEmbeddings(
        batch.map((item) => item.chunk.text),
      );
      for (let j = 0; j < batch.length; j += 1) {
        const pair = batch[j];
        const vector = vectors[j];
        if (!vector) {
          continue;
        }
        working.vectors[pair.chunk.id] = vector;
        working.chunkHashes[pair.chunk.id] = pair.hash;
        dirty = true;
      }
    }
  }

  if (dirty) {
    working.updatedAt = new Date().toISOString();
    store.embeddings[paperID] = working;
    await persistStore(store);
  }

  const vectors = new Map<string, number[]>();
  for (const [chunkID, vector] of Object.entries(working.vectors)) {
    if (Array.isArray(vector) && vector.length) {
      vectors.set(chunkID, vector);
    }
  }
  return vectors;
}

function cosineSimilarity(vecA: number[], vecB: number[]) {
  const size = Math.min(vecA.length, vecB.length);
  if (size <= 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < size; i += 1) {
    const a = vecA[i];
    const b = vecB[i];
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA <= 0 || normB <= 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function enforceEvidence(answer: string, chunks: TextChunk[]) {
  const clean = answer.trim();
  if (!isEvidenceRequired() || !chunks.length || /\[C\d+\]/.test(clean)) {
    return clean;
  }

  const snippets = chunks
    .slice(0, 3)
    .map((chunk, index) => `[C${index + 1}] ${clipText(chunk.text, 220)}`)
    .join("\n");

  return [
    "근거 인용이 누락되어 답변 신뢰도를 보장하기 어렵습니다.",
    clean,
    "",
    "검토용 컨텍스트:",
    snippets,
  ].join("\n");
}

function clipText(text: string, maxChars: number) {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars).trim()}...`;
}

async function loadStore(): Promise<PaperStore> {
  if (storeCache) {
    return storeCache;
  }

  const path = await getStorePath();
  const raw = await readTextFile(path);

  if (!raw) {
    storeCache = {
      version: 2,
      papers: {},
      conversations: {},
      memories: {},
      embeddings: {},
    };
    return storeCache;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PaperStore>;
    storeCache = {
      version: 2,
      papers: parsed?.papers || {},
      conversations: parsed?.conversations || {},
      memories: parsed?.memories || {},
      embeddings: parsed?.embeddings || {},
    };
  } catch (error) {
    ztoolkit.log("Failed to parse paper store, resetting", error);
    storeCache = {
      version: 2,
      papers: {},
      conversations: {},
      memories: {},
      embeddings: {},
    };
  }

  return storeCache;
}

async function persistStore(store: PaperStore) {
  storeCache = store;
  const path = await getStorePath();
  const payload = JSON.stringify(store, null, 2);

  storeWriteQueue = storeWriteQueue
    .then(async () => {
      await writeTextFile(path, payload);
    })
    .catch((error) => {
      ztoolkit.log("Failed to persist store", error);
    });

  await storeWriteQueue;
}

async function getStorePath() {
  const baseDir = String((Zotero as any).DataDirectory?.dir || "").trim();
  if (!baseDir) {
    throw new Error("Zotero data directory is unavailable.");
  }

  const storeDir = joinPath(baseDir, "paper-chat", config.addonRef);
  await ensureDir(storeDir);
  return joinPath(storeDir, STORE_FILE_NAME);
}

function joinPath(...parts: string[]) {
  const pathUtils = (globalThis as any).PathUtils;
  if (pathUtils && typeof pathUtils.join === "function") {
    return pathUtils.join(...parts);
  }

  const os = (globalThis as any).OS;
  if (os?.Path && typeof os.Path.join === "function") {
    return os.Path.join(...parts);
  }

  return parts
    .filter(Boolean)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

function dirname(path: string) {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "";
  }
  return normalized.slice(0, index);
}

async function ensureDir(path: string) {
  const ioUtils = (globalThis as any).IOUtils;
  if (ioUtils && typeof ioUtils.makeDirectory === "function") {
    await ioUtils.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }

  const zoteroFile = (Zotero as any).File;
  if (zoteroFile && typeof zoteroFile.createDirectoryIfMissing === "function") {
    zoteroFile.createDirectoryIfMissing(path);
  }
}

async function readTextFile(path: string) {
  const ioUtils = (globalThis as any).IOUtils;
  if (ioUtils && typeof ioUtils.readUTF8 === "function") {
    try {
      if (typeof ioUtils.exists === "function") {
        const exists = await ioUtils.exists(path);
        if (!exists) {
          return "";
        }
      }
      return String(await ioUtils.readUTF8(path));
    } catch {
      return "";
    }
  }

  const zoteroFile = (Zotero as any).File;
  if (zoteroFile && typeof zoteroFile.getContentsAsync === "function") {
    try {
      const value = await zoteroFile.getContentsAsync(path);
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }

  return "";
}

async function writeTextFile(path: string, content: string) {
  const ioUtils = (globalThis as any).IOUtils;
  if (ioUtils && typeof ioUtils.writeUTF8 === "function") {
    await ioUtils.writeUTF8(path, content);
    return;
  }

  const zoteroFile = (Zotero as any).File;
  if (zoteroFile && typeof zoteroFile.putContentsAsync === "function") {
    await zoteroFile.putContentsAsync(path, content);
    return;
  }

  throw new Error("No writable file API available in this Zotero runtime.");
}

function hashText(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return String(hash >>> 0);
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  ) as HTMLElementTagNameMap[K];
  if (className) {
    node.className = className;
  }
  return node;
}

function stringifyError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}
