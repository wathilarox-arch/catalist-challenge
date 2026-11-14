import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCorpusStats, indexMeetings, initializeMemory, memoryPath, openMemory } from "../lib/db";
import { parseTranscript } from "../lib/parse";

const transcriptDir = join(process.cwd(), "data", "transcripts");
const files = readdirSync(transcriptDir).filter((file) => file.endsWith(".txt")).sort();
if (!files.length) throw new Error(`No transcripts found in ${transcriptDir}`);

function* readTranscripts() {
  for (const file of files) {
    yield parseTranscript(readFileSync(join(transcriptDir, file), "utf8"), file.slice(0, -4));
  }
}

mkdirSync(dirname(memoryPath), { recursive: true });
const db = openMemory(memoryPath, { readonly: false });
try {
  initializeMemory(db);
  const indexed = indexMeetings(db, readTranscripts());
  const { meetings, teams, turns, words } = getCorpusStats(db);
  console.log(`Indexed ${indexed} new meetings. Database contains ${meetings} meetings, ${teams} teams, ${turns} turns, ${words} words.`);
} finally {
  db.close();
}
