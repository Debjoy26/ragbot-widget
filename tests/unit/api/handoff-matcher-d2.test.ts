import { describe, expect, it } from 'vitest';
import { matchesHumanRequest } from '../../../api/src/services/handoff.ts';

// P7-D2 F6: two more ordinary questions that the matcher took for a request for a person. A group
// noun ("the office", "the team") no longer accepts a preposition after it, and "phone", "mobile"
// and "cell" count as contact details only with a contact trailer ("your phone number").

const NEGATIVE = [
  'How do I reach the office by train?',
  'Does this case fit your phone?',
  'How do I reach the office by car',
  'Can I reach the team by 5pm on Friday?',
  'How can I contact the company about a refund policy?',
  'How do I get to the office on foot?',
  'Is the app available on your mobile?',
  'Will it work on your cell?',
  'Does it support your mobile browser?',
  'Is this charger compatible with your phone?',
  'What does your phone app do?',
  'Which phone do you recommend?',
  'Does the plan cover my cell?',
];

const POSITIVE = [
  // Every positive from the P7-D1 list stays a positive.
  'Can I talk to a person?',
  'I want to speak to a human',
  'give me your phone number',
  'how can I contact you',
  'How do I reach your support team?',
  'How can I contact support',
  'How do I get in touch with your team?',
  'I want to call you',
  'what is your phone number',
  "What's your email address?",
  'Could I get your contact details?',
  'send me the phone number please',
  // The group nouns still match when the request ends there.
  'How do I reach the office?',
  'How can I contact the team please',
  'Can I contact the company?',
  // Phone, mobile and cell with a contact trailer.
  'what is your mobile number',
  'Can I have your cell number?',
  'your phone no.',
  'What is your phone line?',
  'please share your telephone number',
  // A preposition after "you" or a person is still a request.
  'How can I contact you by email?',
  'Can I speak to someone about my order?',
];

describe('P7-D2 F6: matcher false positives', () => {
  it.each(NEGATIVE)('does not match an ordinary question: %s', (text) => {
    expect(matchesHumanRequest(text)).toBe(false);
  });

  it.each(POSITIVE)('still matches a clear request: %s', (text) => {
    expect(matchesHumanRequest(text)).toBe(true);
  });
});

describe('a channel or time after a group is still a contact request (P7-R4 #2)', () => {
  it.each([
    'How can I contact the team by email?',
    'can I call the office on Monday?',
    'I want to message the support team via WhatsApp',
    'How do I email the company through the website?',
  ])('matches %j', (q) => {
    expect(matchesHumanRequest(q)).toBe(true);
  });

  it.each(['How do I reach the office by train?', 'Can I reach the store on foot?'])(
    'does not match a journey question %j',
    (q) => {
      expect(matchesHumanRequest(q)).toBe(false);
    },
  );
});
