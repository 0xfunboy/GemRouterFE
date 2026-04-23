export interface GeminiConfig {
  headless: boolean;
  browserChannel?: string;
  browserExecutablePath?: string;
  baseProfileDir: string;
  profileNamespace: string;
  streamPollIntervalMs: number;
  streamStableTicks: number;
  streamFirstChunkTimeoutMs: number;
  streamMaxDurationMs: number;
}

export interface GeminiProviderConfig {
  id: "gemini";
  label: string;
  baseUrl: string;
  readySelectors: string[];
  inputSelector: string;
  submitSelector: string;
  messageSelectors: string[];
  busySelectors: string[];
}

export interface ConversationSnapshot {
  count: number;
  lastText: string;
  mainText: string;
  imageKeys: string[];
  imageNodeCount: number;
  prompt?: string;
}

export interface GeneratedImage {
  src: string;
  alt?: string;
}

export interface GeneratedMedia {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export interface GeneratedMusicDownloads {
  video: GeneratedMedia | null;
  audio: GeneratedMedia | null;
}

export interface GeminiResponse {
  text: string;
  images: GeneratedImage[];
}
