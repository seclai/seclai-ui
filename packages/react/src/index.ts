export {
  AgentChat,
  type AgentChatAttachButton,
  type AgentChatAttachment,
  type AgentChatFile,
  type AgentChatMessage,
  type AgentChatProps,
  type AgentChatTurn,
} from "./AgentChat";
export { AgentRunForm, type AgentRunFormProps } from "./AgentRunForm";
export { SeclaiAgent, type SeclaiAgentProps } from "./SeclaiAgent";
export {
  RunProgress,
  useElapsed,
  type RunProgressProps,
  type RunProgressRun,
} from "./RunProgress";
export {
  useAgentRun,
  type AgentRunEvent,
  type AgentRunState,
  type StartRunOptions,
  type UseAgentRunOptions,
  type UseAgentRunResult,
} from "./useAgentRun";
export {
  DEFAULT_BASE_PATH,
  createEndpoints,
  fetchAttachmentReferences,
  uploadFile,
  type AgentEndpoints,
  type EndpointRequestOptions,
  type UploadFileOptions,
} from "./endpoints";
export type {
  AcceptedAttachmentSlot,
  AgentAttachment,
  AgentEndpointOptions,
  AgentRunStatus,
  AgentRunStep,
  AgentUiMode,
  AttachmentReferences,
  UploadResult,
} from "./types";

// Media. MediaPreview previews images; audio, video and PDF are still to come.
export {
  MediaPreview,
  type MediaAspectRatio,
  type MediaPreviewProps,
} from "./placeholders/MediaPreview";
export { MediaGallery, type MediaGalleryProps } from "./media/MediaGallery";
export { MediaSkeleton, type MediaSkeletonProps } from "./media/MediaSkeleton";
export { MediaViewer, type MediaViewerProps } from "./media/MediaViewer";
export {
  attachmentFileName,
  saveFile,
  saveFiles,
  type SaveFilesEntry,
  type SaveFilesOptions,
} from "./media/files";

// Markdown. HTML, maths and Mermaid diagrams are opt-in: see `@seclai/react/html`,
// `@seclai/react/math` and `@seclai/react/mermaid`.
export { MarkdownContent, type MarkdownContentProps } from "./markdown/MarkdownContent";
export {
  SeclaiMarkdownProvider,
  type MarkdownExtension,
  type SeclaiMarkdownProviderProps,
} from "./markdown/extensions";
