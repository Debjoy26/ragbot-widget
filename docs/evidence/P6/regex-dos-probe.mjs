// Main-session probe for review P6-R3 R-1: does chunking stall on long punctuation or space runs?
const { chunkDocument } = await import('../../../worker/dist/lib/chunk.js');
const cases = {
  punctuation: (n) => [{ number: 1, text: 'a' + '!'.repeat(n) + 'b' }],
  headingSpaces: (n) => [{ number: 1, text: '# a' + ' '.repeat(n) + 'b' }],
};
for (const [name, make] of Object.entries(cases)) {
  for (const n of [2000, 8000, 32000]) {
    const t = performance.now();
    await chunkDocument(make(n), name === 'headingSpaces' ? 'text/markdown' : 'text/plain');
    console.log(name, n, Math.round(performance.now() - t), 'ms');
  }
}
