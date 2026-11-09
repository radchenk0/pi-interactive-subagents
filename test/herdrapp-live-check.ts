// Live plumbing check for the herdrapp backend (herdr-app generation).
// Run from inside a Herdr (herdr-core) terminal:
//   hc run --label herdr.space=<id> --label herdr.tab=<id> -- node test/herdrapp-live-check.ts
// (or just run `node test/herdrapp-live-check.ts` in any Herdr terminal)
import {
  getMuxBackend,
  createSurface,
  sendCommand,
  readScreen,
  closeSurface,
  isSurfaceAlive,
} from "../pi-extension/subagents/cmux.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const backend = getMuxBackend();
console.log("backend:", backend);
if (backend !== "herdrapp") {
  console.error("FAIL: expected herdrapp backend");
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
await sleep(500);
console.log("alive after close:", isSurfaceAlive(surface));
console.log("OK: createSurface → sendCommand → readScreen (sentinel visible) → closeSurface");
