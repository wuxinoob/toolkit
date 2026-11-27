export * from './contracts';
import type { ResourceSource, ResourceTicket, ResourceIdentity, ResourceStat, CaptureRequest, Pointer, WindowSelector, WindowInfo, Rectangle, FileOpenOptions, FileWriterOptions, ModelProfile, ModelRequest, ModelEvent, Usage } from './contracts';
export interface ByteOptions { timeoutMs?: number }
export interface SealedResource {
  readonly id: string;
  readonly maxChunkBytes: number;
  readonly source: ResourceSource;
  read(offset: number, maxBytes?: number): Promise<Uint8Array>;
  stat(): Promise<ResourceStat>;
  close(): Promise<unknown>;
}
export interface ByteTransfer extends Omit<SealedResource, 'source'> {
  write(offset: number, bytes: ArrayBuffer | ArrayBufferView): Promise<number>;
  seal(): Promise<ResourceSource>;
}
export interface BinaryApi {
  open(size: number, options?: ByteOptions): Promise<ByteTransfer>;
  upload(bytes: ArrayBuffer | ArrayBufferView, options?: ByteOptions): Promise<SealedResource>;
  close(id: string): Promise<unknown>;
  identity(): Promise<ResourceIdentity>;
  export(id: string, recipient: {to: string}): Promise<ResourceTicket>;
  import(ticket: Pick<ResourceTicket, 'token'>, options?: ByteOptions): Promise<SealedResource>;
  revoke(ticket: Pick<ResourceTicket, 'token'>): Promise<boolean>;
}
export interface FileReader {
  readonly path: string;
  readonly size: number;
  readonly maxChunkBytes: number;
  readAt(offset: number, length?: number): Promise<Uint8Array>;
  stat(): Promise<{size: number}>;
  close(): Promise<unknown>;
}
export interface FileWriter {
  readonly path: string;
  readonly maxChunkBytes: number;
  write(offset: number, bytes: ArrayBuffer | ArrayBufferView): Promise<number>;
  commit(): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface FileApi {
  open(options?: FileOpenOptions): Promise<FileReader | null>;
  createWriter(options?: FileWriterOptions): Promise<FileWriter | null>;
}
export interface CaptureInfo { bounds: Rectangle; unit: 'physical'; target: Record<string, unknown>; mode: 'visible-desktop' }
export interface ScreenApi {
  monitors(): Promise<Array<{index: number; name: string; position: {x:number; y:number}; width:number; height:number; scaleFactor:number; primary:boolean; unit:'physical'; workArea:Rectangle|null}>>;
  pointer(): Promise<Pointer>;
  windows(selector?: WindowSelector): Promise<WindowInfo[]>;
  capture(request?: Omit<CaptureRequest, 'includeInfo'>): Promise<Uint8Array>;
  captureResource(request: CaptureRequest & {includeInfo: true}): Promise<{source: ResourceSource; capture: CaptureInfo}>;
  captureResource(request?: CaptureRequest & {includeInfo?: false}): Promise<ResourceSource>;
}
export interface LlmApi {
  profiles(): Promise<ModelProfile[]>;
  stream(request: ModelRequest, options?: {signal?: AbortSignal}): AsyncIterable<ModelEvent>;
  generate(request: ModelRequest, options?: {signal?: AbortSignal}): Promise<{output: Array<{type: 'text'; text: string}>; finishReason: string; usage: Usage}>;
}
/** Shared data APIs on ctx and bridge; window/view/UI methods are documented separately. */
export interface PluginDataApi { binary: BinaryApi; fs: FileApi; screen: ScreenApi; llm: LlmApi }
