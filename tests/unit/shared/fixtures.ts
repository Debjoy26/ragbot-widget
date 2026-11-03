// Test fixtures: fake values only (example domains, placeholder numbers, random UUIDs).
export const BOT_ID = '3f2b8c1e-5d4a-4e7b-9c1d-2a6b7c8d9e0f';
export const SESSION_ID = '9a1c5e72-0b3d-4f68-8a21-7d4e6f0b1c93';
export const CONVERSATION_ID = 'c4d2e8a6-1f35-4b79-a0d8-52e9f7c31b64';
export const MESSAGE_ID = '5b7e9d13-8c2a-4f06-b4e1-3a9d0c6f7e82';
export const DOC_ID = 'a8f3c6d1-2e47-4b90-8d5a-1c7e9f3b6a04';
export const VERSION_ID = 'e1b4a7c9-6d28-4f35-9a0c-8b3d5e7f1a26';

export const validContactFields = {
  escalation_label: 'Contact support',
  escalation_messages: { en: "I don't have that information. Our team can help:" },
  contact_email: 'support@client.example.com',
  contact_phone: '+911234567890',
  contact_whatsapp_url: 'https://wa.me/911234567890',
  contact_page_url: 'https://client.example.com/contact',
  business_hours: { 'mon-fri': '09:00-18:00', sat: '10:00-14:00' },
  timezone: 'Asia/Kolkata',
};

export const validPublicConfig = {
  bot_id: BOT_ID,
  bot_slug: 'website-support',
  display_name: 'Acme Assistant',
  greeting: 'Ask about our products and services.',
  suggested_questions: ['What services do you offer?'],
  primary_color: '#3155D9',
  position: 'bottom-right',
  privacy_url: 'https://client.example.com/privacy',
  supported_languages: ['en'],
  ...validContactFields,
};
