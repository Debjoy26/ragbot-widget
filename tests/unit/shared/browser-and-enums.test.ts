import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLES,
  ANALYSIS_STATUSES,
  BUDGET_RESERVATION_STATES,
  CONVERSATION_STATUSES,
  DISCLOSURE_POLICIES,
  DOCUMENT_STATUSES,
  DOCUMENT_VERSION_STATUSES,
  EXTRACTION_METHODS,
  HANDOFF_REASONS,
  JOB_STATES,
  JOB_TYPES,
  MEDIA_TYPES,
  MESSAGE_ROLES,
  MESSAGE_STATUSES,
  MODERATION_VERDICTS,
  REQUEST_RUN_STATES,
  SENTIMENTS,
  USAGE_OPERATIONS,
  VECTOR_DIMENSIONS,
  VISITOR_VISIBLE_ROLES,
  WIDGET_POSITIONS,
} from '@ragbot/shared';

const entry = fileURLToPath(new URL('../../../shared/src/index.ts', import.meta.url));

describe('browser safety', () => {
  it('bundles shared/src/index.ts for the browser with no node: imports or Node globals', async () => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    expect(result.errors).toHaveLength(0);

    const importedPaths = Object.values(result.metafile.inputs).flatMap((i) =>
      i.imports.map((imp) => imp.path),
    );
    expect(importedPaths.filter((p) => p.startsWith('node:'))).toEqual([]);

    const code = result.outputFiles.map((f) => f.text).join('\n');
    expect(code).not.toMatch(/from\s*["']node:/);
    expect(code).not.toMatch(/require\(\s*["']node:/);
    expect(code).not.toMatch(/\bBuffer\./);
    expect(code).not.toMatch(/\bprocess\.(env|argv|cwd)/);
  });
});

describe('canonical enum lists (must match the SQL CHECK constraints in P3)', () => {
  it('has the exact agreed values in the agreed order', () => {
    expect([...ADMIN_ROLES]).toEqual(['owner', 'admin', 'analyst']);
    expect([...DOCUMENT_STATUSES]).toEqual(['draft', 'indexing', 'ready', 'failed', 'deleted']);
    expect([...DISCLOSURE_POLICIES]).toEqual(['public_answer', 'excluded']);
    expect([...DOCUMENT_VERSION_STATUSES]).toEqual([
      'pending_upload',
      'uploaded',
      'extracting',
      'embedding',
      'ready',
      'failed',
      'superseded',
    ]);
    expect([...MEDIA_TYPES]).toEqual(['application/pdf', 'text/markdown', 'text/plain']);
    expect([...EXTRACTION_METHODS]).toEqual(['pdf_text', 'markdown', 'plain_text']);
    expect([...CONVERSATION_STATUSES]).toEqual(['open', 'closed']);
    expect([...MESSAGE_ROLES]).toEqual(['user', 'assistant', 'system']);
    expect([...MESSAGE_STATUSES]).toEqual(['complete', 'partial', 'failed', 'blocked']);
    expect([...HANDOFF_REASONS]).toEqual([
      'no_knowledge',
      'out_of_scope',
      'human_requested',
      'blocked',
      'unavailable',
      'repeated_no_knowledge',
    ]);
    expect([...JOB_TYPES]).toEqual([
      'index_document',
      'analyze_conversation',
      'cleanup',
      'warm_answer_cache',
    ]);
    expect([...JOB_STATES]).toEqual(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
    expect([...REQUEST_RUN_STATES]).toEqual([
      'reserved',
      'running',
      'succeeded',
      'failed',
      'partial',
    ]);
    expect([...BUDGET_RESERVATION_STATES]).toEqual(['reserved', 'settled', 'released', 'expired']);
    expect([...ANALYSIS_STATUSES]).toEqual(['pending', 'complete', 'failed']);
    expect([...SENTIMENTS]).toEqual(['positive', 'neutral', 'negative']);
    expect([...USAGE_OPERATIONS]).toEqual([
      'chat',
      'embedding_query',
      'embedding_index',
      'moderation',
      'analysis',
      'answer_cache_hit',
    ]);
    expect([...MODERATION_VERDICTS]).toEqual(['allow', 'block']);
    expect([...WIDGET_POSITIONS]).toEqual(['bottom-right', 'bottom-left']);
    expect(VECTOR_DIMENSIONS).toBe(1536);
  });

  it('never lets the visitor-visible role list include system', () => {
    expect([...VISITOR_VISIBLE_ROLES]).toEqual(['user', 'assistant']);
  });
});
