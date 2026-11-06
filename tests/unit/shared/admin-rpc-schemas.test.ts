import { describe, expect, it } from 'vitest';
import {
  adminAddDocumentVersionResponseSchema,
  adminCompleteUploadResponseSchema,
  adminDocumentStatusResponseSchema,
  adminGetSettingsResponseSchema,
  adminListBotsResponseSchema,
  adminListMembersResponseSchema,
  adminRegisterDocumentResponseSchema,
  adminReindexDocumentResponseSchema,
  adminRequestDownloadResponseSchema,
  adminRetryVersionResponseSchema,
  adminSettingsVersionResponseSchema,
  adminVoidResponseSchema,
  schemaVersionResponseSchema,
} from '@ragbot/shared';
import { BOT_ID, DOC_ID, VERSION_ID } from './fixtures';

// P3.5-T3: strict response schemas for the browser-callable RPCs. The shapes here are FAKE fixtures; the
// real HTTP responses are checked against the same schemas in tests/integration/admin-real-session.test.ts.

const ok = (r: { success: boolean }) => r.success;
const PATH = `${BOT_ID}/${DOC_ID}/${VERSION_ID}/original.txt`;

const settingsRow = {
  bot_id: BOT_ID,
  slug: 'website-support',
  enabled: false,
  settings_version: 1,
  tone: null,
  scope: null,
  max_bytes: 20971520,
  max_pages: 300,
  display_name: null,
  greeting: null,
  suggested_questions: null,
  primary_color: null,
  position: null,
  privacy_url: null,
  supported_languages: null,
  escalation_label: null,
  escalation_messages: null,
  contact_email: null,
  contact_phone: null,
  contact_whatsapp_url: null,
  contact_page_url: null,
  business_hours: null,
  timezone: null,
};

const statusRow = {
  document_id: DOC_ID,
  title: 'Price list',
  status: 'indexing',
  active_version_id: null,
  latest_version_id: VERSION_ID,
  latest_version_number: 1,
  latest_version_status: 'uploaded',
  batches_done: null,
  batches_total: null,
  failure_code: null,
};

describe('document RPC responses', () => {
  it('accepts a register response of one row', () => {
    const row = { document_id: DOC_ID, version_id: VERSION_ID, storage_path: PATH };
    expect(ok(adminRegisterDocumentResponseSchema.safeParse([row]))).toBe(true);
  });

  it.each([
    ['not an array', { document_id: DOC_ID, version_id: VERSION_ID, storage_path: PATH }],
    ['no rows', []],
    [
      'two rows',
      Array(2).fill({ document_id: DOC_ID, version_id: VERSION_ID, storage_path: PATH }),
    ],
    ['extra column', [{ document_id: DOC_ID, version_id: VERSION_ID, storage_path: PATH, x: 1 }]],
    ['missing path', [{ document_id: DOC_ID, version_id: VERSION_ID }]],
    ['bad uuid', [{ document_id: 'nope', version_id: VERSION_ID, storage_path: PATH }]],
    ['empty path', [{ document_id: DOC_ID, version_id: VERSION_ID, storage_path: '' }]],
  ])('rejects a register response: %s', (_name, body) => {
    expect(ok(adminRegisterDocumentResponseSchema.safeParse(body))).toBe(false);
  });

  it('accepts and rejects add-version responses', () => {
    const row = { version_id: VERSION_ID, version_number: 2, storage_path: PATH };
    expect(ok(adminAddDocumentVersionResponseSchema.safeParse([row]))).toBe(true);
    expect(
      ok(adminAddDocumentVersionResponseSchema.safeParse([{ ...row, version_number: 0 }])),
    ).toBe(false);
    expect(
      ok(adminAddDocumentVersionResponseSchema.safeParse([{ ...row, version_number: 1.5 }])),
    ).toBe(false);
  });

  it('accepts and rejects complete-upload responses', () => {
    const row = { version_id: VERSION_ID, status: 'uploaded', job_queued: true };
    expect(ok(adminCompleteUploadResponseSchema.safeParse([row]))).toBe(true);
    expect(ok(adminCompleteUploadResponseSchema.safeParse([{ ...row, status: 'queued' }]))).toBe(
      false,
    );
    expect(ok(adminCompleteUploadResponseSchema.safeParse([{ ...row, job_queued: 'yes' }]))).toBe(
      false,
    );
    expect(ok(adminCompleteUploadResponseSchema.safeParse([{ version_id: VERSION_ID }]))).toBe(
      false,
    );
  });

  it('accepts and rejects retry and reindex responses', () => {
    expect(
      ok(
        adminRetryVersionResponseSchema.safeParse([{ version_id: VERSION_ID, status: 'uploaded' }]),
      ),
    ).toBe(true);
    expect(ok(adminRetryVersionResponseSchema.safeParse([{ version_id: VERSION_ID }]))).toBe(false);
    expect(
      ok(
        adminReindexDocumentResponseSchema.safeParse([
          { version_id: VERSION_ID, version_number: 3 },
        ]),
      ),
    ).toBe(true);
    expect(
      ok(
        adminReindexDocumentResponseSchema.safeParse([
          { version_id: VERSION_ID, version_number: -1 },
        ]),
      ),
    ).toBe(false);
  });

  it('accepts a document status page, including an empty one', () => {
    expect(ok(adminDocumentStatusResponseSchema.safeParse([]))).toBe(true);
    expect(ok(adminDocumentStatusResponseSchema.safeParse([statusRow]))).toBe(true);
    expect(
      ok(
        adminDocumentStatusResponseSchema.safeParse([
          {
            ...statusRow,
            status: 'failed',
            batches_done: 2,
            batches_total: 5,
            failure_code: 'OCR_REQUIRED',
          },
        ]),
      ),
    ).toBe(true);
  });

  it.each([
    ['unknown failure code', { ...statusRow, failure_code: 'DISK_FULL' }],
    ['unknown document status', { ...statusRow, status: 'archived' }],
    ['last_error column leaks in', { ...statusRow, last_error: 'boom' }],
    ['negative batches', { ...statusRow, batches_done: -1 }],
    ['missing column', { ...statusRow, title: undefined }],
  ])('rejects a document status row: %s', (_name, row) => {
    expect(ok(adminDocumentStatusResponseSchema.safeParse([row]))).toBe(false);
  });

  it('accepts a download path string and rejects anything else', () => {
    expect(ok(adminRequestDownloadResponseSchema.safeParse(PATH))).toBe(true);
    expect(ok(adminRequestDownloadResponseSchema.safeParse(''))).toBe(false);
    expect(ok(adminRequestDownloadResponseSchema.safeParse(null))).toBe(false);
    expect(ok(adminRequestDownloadResponseSchema.safeParse([PATH]))).toBe(false);
  });

  it('accepts null for void functions and rejects a body', () => {
    expect(ok(adminVoidResponseSchema.safeParse(null))).toBe(true);
    expect(ok(adminVoidResponseSchema.safeParse({}))).toBe(false);
    expect(ok(adminVoidResponseSchema.safeParse(''))).toBe(false);
  });
});

describe('settings, bot list and member RPC responses', () => {
  it('accepts a bot list, with and without a display name', () => {
    const row = {
      id: BOT_ID,
      slug: 'dev-bot',
      display_name: 'Dev',
      enabled: true,
      settings_version: 2,
    };
    expect(ok(adminListBotsResponseSchema.safeParse([row, { ...row, display_name: null }]))).toBe(
      true,
    );
    expect(ok(adminListBotsResponseSchema.safeParse([]))).toBe(true);
  });

  it.each([
    ['bad slug', { slug: 'Bad Slug' }],
    ['version zero', { settings_version: 0 }],
    ['enabled as string', { enabled: 'true' }],
    ['extra column', { identity_prompt: 'secret' }],
  ])('rejects a bot list row: %s', (_name, patch) => {
    const row = {
      id: BOT_ID,
      slug: 'dev-bot',
      display_name: 'Dev',
      enabled: true,
      settings_version: 1,
    };
    expect(ok(adminListBotsResponseSchema.safeParse([{ ...row, ...patch }]))).toBe(false);
  });

  it('accepts a settings row before and after a public config exists', () => {
    expect(ok(adminGetSettingsResponseSchema.safeParse([settingsRow]))).toBe(true);
    const full = {
      ...settingsRow,
      tone: 'friendly',
      scope: 'sample documents',
      display_name: 'Dev Assistant',
      greeting: 'Hi',
      suggested_questions: ['What can you do?'],
      primary_color: '#2563eb',
      position: 'bottom-right',
      privacy_url: 'https://example.com/privacy',
      supported_languages: ['en'],
      escalation_label: 'Contact support',
      escalation_messages: { en: 'Please contact support.' },
      contact_email: 'support@example.com',
      business_hours: { 'mon-fri': '09:00-17:00' },
      timezone: 'Asia/Kolkata',
    };
    expect(ok(adminGetSettingsResponseSchema.safeParse([full]))).toBe(true);
  });

  it.each([
    ['identity prompt leaks in', { identity_prompt: 'x' }],
    ['allowed origins leak in', { allowed_origins: ['https://a.example.com'] }],
    ['rate policy leaks in', { rate_policy: {} }],
    ['bad colour', { primary_color: 'blue' }],
    ['bad position', { position: 'top' }],
    ['limit as string', { max_bytes: '20971520' }],
    ['zero limit', { max_pages: 0 }],
    ['languages not an array', { supported_languages: 'en' }],
    ['missing column', { timezone: undefined }],
  ])('rejects a settings row: %s', (_name, patch) => {
    expect(ok(adminGetSettingsResponseSchema.safeParse([{ ...settingsRow, ...patch }]))).toBe(
      false,
    );
  });

  it('requires exactly one settings row', () => {
    expect(ok(adminGetSettingsResponseSchema.safeParse([]))).toBe(false);
    expect(ok(adminGetSettingsResponseSchema.safeParse([settingsRow, settingsRow]))).toBe(false);
    expect(ok(adminGetSettingsResponseSchema.safeParse(settingsRow))).toBe(false);
  });

  it('accepts settings versions and the schema version as positive integers only', () => {
    for (const schema of [adminSettingsVersionResponseSchema, schemaVersionResponseSchema]) {
      expect(ok(schema.safeParse(1))).toBe(true);
      expect(ok(schema.safeParse(10))).toBe(true);
      expect(ok(schema.safeParse(0))).toBe(false);
      expect(ok(schema.safeParse(1.5))).toBe(false);
      expect(ok(schema.safeParse('3'))).toBe(false);
      expect(ok(schema.safeParse(null))).toBe(false);
    }
  });

  it('accepts a member list and rejects an unknown role or a leaked column', () => {
    const row = { user_id: VERSION_ID, role: 'owner', active: true, label: 'owner@example.test' };
    expect(ok(adminListMembersResponseSchema.safeParse([row, { ...row, label: null }]))).toBe(true);
    expect(ok(adminListMembersResponseSchema.safeParse([{ ...row, role: 'superuser' }]))).toBe(
      false,
    );
    expect(ok(adminListMembersResponseSchema.safeParse([{ ...row, created_at: 'x' }]))).toBe(false);
    expect(ok(adminListMembersResponseSchema.safeParse([{ ...row, active: 1 }]))).toBe(false);
  });
});
