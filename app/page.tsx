import { readAskPage } from "../lib/ask-data";
import { liveAvailability } from "../lib/ask-server";
import { AskWorkspace } from "./ask-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function Home() {
  const { questions, teams } = readAskPage();
  return <AskWorkspace questions={questions} teams={teams} liveNotice={liveAvailability(teams.length > 0)} />;
}
