import { createAskHandler } from "../../../lib/ask-server";

export const runtime = "nodejs";
export const maxDuration = 300;

export const POST = createAskHandler();
