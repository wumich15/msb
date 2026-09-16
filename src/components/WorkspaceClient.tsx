"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarkdownPreview from "@/components/MarkdownPreview";
import { api, ApiError } from "@/lib/api-client";
import { clearAllRecoveryDrafts, clearRecoveryDraft, readRecoveryDraft, saveRecoveryDraft } from "@/lib/drafts";
import { SAVE_STATE_LABELS, useAutosave } from "@/hooks/useAutosave";
import { useJobPolling, type JobStatus } from "@/hooks/useJobPolling";
import { NARROW_LAYOUT_QUERY, useMediaQuery } from "@/hooks/useMediaQuery";

type Panel = "projects" | "notes" | "assistant";
type ProblemStatus = "not_started" | "in_progress" | "complete";

interface Folder {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface ProblemSummary {
  id: string;
  folderId: string;
  title: string;
  status: ProblemStatus;
  statementVersion: number;
  importedSourceId: string | null;
  updatedAt: string;
  completedAt: string | null;
}

interface AssistantState {
  enabled: boolean;
  activationGeneration: number;
  preparationGeneration: number;
  preparationChoice: "provide" | "find" | "reuse" | null;
  preparationState: "OFF" | "AWAITING_SOLUTION" | "SEARCHING_MSE" | "SELF_SOLVING" | "VALIDATING" | "READY" | "BLOCKED" | "STALE";
  preparationLabel: string;
  preparationMessage: string | null;
  hasSelectedReference: boolean;
  referenceRevision: number | null;
  statementVersion: number;
  canReuseSavedReference: boolean;
}

interface IdeaState {
  problemCategories: string[];
  safeTags: string[];
  ideaIds: string[];
  mechanism: string | null;
  confidence: number;
  evidenceKind: string;
  isProvisional: boolean;
}

interface ProblemDetail {
  problem: ProblemSummary;
  statement: { version: number; markdown: string; sourceKind: string; sourceMetadata: Record<string, unknown> };
  notes: { revision: number; markdown: string; savedAt: string | null };
  assistant: AssistantState | null;
  ideas?: IdeaState | null;
  activeJobs?: Array<{ id: string; type: string }>;
}

interface ChatMessage {
  id: string;
  threadId: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  notesRevision: number | null;
  selectedExcerpt: string | null;
  statementVersion: number;
  responseMode: string;
  citedNoteExcerpt: string | null;
  isOperational: boolean;
  createdAt: string;
  isHistorical: boolean;
}

interface Recommendation {
  itemId: string;
  runId: string;
  rank: number;
  title: string;
  sourceId: string;
  statementPreview: string;
  competition: string | null;
  country: string | null;
  sourceUrl: string | null;
  relationship: string | null;
  isTentative: boolean;
  savedProblemId: string | null;
  dismissed: boolean;
}

interface RevealedReference {
  provenance: string;
  artifact: {
    restated_problem: string;
    assumptions: string[];
    domain_restrictions: string[];
    notation: string[];
    steps: Array<{ claim: string; justification: string }>;
    boundary_cases: string[];
    conclusion: string;
  };
  checkSummary: string;
  unresolvedGaps: string[];
  sources: Array<{ url: string; title?: string; author?: string; license?: string }>;
}

const STATUS_LABELS: Record<ProblemStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "NOTES_CONFLICT") return "These notes changed in another tab. Your draft is still here.";
    if (error.code === "STATEMENT_CONFLICT") return "The statement changed in another tab. Your draft is still here.";
    if (error.code === "SOLUTION_NOT_READY") return "The assistant is not ready yet. Your question has been kept.";
    if (error.code === "AI_LIMIT_REACHED") return "The daily AI limit has been reached. Your study notes are unaffected.";
    if (error.code === "UNAUTHENTICATED") return "Your session expired. Sign in again to continue.";
    return error.detail || error.code;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

export default function WorkspaceClient({ userId, email }: { userId: string; email: string | null }) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [problems, setProblems] = useState<ProblemSummary[]>([]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [problemId, setProblemId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProblemDetail | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [recommendationState, setRecommendationState] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("notes");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [assistantCollapsed, setAssistantCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [newProblemTitle, setNewProblemTitle] = useState("");
  // Which sidebar add form has a request in flight, so neither can be submitted twice.
  const [creating, setCreating] = useState<"folder" | "problem" | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | ProblemStatus>("all");
  const [editorTab, setEditorTab] = useState<"write" | "preview">("write");
  const [statementTab, setStatementTab] = useState<"write" | "preview">("write");
  const [question, setQuestion] = useState("");
  const [selectedExcerpt, setSelectedExcerpt] = useState<string | null>(null);
  const [workedSolution, setWorkedSolution] = useState("");
  const [revealedReference, setRevealedReference] = useState<RevealedReference | null>(null);
  const [preparationJobId, setPreparationJobId] = useState<string | null>(null);
  const [classificationJobId, setClassificationJobId] = useState<string | null>(null);
  const [chatJobId, setChatJobId] = useState<string | null>(null);
  const [recommendationJobId, setRecommendationJobId] = useState<string | null>(null);
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [exportId, setExportId] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [includeReferences, setIncludeReferences] = useState(false);
  const [aiDisclosureAccepted, setAiDisclosureAccepted] = useState(true);
  const [automaticRecommendations, setAutomaticRecommendations] = useState(true);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const recovered = useRef(new Set<string>());
  // Wide screens show all three panels at once; only the tab layout hides them.
  const tabbedLayout = useMediaQuery(NARROW_LAYOUT_QUERY);

  const saveStatement = useCallback(async (value: string, expectedVersion: number) => {
    if (!problemId) return expectedVersion;
    const result = await api<{ version: number }>(`/api/problems/${problemId}/statement`, {
      method: "PUT",
      json: { statement: value, expectedVersion },
    });
    setProblems((current) => current.map((problem) => problem.id === problemId ? { ...problem, statementVersion: result.version } : problem));
    setDetail((current) => current && current.problem.id === problemId
      ? {
          ...current,
          problem: { ...current.problem, statementVersion: result.version },
          statement: { ...current.statement, version: result.version, markdown: value },
          assistant: current.assistant && result.version !== expectedVersion
            ? { ...current.assistant, statementVersion: result.version, preparationState: current.assistant.enabled ? "STALE" : "OFF", preparationLabel: current.assistant.enabled ? "The statement changed" : "Off", hasSelectedReference: false }
            : current.assistant,
        }
      : current);
    return result.version;
  }, [problemId]);

  const saveNotes = useCallback(async (value: string, expectedRevision: number) => {
    if (!problemId) return expectedRevision;
    const result = await api<{ revision: number }>(`/api/problems/${problemId}/notes`, {
      method: "PUT",
      json: { markdown: value, expectedRevision },
    });
    return result.revision;
  }, [problemId]);

  const statement = useAutosave({
    userId,
    problemId: problemId ?? "none",
    field: "statement",
    initialValue: detail?.statement.markdown ?? "",
    initialRevision: detail?.statement.version ?? 0,
    save: saveStatement,
  });

  const notes = useAutosave({
    userId,
    problemId: problemId ?? "none",
    field: "notes",
    initialValue: detail?.notes.markdown ?? "",
    initialRevision: detail?.notes.revision ?? 0,
    save: saveNotes,
  });

  const loadMessages = useCallback(async (id: string) => {
    const result = await api<{ messages: ChatMessage[] }>(`/api/problems/${id}/messages`);
    setMessages(result.messages);
  }, []);

  const loadProblem = useCallback(async (id: string) => {
    const result = await api<ProblemDetail>(`/api/problems/${id}`);
    setDetail(result);
    setProblemId(id);
    setFolderId(result.problem.folderId);
    window.history.replaceState(null, "", `/workspace?problem=${encodeURIComponent(id)}`);
    setRevealedReference(null);
    for (const job of result.activeJobs ?? []) {
      if (job.type === "prepare-reference") setPreparationJobId(job.id);
      if (job.type === "classify-problem") setClassificationJobId(job.id);
      if (job.type === "respond-to-question") setChatJobId(job.id);
      if (job.type === "recommend-problems") setRecommendationJobId(job.id);
    }
    await loadMessages(id);
  }, [loadMessages]);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    try {
      const [folderResult, problemResult, settingsResult] = await Promise.all([
        api<{ folders: Folder[] }>("/api/folders"),
        api<{ problems: ProblemSummary[] }>("/api/problems"),
        api<{ profile: { automaticRecommendations: boolean; aiDisclosureVersion: number } }>("/api/settings"),
      ]);
      setFolders(folderResult.folders);
      setProblems(problemResult.problems);
      setAutomaticRecommendations(settingsResult.profile.automaticRecommendations);
      setAiDisclosureAccepted(settingsResult.profile.aiDisclosureVersion >= 1);
      const requestedId = new URL(window.location.href).searchParams.get("problem");
      const firstProblem = problemResult.problems.find((problem) => problem.id === requestedId) ?? problemResult.problems[0];
      if (firstProblem) await loadProblem(firstProblem.id);
      else setFolderId(folderResult.folders[0]?.id ?? null);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [loadProblem]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace, userId]);

  useEffect(() => {
    if (!problemId || !detail) return;
    const recoveryKey = `${problemId}:${detail.notes.revision}:${detail.statement.version}`;
    if (recovered.current.has(recoveryKey)) return;
    recovered.current.add(recoveryKey);
    const recoveredNotes = readRecoveryDraft(userId, problemId, "notes");
    const recoveredStatement = readRecoveryDraft(userId, problemId, "statement");
    const recoveredQuestion = readRecoveryDraft(userId, problemId, "question");
    if (recoveredNotes && recoveredNotes.value !== detail.notes.markdown) notes.change(recoveredNotes.value);
    if (recoveredStatement && recoveredStatement.value !== detail.statement.markdown) statement.change(recoveredStatement.value);
    if (recoveredQuestion) setQuestion(recoveredQuestion.value);
  }, [detail, notes, problemId, statement, userId]);

  const flushEditors = useCallback(async () => {
    const [statementSaved, notesSaved] = await Promise.all([statement.flush(), notes.flush()]);
    if (!statementSaved || !notesSaved) {
      setNotice("Save the current draft or resolve its conflict before continuing.");
      return false;
    }
    return true;
  }, [notes, statement]);

  const selectProblem = useCallback(async (id: string) => {
    if (id === problemId) return;
    if (problemId && !(await flushEditors())) return;
    setNotice(null);
    setRecommendations([]);
    setRecommendationState(null);
    await loadProblem(id).catch((error) => setNotice(errorMessage(error)));
    setPanel("notes");
  }, [flushEditors, loadProblem, problemId]);

  const fetchSimilar = useCallback(async (refresh = false) => {
    if (!problemId || !(await flushEditors())) return;
    setNotice(null);
    try {
      const result = await api<{ jobId?: string; runId?: string; state: string; items: Recommendation[] }>(`/api/problems/${problemId}/similar`, {
        method: "POST",
        json: { refresh },
      });
      setRecommendationState(result.state);
      setRecommendations(result.items ?? []);
      if (result.jobId) setRecommendationJobId(result.jobId);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [flushEditors, problemId]);

  const onPreparationTerminal = useCallback((job: JobStatus) => {
    setPreparationJobId(null);
    if (problemId) void loadProblem(problemId);
    if (job.state !== "SUCCEEDED") setNotice(`Solution preparation ended: ${job.errorCode ?? job.state}.`);
  }, [loadProblem, problemId]);

  const onChatTerminal = useCallback((job: JobStatus) => {
    setChatJobId(null);
    if (problemId) void loadMessages(problemId);
    if (job.state !== "SUCCEEDED") setNotice(`The assistant could not answer: ${job.errorCode ?? job.state}. Your question is kept in the conversation.`);
  }, [loadMessages, problemId]);

  const onClassificationTerminal = useCallback((job: JobStatus) => {
    setClassificationJobId(null);
    if (problemId) void loadProblem(problemId);
    if (job.state !== "SUCCEEDED") setNotice(`Solution classification ended: ${job.errorCode ?? job.state}.`);
  }, [loadProblem, problemId]);

  const onRecommendationTerminal = useCallback((job: JobStatus) => {
    setRecommendationJobId(null);
    if (job.state === "SUCCEEDED") void fetchSimilar(false);
    else setNotice(`Recommendations ended: ${job.errorCode ?? job.state}.`);
  }, [fetchSimilar]);

  const onExportTerminal = useCallback(async (job: JobStatus) => {
    setExportJobId(null);
    if (job.state !== "SUCCEEDED" || !exportId) {
      setNotice(`Export ended: ${job.errorCode ?? job.state}.`);
      return;
    }
    try {
      const result = await api<{ downloadUrl: string | null }>(`/api/exports/${exportId}`);
      setDownloadUrl(result.downloadUrl);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }, [exportId]);

  const preparationJob = useJobPolling(preparationJobId, onPreparationTerminal);
  const classificationJob = useJobPolling(classificationJobId, onClassificationTerminal);
  const chatJob = useJobPolling(chatJobId, onChatTerminal);
  const recommendationJob = useJobPolling(recommendationJobId, onRecommendationTerminal);
  const exportJob = useJobPolling(exportJobId, onExportTerminal);

  const filteredProblems = useMemo(
    () => problems.filter((problem) => (!folderId || problem.folderId === folderId) && (statusFilter === "all" || problem.status === statusFilter)),
    [folderId, problems, statusFilter],
  );

  const selectedFolder = useMemo(() => folders.find((folder) => folder.id === folderId) ?? null, [folderId, folders]);

  const problemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const problem of problems) counts.set(problem.folderId, (counts.get(problem.folderId) ?? 0) + 1);
    return counts;
  }, [problems]);

  async function createFolder(event: React.FormEvent) {
    event.preventDefault();
    // The guard plus the disabled button keep a double submit from creating twin projects.
    if (creating || !newFolderName.trim()) return;
    setCreating("folder");
    setNotice(null);
    try {
      if (!(await flushEditors())) return;
      const result = await api<{ folder: Folder }>("/api/folders", { method: "POST", json: { name: newFolderName } });
      setFolders((current) => [...current, result.folder]);
      setFolderId(result.folder.id);
      setNewFolderName("");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setCreating(null);
    }
  }

  async function renameFolder() {
    const folder = folders.find((entry) => entry.id === folderId);
    if (!folder) return;
    const name = window.prompt("New project name", folder.name)?.trim();
    if (!name) return;
    try {
      const result = await api<{ folder: Folder }>(`/api/folders/${folder.id}`, { method: "PATCH", json: { name } });
      setFolders((current) => current.map((entry) => entry.id === folder.id ? result.folder : entry));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function deleteFolder() {
    const folder = folders.find((entry) => entry.id === folderId);
    if (!folder || !window.confirm(`Delete “${folder.name}” and all of its problems? This cannot be undone.`)) return;
    try {
      await api(`/api/folders/${folder.id}?confirm=delete-contents`, { method: "DELETE" });
      const removed = new Set(problems.filter((problem) => problem.folderId === folder.id).map((problem) => problem.id));
      setFolders((current) => current.filter((entry) => entry.id !== folder.id));
      setProblems((current) => current.filter((problem) => !removed.has(problem.id)));
      setFolderId(folders.find((entry) => entry.id !== folder.id)?.id ?? null);
      setProblemId(null);
      setDetail(null);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function createProblem(event: React.FormEvent) {
    event.preventDefault();
    if (creating || !folderId || !newProblemTitle.trim()) return;
    setCreating("problem");
    setNotice(null);
    try {
      if (!(await flushEditors())) return;
      const result = await api<{ problem: ProblemSummary }>("/api/problems", {
        method: "POST",
        json: { folderId, title: newProblemTitle, statement: "" },
      });
      setProblems((current) => [result.problem, ...current]);
      setNewProblemTitle("");
      setRecommendations([]);
      setRecommendationState(null);
      await loadProblem(result.problem.id);
      // On the tab layout the new problem's editor is a different tab.
      setPanel("notes");
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setCreating(null);
    }
  }

  async function saveMetadata(patch: { title?: string; folderId?: string }) {
    if (!problemId) return;
    try {
      const result = await api<{ problem: ProblemSummary }>(`/api/problems/${problemId}`, { method: "PATCH", json: patch });
      setProblems((current) => current.map((problem) => problem.id === problemId ? result.problem : problem));
      setDetail((current) => current ? { ...current, problem: result.problem } : current);
      if (patch.folderId) setFolderId(patch.folderId);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function deleteProblem() {
    if (!detail || !window.confirm(`Delete “${detail.problem.title}”? This cannot be undone.`)) return;
    try {
      await api(`/api/problems/${detail.problem.id}`, { method: "DELETE" });
      const remaining = problems.filter((problem) => problem.id !== detail.problem.id);
      setProblems(remaining);
      setProblemId(null);
      setDetail(null);
      setMessages([]);
      const next = remaining.find((problem) => problem.folderId === folderId) ?? remaining[0];
      if (next) await loadProblem(next.id);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function changeStatus(status: ProblemStatus) {
    if (!problemId || !(await flushEditors())) return;
    try {
      const result = await api<{ changed: boolean; recommendationJobId: string | null }>(`/api/problems/${problemId}/status`, {
        method: "PATCH",
        json: { status, expectedStatementVersion: statement.revision, expectedNotesRevision: notes.revision },
      });
      setProblems((current) => current.map((problem) => problem.id === problemId ? { ...problem, status } : problem));
      setDetail((current) => current ? { ...current, problem: { ...current.problem, status } } : current);
      if (result.recommendationJobId) {
        setRecommendationState("QUEUED");
        setRecommendationJobId(result.recommendationJobId);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function toggleAssistant(enabled: boolean) {
    if (!problemId || !(await flushEditors())) return;
    if (enabled && !aiDisclosureAccepted) {
      setNotice("Read and accept the AI disclosure before turning on the assistant.");
      return;
    }
    try {
      await api(`/api/problems/${problemId}/assistant`, { method: "POST", json: { enabled } });
      await loadProblem(problemId);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function chooseReference(choice: "provide" | "find" | "reuse") {
    if (!problemId || !(await flushEditors())) return;
    try {
      const result = await api<{ jobId: string | null }>(`/api/problems/${problemId}/reference`, {
        method: "POST",
        json: {
          choice,
          expectedStatementVersion: statement.revision,
          ...(choice === "provide" ? { workedSolution } : {}),
        },
      });
      setWorkedSolution("");
      if (result.jobId) setPreparationJobId(result.jobId);
      await loadProblem(problemId);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function researchRelatedProblems() {
    if (!problemId || !detail?.assistant || !(await flushEditors())) return;
    const hasSolutionProfile = detail.ideas &&
      !detail.ideas.isProvisional &&
      ["checked_reference", "user_supplied_work"].includes(detail.ideas.evidenceKind);
    if (hasSolutionProfile) {
      await fetchSimilar(false);
      return;
    }
    if (!aiDisclosureAccepted) {
      setNotice("Read and accept the AI disclosure before starting related-problem research.");
      return;
    }
    try {
      if (!detail.assistant.enabled) {
        await api(`/api/problems/${problemId}/assistant`, { method: "POST", json: { enabled: true } });
      }
      const choice = workedSolution.trim() ? "provide" : "find";
      const result = await api<{ jobId: string | null }>(`/api/problems/${problemId}/reference`, {
        method: "POST",
        json: {
          choice,
          expectedStatementVersion: statement.revision,
          researchRelated: true,
          ...(choice === "provide" ? { workedSolution } : {}),
        },
      });
      setWorkedSolution("");
      if (result.jobId) setPreparationJobId(result.jobId);
      setNotice(choice === "provide"
        ? "Checking your solution before researching related MathNet problems."
        : "Looking for a solution before researching related MathNet problems.");
      await loadProblem(problemId);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  function attachSelection() {
    const textarea = notesRef.current;
    if (!textarea) return;
    const excerpt = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd).trim();
    if (!excerpt) {
      setNotice("Select a passage in your notes first.");
      return;
    }
    setSelectedExcerpt(excerpt.slice(0, 4000));
    setPanel("assistant");
  }

  function changeQuestion(value: string) {
    setQuestion(value);
    if (!problemId) return;
    saveRecoveryDraft(userId, problemId, { field: "question", value, baseRevision: notes.revision, savedAt: Date.now() });
  }

  async function sendQuestion(responseMode: "default" | "stronger_hint" | "discuss_note_question" = "default") {
    if (!problemId || !question.trim() || !(await flushEditors())) return;
    try {
      const result = await api<{ jobId: string | null }>(`/api/problems/${problemId}/messages`, {
        method: "POST",
        json: {
          requestId: crypto.randomUUID(),
          question,
          expectedNotesRevision: notes.revision,
          selectedExcerpt: selectedExcerpt ?? undefined,
          responseMode,
        },
      });
      clearRecoveryDraft(userId, problemId, "question");
      setQuestion("");
      setSelectedExcerpt(null);
      if (result.jobId) setChatJobId(result.jobId);
      await loadMessages(problemId);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function revealReference() {
    if (!problemId) return;
    if (!window.confirm("Show the complete reference solution? This will reveal the answer.")) return;
    try {
      const result = await api<{ reference: RevealedReference }>(`/api/problems/${problemId}/reference/reveal`, { method: "POST" });
      setRevealedReference(result.reference);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function reportReference() {
    if (!problemId) return;
    const reason = window.prompt("What appears to be wrong with the reference?")?.trim();
    if (!reason) return;
    try {
      await api(`/api/problems/${problemId}/reference/report`, { method: "POST", json: { reason } });
      setRevealedReference(null);
      await loadProblem(problemId);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function dismissRecommendation(item: Recommendation) {
    try {
      await api(`/api/recommendations/${item.runId}/items/${item.itemId}`, { method: "PATCH", json: { dismissed: true } });
      setRecommendations((current) => current.filter((entry) => entry.itemId !== item.itemId));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function rateRecommendation(item: Recommendation, relevance: "useful" | "same_topic_only" | "unrelated") {
    try {
      await api(`/api/recommendations/${item.runId}/items/${item.itemId}`, { method: "PATCH", json: { relevance } });
      setNotice("Thanks — that feedback will be used when filtering future results.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function saveRecommendation(item: Recommendation) {
    if (!folderId) return;
    try {
      const result = await api<{ problemId: string }>(`/api/recommendations/${item.runId}/items/${item.itemId}/save`, {
        method: "POST",
        json: { folderId },
      });
      const refreshed = await api<{ problems: ProblemSummary[] }>("/api/problems");
      setProblems(refreshed.problems);
      setRecommendations((current) => current.filter((entry) => entry.itemId !== item.itemId));
      setNotice("The recommended problem was added to this project.");
      if (result.problemId) await selectProblem(result.problemId);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function startExport(scope: "problem" | "folder" | "account") {
    if (!(await flushEditors())) return;
    const scopeId = scope === "problem" ? problemId : scope === "folder" ? folderId : null;
    if (scope !== "account" && !scopeId) return;
    try {
      const result = await api<{ export: { id: string }; jobId: string }>("/api/exports", {
        method: "POST",
        json: { scope, scopeId, includeReferences },
      });
      setExportId(result.export.id);
      setExportJobId(result.jobId);
      setDownloadUrl(null);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function acceptDisclosure() {
    try {
      await api("/api/settings", { method: "PATCH", json: { acceptAiDisclosureVersion: 1, automaticRecommendations } });
      setAiDisclosureAccepted(true);
      setNotice("AI preferences saved.");
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  if (loading) return <main className="panel"><p role="status">Loading your workspace…</p></main>;

  return (
    <>
      <header className="app-header">
        <h1>Math Study Buddy</h1>
        <nav aria-label="Account">
          <Link href="/settings">Settings</Link>
          <span>{email}</span>
          <form action="/auth/signout" method="post" onSubmit={() => clearAllRecoveryDrafts()}><button className="link-button" type="submit">Sign out</button></form>
        </nav>
      </header>

      {!aiDisclosureAccepted ? (
        <section className="disclosure" aria-labelledby="ai-disclosure-title">
          <h2 id="ai-disclosure-title">Before using AI help</h2>
          <p>AI providers receive the current problem and the notes attached to your question. MathOverflow and Math Stack Exchange receive only search terms made from the problem statement. Notes, statuses, and exports work without AI.</p>
          <label><input type="checkbox" checked={automaticRecommendations} onChange={(event) => setAutomaticRecommendations(event.target.checked)} /> Automatic idea tags and recommendations</label>{" "}
          <button type="button" onClick={() => void acceptDisclosure()}>I understand</button>
        </section>
      ) : null}

      {notice ? <div className="global-notice notice" role="alert">{notice} <button className="link-button" type="button" onClick={() => setNotice(null)}>Dismiss</button></div> : null}

      <nav className="panel-tabs" aria-label="Workspace panels">
        {(["projects", "notes", "assistant"] as Panel[]).map((name) => (
          <button key={name} type="button" role="tab" aria-selected={panel === name} onClick={() => setPanel(name)}>{name[0]?.toUpperCase()}{name.slice(1)}</button>
        ))}
      </nav>

      <main className="workspace" data-sidebar-collapsed={sidebarCollapsed} data-assistant-collapsed={assistantCollapsed}>
        <aside className="panel panel-projects" hidden={tabbedLayout && panel !== "projects"} aria-label="Math projects">
          <div className="section-heading sidebar-heading">
            {sidebarCollapsed ? null : <h2>Math projects</h2>}
            <button type="button" aria-label={sidebarCollapsed ? "Expand project sidebar" : "Collapse project sidebar"} onClick={() => setSidebarCollapsed((value) => !value)}>{sidebarCollapsed ? "+" : "−"}</button>
          </div>
          {sidebarCollapsed ? null : <>
          <form onSubmit={createFolder} className="compact-form">
            <label htmlFor="new-folder">New project</label>
            <input id="new-folder" value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} maxLength={120} placeholder="Olympiad algebra" />
            <button type="submit" disabled={creating !== null || !newFolderName.trim()}>{creating === "folder" ? "Adding…" : "Add project"}</button>
          </form>
          {folders.length === 0 ? <p className="empty-state">Create a project to begin.</p> : (
            <ul className="tree-list">
              {folders.map((folder) => {
                const count = problemCounts.get(folder.id) ?? 0;
                return (
                  <li key={folder.id}>
                    <button className="row-button" type="button" aria-current={folder.id === folderId} onClick={() => setFolderId(folder.id)}>
                      {folder.name}{" "}
                      {/* A bare number reads as noise to a screen reader, so the unit is spoken but not shown. */}
                      <span className="row-count">{count}<span className="visually-hidden">{count === 1 ? " problem" : " problems"}</span></span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {folderId ? <div className="button-row"><button type="button" onClick={() => void renameFolder()}>Rename</button><button type="button" onClick={() => void deleteFolder()}>Delete</button></div> : null}
          <hr />
          <form onSubmit={createProblem} className="compact-form">
            <label htmlFor="new-problem">{selectedFolder ? `New problem in ${selectedFolder.name}` : "New problem"}</label>
            <input id="new-problem" value={newProblemTitle} onChange={(event) => setNewProblemTitle(event.target.value)} maxLength={300} disabled={!folderId} placeholder="Problem title" />
            <button type="submit" disabled={creating !== null || !folderId || !newProblemTitle.trim()}>{creating === "problem" ? "Adding…" : "Add problem"}</button>
          </form>
          {folderId ? <p className="scope-note">The problem opens empty — paste its statement in the notes panel.</p> : <p className="scope-note">Choose or create a project first; every problem lives in one.</p>}
          <label htmlFor="status-filter">Show</label>{" "}
          <select id="status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
            <option value="all">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          {filteredProblems.length === 0 ? (
            <p className="empty-state">{problems.length === 0 ? "No problems yet. Add one above." : "No problems match this project and status."}</p>
          ) : (
            <ul className="problem-list">
              {filteredProblems.map((problem) => (
                <li key={problem.id}>
                  <button className="row-button" type="button" aria-current={problem.id === problemId} onClick={() => void selectProblem(problem.id)}>
                    <span className="status-badge" data-status={problem.status}>{STATUS_LABELS[problem.status]}</span><br />{problem.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
          </>}
        </aside>

        <section className="panel panel-editor" hidden={tabbedLayout && panel !== "notes"} aria-label="Problem and notes">
          {!detail ? <div className="empty-state"><h2>No problem selected</h2><p>Create a project and problem, then paste a typed, English, text-complete statement. Handwriting, OCR, diagrams, and file uploads are outside this MVP.</p></div> : (
            <>
              <div className="problem-heading">
                <input aria-label="Problem title" value={detail.problem.title} onChange={(event) => setDetail({ ...detail, problem: { ...detail.problem, title: event.target.value } })} onBlur={(event) => void saveMetadata({ title: event.target.value })} />
                <select aria-label="Problem status" value={detail.problem.status} onChange={(event) => void changeStatus(event.target.value as ProblemStatus)}>
                  {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <details className="problem-settings">
                <summary>Problem settings</summary>
                <div className="button-row">
                  <label htmlFor="problem-project">Project</label>
                  <select id="problem-project" value={detail.problem.folderId} onChange={(event) => void saveMetadata({ folderId: event.target.value })}>
                    {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                  </select>
                  <button type="button" onClick={() => void deleteProblem()}>Delete problem</button>
                </div>
              </details>

              <section className="problem-statement-section">
                <h2>Problem statement</h2>
                <details className="editor-help"><summary>Formatting help</summary><p>Paste a typed, English, text-complete problem. Use LaTeX between <code>$...$</code> or <code>$$...$$</code>. Diagrams and uploads are not interpreted.</p></details>
                <div className="editor-tabs" role="tablist" aria-label="Problem statement editor">
                  <button type="button" role="tab" aria-selected={statementTab === "write"} onClick={() => setStatementTab("write")}>Write</button>
                  <button type="button" role="tab" aria-selected={statementTab === "preview"} onClick={() => setStatementTab("preview")}>Preview</button>
                </div>
                {statementTab === "write" ? <textarea aria-label="Problem statement" value={statement.value} onChange={(event) => statement.change(event.target.value)} /> : <MarkdownPreview source={statement.value} label="Rendered problem statement preview" />}
                <span className="save-state" data-state={statement.state}>{SAVE_STATE_LABELS[statement.state]}</span>
                {statement.state === "conflict" ? <button type="button" onClick={statement.resolveConflictKeepingMine}>Keep my draft and retry</button> : null}
              </section>

              <section className="notes-section">
                <div className="section-heading"><h2>Notes</h2><button type="button" onClick={attachSelection}>Ask about selection</button></div>
                <div className="editor-tabs" role="tablist" aria-label="Notes editor">
                  <button type="button" role="tab" aria-selected={editorTab === "write"} onClick={() => setEditorTab("write")}>Write</button>
                  <button type="button" role="tab" aria-selected={editorTab === "preview"} onClick={() => setEditorTab("preview")}>Preview</button>
                </div>
                {editorTab === "write" ? (
                  <textarea ref={notesRef} aria-label="Mathematical notes" value={notes.value} onChange={(event) => notes.change(event.target.value)} />
                ) : <MarkdownPreview source={notes.value} label="Rendered notes preview" />}
                <span className="save-state" data-state={notes.state}>{SAVE_STATE_LABELS[notes.state]}</span>
                {notes.state === "conflict" ? <button type="button" onClick={notes.resolveConflictKeepingMine}>Keep my draft and retry</button> : null}
              </section>

              {detail.ideas ? (
                <section className="idea-summary">
                  <h2>Solution ideas</h2>
                  {detail.ideas.problemCategories.length > 0 ? <p><strong>MathNet category:</strong> {detail.ideas.problemCategories.join(", ")}</p> : null}
                  <p>{detail.ideas.ideaIds.length > 0 ? detail.ideas.ideaIds.join(", ") : detail.ideas.safeTags.join(", ") || "No safe idea tags yet."}</p>
                  {detail.ideas.mechanism ? <p>{detail.ideas.mechanism}</p> : null}
                </section>
              ) : null}

              <section>
                <div className="section-heading"><h2>Related problems research</h2><button type="button" disabled={Boolean(preparationJobId || classificationJobId || recommendationJobId)} onClick={() => void researchRelatedProblems()}>{workedSolution.trim() ? "Use solution & research" : "Research related problems"}</button></div>
                <p className="scope-note">Searches within the same MathNet problem category, then compares the key ideas in checked solutions.</p>
                {classificationJob ? <p role="status">Categorizing the checked solution: {classificationJob.stage ?? classificationJob.state}</p> : null}
                {recommendationJob ? <p role="status">Researching related problems: {recommendationJob.stage ?? recommendationJob.state}</p> : null}
                {recommendationState === "NO_MATCH" ? <p className="empty-state">No confident match was found.</p> : null}
                <ul className="recommendation-list">
                  {recommendations.map((item) => (
                    <li className="recommendation-card" key={item.itemId}>
                      <h3>{item.title} {item.isTentative ? <span className="tentative-flag">Tentative</span> : null}</h3>
                      <p>{item.statementPreview}</p>
                      {item.relationship ? <p><strong>Relationship:</strong> {item.relationship}</p> : null}
                      <p>{[item.competition, item.country, `MathNET ${item.sourceId}`].filter(Boolean).join(" — ")}</p>
                      <div className="button-row">
                        {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">Source</a> : null}
                        <button type="button" onClick={() => void saveRecommendation(item)}>Add to project</button>
                        <button type="button" onClick={() => void rateRecommendation(item, "useful")}>Useful</button>
                        <button type="button" onClick={() => void rateRecommendation(item, "same_topic_only")}>Same topic only</button>
                        <button type="button" onClick={() => void rateRecommendation(item, "unrelated")}>Unrelated</button>
                        <button type="button" onClick={() => void dismissRecommendation(item)}>Dismiss</button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <details>
                <summary>Export study log</summary>
                <p>Download Markdown study logs and structured JSON in a ZIP archive.</p>
                <label><input type="checkbox" checked={includeReferences} onChange={(event) => setIncludeReferences(event.target.checked)} /> Include reference solutions and hidden idea tags (spoilers)</label>
                <div className="button-row">
                  <button type="button" onClick={() => void startExport("problem")}>Current problem</button>
                  <button type="button" onClick={() => void startExport("folder")}>Current project</button>
                  <button type="button" onClick={() => void startExport("account")}>All work</button>
                </div>
                {exportJob ? <p role="status">Preparing export: {exportJob.stage ?? exportJob.state}</p> : null}
                {downloadUrl ? <p><a href={downloadUrl}>Download export ZIP</a> (link expires shortly)</p> : null}
              </details>
            </>
          )}
        </section>

        <aside className="panel panel-assistant" hidden={tabbedLayout && panel !== "assistant"} aria-label="AI assistant">
          <div className="section-heading">
            <h2>AI assistant</h2>
            <button type="button" aria-label={assistantCollapsed ? "Expand assistant" : "Collapse assistant"} onClick={() => setAssistantCollapsed((value) => !value)}>{assistantCollapsed ? "+" : "−"}</button>
          </div>
          {assistantCollapsed ? null : !detail?.assistant ? <p>Select a problem.</p> : (
            <>
              <label className="switch-label"><input type="checkbox" checked={detail.assistant.enabled} onChange={(event) => void toggleAssistant(event.target.checked)} /> Assistant {detail.assistant.enabled ? "on" : "off"}</label>
              <p className="preparation-status" role="status"><strong>Preparation:</strong> {detail.assistant.preparationLabel}</p>
              {detail.assistant.preparationMessage ? <p className="notice">{detail.assistant.preparationMessage}</p> : null}
              {preparationJob ? <p role="status">{preparationJob.stage ?? preparationJob.state}</p> : null}

              {detail.assistant.enabled && ["AWAITING_SOLUTION", "STALE", "BLOCKED"].includes(detail.assistant.preparationState) ? (
                <fieldset>
                  <legend>Would you like to provide a worked solution, or should I find one?</legend>
                  <textarea aria-label="Worked solution" placeholder="Paste a complete worked solution" value={workedSolution} onChange={(event) => setWorkedSolution(event.target.value)} />
                  <div className="button-row">
                    <button type="button" disabled={!workedSolution.trim()} onClick={() => void chooseReference("provide")}>Use my worked solution</button>
                    <button type="button" onClick={() => void chooseReference("find")}>Find a solution for me</button>
                    {detail.assistant.canReuseSavedReference ? <button type="button" onClick={() => void chooseReference("reuse")}>Use saved reference</button> : null}
                  </div>
                </fieldset>
              ) : null}

              {detail.assistant.preparationState === "READY" ? (
                <div className="button-row">
                  <button type="button" onClick={() => void revealReference()}>Show full solution</button>
                  <button type="button" onClick={() => void reportReference()}>Report an issue</button>
                  <button type="button" onClick={() => void chooseReference("find")}>Replace reference</button>
                </div>
              ) : null}

              {revealedReference ? (
                <section className="revealed-reference" aria-label="Complete reference solution">
                  <h3>Reference solution — spoiler</h3>
                  <p>{revealedReference.artifact.restated_problem}</p>
                  <ol>{revealedReference.artifact.steps.map((step, index) => <li key={index}><p>{step.claim}</p><p><em>{step.justification}</em></p></li>)}</ol>
                  <p><strong>Conclusion:</strong> {revealedReference.artifact.conclusion}</p>
                  <p><strong>Check:</strong> {revealedReference.checkSummary}</p>
                  {revealedReference.sources.map((source) => <p key={source.url}><a href={source.url} target="_blank" rel="noreferrer">{source.title ?? "Source"}</a> — {source.author ?? "unknown author"} — {source.license ?? "license not reported"}</p>)}
                </section>
              ) : null}

              <div className="conversation" aria-live="polite">
                {messages.length === 0 ? <p className="empty-state">No conversation yet.</p> : messages.map((message) => (
                  <article className="chat-turn" data-role={message.role} data-historical={message.isHistorical} key={message.id}>
                    <span className="chat-meta">{message.role === "user" ? "You" : message.isOperational ? "Assistant status" : "Assistant"} · notes revision {message.notesRevision ?? "—"}{message.isHistorical ? " · earlier statement" : ""}</span>
                    <MarkdownPreview source={message.content} label={`${message.role} message`} />
                    {message.citedNoteExcerpt ? <blockquote>{message.citedNoteExcerpt}</blockquote> : null}
                  </article>
                ))}
              </div>

              <div className="notes-excerpt"><strong>Current notes excerpt:</strong> {notes.value.replace(/\s+/g, " ").trim().slice(0, 320) || "No notes yet."}</div>
              {selectedExcerpt ? <div className="notes-excerpt"><strong>Attached selection:</strong> {selectedExcerpt} <button className="link-button" type="button" onClick={() => setSelectedExcerpt(null)}>Remove</button></div> : null}
              <label htmlFor="question">Ask about my notes</label>
              <textarea id="question" value={question} onChange={(event) => changeQuestion(event.target.value)} placeholder="Ask about one specific step" maxLength={4000} />
              <div className="button-row">
                <button type="button" disabled={!question.trim() || detail.assistant.preparationState !== "READY" || Boolean(chatJobId)} onClick={() => void sendQuestion("default")}>Send</button>
                <button type="button" disabled={!question.trim() || detail.assistant.preparationState !== "READY" || Boolean(chatJobId)} onClick={() => void sendQuestion("stronger_hint")}>Ask for a stronger hint</button>
                <button type="button" disabled={!question.trim() || detail.assistant.preparationState !== "READY" || Boolean(chatJobId)} onClick={() => void sendQuestion("discuss_note_question")}>Discuss a question in my notes</button>
              </div>
              {chatJob ? <p role="status">Thinking: {chatJob.stage ?? chatJob.state}</p> : null}
            </>
          )}
        </aside>
      </main>
    </>
  );
}
