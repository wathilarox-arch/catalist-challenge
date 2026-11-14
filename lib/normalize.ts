export function normalizeForSearch(text: string): string {
  return text.toLowerCase()
    .replace(/\b(?:um+|uh+|erm+|er+)\b/g, " ")
    .replace(/\b(?:[a-z]_){2,}/g, (acronym) => `${acronym} ${acronym.replaceAll("_", "")}`)
    .replace(/\s+/g, " ")
    .trim();
}
