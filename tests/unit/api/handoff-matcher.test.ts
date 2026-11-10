import { describe, expect, it } from 'vitest';
import { matchesHumanRequest } from '../../../api/src/services/handoff.ts';

// P7-D1 fix 1 (R2-1): the deterministic human-request matcher skips retrieval and generation, so a
// false positive turns an ordinary question into a contact card. A match needs an intent
// (I want to, can I, how do I, please, an imperative) or a second-person possessive (your phone).

const POSITIVE = [
  // The four from the review.
  'Can I talk to a person?',
  'I want to speak to a human',
  'give me your phone number',
  'how can I contact you',
  // Intent plus a person.
  'I would like to talk to someone',
  "I'd like to speak to the manager",
  'Can I speak with a real person please',
  'I need to talk to customer service',
  'Please connect me to a representative',
  'Transfer me to an agent',
  'Could I chat with a live agent?',
  'Hi, I want to speak to somebody from sales',
  'talk to a human',
  // Intent plus contact verb.
  'How do I reach your support team?',
  'How can I contact support',
  'How do I get in touch with your team?',
  'I want to call you',
  'Is there a way to email you? Can I email you?',
  // Second-person possessive nouns.
  'what is your phone number',
  "What's your email address?",
  'Could I get your contact details?',
  'send me the phone number please',
  // A bare request.
  'human',
  'Agent please',
  // Other languages.
  'necesito hablar con una persona',
  'quel est votre numéro de téléphone',
  'ich möchte mit einem Mitarbeiter sprechen',
];

const NEGATIVE = [
  // The four from the review.
  'How do I update my contact information?',
  'What is your customer service refund policy?',
  'What phone number format do you accept?',
  'How do I contact support hours',
  // Earlier negatives.
  'How much is the standard plan?',
  'What are your opening hours?',
  'Does the human resources module exist?',
  'Tell me about the contact form validation',
  // More ordinary questions that share a word with the patterns.
  'Are you a real person?',
  'Is this a live agent or a bot?',
  'Do you offer live agent chat in the product?',
  'How do I change the phone number on my account?',
  'Can I use my own email address to sign up?',
  'What is your email policy?',
  'Is the sales team available on weekends?',
  'Our team wants to contact customers by phone.',
  'How can I contact my own customers through your API?',
  'Do you share my email address with third parties?',
  'Can I call the API with an agent header?',
  'What does the support plan include?',
  'How do I text message the contact list?',
  'What is the customer support response time?',
  'Where is the contact us page?',
  'I want to update my phone number',
  'Can I talk to my friends about this product?',
  'Please explain how the agent dashboard works',
  'What is your customer service phone number format?',
  'quiero saber el precio del plan',
  'quel est le prix du plan',
  'wie viel kostet der Plan',
];

describe('matchesHumanRequest', () => {
  it('has at least ten of each', () => {
    expect(POSITIVE.length).toBeGreaterThanOrEqual(10);
    expect(NEGATIVE.length).toBeGreaterThanOrEqual(10);
  });

  it.each(POSITIVE)('matches a clear request: %s', (text) => {
    expect(matchesHumanRequest(text)).toBe(true);
  });

  it.each(NEGATIVE)('does not match an ordinary question: %s', (text) => {
    expect(matchesHumanRequest(text)).toBe(false);
  });

  it('ignores case, repeated whitespace and curly apostrophes', () => {
    expect(matchesHumanRequest('  I   WANT   TO   SPEAK   TO   A   HUMAN  ')).toBe(true);
    expect(matchesHumanRequest('I’d like to speak to the manager')).toBe(true);
    expect(matchesHumanRequest('')).toBe(false);
  });

  it('stays fast on long hostile input', () => {
    const inputs = [
      `${'i want to talk to '.repeat(120)}x`,
      `${'can i '.repeat(330)}`,
      `${'how do i contact '.repeat(125)}`,
      `${'your '.repeat(400)}`,
      `${'real '.repeat(400)}`,
      'a'.repeat(2000),
    ];
    const started = performance.now();
    for (const text of inputs) matchesHumanRequest(text);
    // Generous: linear work on 2000 characters is far below this.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
