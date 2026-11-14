import { existsSync } from "node:fs";
import { getCorpusStats, memoryPath, openMemory } from "../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function Home() {
  const stats = readStats();

  return (
    <main className="mx-auto max-w-3xl px-6 py-20 sm:py-28">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Meeting Memory</h1>
      <p className="mt-5 text-lg text-stone-600">Search the AMI design meetings by team from your terminal.</p>
      {stats ? (
        <>
          <dl className="mt-10 grid grid-cols-3 gap-4 border-y border-stone-200 py-6">
            {Object.entries({ Meetings: stats.meetings, Teams: stats.teams, "Speaker turns": stats.turns }).map(([label, value]) => (
              <div key={label}>
                <dt className="text-sm text-stone-600">{label}</dt>
                <dd className="mt-2 text-2xl font-semibold tabular-nums sm:text-3xl">{value.toLocaleString("en-US")}</dd>
              </div>
            ))}
          </dl>
          <pre className="mt-8 overflow-x-auto rounded-lg bg-stone-900 p-4 text-sm text-stone-100"><code>npm run find -- TS3012 design --max-seq 3</code></pre>
        </>
      ) : (
        <p className="mt-8">Run <code className="rounded bg-stone-200 px-1.5 py-0.5">npm run ingest:parse</code> to load the transcripts.</p>
      )}
    </main>
  );
}

function readStats() {
  if (!existsSync(memoryPath)) return null;
  const db = openMemory();
  try {
    return getCorpusStats(db);
  } finally {
    db.close();
  }
}
