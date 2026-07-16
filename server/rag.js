// Simple keyword-matching RAG: scores each FAQ entry by how many of its
// keywords appear in the user's message, and returns the best match(es).
function findRelevantFaq(message, faqList, maxResults = 2) {
  const text = message.toLowerCase();

  const scored = faqList
    .map((entry) => {
      const score = entry.keywords.reduce((count, keyword) => {
        return text.includes(keyword.toLowerCase()) ? count + 1 : count;
      }, 0);
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, maxResults).map((item) => item.entry.answer);
}

module.exports = { findRelevantFaq };
