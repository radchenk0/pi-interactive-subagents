// Live plumbing check for the herdr backend (S2). Run from inside a herdr session:
//   node test/herdr-live-check.ts
import {
  getMuxBackend,
  createSurface,
  sendCommand,
  readScreen,
  closeSurface,
} from "../pi-extension/subagents/cmux.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const backend = getMuxBackend();
console.log("backend:", backend);
if (backend !== "herdr") {
  console.error("FAIL: expected herdr backend");
  process.exit(1);
}

const surface = createSurface("live-check");
console.log("surface:", surface);

sendCommand(surface, "echo __SUBAGENT_DONE_42__ && sleep 0.5");
await sleep(2000);
const screen = readScreen(surface, 5);
console.log("--- screen tail ---");
console.log(screen);
console.log("-------------------");

if (!screen.includes("__SUBAGENT_DONE_42__")) {
  closeSurface(surface);
  console.error("FAIL: sentinel not visible in readScreen output");
  process.exit(1);
}

closeSurface(surface);
console.log("OK: createSurface → sendCommand → readScreen (sentinel visible) → closeSurface");
