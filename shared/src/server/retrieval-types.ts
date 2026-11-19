// Shared server retrieval evidence and strict row boundary.
import { z } from 'zod';
import { CHUNK_ID_PATTERN } from '../index.js';

export interface RetrievedChunk {
  readonly chunk_id: string;
  readonly document_id: string;
  readonly document_version_id: string;
  readonly document_title: string;
  readonly chunk_index: number;
  readonly content: string;
  readonly page_number: number | null;
  readonly section: string | null;
  readonly similarity: number;
}

export const retrievedChunkSchema = z.looseObject({
  chunk_id: z.string().regex(CHUNK_ID_PATTERN),
  document_id: z.uuid(),
  document_version_id: z.uuid(),
  document_title: z.string(),
  chunk_index: z.int().min(0),
  content: z.string(),
  page_number: z.int().min(1).nullable(),
  section: z.string().nullable(),
  similarity: z.number().min(-1).max(1),
});
